import { z } from "zod";
import { getNamingPreferencesReadiness, namingPreferencesV2Schema } from "../src/domain/naming-brain-preferences";
import { namingPreferencesRuntimeFingerprint } from "./naming-brain-configuration";
import { isDeepStrictEqual } from "node:util";
import { namingBrainJobInputSchema, namingEvidenceSourceSchema, namingProviderReceiptSchema, namingRoleOutputSchema, namingStageKeySchema, namingStageRequestSchema, type NamingBrainPolicy, type NamingProviderReceipt, type NamingRoleOutput, type NamingStageKey, type NamingStageRequest, type NamingPreparedSet, type NamingValidatedCandidate, type NamingVerification } from "../src/domain/naming-brain";
import { nameIdentityKey, namingStrategyBasisSchema, namingStrategyKeyFromBasis } from "../src/domain/project-naming";
import type { ClaimedJob, StepOutcome } from "../src/domain/jobs";
import { NAMING_GAP_ENVELOPE } from "../src/server/ai/naming-brain/policy";
import { namingHash } from "../src/server/ai/naming-brain/identity";
import type { NamingProviderItemRecord, NamingRuntimePersistence, NamingToolResultRecord } from "../src/server/ai/naming-brain/transport";
import { parseClaimedJob, type JobDatabase } from "./postgres-store";
import { PlanConflictError, type JobStore, type PlannedStep } from "./runner";

const identifier = z.string().min(1).max(300), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const providerTurnSchema = z.strictObject({ providerCallKey: identifier, sessionId: identifier, turnId: identifier, turn: z.object({ id: identifier, session_id: identifier, agent_id: identifier, subagent_id: z.null(), status: z.enum(["completed", "failed", "cancelled"]) }).catchall(z.json()) }).refine(row => row.turn.id === row.turnId && row.turn.session_id === row.sessionId);
const providerItemSchema = z.strictObject({ providerCallKey: identifier, sessionId: identifier, turnId: identifier, itemId: identifier, item: z.json() });
const toolResultSchema = z.strictObject({ providerCallKey: identifier, sessionId: identifier, turnId: identifier, callId: identifier, requestHash: hash,
  result: z.strictObject({ argumentsHash: hash, reply: z.strictObject({ type: z.literal("agent.session.input.tool_result"), turn_id: identifier, call_id: identifier, success: z.boolean(), output: z.string().max(131_072).optional(), error: z.string().max(200).optional() }) }), sourceEvidence: namingEvidenceSourceSchema.nullable() });
const allocationSchema = z.strictObject({ providerCallKey: identifier, assignmentKey: identifier.nullable(), requestKey: identifier, requestHash: hash, sessionLimitCents: z.number().int().min(1).max(150), maxWebSearchCalls: z.number().int().min(0).max(20), role: z.enum(["researcher", "director", "creator", "curator", "verifier"]) });
const completedOutputSchema = z.strictObject({ artifactIds: z.array(z.uuid()).max(60), errorCode: z.string().max(100).optional(), partialArtifacts: z.array(z.json()).max(100).optional() });
const stageResultSchema = z.strictObject({ id: z.uuid(), run_id: z.uuid(), stage_key: namingStageKeySchema, state: z.enum(["succeeded", "failed", "ambiguous"]), output: completedOutputSchema, created_at: z.iso.datetime({ offset: true }) });
const stageSchema = z.strictObject({ stageKey: namingStageKeySchema, state: z.enum(["pending", "in_flight", "succeeded", "failed", "ambiguous"]), requestKey: z.string().nullable(), startedAt: z.iso.datetime({ offset: true }).nullable(), maximumCostMicrousd: z.number().int().nonnegative(), recoveryMode: z.enum(["execute", "observe_only"]), observationDeadlineAt: z.iso.datetime({ offset: true }).nullable(), stageResults: z.array(stageResultSchema).max(100),
  artifacts: z.array(namingRoleOutputSchema).max(60), receipts: z.array(namingProviderReceiptSchema).max(500), requests: z.array(namingStageRequestSchema).max(60), providerItems: z.array(providerItemSchema).max(500), providerTurns: z.array(providerTurnSchema).max(500), toolResults: z.array(toolResultSchema).max(200), callPlans: z.array(z.strictObject({ phase: z.enum(["main", "direction", "creation", "curation", "verification"]), calls: z.array(allocationSchema).max(60) })).max(4), gapEnvelope: z.json(), gapPlanIdentity: hash });
