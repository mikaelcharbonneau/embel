import { describe, expect, it } from "vitest";
import * as brain from "../../src/domain/naming-brain";
import { createNamingGapContext } from "../../src/domain/naming-brain-selection";
import { assignment, curation, envelope, id, plan, receipt, research, snapshot, sourceContext, verification } from "./naming-brain-fixtures";

const policy = () => ({ version: 1, billingMode: "openai_api", handlerVersion: "naming-brain-v1", protocol: "openai_agents", model: "fixture-selected-model", reasoningEffort: "xhigh", runAllowanceMicrousd: 5_000_000, aggregateAllowanceMicrousd: 25_000_000, maxUnsettledRuns: 5, maxConcurrentCreators: 3, maxInitialCandidates: 150, maxGapCandidates: 50, maxGapRounds: 1, maxInputBytes: 131_072, maxOutputBytes: 524_288, stageDeadlineMs: 240_000, stageLimits: {
  research: { maximumCostMicrousd: 750_000, maxWebSearchCalls: 4 }, direction: { maximumCostMicrousd: 250_000, maxWebSearchCalls: 0 }, creation: { maximumCostMicrousd: 1_500_000, maxWebSearchCalls: 0 }, curation: { maximumCostMicrousd: 500_000, maxWebSearchCalls: 0 }, verification: { maximumCostMicrousd: 1_250_000, maxWebSearchCalls: 20 }, gap: { maximumCostMicrousd: 750_000, maxWebSearchCalls: 8 }, prepare: { maximumCostMicrousd: 0, maxWebSearchCalls: 0 },
} });
const rolePolicy = () => ({ version: 1, role: "researcher", protocol: "openai_agents", model: "fixture-selected-model", reasoningEffort: "xhigh", maximumCostMicrousd: 750_000, sessionLimitCents: 75, maxWebSearchCalls: 4, maxInputBytes: 131_072, maxOutputBytes: 524_288, deadlineMs: 240_000, nativeDelegation: false, allowedTools: ["web_search", "read_reference"], referenceHosts: ["example.com"] });

describe("immutable managed policy and runtime requests", () => {
  it("holds a full $5 per unresolved expense up to the $25 aggregate without estimating an actual expense", () => {
    expect(brain.namingBrainPolicySchema?.safeParse(policy()).success).toBe(true);
    for (const patch of [{ runAllowanceMicrousd: 4_999_999 }, { aggregateAllowanceMicrousd: 30_000_000 }, { maxUnsettledRuns: 6 }, { protocol: "openai_responses" }, { maxConcurrentCreators: 4 }, { model: "" }, { reasoningEffort: "low" }]) expect(brain.namingBrainPolicySchema?.safeParse({ ...policy(), ...patch }).success).toBe(false);
  });
  it("binds role, request, dependencies and snapshot without granting extra tools", () => {
    const request = { runId: id(3), stageKey: "research", role: "researcher", snapshotHash: snapshot().snapshotHash, input: { role: "researcher", snapshot: snapshot() }, dependencyArtifactIds: [], requestKey: "fixture-stage-request-001", providerCallKey: "research-one", assignmentKey: null, requestHash: "c".repeat(64), policy: rolePolicy() };
    expect(brain.namingStageRequestSchema?.safeParse(request).success).toBe(true);
    expect(brain.namingStageRequestSchema?.safeParse({ ...request, role: "creator" }).success).toBe(false);
    expect(brain.namingStageRequestSchema?.safeParse({ ...request, policy: { ...rolePolicy(), allowedTools: ["web_search", "database"] } }).success).toBe(false);
    expect(brain.namingStageRequestSchema?.safeParse({ ...request, snapshotHash: "d".repeat(64) }).success).toBe(false);
    const director = { ...request, stageKey: "direction", role: "director", input: { role: "director", snapshot: snapshot(), research: research() }, policy: { ...rolePolicy(), role: "director", maximumCostMicrousd: 250_000, sessionLimitCents: 25, maxWebSearchCalls: 0, allowedTools: [], referenceHosts: [] } };
    expect(brain.namingStageRequestSchema?.safeParse(director).success).toBe(false);
    expect(brain.namingStageRequestSchema?.safeParse({ ...director, dependencyArtifactIds: [research().artifactId] }).success).toBe(true);
  });
  it("keeps the V2 immutable input explicit and rejects unknown policy or client-controlled fields", () => {
    const input = { version: 2, handlerVersion: "naming-brain-v1", billingMode: "openai_api", runId: id(3), jobId: id(4), batchId: id(5), snapshot: snapshot(), acceptedPolicyIdentity: "a".repeat(64), policy: policy() };
    expect(brain.namingBrainJobInputSchema?.safeParse(input).success).toBe(true);
    expect(brain.namingBrainJobInputSchema?.safeParse({ ...input, policy: { ...policy(), protocol: "openai_responses" } }).success).toBe(false);
    expect(brain.namingBrainJobInputSchema?.safeParse({ ...input, ownerId: id(90) }).success).toBe(false);
  });
  it("retains known terminal cancellation separately from unknown dispatch", () => {
    expect(brain.namingStageOutcomeSchema.safeParse({ status: "cancelled", code: "provider_cancelled", receipt: receipt(), partialArtifacts: [] }).success).toBe(true);
    expect(brain.namingStageOutcomeSchema.safeParse({ status: "failed", code: "provider_failed", receipt: receipt(), partialArtifacts: [] }).success).toBe(true);
  });
});

