import { LocalNamingFailure, reportNamingFailure, retryLocalPersistence } from "../local-persistence-recovery";
import { isDeepStrictEqual } from "node:util";
import { createNamingCurationProjection, createNamingReviewProjection, namingAssignmentPlanSchema, namingCreatorSetSchema, namingCurationSchema, namingResearchPackSchema, namingVerificationSchema, validateNamingCreatorSet,
  type NamingBrainJobInput, type NamingMicrobatchInput, type NamingProgressiveAssignment, type NamingProgressivePhase, type NamingResearchPack, type NamingAssignmentPlan,
  type NamingStageInput, type NamingStageOutcome, type NamingStageRequest } from "../../src/domain/naming-brain";
import { createNamingMicrobatch } from "../../src/domain/naming-brain-progressive";
import type { NamingApproach } from "../../src/domain/naming-brain-preferences";
import type { ClaimedJob } from "../../src/domain/jobs";
import { createBudgetedProgressiveNamingRolePolicy, createProgressiveNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { namingSourceContext } from "../../src/server/ai/naming-brain/outputs";
import { chooseProgressiveNamingApproach, createProgressiveNamingAssignment, PROGRESSIVE_CREATIVE_APPROACHES, PROGRESSIVE_PART_LIMIT, PROGRESSIVE_RAW_LIMIT, progressivePartKey } from "../../src/server/ai/naming-brain/progressive-assignments";
import { namingLatestReceipt, type NamingBrainJobStore, type NamingSavedStage } from "../naming-brain-store";

type Options = {
  job: ClaimedJob; input: NamingBrainJobInput; store: Pick<NamingBrainJobStore, "loadProgressiveState" | "resumeExecution" | "saveProgressiveCallPlan" | "publishMicrobatch">; signal: AbortSignal;
  call(request: NamingStageRequest, phase: NamingProgressivePhase, signal: AbortSignal): Promise<NamingStageOutcome>;
};
const partOf = (key: string) => /^part[0-9]{3}(?=\.)/u.exec(key)?.[0] ?? null;
const callKey = (phase: string, role: NamingStageInput["role"]) => `${phase}.${role}`;

/** Failed optional guidance is distinct from an unknown provider outcome. The
 * exact retained receipt and genuine terminal Turn remain the authority. */
export function hasSettledProgressiveDirectorFailure(stage: NamingSavedStage, request: NamingStageRequest, outcome: NamingStageOutcome): boolean {
  if (request.role !== "director" || request.stageKey !== "creation" || request.policy.localPipelineVersion !== 2 || request.policy.budgetControl !== "local_unlimited_v1"
    || outcome.status !== "failed" && outcome.status !== "cancelled") return false;
  const receipt = outcome.receipt, status = outcome.status === "cancelled" ? "cancelled" : outcome.code === "provider_output_invalid" ? "completed" : "failed";
  return receipt.localPipelineVersion === 2 && receipt.budgetControl === "local_unlimited_v1" && receipt.dispatchState === "dispatched"
    && receipt.runId === request.runId && receipt.snapshotHash === request.snapshotHash && receipt.stageKey === request.stageKey && receipt.role === request.role
    && receipt.requestHash === request.requestHash && receipt.requestKey === request.requestKey && receipt.providerCallKey === request.providerCallKey
    && stage.requests.some(saved => isDeepStrictEqual(saved, request)) && isDeepStrictEqual(namingLatestReceipt(stage, request.providerCallKey), receipt)
    && stage.providerTurns.some(record => record.providerCallKey === request.providerCallKey && record.sessionId === receipt.sessionId && record.turnId === receipt.turnId
      && record.turn.agent_id === receipt.agentId && record.turn.status === status);
}

/** One admitted logical exploration, with independent reviewed pages as they finish. */
export async function executeProgressiveNaming(options: Options): Promise<{ outcomes: NamingStageOutcome[]; complete: boolean }> {
  const { job, input, store, signal } = options, snapshot = input.snapshot;
  const initial = await store.loadProgressiveState(job);
  const outcomes: NamingStageOutcome[] = [];
  const planned = new Map(initial.plannedRequests.map(request => [request.providerCallKey, request]));
  // Authorization is authoritative over its earlier acknowledged full plan.
  for (const request of initial.stage.requests) planned.set(request.providerCallKey, request);
  const completed = new Map(initial.stage.artifacts.map(artifact => [artifact.providerReceipt.providerCallKey, artifact]));
  let blocked = false, publishedCount = initial.publishedCount, primaryCounts = initial.primaryCounts;
  const publications = new Set(initial.publications.map(publication => publication.key));
  const inFlight = new Map<string, NamingProgressiveAssignment>();
  let research: NamingResearchPack | undefined, guidance: NamingAssignmentPlan | undefined;
  const refreshContext = () => {
    const pack = completed.get(callKey("context.research", "researcher")), plan = completed.get(callKey("context.direction", "director"));
    if (pack) research = namingResearchPackSchema.parse(pack);
    if (plan) guidance = namingAssignmentPlanSchema.parse(plan);
  };
  refreshContext();

  async function optionalFailureSettled(request: NamingStageRequest, outcome: NamingStageOutcome) {
    return request.role === "director" && hasSettledProgressiveDirectorFailure((await store.loadProgressiveState(job, "context.direction")).stage, request, outcome);
  }

  async function invoke(request: NamingStageRequest, phase: NamingProgressivePhase): Promise<NamingStageOutcome | null> {
    const saved = completed.get(request.providerCallKey);
    if (saved) return { status: "completed", receipt: saved.providerReceipt, output: saved };
    if (blocked || signal.aborted) return null;
    const outcome = await options.call(request, phase, signal);
    outcomes.push(outcome);
    if (outcome.status === "completed") completed.set(request.providerCallKey, outcome.output);
    else if (!await optionalFailureSettled(request, outcome)) blocked = true;
    return outcome;
  }
  async function freezeRequest(phase: NamingProgressivePhase, role: NamingStageInput["role"], build: () => { input: NamingStageInput; dependencies: string[] }): Promise<NamingStageRequest> {
    const key = callKey(phase, role), saved = planned.get(key);
    if (saved) {
      if (saved.role !== role || saved.stageKey !== "creation" || saved.policy.localPipelineVersion !== 2) throw new Error("progressive_saved_request_mismatch");
      return saved;
    }
    try {
    const value = build();
    const request = createNamingRoleRequest({ runId: input.runId, stageKey: "creation", providerCallKey: key, input: value.input,
      dependencyArtifactIds: [...new Set(value.dependencies)], policy: input.providerBudgetVersion === 1 ? createBudgetedProgressiveNamingRolePolicy(input.policy, role) : createProgressiveNamingRolePolicy(input.policy, role, undefined, undefined, true, 3) });
    await retryLocalPersistence(() => store.saveProgressiveCallPlan(job, phase, [request]), signal);
    planned.set(key, request);
    return request;
    } catch (error) { throw new LocalNamingFailure("planning", error); }
  }

  // Recover every issued sibling before any new provider authorization. A missing
  // Session identity stays quarantined; publishing 100 names cannot erase it.
  for (const request of initial.stage.requests.filter(request => !completed.has(request.providerCallKey))) {
    const phase = initial.stage.callPlans.find(plan => plan.calls.some(call => call.providerCallKey === request.providerCallKey))?.phase;
    if (!phase) throw new Error("progressive_saved_phase_missing");
    const outcome = await options.call(request, phase, signal); outcomes.push(outcome);
    if (outcome.status === "completed") completed.set(request.providerCallKey, outcome.output); else if (!await optionalFailureSettled(request, outcome)) blocked = true;
  }
  refreshContext();
  if (blocked || signal.aborted) return { outcomes, complete: false };
  if (initial.stage.recoveryMode === "observe_only" && publishedCount < 100 && !await store.resumeExecution(job, "creation")) return { outcomes: [...outcomes, { status: "rejected_before_dispatch", code: "naming_observe_only" }], complete: false };

  const existingParts = [...new Set([...planned.keys()].flatMap(key => partOf(key) ?? []))].sort();
  const replay = existingParts.filter(key => !publications.has(key));
  let nextPartIndex = existingParts.reduce((maximum, key) => Math.max(maximum, Number(key.slice(4))), 0);
  let plannedRaw = [...planned.values()].filter(request => request.input.role === "creator").reduce((sum, request) => sum + (request.input.role === "creator" ? request.input.assignment.targetCount : 0), 0);
  let contextDone = false;

  async function contextWork() {
    if (publishedCount >= 100) return;
    const request = await freezeRequest("context.research", "researcher", () => ({ input: { role: "researcher", snapshot }, dependencies: [] }));
    const outcome = await invoke(request, "context.research");
    if (outcome?.status !== "completed") return;
    research = namingResearchPackSchema.parse(outcome.output);
    // A completed logical target is not permission for another unnecessary call.
    if (blocked || signal.aborted || publishedCount >= 100) return;
    const direction = await freezeRequest("context.direction", "director", () => ({ input: { role: "director", snapshot, research: research! }, dependencies: [research!.artifactId] }));
    const result = await invoke(direction, "context.direction");
    if (result?.status === "completed") guidance = namingAssignmentPlanSchema.parse(result.output);
  }
  function recordFailure(error: unknown, fallback: string) {
    blocked = true;
    reportNamingFailure(error, fallback);
    // Planning never dispatches. Other already issued branches drain below and
    // retain their own evidence; the DB still refuses to settle unknown calls.
    outcomes.push(error instanceof LocalNamingFailure && error.phase === "planning"
      ? { status: "rejected_before_dispatch", code: "local_planning_failed" }
      : { status: "unresolved", code: error instanceof LocalNamingFailure ? "local_publication_failed" : fallback, receipt: null, partialArtifacts: [] });
  }
  const context = contextWork().catch(error => recordFailure(error, "progressive_context_unknown")).finally(() => { contextDone = true; });

  function availableApproaches(): ReadonlySet<NamingApproach> {
    const available = new Set(PROGRESSIVE_CREATIVE_APPROACHES);
    if (research && guidance) for (const approach of snapshot.preferences.approaches) {
      try { createProgressiveNamingAssignment({ runId: input.runId, snapshot, partIndex: Math.min(nextPartIndex, PROGRESSIVE_PART_LIMIT - 1), approach, targetCount: 1, research, guidance }); available.add(approach); } catch { /* An unavailable factual route must retain its coverage slot. */ }
    }
    return available;
  }

  async function processPart(key: string, assignment: NamingProgressiveAssignment) {
    const creationPhase = `${key}.creation`, curationPhase = `${key}.curation`, verificationPhase = `${key}.verification`;
    const creator = await freezeRequest(creationPhase, "creator", () => ({ input: { role: "creator", snapshot, assignment }, dependencies: assignment.assignmentBasis.kind === "director_guidance"
      ? [assignment.assignmentBasis.artifactId, ...(research ? [research.artifactId] : [])] : [] }));
    const created = await invoke(creator, creationPhase);
    if (created?.status !== "completed" || blocked || signal.aborted || publishedCount >= 100) return;
    if (creator.input.role !== "creator") throw new Error("progressive_creator_request_missing");
    const artifact = namingCreatorSetSchema.parse(created.output), validated = validateNamingCreatorSet(snapshot, creator.input.assignment, artifact);
    if (!validated.accepted.length) return;
    const review = createNamingReviewProjection({ runId: input.runId, snapshotHash: snapshot.snapshotHash, candidates: validated.accepted });
    const sourceDependencies = [artifact.artifactId, ...(research ? [research.artifactId] : [])];
    const curate = await freezeRequest(curationPhase, "curator", () => ({ input: { role: "curator", snapshot, review, validationRejections: validated.rejected }, dependencies: sourceDependencies }));
    const curated = await invoke(curate, curationPhase);
    if (curated?.status !== "completed" || blocked || signal.aborted || publishedCount >= 100) return;
    const curation = namingCurationSchema.parse(curated.output);
    let verification: Parameters<typeof createNamingMicrobatch>[0]["verification"], verificationRequest: NamingStageRequest | undefined;
    if (!PROGRESSIVE_CREATIVE_APPROACHES.has(creator.input.assignment.primaryApproach) || validated.accepted.some(candidate => candidate.claims.length)) {
      const verify = await freezeRequest(verificationPhase, "verifier", () => ({ input: { role: "verifier", snapshot, review, curation: createNamingCurationProjection(curation) }, dependencies: [...sourceDependencies, curation.artifactId] }));
      const verified = await invoke(verify, verificationPhase);
      if (verified?.status !== "completed" || blocked || signal.aborted || publishedCount >= 100) return;
      verification = namingVerificationSchema.parse(verified.output); verificationRequest = verify;
    }
    let publication: NamingMicrobatchInput;
    try { publication = createNamingMicrobatch({ key, snapshot, candidates: validated.accepted, curation, verification,
      ...(verificationRequest ? { sourceContext: namingSourceContext(verificationRequest, [...completed.values()]) } : {}) }); }
    catch (error) { if (error instanceof Error && error.message === "naming_microbatch_no_eligible_candidates") return; throw error; }
    const result = await retryLocalPersistence(() => store.publishMicrobatch(job, publication, signal), signal)
      .catch(error => { throw new LocalNamingFailure("publication", error); });
    publications.add(key);
    if (result.publishedCount >= publishedCount) { publishedCount = result.publishedCount; primaryCounts = result.primaryCounts; }
    console.info(JSON.stringify({ event: "naming_microbatch_published", key, count: result.entryIds.length, publishedCount: result.publishedCount }));
  }

  async function partWorker() {
    while (!blocked && !signal.aborted && publishedCount < 100) {
      const previous = replay.shift();
      let key: string, assignment: NamingProgressiveAssignment;
      if (previous) {
        const request = planned.get(callKey(`${previous}.creation`, "creator"));
        if (!request || request.input.role !== "creator" || !("assignmentBasis" in request.input.assignment)) throw new Error("progressive_saved_assignment_missing");
        key = previous; assignment = request.input.assignment;
      } else {
        const remaining = 100 - publishedCount - [...inFlight.values()].reduce((sum, value) => sum + value.targetCount, 0);
        if (remaining < 1 || nextPartIndex >= PROGRESSIVE_PART_LIMIT || plannedRaw >= PROGRESSIVE_RAW_LIMIT) return;
        const approach = chooseProgressiveNamingApproach(snapshot, primaryCounts, [...inFlight.values()], availableApproaches(), guidance);
        if (!approach) { if (!contextDone) { await context; continue; } return; }
        const partIndex = nextPartIndex++, targetCount = Math.min(partIndex < 3 ? 4 : 6, remaining, PROGRESSIVE_RAW_LIMIT - plannedRaw);
        key = progressivePartKey(partIndex);
        const generatedValues = [...completed.values()].flatMap(artifact => artifact.output.role === "creator" ? artifact.output.candidates.map(candidate => candidate.value) : []);
        assignment = createProgressiveNamingAssignment({ runId: input.runId, snapshot, partIndex, approach, targetCount, research, guidance, generatedValues });
        plannedRaw += targetCount;
      }
      inFlight.set(key, assignment);
      try { await processPart(key, assignment); } finally { inFlight.delete(key); }
    }
  }
  const workers = Array.from({ length: 3 }, () => partWorker().catch(error => recordFailure(error, "progressive_execution_unknown")));
  // Ordinary failure closes scheduling. Already started calls drain under their
  // own durable deadlines; the parent signal still cancels them immediately.
  await Promise.all([context, ...workers]);
  const researchAttempt = [...completed.values()].some(artifact => artifact.output.role === "researcher" && artifact.providerReceipt.toolCalls.some(call => call.type === "web_search" || call.type === "function"));
  const complete = !blocked && !signal.aborted && publishedCount === 100 && snapshot.preferences.approaches.every(approach => (primaryCounts.find(row => row.approach === approach)?.count ?? 0) >= 5) && researchAttempt;
  return { outcomes, complete };
}