export type NamingSavedStage = z.infer<typeof stageSchema>;
export type NamingGapPhase = "direction" | "creation" | "curation" | "verification";

/** Reconstruct the established derived key after PostgreSQL JSONB serialization; substantive data is unchanged. */
export function normalizeNamingStoredJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNamingStoredJson);
  if (!value || typeof value !== "object") return value;
  const record = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeNamingStoredJson(child)]));
  if (record.strategyBasis) record.strategyKey = namingStrategyKeyFromBasis(namingStrategyBasisSchema.parse(record.strategyBasis));
  return record;
}
function jobInput(job: ClaimedJob) {
  const input = namingBrainJobInputSchema.parse(normalizeNamingStoredJson(job.input));
  if (job.operation !== "naming.generate" || input.jobId !== job.id || input.snapshot.ownerId !== job.ownerId || input.snapshot.projectId !== job.projectId || input.snapshot.contextRevision !== job.inputRevision || job.reservedCostMicrousd !== input.policy.runAllowanceMicrousd) throw new Error("naming_job_binding_mismatch");
  return input;
}

export class NamingBrainJobStore implements JobStore {
  private readonly observedOnly = new Set<string>();
  private readonly stoppedJobs = new Set<string>();
  private readonly cancellationListeners = new Map<string, Set<() => void>>();
  constructor(private readonly database: JobDatabase, readonly deploymentId: string) {}
  private async rpc(name: "get_naming_brain_preference_work" | "attest_naming_brain_preferences" | "report_naming_brain_worker_ready" | "claim_naming_brain_job" | "expire_naming_brain_leases" | "naming_brain_worker_action" | "authorize_naming_brain_dispatch" | "record_naming_brain_provider_receipt" | "complete_naming_brain_stage", values: unknown[]): Promise<unknown> {
    const response = await this.database.query(`select public.${name}(${values.map((_value, index) => `$${index + 1}`).join(",")}) as result`, values);
    if (response.rows.length !== 1 || !Object.hasOwn(response.rows[0]!, "result")) throw new Error("naming_store_response_invalid");
    return normalizeNamingStoredJson(response.rows[0]!.result);
  }
  async action(job: ClaimedJob, action: string, payload: unknown): Promise<unknown> {
    jobInput(job);
    const body = JSON.stringify(payload); if (Buffer.byteLength(body) > 1_048_576) throw new Error("naming_store_payload_limit");
    return this.rpc("naming_brain_worker_action", [job.id, job.leaseToken, action, body]);
  }
  async attestPendingPreferences(): Promise<number> {
    const work = z.array(z.strictObject({ ownerId: z.uuid(), projectId: z.uuid(), preferencesVersion: z.number().int().positive(), preferences: z.json(), preferencesHash: hash, expectedFingerprint: z.json() })).max(20).parse(await this.rpc("get_naming_brain_preference_work", [20]));
    const fingerprint = namingPreferencesRuntimeFingerprint(); let count = 0;
    for (const row of work) {
      if (!isDeepStrictEqual(row.expectedFingerprint, fingerprint)) continue;
      const parsed = namingPreferencesV2Schema.safeParse(row.preferences);
      const readiness = parsed.success && isDeepStrictEqual(parsed.data, row.preferences) ? getNamingPreferencesReadiness(parsed.data) : { ready: false, missing: ["invalid_preferences"] };
      const saved = z.object({ attestationId: z.uuid(), projectId: z.uuid(), preferencesVersion: z.number().int(), preferencesHash: hash, fingerprint: z.json(), ready: z.boolean(), missing: z.array(z.string()).max(5) }).parse(await this.rpc("attest_naming_brain_preferences", [row.projectId, row.preferencesVersion, row.preferencesHash, JSON.stringify(fingerprint), JSON.stringify(readiness)]));
      if (saved.projectId !== row.projectId || saved.preferencesVersion !== row.preferencesVersion || saved.preferencesHash !== row.preferencesHash || !isDeepStrictEqual(saved.fingerprint, fingerprint) || saved.ready !== readiness.ready || !isDeepStrictEqual(saved.missing, readiness.missing)) throw new Error("naming_attestation_mismatch");
      count++;
    }
    return count;
  }
  async reportReady(policy: NamingBrainPolicy, workerId: string) { return z.boolean().parse(await this.rpc("report_naming_brain_worker_ready", [JSON.stringify(policy), this.deploymentId, workerId, 60])); }
  async expireLeases(workerId: string) { return z.number().int().nonnegative().parse(await this.rpc("expire_naming_brain_leases", [workerId, this.deploymentId])); }
  async claim(workerId: string, leaseSeconds: number): Promise<ClaimedJob | null> {
    const raw = await this.rpc("claim_naming_brain_job", [workerId, this.deploymentId, leaseSeconds]); if (raw === null) return null;
    const parsed = z.object({ mode: z.enum(["execute", "observe_only"]), job: z.object({ billing_mode: z.literal("openai_api") }).passthrough() }).parse(raw);
    const job = parseClaimedJob(parsed.job); jobInput(job); if (!["running", "cancel_requested"].includes(job.status)) throw new Error("naming_claim_state_invalid"); if (parsed.mode === "observe_only") this.observedOnly.add(job.id); if (job.status === "cancel_requested") this.stoppedJobs.add(job.id); return job;
  }
  async heartbeat(job: ClaimedJob, leaseSeconds: number) {
    const raw = z.object({ recoveryMode: z.enum(["execute", "observe_only"]), observationDeadlineAt: z.iso.datetime({ offset: true }).nullable() }).passthrough().parse(await this.action(job, "heartbeat", { leaseSeconds }));
    const current = parseClaimedJob(raw);
    if (raw.recoveryMode === "observe_only") this.observedOnly.add(job.id);
    if (current.status === "cancel_requested") { this.stoppedJobs.add(job.id); for (const listener of this.cancellationListeners.get(job.id) ?? []) listener(); }
    if (current.id !== job.id || current.ownerId !== job.ownerId || current.projectId !== job.projectId || current.leaseToken !== job.leaseToken) throw new Error("naming_lease_mismatch");
    return { cancelled: current.status === "cancel_requested" && !this.observedOnly.has(job.id) };
  }
  async registerPlan(job: ClaimedJob, manifest: readonly PlannedStep[]) {
    try { await this.action(job, "plan", { manifest, gapEnvelope: NAMING_GAP_ENVELOPE }); }
    catch (error) { if (error instanceof Error && error.message === "plan_conflict") throw new PlanConflictError((await this.loadStages(job)).some(stage => stage.state === "succeeded")); throw error; }
  }
  async beginStep(job: ClaimedJob, stepKey: string, maximumCostMicrousd: number): Promise<"started" | "already_succeeded"> {
    const stageKey = namingStageKeySchema.parse(stepKey);
    const response = z.object({ disposition: z.enum(["started", "already_succeeded", "resume_observation"]) }).parse(await this.action(job, "begin", { stageKey, requestKey: namingHash([job.id, stageKey, "naming-brain-v1"]), maximumCostMicrousd }));
    // Handler must reload stage.recoveryMode before executing. Authorization refuses new creates in observe_only.
    return response.disposition === "already_succeeded" ? "already_succeeded" : "started";
  }
  async completeStep(job: ClaimedJob, stepKey: string, outcome: StepOutcome) {
    jobInput(job); namingStageKeySchema.parse(stepKey);
    if (outcome.costMicrousd !== 0) throw new Error("unverified_naming_expense");
    const result = completedOutputSchema.parse("result" in outcome && outcome.result ? outcome.result : { artifactIds: [], ...(outcome.status === "succeeded" ? {} : { errorCode: outcome.code }) });
    await this.rpc("complete_naming_brain_stage", [job.id, job.leaseToken, stepKey, outcome.status === "needs_reconciliation" ? "ambiguous" : outcome.status, JSON.stringify(result)]);
  }
  async finish(job: ClaimedJob, state: "succeeded" | "failed" | "partial" | "cancelled") {
    const lease = await this.heartbeat(job, 120); if (lease.cancelled || this.stoppedJobs.has(job.id)) state = "cancelled";
    await this.action(job, "finish", { state, errorCode: state === "failed" || state === "partial" ? "naming_incomplete" : null });
    this.observedOnly.delete(job.id); this.stoppedJobs.delete(job.id); this.cancellationListeners.delete(job.id);
  }
  async loadStage(job: ClaimedJob, stageKey: NamingStageKey): Promise<NamingSavedStage> {
    const input = jobInput(job), stage = stageSchema.parse(await this.action(job, "stage", { stageKey }));
    if (stage.stageKey !== stageKey || !isDeepStrictEqual(stage.gapEnvelope, NAMING_GAP_ENVELOPE) || stage.maximumCostMicrousd !== input.policy.stageLimits[stageKey].maximumCostMicrousd || [...stage.artifacts, ...stage.requests, ...stage.receipts].some(value => value.runId !== input.runId || value.snapshotHash !== input.snapshot.snapshotHash || value.stageKey !== stageKey)) throw new Error("naming_stage_mismatch");
    if (stage.stageResults.some(result => result.run_id !== input.runId || result.stage_key !== stageKey)) throw new Error("naming_stage_result_mismatch");
    if (stage.recoveryMode === "observe_only") this.observedOnly.add(job.id);
    return stage;
  }
  loadStages(job: ClaimedJob) { return Promise.all(namingStageKeySchema.options.map(key => this.loadStage(job, key))); }
  async saveCallPlan(job: ClaimedJob, stageKey: NamingStageKey, requests: readonly NamingStageRequest[], phase?: NamingGapPhase) {
    const calls = requests.map(request => ({ providerCallKey: request.providerCallKey, assignmentKey: request.assignmentKey, requestKey: request.requestKey, requestHash: request.requestHash, sessionLimitCents: request.policy.sessionLimitCents, maxWebSearchCalls: request.policy.maxWebSearchCalls, role: request.role }));
    const saved = await this.action(job, "call_plan", { stageKey, ...(phase ? { phase } : {}), calls });
    if (!isDeepStrictEqual(saved, calls)) throw new Error("naming_call_plan_mismatch");
  }
  cancellationRequested(job: ClaimedJob): boolean { return this.stoppedJobs.has(job.id); }
  onCancellation(job: ClaimedJob, callback: () => void): () => void {
    const listeners = this.cancellationListeners.get(job.id) ?? new Set<() => void>(); listeners.add(callback); this.cancellationListeners.set(job.id, listeners);
    if (this.stoppedJobs.has(job.id)) callback();
    return () => { listeners.delete(callback); if (!listeners.size) this.cancellationListeners.delete(job.id); };
  }
  async assertContinuation(job: ClaimedJob) {
    const heartbeat = await this.heartbeat(job, 120);
    if (heartbeat.cancelled || this.observedOnly.has(job.id) || this.stoppedJobs.has(job.id)) throw new Error("naming_observe_only");
  }
  async resumeExecution(job: ClaimedJob, stageKey: NamingStageKey): Promise<boolean> {
    const response = z.strictObject({ recoveryMode: z.enum(["execute", "observe_only"]), resumed: z.boolean() }).parse(await this.action(job, "resume_execution", { stageKey }));
    if (response.recoveryMode === "execute") this.observedOnly.delete(job.id);
    return response.recoveryMode === "execute";
  }
  async authorizeDispatch(job: ClaimedJob, request: NamingStageRequest) { if (await this.rpc("authorize_naming_brain_dispatch", [job.id, job.leaseToken, JSON.stringify(namingStageRequestSchema.parse(request))]) !== true) throw new Error("naming_dispatch_unavailable"); }
  async recordReceipt(job: ClaimedJob, receipt: NamingProviderReceipt) { const saved = await this.rpc("record_naming_brain_provider_receipt", [job.id, job.leaseToken, JSON.stringify(namingProviderReceiptSchema.parse(receipt))]); if (!isDeepStrictEqual(saved, receipt)) throw new Error("naming_receipt_mismatch"); }
  async saveProviderItem(job: ClaimedJob, record: unknown) {
    if (record && typeof record === "object" && "kind" in record && record.kind === "provider_turn") {
      const { kind: _kind, ...payload } = record; void _kind;
      await this.action(job, "provider_turn", providerTurnSchema.parse(payload));
    } else await this.action(job, "provider_item", providerItemSchema.parse(record));
  }
  async saveArtifact(job: ClaimedJob, artifact: NamingRoleOutput) { const saved = await this.action(job, "artifact", { artifact: namingRoleOutputSchema.parse(artifact) }); if (!isDeepStrictEqual(saved, artifact)) throw new Error("naming_artifact_mismatch"); }
  runtimePersistence(job: ClaimedJob): NamingRuntimePersistence {
    return { load: async identity => {
      const input = jobInput(job); if (identity.runId !== input.runId) throw new Error("naming_run_mismatch");
      const stages = await this.loadStages(job), stage = stages.find(value => value.stageKey === identity.stageKey)!;
      const request = stage.requests.find(value => value.providerCallKey === identity.providerCallKey) ?? null;
      if (!stage.startedAt || request && request.requestHash !== identity.requestHash) throw new Error("naming_call_state_mismatch");
      const supplied = namingStageRequestSchema.safeParse(identity);
      const desiredRequest = request ?? (supplied.success ? supplied.data : null);
      if (desiredRequest && (desiredRequest.runId !== input.runId || desiredRequest.snapshotHash !== input.snapshot.snapshotHash)) throw new Error("naming_request_scope_mismatch");
      const dependencies = stages.flatMap(value => value.artifacts).filter(artifact => desiredRequest?.dependencyArtifactIds.includes(artifact.artifactId));
      return { startedAt: stage.startedAt, observationDeadlineAt: stage.observationDeadlineAt, request, dependencies, providerItems: stage.providerItems as NamingProviderItemRecord[], toolResults: stage.toolResults as NamingToolResultRecord[] };
    }, saveToolResult: async record => { await this.action(job, "tool_result", toolResultSchema.parse(record)); } };
  }
  async identities(job: ClaimedJob, keys: readonly string[], signal: AbortSignal): Promise<string[]> {
    let cursor: string | null = null;
    for (let pages = 0; pages < 100_000; pages++) {
      if (signal.aborted) throw new Error("naming_index_cancelled");
      const page = z.object({ epoch: z.number().int().nonnegative(), entries: z.array(z.object({ candidateId: z.uuid(), value: z.string() })).max(500) }).parse(await this.action(job, "index_page", { afterId: cursor, limit: 500 }));
      if (!page.entries.length) { await this.action(job, "index_finalize", { epoch: page.epoch }); return z.array(z.string()).max(200).parse(await this.action(job, "identities", { keys: [...new Set(keys)] })); }
      await this.action(job, "index_record", { epoch: page.epoch, entries: page.entries.map(entry => ({ ...entry, identityKey: nameIdentityKey(entry.value) })) });
      const next = page.entries.at(-1)!.candidateId; if (next === cursor) throw new Error("naming_index_cursor_invalid"); cursor = next;
    }
    throw new Error("naming_index_incomplete");
  }
  async prepare(job: ClaimedJob, preparedSet: NamingPreparedSet, candidates: readonly NamingValidatedCandidate[], verification: NamingVerification) {
    const selected = new Set(preparedSet.candidateIds);
    return this.action(job, "prepare", { preparedSet, candidates: candidates.filter(candidate => selected.has(candidate.candidateId)).map(({ candidateId, sourceArtifactId, candidateKey, assignmentKey, identityKey, runId, snapshotHash }) => ({ candidateId, sourceArtifactId, candidateKey, assignmentKey, identityKey, runId, snapshotHash })), verification: { artifact: verification } });
  }
}