describe("authenticated feed mutation intent", () => {
  const intent = () => ({ version: 1, expectedDemandSequence: 0, expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0, consumedThrough: null, reason: "initial", idempotencyKey: "fixture-initial-demand-001" });
  it("accepts revision-bound demand and rejects browser ownership, generated results and arbitrary cost policy", () => {
    expect(brain.ensureNamingRunIntentSchema?.safeParse(intent()).success).toBe(true);
    for (const patch of [{ ownerId: id(1) }, { projectId: id(2) }, { targetCount: 100 }, { policy: policy() }, { output: plan() }, { maximumCostMicrousd: 0 }]) expect(brain.ensureNamingRunIntentSchema?.safeParse({ ...intent(), ...patch }).success).toBe(false);
    expect(brain.ensureNamingRunIntentSchema?.safeParse({ ...intent(), reason: "scroll", consumedThrough: { entryId: id(40), position: 30 } }).success).toBe(true);
    expect(brain.ensureNamingRunIntentSchema?.safeParse({ ...intent(), reason: "scroll" }).success).toBe(false);
  });
  it("requires one to five unique strong seed IDs and keeps feedback revision separate", () => {
    const steering = { expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0, candidateIds: [id(40)], instruction: null, idempotencyKey: "fixture-strong-steering-001" };
    expect(brain.steerNamingFeedIntentSchema?.safeParse(steering).success).toBe(true);
    expect(brain.steerNamingFeedIntentSchema?.safeParse({ ...steering, candidateIds: [] }).success).toBe(false);
    expect(brain.steerNamingFeedIntentSchema?.safeParse({ ...steering, candidateIds: [id(40), id(40)] }).success).toBe(false);
    expect(brain.steerNamingFeedIntentSchema?.safeParse({ ...steering, feedbackRevision: 999 }).success).toBe(false);
  });
});


function runSummary() {
  return { version: 1, ownerId: id(1), projectId: id(2), runId: id(3), jobId: id(4), batchId: id(5), revision: 1, resumedFromRunId: null, state: "queued", projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 0, snapshotHash: "a".repeat(64), acceptedPolicyIdentity: "a".repeat(64), progress: 0, preparedSetId: null, fulfillment: null, accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null }, createdAt: "2026-10-16T12:00:00Z", updatedAt: "2026-10-16T12:00:00Z" };
}
function feed() {
  return { version: 1, ownerId: id(1), projectId: id(2), projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 0, entries: [], nextCursor: null, consumedThrough: null, activeRun: runSummary(), preparedSetId: null, state: "active", availability: { status: "unavailable", code: "runtime_disabled" } };
}

