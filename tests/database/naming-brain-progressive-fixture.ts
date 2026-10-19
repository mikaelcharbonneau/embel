import { createHash } from "node:crypto";
import { namingBrainJobInputSchema, namingRoleOutputSchema, namingProviderReceiptSchema, namingCreatorSetSchema, namingCurationSchema, namingEvidenceSourceSchema, createNamingReviewProjection, validateNamingCreatorSet,
 type NamingStageInput, type NamingStageRequest, type NamingProgressivePhase, type NamingRoleOutput } from "../../src/domain/naming-brain";
import { createNamingMicrobatch } from "../../src/domain/naming-brain-progressive";
import type { NamingApproach } from "../../src/domain/naming-brain-preferences";
import { guidedStrategyPolicy } from "../../src/server/ai/config";
import { createProgressiveNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { createProgressiveNamingAssignment, progressivePartKey } from "../../src/server/ai/naming-brain/progressive-assignments";
import { NamingBrainJobStore, normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import { OWNER_A, type TestDatabase } from "./local-supabase";
import { attestBrainPreferences, brainPreferences, brainRpc, brainWorker, initialIntent, seedBrainFixture } from "./naming-brain-fixture";
import { historicalNamingClaimDatabase } from "./naming-brain-historical-claim";

/** Synthetic provider evidence only. Every plan, authorization, receipt, original
 * item, terminal turn, artifact and publication uses the restricted SQL gateway. */
export async function seedProgressiveFixture(db: TestDatabase, approaches: NamingApproach[] = ["real_words", "compounds", "invented"]) {
 const project = await seedBrainFixture(db), policy = guidedStrategyPolicy("strategy.reformulate");
 await db.query("insert into fluid_private.strategy_runtime_policy(operation,enabled,policy) values('strategy.reformulate',true,$1) on conflict(operation) do update set enabled=true,policy=excluded.policy", [policy]);
 await db.query("insert into fluid_private.local_prototype_strategy_capabilities(owner_id,operation,role_name,role_oid,deployment_id,policy,enabled,ready_until) select $1,'strategy.reformulate',rolname,oid,'fixture-deployment',$2,true,clock_timestamp()+interval '90 seconds' from pg_roles where rolname='fixture_naming_brain_a'", [OWNER_A, policy]);
 if (JSON.stringify(approaches) !== JSON.stringify(brainPreferences.approaches)) {
  await brainRpc(db, "save_naming_preferences", [project, 1, { ...brainPreferences, approaches }]); await attestBrainPreferences(db);
 }
 const intent = { ...initialIntent("synthetic-progressive-initial"), expectedPreferencesVersion: approaches.length === 1 && approaches[0] === "real_words" ? 1 : 2 };
 const admission = await brainRpc(db, "ensure_local_naming_brain_run", [project, intent]);
 const store = new NamingBrainJobStore(await historicalNamingClaimDatabase(db), "fixture-deployment");
 const job = await brainWorker(db, () => store.claim("fixture-worker", 120)); if (!job) throw Error("synthetic_progressive_job_missing");
 const input = namingBrainJobInputSchema.parse(normalizeNamingStoredJson(job.input));
 await brainWorker(db, () => store.registerPlan(job, [{ key: "creation", maximumCostMicrousd: 1_500_000 }, { key: "prepare", maximumCostMicrousd: 0 }]));
 await brainWorker(db, () => store.beginStep(job, "creation", 1_500_000));
 return { db, project, store, job, input, intent, admission };
}
export type ProgressiveFixture = Awaited<ReturnType<typeof seedProgressiveFixture>>;
export function progressiveRequest(fixture: ProgressiveFixture, phase: NamingProgressivePhase, input: NamingStageInput, dependencies: string[] = []) {
 return createNamingRoleRequest({ runId: fixture.input.runId, stageKey: "creation", providerCallKey: `${phase}.${input.role}`, input,
  dependencyArtifactIds: dependencies, policy: createProgressiveNamingRolePolicy(fixture.input.policy, input.role, undefined, undefined, true) });
}
export async function recordProgressiveOutput(fixture: ProgressiveFixture, phase: NamingProgressivePhase, request: NamingStageRequest, output: unknown, extra: Record<string, unknown> = {}, externalAttempt = false) {
 const { db, store, job, input } = fixture, suffix = request.providerCallKey.replaceAll(".", "_"), sessionId = `sess_${suffix}`, turnId = `turn_${suffix}`, itemId = `item_${suffix}`, agentId = `agent_${suffix}`;
 const text = JSON.stringify(output);
 await brainWorker(db, () => store.saveProgressiveCallPlan(job, phase, [request]));
 await brainWorker(db, () => store.authorizeDispatch(job, request));
 const receipt = namingProviderReceiptSchema.parse({ version: 1, provider: "openai", billingMode: "openai_api", protocol: "openai_agents", budgetControl: "local_unlimited_v1", localPipelineVersion: 2,
  runId: input.runId, stageKey: "creation", role: request.role, snapshotHash: input.snapshot.snapshotHash,
  providerCallKey: request.providerCallKey, assignmentKey: request.assignmentKey, requestKey: request.requestKey, requestHash: request.requestHash, sessionLimitCents: request.policy.sessionLimitCents,
  dispatchState: "dispatched", requestId: `req_${suffix}`, sessionId, turnId, agentId, responseId: null, callIds: [], observedModel: input.policy.model,
  toolCalls: externalAttempt ? [{ callId: `search_${suffix}`, providerItemId: `web_${suffix}`, type: "web_search", status: "completed" }] : [], artifactItemIds: [itemId], usageObservations: [], estimatedCostMicrousd: null,
  providerCostCounters: [], accountingStatus: "provisional", confirmedActualCostMicrousd: null, recordedAt: "2026-10-18T10:00:00Z" });
 await brainWorker(db, () => store.recordReceipt(job, receipt));
 if (externalAttempt) await brainWorker(db, () => store.saveProviderItem(job, { providerCallKey: request.providerCallKey, sessionId, turnId, itemId: `web_${suffix}`,
  item: { id: `web_${suffix}`, type: "web_search_call", status: "completed", turn_id: turnId, action: { type: "search", query: "synthetic fixture research" } } }));
 if (Array.isArray(extra.sources)) for (const rawSource of extra.sources) {
  const source = namingEvidenceSourceSchema.parse(rawSource);
  await brainWorker(db, () => store.runtimePersistence(job).saveToolResult({ providerCallKey: request.providerCallKey, sessionId, turnId, callId: `read_${source.sourceKey}`, requestHash: request.requestHash,
   result: { argumentsHash: createHash("sha256").update(source.url).digest("hex"), reply: { type: "agent.session.input.tool_result", turn_id: turnId, call_id: `read_${source.sourceKey}`, success: true, output: JSON.stringify(source) } }, sourceEvidence: source }));
 }
 await brainWorker(db, () => store.saveProviderItem(job, { providerCallKey: request.providerCallKey, sessionId, turnId, itemId,
  item: { id: itemId, type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: turnId, content: [{ type: "output_text", text }] } }));
 await brainWorker(db, () => store.saveProviderItem(job, { kind: "provider_turn", providerCallKey: request.providerCallKey, sessionId, turnId,
  turn: { id: turnId, session_id: sessionId, agent_id: agentId, subagent_id: null, object: "agent.session.turn", status: "completed", created_at: 1, started_at: 1, completed_at: 2, error: null, usage: null } }));
 return { artifactId: crypto.randomUUID(), runId: input.runId, stageKey: "creation", snapshotHash: input.snapshot.snapshotHash, schemaVersion: 1, promptVersion: "naming-brain-v1", providerReceipt: receipt, output,
  ...(request.role === "creator" ? { creatorAttribution: { protocol: "openai_agents", executionKind: "independent_session", assignmentKey: request.assignmentKey, assignmentInputHash: request.requestHash,
   sessionId, turnId, responseId: null, subagentId: null, itemId, itemContentHash: createHash("sha256").update(text).digest("hex") } } : {}), ...extra };
}
export async function saveProgressiveOutput(fixture: ProgressiveFixture, phase: NamingProgressivePhase, request: NamingStageRequest, output: unknown, extra: Record<string, unknown> = {}, externalAttempt = false): Promise<NamingRoleOutput> {
 const artifact = namingRoleOutputSchema.parse(await recordProgressiveOutput(fixture, phase, request, output, extra, externalAttempt));
 await brainWorker(fixture.db, () => fixture.store.saveArtifact(fixture.job, artifact)); return artifact;
}
export async function saveProgressiveResearch(fixture: ProgressiveFixture, externalAttempt = true) {
 const request = progressiveRequest(fixture, "context.research", { role: "researcher", snapshot: fixture.input.snapshot });
 return saveProgressiveOutput(fixture, "context.research", request, { role: "researcher", territories: [
  { territoryId: "synthetic-nature", title: "Synthetic nature", direction: "An imaginative natural association.", sourceKeys: [] },
  { territoryId: "synthetic-sound", title: "Synthetic sound", direction: "An imaginative sound association.", sourceKeys: [] },
 ], facts: [], interpretations: [], uncertainties: ["The synthetic external attempt returned no retrieved evidence."] }, { readiness: "partial", sources: [] }, externalAttempt);
}
export async function saveProgressivePart(fixture: ProgressiveFixture, index: number, count = 6, approach: NamingApproach = "real_words", options: { values?: string[]; claim?: boolean } = {}) {
 const key = progressivePartKey(index), assignment = createProgressiveNamingAssignment({ runId: fixture.input.runId, snapshot: fixture.input.snapshot, partIndex: index, approach, targetCount: count });
 const creatorRequest = progressiveRequest(fixture, `${key}.creation`, { role: "creator", snapshot: fixture.input.snapshot, assignment });
 const proposals = Array.from({ length: count }, (_, i) => ({ candidateKey: `candidate-${i}`, value: options.values?.[i] ?? `Synthetic${index}Name${i}`, primaryApproach: approach, additionalApproaches: [],
  territoryId: assignment.territoryId, constructionKey: assignment.constructionKey, rationale: "Synthetic imaginative association.", caution: null, claims: options.claim ? [{ claimKey: "synthetic-claim", requirement: "optional", statement: "An unsupported synthetic factual explanation.", sourceKeys: [], status: "unverified" }] : [] }));
 const creator = namingCreatorSetSchema.parse(await saveProgressiveOutput(fixture, `${key}.creation`, creatorRequest, { role: "creator", assignmentKey: assignment.assignmentKey, candidates: proposals },
  { candidateIds: proposals.map(proposal => ({ candidateKey: proposal.candidateKey, candidateId: crypto.randomUUID() })) }));
 const candidates = validateNamingCreatorSet(fixture.input.snapshot, assignment, creator).accepted;
 const curatorRequest = progressiveRequest(fixture, `${key}.curation`, { role: "curator", snapshot: fixture.input.snapshot,
  review: createNamingReviewProjection({ runId: fixture.input.runId, snapshotHash: fixture.input.snapshot.snapshotHash, candidates }), validationRejections: [] }, [creator.artifactId]);
 const curation = namingCurationSchema.parse(await saveProgressiveOutput(fixture, `${key}.curation`, curatorRequest, { role: "curator", annotations: [], gaps: [] }));
 const publication = options.claim ? null : createNamingMicrobatch({ key, snapshot: fixture.input.snapshot, candidates, curation });
 return { key, assignment, creatorRequest, creator, candidates, curatorRequest, curation, publication };
}
