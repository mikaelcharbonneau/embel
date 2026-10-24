import { retryLocalPersistence } from "../local-persistence-recovery";
import { isDeepStrictEqual } from "node:util";
import {
  namingBrainJobInputSchema, namingStageKeySchema, namingStageOutcomeSchema, validateNamingAssignmentPlan, validateNamingCreatorSet,
  createNamingReviewProjection, createNamingCurationProjection, applyNamingVerification,
  type NamingAgentRuntime, type NamingAssemblyInput, type NamingAssignmentPlan, type NamingBrainJobInput,
  type NamingCreatorSet, type NamingCandidateRejection, type NamingCuration, type NamingResearchPack, type NamingRoleOutput,
  type NamingProgressivePhase, type NamingStageInput, type NamingStageKey, type NamingStageOutcome, type NamingStageRequest, type NamingValidatedCandidate, type NamingVerification,
} from "../../src/domain/naming-brain";
import { assembleNamingSet, createNamingGapContext } from "../../src/domain/naming-brain-selection";
import type { ClaimedJob, StepOutcome } from "../../src/domain/jobs";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { allocateNamingCreatorCaps, createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { runNamingCreatorPool } from "../../src/server/ai/naming-brain/creator-pool";
import { namingSourceContext } from "../../src/server/ai/naming-brain/outputs";
import { NamingBrainJobStore, normalizeNamingStoredJson, type NamingGapPhase, type NamingSavedStage } from "../naming-brain-store";
import type { HandlerRegistry } from "../runner";
import { executeProgressiveNaming, hasSettledProgressiveDirectorFailure } from "./naming-progressive";

type Options = { store: NamingBrainJobStore; apiKey?: string;
  /** Retained for caller compatibility; process location grants no job authority. */
  localPrototype?: boolean;
  assertReady(): Promise<void>; runtime?: (job: ClaimedJob, input: NamingBrainJobInput) => NamingAgentRuntime };
const allCompleted = (outcomes: readonly NamingStageOutcome[]): boolean => outcomes.every(row => row.status === "completed");
const artifacts = (stages: readonly NamingSavedStage[]) => stages.flatMap(stage => stage.artifacts);
function one<T extends NamingRoleOutput>(rows: readonly NamingRoleOutput[], predicate: (row: NamingRoleOutput) => row is T): T {
  const matches = rows.filter(predicate); if (matches.length !== 1) throw new Error("naming_saved_dependency_missing"); return matches[0]!;
}
const isResearch = (row: NamingRoleOutput): row is NamingResearchPack => row.output.role === "researcher";
const isPlan = (row: NamingRoleOutput): row is NamingAssignmentPlan => row.output.role === "director";
const isCuration = (row: NamingRoleOutput): row is NamingCuration => row.output.role === "curator";
const isVerification = (row: NamingRoleOutput): row is NamingVerification => row.output.role === "verifier";

/** Rebuild from immutable artifacts and their original full authorized requests on every stage/restart. */
export function namingSavedCandidatePool(input: NamingBrainJobInput, stages: readonly NamingSavedStage[], includeGap: boolean) {
  const rows = artifacts(stages), research = one(rows, isResearch), candidates: NamingValidatedCandidate[] = [], rejections: NamingCandidateRejection[] = [];
  for (const stage of stages.filter(stage => stage.stageKey === "creation" || includeGap && stage.stageKey === "gap")) {
    for (const output of stage.artifacts.filter((row): row is NamingCreatorSet => row.output.role === "creator")) {
      const request = stage.requests.find(request => request.providerCallKey === output.providerReceipt.providerCallKey);
      if (!request || request.input.role !== "creator" || request.requestHash !== output.creatorAttribution.assignmentInputHash) throw new Error("naming_creator_request_missing");
      const creatorInput = request.input;
      if (!("planArtifactId" in creatorInput.assignment)) throw new Error("naming_legacy_assignment_missing");
      const planArtifactId = creatorInput.assignment.planArtifactId;
      const plan = one(rows.filter(row => row.artifactId === planArtifactId), isPlan);
      const planRequest = stages.flatMap(stage => stage.requests).find(request => request.providerCallKey === plan.providerReceipt.providerCallKey);
      if (!planRequest || planRequest.input.role !== "director") throw new Error("naming_director_request_missing");
      const assignment = validateNamingAssignmentPlan(input.snapshot, research, plan, planRequest.input.gapContext).find(row => row.assignmentKey === request.assignmentKey);
      if (!assignment || !isDeepStrictEqual(assignment, request.input.assignment)) throw new Error("naming_assignment_mismatch");
      const validated = validateNamingCreatorSet(input.snapshot, assignment, output);
      candidates.push(...validated.accepted); rejections.push(...validated.rejected);
    }
  }
  if (candidates.length + rejections.length > (includeGap ? 200 : 150)) throw new Error("naming_candidate_limit");
  return { candidates, rejections };
}

export function createNamingBrainHandlers(options: Options): HandlerRegistry {
  const { store } = options;
  const checkedInput = (job: ClaimedJob) => namingBrainJobInputSchema.parse(normalizeNamingStoredJson(job.input));
  const compatibilityExecution = (job: ClaimedJob) => store.hasUnmeteredExecutionAuthority(job);
  async function readiness(job: ClaimedJob) { await options.assertReady(); await store.assertContinuation(job); }
  // localPrototype is the retained provider-profile option, not runtime detection.
  // Only the exact database claim selects it for local or hosted-owned work.
  const runtime = (job: ClaimedJob, input: NamingBrainJobInput) => options.runtime?.(job, input) ?? createNamingAgentRuntime({ apiKey: options.apiKey, model: input.policy.model, localPrototype: compatibilityExecution(job), persistence: store.runtimePersistence(job), assertContinuation: () => readiness(job) });
  const request = (job: ClaimedJob, input: NamingBrainJobInput, stageKey: NamingStageKey, roleInput: NamingStageInput, dependencies: string[], cents?: number, searches?: number) => createNamingRoleRequest({ runId: input.runId, stageKey,
    providerCallKey: `${stageKey}-${roleInput.role}${roleInput.role === "creator" ? `-${roleInput.assignment.assignmentKey}` : ""}`, input: roleInput, dependencyArtifactIds: [...new Set(dependencies)], policy: createNamingRolePolicy(input.policy, stageKey, roleInput.role, cents, searches, compatibilityExecution(job), compatibilityExecution(job) && input.localTimingVersion === 2 ? 900_000 : 240_000) });

  function retainedLocalNoDispatch(job: ClaimedJob, stage: NamingSavedStage, desired: NamingStageRequest): NamingStageOutcome | null {
    if (!compatibilityExecution(job) || desired.policy.budgetControl !== "local_unlimited_v1"
      || stage.providerItems.some(row => row.providerCallKey === desired.providerCallKey) || stage.providerTurns.some(row => row.providerCallKey === desired.providerCallKey)
      || stage.toolResults.some(row => row.providerCallKey === desired.providerCallKey)) return null;
    const receipts = stage.receipts.filter(row => row.providerCallKey === desired.providerCallKey);
    if (receipts.some(row => row.dispatchState === "dispatched" || row.requestId !== null || row.sessionId !== null || row.turnId !== null || row.agentId !== null || row.responseId !== null
      || row.callIds.length || row.toolCalls.length || row.artifactItemIds.length || row.usageObservations.length || row.providerCostCounters.length)) return null;
    for (const result of stage.stageResults.filter(row => row.state === "failed")) for (const proof of result.output.partialArtifacts ?? []) {
      if (!proof || typeof proof !== "object" || Array.isArray(proof) || proof.providerCallKey !== desired.providerCallKey) continue;
      const parsed = namingStageOutcomeSchema.safeParse({ status: proof.status, code: proof.code, receipt: proof.receipt });
      if (!parsed.success || parsed.data.status !== "rejected_before_dispatch" || parsed.data.code !== "local_dispatch_not_attempted" || !parsed.data.receipt) continue;
      const receipt = parsed.data.receipt;
      if (receipt.requestHash === desired.requestHash && receipt.requestKey === desired.requestKey && receipt.runId === desired.runId && receipt.stageKey === desired.stageKey
        && receipt.providerCallKey === desired.providerCallKey && receipts.some(row => isDeepStrictEqual(row, receipt))) return parsed.data;
    }
    return null;
  }

  async function call(job: ClaimedJob, input: NamingBrainJobInput, desired: NamingStageRequest, signal: AbortSignal, phase?: NamingProgressivePhase): Promise<NamingStageOutcome> {
    const stage = phase ? (await store.loadProgressiveState(job, phase)).stage : await store.loadStage(job, desired.stageKey), saved = stage.requests.find(row => row.providerCallKey === desired.providerCallKey), output = stage.artifacts.find(row => row.providerReceipt.providerCallKey === desired.providerCallKey);
    if (saved && !isDeepStrictEqual(saved, desired)) throw new Error("naming_frozen_request_mismatch");
    if (output) return { status: "completed", receipt: output.providerReceipt, output };
    const retainedFailure = saved && retainedLocalNoDispatch(job, stage, saved); if (retainedFailure) return retainedFailure;
    const cancellation = new AbortController(), detachCancellation = store.onCancellation(job, () => cancellation.abort());
    const callSignal = AbortSignal.any([signal, cancellation.signal]);
    const agent = runtime(job, input), hooks = { signal: callSignal, beforeDispatch: async () => { await readiness(job); if (callSignal.aborted) throw new Error("naming_cancelled"); await store.authorizeDispatch(job, desired); }, onReceipt: (receipt: Parameters<typeof store.recordReceipt>[1]) => store.recordReceipt(job, receipt), onArtifact: (raw: unknown) => store.saveProviderItem(job, raw) };
    let outcome: NamingStageOutcome;
    try {
    if (saved) {
      const receipt = [...stage.receipts].reverse().find(row => row.providerCallKey === desired.providerCallKey);
      if (!receipt) return { status: "unresolved", code: "dispatch_identity_unknown", receipt: null, partialArtifacts: [] };
      outcome = await agent.resumeStage(receipt, hooks);
    } else {
      if (stage.recoveryMode !== "execute") return { status: "rejected_before_dispatch", code: "naming_observe_only" };
      outcome = await agent.runStage(desired, hooks);
    }
    if (outcome.status === "completed") { const output = outcome.output; await retryLocalPersistence(() => store.saveArtifact(job, output), callSignal, undefined, true); }
    return outcome;
    } finally { detachCancellation(); }
  }

  async function calls(job: ClaimedJob, input: NamingBrainJobInput, stageKey: NamingStageKey, desired: NamingStageRequest[], signal: AbortSignal, phase?: NamingGapPhase): Promise<NamingStageOutcome[]> {
    let stage = await store.loadStage(job, stageKey);
    // Observe every issued incomplete call before asking to unlock any original unissued allocation.
    const outcomes: NamingStageOutcome[] = [];
    const observeIssuedClosure = stage.recoveryMode === "observe_only";
    for (const issued of stage.requests.filter(row => !stage.artifacts.some(artifact => artifact.providerReceipt.providerCallKey === row.providerCallKey))) {
      const outcome = await call(job, input, issued, signal); outcomes.push(outcome);
      if (outcome.status !== "completed" && !observeIssuedClosure) return outcomes;
    }
    // A known invalid result is not permission to skip its issued siblings.
    // Aggregate the whole read-only closure, then return before any paid gate.
    if (!allCompleted(outcomes)) return outcomes;
    stage = await store.loadStage(job, stageKey);
    if (stage.recoveryMode === "observe_only" && desired.some(row => !stage.artifacts.some(artifact => artifact.providerReceipt.providerCallKey === row.providerCallKey))) {
      await options.assertReady();
      if (!await store.resumeExecution(job, stageKey)) return [...outcomes, { status: "rejected_before_dispatch", code: "naming_observe_only" }];
    }
    const remaining = desired.filter(row => !stage.artifacts.some(artifact => artifact.providerReceipt.providerCallKey === row.providerCallKey));
    if (!remaining.length) return outcomes;
    await store.saveCallPlan(job, stageKey, desired, phase);
    if (remaining[0]?.role === "creator") {
      const pooled = await runNamingCreatorPool(remaining.map(row => ({ assignmentKey: row.assignmentKey!, sessionLimitCents: row.policy.sessionLimitCents, execute: (signal: AbortSignal) => call(job, input, row, signal) })), { maximumTotalCents: stageKey === "gap" ? 40 : 150, localUnlimited: compatibilityExecution(job) && remaining.every(row => row.policy.budgetControl === "local_unlimited_v1"), signal, stopAfter: outcome => outcome.status !== "completed" });
      outcomes.push(...pooled.results.map(row => row.value));
      if (pooled.failures.length) outcomes.push({ status: "unresolved", code: "creator_execution_unknown", receipt: null, partialArtifacts: [] });
      else if (pooled.notStarted.length && allCompleted(outcomes)) outcomes.push({ status: "rejected_before_dispatch", code: "creator_pool_stopped" });
    } else for (const row of remaining) { const outcome = await call(job, input, row, signal); outcomes.push(outcome); if (outcome.status !== "completed") break; }
    return outcomes;
  }
  async function stepOutcome(job: ClaimedJob, stageKey: NamingStageKey, outcomes: NamingStageOutcome[], completeProgressive = false): Promise<StepOutcome> {
    const stage = await store.loadStage(job, stageKey);
    const blocking = completeProgressive ? outcomes.filter(outcome => !stage.requests.some(request => hasSettledProgressiveDirectorFailure(stage, request, outcome))) : outcomes;
    const bad = blocking.find(row => row.status === "unresolved") ?? blocking.find(row => row.status !== "completed");
    const invalidFailures = outcomes.flatMap(outcome => outcome.status === "failed" && outcome.code === "provider_output_invalid"
      ? [{ providerCallKey: outcome.receipt.providerCallKey, status: "failed" as const, code: "provider_output_invalid" as const, receipt: outcome.receipt }] : []);
    const noDispatchFailures = outcomes.flatMap(outcome => compatibilityExecution(job) && outcome.status === "rejected_before_dispatch" && outcome.code === "local_dispatch_not_attempted" && outcome.receipt
      ? [{ providerCallKey: outcome.receipt.providerCallKey, status: "rejected_before_dispatch" as const, code: "local_dispatch_not_attempted" as const, receipt: outcome.receipt }] : []);
    const terminalProof = (request: NamingStageRequest, statuses: readonly string[], exactReceipt?: NamingRoleOutput["providerReceipt"]) => stage.providerTurns.some(record =>
      record.providerCallKey === request.providerCallKey && statuses.includes(record.turn.status) && stage.receipts.some(receipt =>
        receipt.providerCallKey === request.providerCallKey && receipt.requestHash === request.requestHash && receipt.requestKey === request.requestKey && receipt.dispatchState === "dispatched" && receipt.sessionId === record.sessionId && receipt.turnId === record.turnId && receipt.agentId === record.turn.agent_id && (!exactReceipt || isDeepStrictEqual(exactReceipt, receipt))));
    const overrun = stage.receipts.some(receipt => (receipt.providerSpendCapCents !== undefined || receipt.budgetControl !== "local_unlimited_v1") && receipt.providerCostCounters.some(counter => counter.kind === "consumed_usd_cents" && counter.value > receipt.sessionLimitCents));
    const handledGap = stageKey === "gap" && bad && !store.cancellationRequested(job) && !overrun && outcomes.every(row => row.status !== "unresolved") && stage.requests.every(request =>
      stage.artifacts.some(artifact => artifact.providerReceipt.providerCallKey === request.providerCallKey && terminalProof(request, ["completed"], artifact.providerReceipt)) ||
      terminalProof(request, ["failed", "cancelled"]) || invalidFailures.some(failure => failure.providerCallKey === request.providerCallKey && terminalProof(request, ["completed"], failure.receipt)));
    const rejectedCall = (request: NamingStageRequest) => {
      const receipts = stage.receipts.filter(receipt => receipt.providerCallKey === request.providerCallKey);
      const last = receipts.at(-1);
      if (request.policy.budgetControl === "local_unlimited_v1" && noDispatchFailures.some(proof => proof.providerCallKey === request.providerCallKey
        && proof.receipt.requestHash === request.requestHash && proof.receipt.requestKey === request.requestKey && isDeepStrictEqual(proof.receipt, last))
        && receipts.every(receipt => receipt.dispatchState !== "dispatched" && receipt.requestId === null && receipt.sessionId === null && receipt.turnId === null
          && receipt.agentId === null && receipt.responseId === null && !receipt.callIds.length && !receipt.toolCalls.length && !receipt.artifactItemIds.length
          && !receipt.usageObservations.length && !receipt.providerCostCounters.length)
        && !stage.providerTurns.some(record => record.providerCallKey === request.providerCallKey) && !stage.providerItems.some(record => record.providerCallKey === request.providerCallKey)
        && !stage.toolResults.some(record => record.providerCallKey === request.providerCallKey)) return true;
      // A durable authorization alone is not proof of dispatch. An explicit
      // transport rejection plus its exact retained no-dispatch receipt is a
      // known failure. Missing/unknown/dispatched evidence remains quarantined.
      return bad?.status === "rejected_before_dispatch" && bad.code === "provider_request_rejected" && last?.dispatchState === "not_dispatched"
        && last.requestId !== null && /^req_[A-Za-z0-9_-]{1,196}$/u.test(last.requestId)
        && last.requestHash === request.requestHash && last.requestKey === request.requestKey && last.sessionId === null && last.turnId === null
        && receipts.every(receipt => receipt.dispatchState === "not_dispatched")
        && !stage.providerTurns.some(record => record.providerCallKey === request.providerCallKey);
    };
    const ambiguous = bad?.status === "unresolved" || bad?.status === "rejected_before_dispatch" && stage.requests.some(request => !stage.artifacts.some(artifact => artifact.providerReceipt.providerCallKey === request.providerCallKey) && !rejectedCall(request) && !stage.providerTurns.some(record => record.providerCallKey === request.providerCallKey));
    const providerFailures = outcomes.flatMap(row => row.status === "rejected_before_dispatch" && row.failure ? [{ type: "provider_failure", ...row.failure }] : []);
    const result = { artifactIds: stage.artifacts.map(row => row.artifactId), ...(bad ? { errorCode: handledGap ? "gap_incomplete" : bad.code, partialArtifacts: [...invalidFailures, ...noDispatchFailures, ...providerFailures, ...outcomes.flatMap(row => "partialArtifacts" in row ? row.partialArtifacts : []).slice(-3)] } : completeProgressive && invalidFailures.length ? { partialArtifacts: invalidFailures } : {}) };
    // This is the verified-known subtotal (none). It is never a certified total expense.
    return bad && !handledGap ? { status: ambiguous ? "needs_reconciliation" : "failed", code: bad.code, costMicrousd: 0, providerRequestId: "receipt" in bad ? bad.receipt?.requestId ?? null : null, result }
      : { status: "succeeded", costMicrousd: 0, providerRequestId: null, result };
  }
  async function assembly(job: ClaimedJob, input: NamingBrainJobInput, stages: NamingSavedStage[], gap: boolean, signal: AbortSignal): Promise<NamingAssemblyInput> {
    const pool = namingSavedCandidatePool(input, stages, gap), rows = artifacts(stages), curation = one(rows.filter(row => row.stageKey === (gap ? "gap" : "curation")), isCuration), verification = one(rows.filter(row => row.stageKey === (gap ? "gap" : "verification")), isVerification);
    const verificationRequest = stages.flatMap(stage => stage.requests).find(row => row.providerCallKey === verification.providerReceipt.providerCallKey);
    if (!verificationRequest) throw new Error("naming_verification_request_missing");
    return { snapshot: input.snapshot, candidates: pool.candidates, curation, verification: applyNamingVerification(pool.candidates, verification, namingSourceContext(verificationRequest, rows)), existingIdentityKeys: await store.identities(job, pool.candidates.map(row => row.identityKey), signal) };
  }
  async function prepare(job: ClaimedJob, input: NamingBrainJobInput, signal: AbortSignal) {
    // A committed preparation is already part of global duplicate history. Its
    // leased immutable acknowledgement must precede any fresh index/assembly.
    const saved = await store.loadStage(job, "prepare");
    if (saved.preparation) return;
    const stages = await store.loadStages(job), gap = stages.find(stage => stage.stageKey === "gap")!.artifacts.some(isVerification), data = await assembly(job, input, stages, gap, signal), prepared = assembleNamingSet(data);
    await store.prepare(job, prepared, data.candidates, data.verification.artifact);
  }
  async function execute(job: ClaimedJob, stageKey: NamingStageKey, signal: AbortSignal): Promise<StepOutcome> {
    const input = checkedInput(job), snapshot = input.snapshot;
    try {
      if (input.localPipelineVersion === 2) {
        if (!compatibilityExecution(job)) throw new Error("naming_progressive_unavailable");
        if (stageKey === "prepare") { await store.finalizeProgressive(job); return stepOutcome(job, stageKey, []); }
        if (stageKey !== "creation") throw new Error("naming_progressive_stage_invalid");
        const result = await executeProgressiveNaming({ job, input, store, signal, call: (request, phase, callSignal) => call(job, input, request, callSignal, phase) });
        if (!result.complete && allCompleted(result.outcomes)) result.outcomes.push({ status: "rejected_before_dispatch", code: "naming_progressive_incomplete" });
        return stepOutcome(job, stageKey, result.outcomes, result.complete);
      }
      let stages = await store.loadStages(job), rows = artifacts(stages);
      if (stageKey === "prepare") { await prepare(job, input, signal); return stepOutcome(job, stageKey, []); }
      if (stageKey === "research") return stepOutcome(job, stageKey, await calls(job, input, stageKey, [request(job, input, stageKey, { role: "researcher", snapshot }, [])], signal));
      const research = one(rows, isResearch);
      if (research.readiness !== "sourced" && !(compatibilityExecution(job) && research.readiness === "partial" && research.providerReceipt.budgetControl === "local_unlimited_v1")) throw new Error("naming_research_incomplete");
      if (stageKey === "direction") return stepOutcome(job, stageKey, await calls(job, input, stageKey, [request(job, input, stageKey, { role: "director", snapshot, research }, [research.artifactId])], signal));
      const creation = async (key: "creation" | "gap", plan: NamingAssignmentPlan, gapContext?: Parameters<typeof validateNamingAssignmentPlan>[3]) => {
        const assignments = validateNamingAssignmentPlan(snapshot, research, plan, gapContext), caps = allocateNamingCreatorCaps(assignments.map(row => row.targetCount), key === "gap" ? 40 : 150);
        return calls(job, input, key, assignments.map((assignment, index) => request(job, input, key, { role: "creator", snapshot, assignment }, [research.artifactId, plan.artifactId], caps[index], 0)), signal, key === "gap" ? "creation" : undefined);
      };
      if (stageKey === "creation") return stepOutcome(job, stageKey, await creation(stageKey, one(rows.filter(row => row.stageKey === "direction"), isPlan)));
      const review = async (key: "curation" | "verification" | "gap", role: "curator" | "verifier") => {
        const saved = await store.loadStages(job), all = artifacts(saved), pool = namingSavedCandidatePool(input, saved, key === "gap"), projection = createNamingReviewProjection({ runId: input.runId, snapshotHash: snapshot.snapshotHash, candidates: pool.candidates });
        const dependencies = [...new Set(pool.candidates.map(row => row.sourceArtifactId)), research.artifactId];
        if (role === "curator") return calls(job, input, key, [request(job, input, key, { role, snapshot, review: projection, validationRejections: pool.rejections }, dependencies, key === "gap" ? 5 : undefined, 0)], signal, key === "gap" ? "curation" : undefined);
        const curation = one(all.filter(row => row.stageKey === (key === "gap" ? "gap" : "curation")), isCuration);
        const priorVerification = key === "gap" ? one(all.filter(row => row.stageKey === "verification"), isVerification) : null;
        return calls(job, input, key, [request(job, input, key, { role, snapshot, review: projection, curation: createNamingCurationProjection(curation) }, [...dependencies, curation.artifactId, ...(priorVerification ? [priorVerification.artifactId] : [])], key === "gap" ? 20 : undefined, key === "gap" ? 8 : undefined)], signal, key === "gap" ? "verification" : undefined);
      };
      if (stageKey === "curation" || stageKey === "verification") return stepOutcome(job, stageKey, await review(stageKey, stageKey === "curation" ? "curator" : "verifier"));
      const savedDirection = stages.find(stage => stage.stageKey === "gap")!.requests.find(row => row.role === "director");
      let gapRequest: NamingStageRequest;
      if (savedDirection) gapRequest = savedDirection;
      else {
        const data = await assembly(job, input, stages, false, signal);
        if (assembleNamingSet(data).fulfillment.status === "complete") return stepOutcome(job, stageKey, []);
        const gapContext = createNamingGapContext(data);
        gapRequest = request(job, input, "gap", { role: "director", snapshot, research, gapContext }, [research.artifactId, gapContext.curationArtifactId, gapContext.verificationArtifactId, ...gapContext.sourceArtifactIds], 10, 0);
      }
      const outcomes = await calls(job, input, "gap", [gapRequest], signal, "direction");
      if (allCompleted(outcomes)) {
        stages = await store.loadStages(job); rows = artifacts(stages);
        outcomes.push(...await creation("gap", one(rows.filter(row => row.stageKey === "gap"), isPlan), gapRequest.input.role === "director" ? gapRequest.input.gapContext : undefined));
      }
      if (allCompleted(outcomes)) outcomes.push(...await review("gap", "curator"));
      if (allCompleted(outcomes)) outcomes.push(...await review("gap", "verifier"));
      return stepOutcome(job, stageKey, outcomes);
    } catch {
      // A local validation error cannot recreate an authorized request. Durable state
      // decides whether this is a pre-dispatch rejection or unresolved provider work.
      const stage = await store.loadStage(job, stageKey);
      const unresolved = stage.requests.some(row => !stage.artifacts.some(artifact => artifact.providerReceipt.providerCallKey === row.providerCallKey));
      return stepOutcome(job, stageKey, [unresolved ? { status: "unresolved", code: "naming_stage_incomplete", receipt: null, partialArtifacts: [] } : { status: "rejected_before_dispatch", code: "naming_stage_invalid" }]);
    }
  }
  function stageTimeout(job: ClaimedJob, input: NamingBrainJobInput, key: NamingStageKey) {
    if (!compatibilityExecution(job) || key === "prepare") return 270_000;
    if (key === "creation" || key === "gap") return 3_600_000;
    return input.localTimingVersion === 2 ? 1_200_000 : 270_000;
  }
  return new Map([["naming.generate", { steps(job: ClaimedJob) { const input = checkedInput(job); const keys = input.localPipelineVersion === 2 ? ["creation", "prepare"] as const : namingStageKeySchema.options; return keys.map(key => ({ key, maximumCostMicrousd: input.policy.stageLimits[key].maximumCostMicrousd, timeoutMs: stageTimeout(job, input, key), execute: ({ job, signal }: { job: ClaimedJob; signal: AbortSignal }) => execute(job, key, signal) })); } }]]);
}