describe("saved feed and explicit Resume", () => {
  it("separates explicit terminal-run Resume from ordinary scroll demand", () => {
    const resume = { version: 1, expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0, expectedDemandSequence: 4, consumedThrough: null, reason: "resume", resumeOfRunId: id(30), expectedRunRevision: 2, idempotencyKey: "fixture-explicit-resume-001" };
    expect(brain.ensureNamingRunIntentSchema.safeParse(resume).success).toBe(true);
    expect(brain.ensureNamingRunIntentSchema.safeParse({ ...resume, reason: "initial" }).success).toBe(false);
    expect(brain.ensureNamingRunIntentSchema.safeParse({ ...resume, expectedRunRevision: 0 }).success).toBe(false);
  });
  it("binds feed/run ownership and preserves the full unsettled allowance after output completion", () => {
    expect(brain.namingFeedSchema?.safeParse(feed()).success).toBe(true);
    expect(brain.namingFeedSchema?.safeParse({ ...feed(), activeRun: { ...runSummary(), ownerId: id(90) } }).success).toBe(false);
    expect(brain.namingBrainRunSummarySchema?.safeParse({ ...runSummary(), state: "succeeded", progress: 100 }).success).toBe(true);
    expect(brain.namingBrainRunSummarySchema?.safeParse({ ...runSummary(), accounting: { status: "held_unsettled", heldAllowanceMicrousd: 0, confirmedActualCostMicrousd: null } }).success).toBe(false);
    expect(brain.namingBrainRunSummarySchema?.safeParse({ ...runSummary(), resumedFromRunId: id(3) }).success).toBe(false);
    expect(brain.namingFeedEnsureResultSchema?.safeParse({ status: "pending", feed: feed(), run: runSummary(), reused: true }).success).toBe(true);
  });
  it("requires all seven fixed stages in a run manifest and rejects raw role outputs as public run authority", () => {
    const stages = ["research", "direction", "creation", "curation", "verification", "gap", "prepare"].map(stageKey => ({ stageKey, state: "pending", artifactIds: [], startedAt: null, finishedAt: null, errorCode: null }));
    const run = { ...runSummary(), snapshot: snapshot(), stages };
    expect(brain.namingBrainRunSchema?.safeParse(run).success).toBe(true);
    expect(brain.namingBrainRunSchema?.safeParse({ ...run, stages: stages.slice(1) }).success).toBe(false);
    expect(brain.namingBrainRunSchema?.safeParse({ ...run, providerOutput: research() }).success).toBe(false);
  });
});


it("bounds gap verification by the shared gap reservation rather than the larger first verification cap", () => {
  const request = { runId: id(3), stageKey: "gap", role: "verifier", snapshotHash: snapshot().snapshotHash, input: { role: "verifier", snapshot: snapshot(), review: brain.createNamingReviewProjection({ runId: id(3), snapshotHash: snapshot().snapshotHash, candidates: [] }), curation: brain.createNamingCurationProjection(curation()) }, dependencyArtifactIds: [curation().artifactId], requestKey: "fixture-gap-request-001", providerCallKey: "gap-verification", assignmentKey: null, requestHash: "c".repeat(64), policy: { ...rolePolicy(), role: "verifier", maxWebSearchCalls: 20, maximumCostMicrousd: 1_250_000, sessionLimitCents: 125 } };
  expect(brain.namingStageRequestSchema.safeParse(request).success).toBe(false);
  expect(brain.namingStageRequestSchema.safeParse({ ...request, policy: { ...request.policy, maxWebSearchCalls: 8, maximumCostMicrousd: 750_000, sessionLimitCents: 75 } }).success).toBe(true);
});


describe("Creator round binding before dispatch", () => {
  it.each([["initial", "creation", "gap"], ["gap", "gap", "creation"]])("accepts %s only in %s and rejects %s before dispatch", (round, validStage, invalidStage) => {
    const initial = brain.validateNamingAssignmentPlan(snapshot(), research(), plan())[0]!;
    const gapPlan = { ...envelope("gap", "director", 44), output: { role: "director", round: "gap", assignments: [assignment("real_words", "gap-real", 10), assignment("invented", "gap-invented", 10, "rhythm"), assignment("other_languages", "gap-language", 10)], feedbackHypotheses: [] } };
    const context = createNamingGapContext({ snapshot: snapshot(), candidates: [], curation: curation(), verification: brain.applyNamingVerification([], verification(), sourceContext()), existingIdentityKeys: [] });
    const gap = brain.validateNamingAssignmentPlan(snapshot(), research(), gapPlan, context)[0]!;
    const request = (savedAssignment: typeof initial, stageKey: string) => ({ runId: id(3), stageKey, role: "creator", snapshotHash: snapshot().snapshotHash, input: { role: "creator", snapshot: snapshot(), assignment: savedAssignment }, dependencyArtifactIds: [savedAssignment.planArtifactId], requestKey: "fixture-round-request-001", providerCallKey: "round-creator", assignmentKey: savedAssignment.assignmentKey, requestHash: "c".repeat(64), policy: { ...rolePolicy(), role: "creator", maximumCostMicrousd: 50_000, sessionLimitCents: 5, maxWebSearchCalls: 0, allowedTools: [], referenceHosts: [] } });
    const savedAssignment = round === "initial" ? initial : gap;
    expect(brain.namingStageRequestSchema.safeParse(request(savedAssignment, validStage!)).success).toBe(true);
    expect(brain.namingStageRequestSchema.safeParse(request(savedAssignment, invalidStage!)).success).toBe(false);
  });
});

it("defaults unqualified run recovery to false and accepts only an explicit admissible terminal witness", () => {
  expect(brain.namingBrainRunSummarySchema.parse(runSummary()).canResume).toBe(false);
  expect(brain.namingBrainRunSummarySchema.parse({ ...runSummary(), state: "partial", revision: 2, canResume: true }).canResume).toBe(true);
  for (const state of ["queued", "running", "cancel_requested", "needs_reconciliation", "succeeded", "prepared", "superseded"]) {
    expect(brain.namingBrainRunSummarySchema.safeParse({ ...runSummary(), state, canResume: true }).success).toBe(false);
  }
  const complete = { status: "complete", targetCount: 100, acceptedCount: 100, missingCount: 0, coverageSatisfied: true, message: null };
  expect(brain.namingBrainRunSummarySchema.safeParse({ ...runSummary(), state: "partial", canResume: true, fulfillment: complete }).success).toBe(false);
  const stages = ["research", "direction", "creation", "curation", "verification", "gap", "prepare"].map(stageKey => ({ stageKey, state: "pending", artifactIds: [], startedAt: null, finishedAt: null, errorCode: null }));
  expect(brain.namingBrainRunSchema.parse({ ...runSummary(), snapshot: snapshot(), stages }).canResume).toBe(false);
  expect(brain.namingBrainRunSchema.safeParse({ ...runSummary(), snapshot: snapshot(), stages, canResume: true }).success).toBe(false);
});

describe("incomplete response Resume witness consistency", () => {
  it.each([
    { label: "true/false contradiction", canResume: true, witness: false, valid: false },
    { label: "false/true contradiction", canResume: false, witness: true, valid: false },
    { label: "true/omitted default-false contradiction", canResume: true, witness: undefined, valid: false },
    { label: "consistent false/false", canResume: false, witness: false, valid: true },
    { label: "consistent true/true", canResume: true, witness: true, valid: true },
    { label: "consistent false/omitted default-false", canResume: false, witness: undefined, valid: true },
  ])("validates $label", ({ canResume, witness, valid }) => {
    const fulfillment = { status: "partial", targetCount: 100, acceptedCount: 2, missingCount: 98, coverageSatisfied: false, message: "2 of 100 names are ready." };
    const run = { ...runSummary(), state: "partial", revision: 2, fulfillment, ...(witness === undefined ? {} : { canResume: witness }) };
    const result = { status: "incomplete", feed: { ...feed(), activeRun: run }, run, fulfillment, message: "The saved run is incomplete.", canResume };
    expect(brain.namingFeedEnsureResultSchema.safeParse(result).success).toBe(valid);
  });
});

describe("durable Stop and free saved-output continuation", () => {
  const complete = () => ({ status: "complete", targetCount: 100, acceptedCount: 100, missingCount: 0, coverageSatisfied: true, message: null });
  const preparedRun = (state = "succeeded") => ({ ...runSummary(), state, progress: 100, preparedSetId: id(50), fulfillment: complete() });
  const stages = () => brain.namingStageKeySchema.options.map(stageKey => ({ stageKey, state: "succeeded", artifactIds: [], startedAt: null, finishedAt: null, errorCode: null }));

  it("binds Stop to an explicit demand sequence and optional pending Ensure identity without client authority", () => {
    const stop = { version: 1, expectedDemandSequence: 0, pendingEnsureIdempotencyKey: null, idempotencyKey: "fixture-stop-demand-001" };
    expect(brain.stopNamingFeedIntentSchema?.safeParse(stop).success).toBe(true);
    expect(brain.stopNamingFeedIntentSchema?.safeParse({ ...stop, pendingEnsureIdempotencyKey: "fixture-explicit-resume-001" }).success).toBe(true);
    expect(brain.stopNamingFeedIntentSchema?.safeParse({ version: 1, expectedDemandSequence: 0, idempotencyKey: stop.idempotencyKey }).success).toBe(false);
    for (const patch of [{ version: 2 }, { expectedDemandSequence: -1 }, { expectedDemandSequence: 0.5 }, { expectedDemandSequence: Number.MAX_SAFE_INTEGER + 1 }, { pendingEnsureIdempotencyKey: "short" }, { idempotencyKey: "invalid stop key 001" }, { ownerId: id(90) }, { runId: id(3) }, { policy: policy() }]) {
      expect(brain.stopNamingFeedIntentSchema?.safeParse({ ...stop, ...patch }).success).toBe(false);
    }
  });

  it("defaults legacy feeds to unpaused and retains durable pause separately from availability state", () => {
    expect(brain.namingFeedSchema.parse(feed()).paused).toBe(false);
    const paused = { ...feed(), paused: true, state: "blocked", activeRun: null };
    expect(brain.namingFeedSchema.parse(paused).paused).toBe(true);
    expect(brain.stopNamingFeedResponseSchema?.safeParse({ feed: paused }).success).toBe(true);
    expect(brain.stopNamingFeedResponseSchema?.safeParse({ feed: paused, runId: id(3) }).success).toBe(false);
  });

  it.each(["prepared", "succeeded", "cancelled"])("allows a server witness for complete %s membership without inferring one", state => {
    const run = preparedRun(state);
    expect(brain.namingBrainRunSummarySchema.parse(run).canResume).toBe(false);
    expect(brain.namingBrainRunSummarySchema.safeParse({ ...run, canResume: true }).success).toBe(true);
    expect(brain.namingBrainRunSchema.safeParse({ ...run, canResume: true, snapshot: snapshot(), stages: stages() }).success).toBe(true);
    expect(brain.namingFeedSchema.safeParse({ ...feed(), paused: true, state: "paused", activeRun: { ...run, canResume: true }, preparedSetId: run.preparedSetId }).success).toBe(true);
  });

  it("blocks complete-output Resume without terminal prepared membership or during reconciliation", () => {
    const run = { ...preparedRun(), canResume: true };
    for (const state of ["queued", "running", "cancel_requested", "needs_reconciliation", "superseded", "partial", "failed"]) {
      expect(brain.namingBrainRunSummarySchema.safeParse({ ...run, state }).success).toBe(false);
      expect(brain.namingBrainRunSchema.safeParse({ ...run, state, snapshot: snapshot(), stages: stages() }).success).toBe(false);
    }
    for (const patch of [{ preparedSetId: null }, { fulfillment: null }]) {
      expect(brain.namingBrainRunSummarySchema.safeParse({ ...run, ...patch }).success).toBe(false);
    }
  });

  it("requires a separate consistent saved-membership witness before bypassing paid readiness", () => {
    const run = { ...preparedRun(), state: "partial", canResume: true, canResumeSaved: true, fulfillment: { status: "partial", targetCount: 100, acceptedCount: 1, missingCount: 99, coverageSatisfied: false, message: "One saved name." } };
    expect(brain.namingBrainRunSummarySchema.safeParse(run).success).toBe(true);
    for (const patch of [{ canResume: false }, { preparedSetId: null }, { fulfillment: null }, { state: "needs_reconciliation" }, { state: "running" }, { fulfillment: { status: "none", targetCount: 100, acceptedCount: 0, missingCount: 100, coverageSatisfied: false, message: "No saved names." } }]) expect(brain.namingBrainRunSummarySchema.safeParse({ ...run, ...patch }).success).toBe(false);
    expect(brain.namingBrainRunSummarySchema.parse({ ...run, canResumeSaved: undefined }).canResumeSaved).toBeUndefined();
  });

  it.each(["prepared", "succeeded", "cancelled"])("acknowledges already-exposed %s membership without appending or granting another Resume", state => {
    const run = { ...preparedRun(state), canResume: false };
    const result = { status: "appended", feed: { ...feed(), paused: false, demandSequence: 2, activeRun: run, preparedSetId: null }, runId: run.runId, appendedEntryIds: [] };
    expect(brain.namingFeedEnsureResultSchema.safeParse(result).success).toBe(true);
  });

  it("rejects empty append acknowledgements detached from the retained complete head", () => {
    const run = preparedRun();
    const result = { status: "appended", feed: { ...feed(), activeRun: run }, runId: run.runId, appendedEntryIds: [] };
    expect(brain.namingFeedEnsureResultSchema.safeParse(result).success).toBe(true);
    expect(brain.namingFeedEnsureResultSchema.safeParse({ ...result, runId: id(90) }).success).toBe(false);
    expect(brain.namingFeedEnsureResultSchema.safeParse({ ...result, feed: { ...result.feed, activeRun: null } }).success).toBe(false);
    for (const patch of [{ preparedSetId: null }, { fulfillment: null }, { state: "running" }, { state: "needs_reconciliation" }, { state: "superseded" }]) {
      expect(brain.namingFeedEnsureResultSchema.safeParse({ ...result, feed: { ...result.feed, activeRun: { ...run, ...patch } } }).success).toBe(false);
    }
    expect(brain.namingFeedEnsureResultSchema.safeParse({ ...result, appendedEntryIds: [id(60)] }).success).toBe(false);
  });

  it("keeps complete saved consumption out of the incomplete response branch", () => {
    const run = { ...preparedRun("cancelled"), canResume: false };
    const fulfillment = { status: "partial", targetCount: 100, acceptedCount: 2, missingCount: 98, coverageSatisfied: false, message: "2 of 100 names are ready." };
    const result = { status: "incomplete", feed: { ...feed(), activeRun: run }, run, fulfillment, message: "The saved run is incomplete.", canResume: false };
    expect(brain.namingFeedEnsureResultSchema.safeParse(result).success).toBe(false);
  });
});
