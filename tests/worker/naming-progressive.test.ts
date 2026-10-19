import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBrainJobInputSchema, namingProviderReceiptSchema, type NamingModelOutput, type NamingRoleOutput, type NamingStageOutcome, type NamingStageRequest } from "../../src/domain/naming-brain";
import { executeProgressiveNaming, hasSettledProgressiveDirectorFailure } from "../../worker/handlers/naming-progressive";
import { createNamingBrainHandlers } from "../../worker/handlers/naming-brain";
import { createProgressiveNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { validateNamingRoleOutput } from "../../src/server/ai/naming-brain/outputs";
import { namingTextHash } from "../../src/server/ai/naming-brain/identity";
import { createProgressiveNamingAssignment } from "../../src/server/ai/naming-brain/progressive-assignments";
import { parseClaimedJob } from "../../worker/postgres-store";
import type { NamingProgressiveState } from "../../worker/naming-brain-store";
import { createInertNamingHarness } from "./naming-brain-handler-fixture";
import { id, receipt } from "../domain/naming-brain-fixtures";

function deferred() { let resolve = () => {}; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** Synthetic role completions pass the real request/output/assignment validators.
 * The in-memory store models immutable phase plans and atomic publication ACKs. */
function fixture() {
  const legacy = createInertNamingHarness({ localPrototype: true });
  const input = namingBrainJobInputSchema.parse({ ...legacy.input, localTimingVersion: 2, localPipelineVersion: 2 });
  const job = parseClaimedJob({ ...legacy.jobRow, input });
  const stage = legacy.stages.get("creation")!; stage.startedAt = new Date().toISOString();
  const state: NamingProgressiveState = { stage: { ...stage, callPlans: [] }, plannedRequests: [], publishedCount: 0, primaryCounts: input.snapshot.preferences.approaches.map(approach => ({ approach, count: 0 })), publications: [] };
  const calls: NamingStageRequest[] = [], published: string[] = [], plans: string[] = [];
  const abort = new AbortController();
  const completed = (request: NamingStageRequest): NamingStageOutcome => {
    let output: NamingModelOutput;
    if (request.input.role === "researcher") output = { role: "researcher", territories: [{ territoryId: "objects", title: "Objects", direction: "Unexpected everyday objects.", sourceKeys: [] }, { territoryId: "rhythm", title: "Rhythm", direction: "Distinct rhythm and texture.", sourceKeys: [] }], facts: [], interpretations: [], uncertainties: [] };
    else if (request.input.role === "director") output = { role: "director", round: "initial", assignments: input.snapshot.preferences.approaches.map((approach, index) => ({ assignmentKey: `guide-${approach}`, primaryApproach: approach, additionalApproaches: [], territoryId: index ? "rhythm" : "objects", constructionKey: `guide-${index}`, direction: "Explore varied, unexpected associations.", targetCount: index ? 75 : 75, sourceKeys: [], avoidPatterns: [], freshTerritory: true })), feedbackHypotheses: [] };
    else if (request.input.role === "creator") {
      const assignment = request.input.assignment;
      output = { role: "creator", assignmentKey: assignment.assignmentKey, candidates: Array.from({ length: assignment.targetCount }, (_, index) => ({ candidateKey: `c${index}`, value: `${assignment.assignmentKey}word${index}`, primaryApproach: assignment.primaryApproach, additionalApproaches: [], territoryId: assignment.territoryId, constructionKey: assignment.constructionKey, rationale: "A concise creative association.", caution: null, claims: [] })) };
    } else if (request.input.role === "curator") output = { role: "curator", annotations: [], gaps: [] };
    else output = { role: "verifier", findings: [] };
    const observed = namingProviderReceiptSchema.parse({ ...receipt("creation", request.role), runId: request.runId, snapshotHash: request.snapshotHash,
      requestKey: request.requestKey, requestHash: request.requestHash, providerCallKey: request.providerCallKey, assignmentKey: request.assignmentKey,
      sessionId: `session-${request.providerCallKey}`, turnId: `turn-${request.providerCallKey}`, agentId: "agent-synthetic", observedModel: request.policy.model,
      sessionLimitCents: request.policy.sessionLimitCents, budgetControl: "local_unlimited_v1", localPipelineVersion: 2,
      toolCalls: request.role === "researcher" ? [{ callId: "research-attempt", type: "web_search", providerItemId: "search-item", status: "completed" }] : [], artifactItemIds: ["final-item"] });
    const text = JSON.stringify(output);
    const artifact = validateNamingRoleOutput({ request, receipt: observed, final: { itemId: "final-item", itemContentHash: namingTextHash(text), text, value: output }, dependencies: state.stage.artifacts.filter(artifact => request.dependencyArtifactIds.includes(artifact.artifactId)), sources: [] });
    if (!state.stage.artifacts.some(row => row.artifactId === artifact.artifactId)) state.stage.artifacts.push(artifact);
    return { status: "completed", receipt: observed, output: artifact };
  };
  let beforeCall: ((request: NamingStageRequest, signal: AbortSignal) => Promise<NamingStageOutcome | void>) | undefined;
  const call = async (request: NamingStageRequest, _phase: string, signal: AbortSignal) => {
    calls.push(request);
    if (!state.stage.requests.some(row => row.providerCallKey === request.providerCallKey)) state.stage.requests.push(request);
    const result = await beforeCall?.(request, signal); return result ?? completed(request);
  };
  const store: Parameters<typeof executeProgressiveNaming>[0]["store"] = {
    async loadProgressiveState() { return structuredClone(state); },
    async resumeExecution() { state.stage.recoveryMode = "execute"; return true; },
    async saveProgressiveCallPlan(_job, phase, requests) {
      for (const request of requests) {
        const prior = state.plannedRequests.find(row => row.providerCallKey === request.providerCallKey);
        if (prior && prior.requestHash !== request.requestHash) throw new Error("immutable_plan_changed");
        if (!prior) state.plannedRequests.push(request);
      }
      if (!state.stage.callPlans.some(plan => plan.phase === phase)) state.stage.callPlans.push({ phase, calls: requests.map(request => ({ providerCallKey: request.providerCallKey, assignmentKey: request.assignmentKey, requestKey: request.requestKey, requestHash: request.requestHash, sessionLimitCents: request.policy.sessionLimitCents, maxWebSearchCalls: request.policy.maxWebSearchCalls, role: request.role })) });
      plans.push(phase);
    },
    async publishMicrobatch(_job, value) {
      const prior = state.publications.find(row => row.key === value.key);
      if (!prior) {
        const candidateIds = value.candidates.slice(0, 100 - state.publishedCount).map(row => row.candidateId);
        const creator = state.stage.artifacts.find(row => row.artifactId === value.candidates[0]!.sourceArtifactId)!;
        if (creator.output.role !== "creator") throw new Error("synthetic_creator_missing");
        const count = candidateIds.length, approach = creator.output.candidates[0]!.primaryApproach;
        state.primaryCounts.find(row => row.approach === approach)!.count += count;
        state.publishedCount += count;
        state.publications.push({ key: value.key, publicationId: id(500 + state.publications.length), candidateIds, entryIds: candidateIds.map((_, index) => id(1000 + state.publishedCount - count + index)) }); published.push(value.key);
      }
      return { ...state.publications.find(row => row.key === value.key)!, publishedCount: state.publishedCount, primaryCounts: structuredClone(state.primaryCounts), complete: state.publishedCount === 100 };
    },
  };
  return { input, job, state, calls, published, plans, completed, store, call, abort, setBeforeCall: (hook: typeof beforeCall) => { beforeCall = hook; }, run: () => executeProgressiveNaming({ job, input, store, call, signal: abort.signal }) };
}

describe("Progressive Naming reviewed publication", () => {
  it("publishes the first genuine Creator+Curator part before Research or the other parts finish", async () => {
    const value = fixture(), research = deferred(), others = deferred(), first = deferred();
    value.setBeforeCall(async request => { if (request.role === "researcher") await research.promise; if (request.role === "creator" && request.providerCallKey !== "part001.creation.creator") await others.promise; });
    const publish = value.store.publishMicrobatch; value.store.publishMicrobatch = async (...args) => { const result = await publish(...args); first.resolve(); return result; };
    const pending = value.run(); await first.promise;
    expect(value.state.publishedCount).toBe(4); expect(value.published).toEqual(["part001"]);
    expect(value.state.stage.artifacts.map(row => row.output.role)).toEqual(["creator", "curator"]);
    expect(value.calls.some(row => row.role === "director")).toBe(false);
    research.resolve(); others.resolve();
    expect((await pending).complete).toBe(true); expect(value.state.publishedCount).toBe(100);
    expect(value.state.primaryCounts.every(row => row.count >= 5)).toBe(true);
    expect(value.calls.filter(row => row.role === "curator")).toHaveLength(value.published.length);
  });

  it("uses the next part after all saved plans are already published without replaying a Creator", async () => {
    const value = fixture(); await value.run();
    // Preserve the actual completed plans/artifacts, but model a target that still
    // has room after a prior atomic duplicate filter accepted fewer candidates.
    value.state.publishedCount = 96; value.state.primaryCounts[0]!.count -= 4;
    const prior = value.calls.map(row => row.providerCallKey), maximum = Math.max(...value.published.map(key => Number(key.slice(4))));
    value.calls.length = 0;
    expect((await value.run()).complete).toBe(true);
    const creator = value.calls.find(row => row.role === "creator")!;
    expect(creator.providerCallKey).toBe(`part${String(maximum + 1).padStart(3, "0")}.creation.creator`);
    expect(prior).not.toContain(creator.providerCallKey);
  });

  it("reuses the exact saved unissued request when background Director context arrived before reclaim", async () => {
    const value = fixture(); await value.run();
    const assignment = createProgressiveNamingAssignment({ runId: value.input.runId, snapshot: value.input.snapshot, partIndex: 30, approach: "real_words", targetCount: 4 });
    const request = createNamingRoleRequest({ runId: value.input.runId, stageKey: "creation", providerCallKey: "part031.creation.creator", input: { role: "creator", snapshot: value.input.snapshot, assignment }, dependencyArtifactIds: [], policy: createProgressiveNamingRolePolicy(value.input.policy, "creator", undefined, undefined, true) });
    await value.store.saveProgressiveCallPlan(value.job, "part031.creation", [request]);
    value.state.publishedCount = 96; value.state.primaryCounts[0]!.count -= 4; value.calls.length = 0;
    expect((await value.run()).complete).toBe(true);
    expect(value.calls.find(row => row.providerCallKey === request.providerCallKey)).toEqual(request);
    expect(value.state.plannedRequests.filter(row => row.providerCallKey === request.providerCallKey)).toHaveLength(1);
  });

  it("does not certify completion at 100 while any issued call is still unknown", async () => {
    const value = fixture(); await value.run();
    const original = value.state.stage.requests.find(row => row.role === "creator")!;
    value.state.stage.artifacts = value.state.stage.artifacts.filter(row => row.providerReceipt.providerCallKey !== original.providerCallKey);
    value.state.stage.recoveryMode = "observe_only";
    value.setBeforeCall(async () => ({ status: "unresolved", code: "synthetic_ack_unknown", receipt: null, partialArtifacts: [] }));
    const previous = value.state.plannedRequests.length, result = await value.run();
    expect(result.complete).toBe(false); expect(result.outcomes).toContainEqual(expect.objectContaining({ status: "unresolved" }));
    expect(value.state.plannedRequests).toHaveLength(previous); expect(value.state.publishedCount).toBe(100);
  });

  it("requires actual Research tool use before final completion", async () => {
    const value = fixture(); await value.run();
    const index = value.state.stage.artifacts.findIndex(row => row.output.role === "researcher");
    value.state.stage.artifacts[index] = { ...value.state.stage.artifacts[index]!, providerReceipt: { ...value.state.stage.artifacts[index]!.providerReceipt, toolCalls: [] } } as NamingRoleOutput;
    expect((await value.run()).complete).toBe(false);
  });

  it.each(["failed", "cancelled", "provider_output_invalid"] as const)("retains genuine optional Director %s while independently reviewed creative names complete", async failure => {
    const value = fixture();
    value.setBeforeCall(async request => {
      if (request.role !== "director") return;
      const original = value.completed(request); if (original.status !== "completed") throw new Error("synthetic_completion_missing");
      value.state.stage.artifacts = value.state.stage.artifacts.filter(row => row.providerReceipt.providerCallKey !== request.providerCallKey);
      value.state.stage.receipts.push(original.receipt);
      value.state.stage.providerTurns.push({ providerCallKey: request.providerCallKey, sessionId: original.receipt.sessionId!, turnId: original.receipt.turnId!, turn: { id: original.receipt.turnId!, session_id: original.receipt.sessionId!, agent_id: original.receipt.agentId!, subagent_id: null, status: failure === "provider_output_invalid" ? "completed" : failure } });
      return { status: failure === "cancelled" ? "cancelled" : "failed", code: failure === "provider_output_invalid" ? failure : `provider_turn_${failure}`, receipt: original.receipt, partialArtifacts: [] };
    });
    const result = await value.run(), outcome = result.outcomes.find(row => row.status !== "completed")!;
    const request = value.state.stage.requests.find(row => row.role === "director")!;
    expect(result.complete).toBe(true); expect(value.state.publishedCount).toBe(100);
    expect(value.state.stage.artifacts.some(row => row.output.role === "director")).toBe(false);
    expect(hasSettledProgressiveDirectorFailure(value.state.stage, request, outcome)).toBe(true);
    value.state.stage.providerTurns = value.state.stage.providerTurns.filter(row => row.providerCallKey !== request.providerCallKey);
    expect(hasSettledProgressiveDirectorFailure(value.state.stage, request, outcome)).toBe(false);
  });

  it("keeps a Director with an unknown identity quarantined even when 100 reviewed names already exist", async () => {
    const value = fixture(); await value.run();
    const request = value.state.stage.requests.find(row => row.role === "director")!;
    value.state.stage.artifacts = value.state.stage.artifacts.filter(row => row.providerReceipt.providerCallKey !== request.providerCallKey);
    value.state.stage.recoveryMode = "observe_only";
    value.setBeforeCall(async () => ({ status: "unresolved", code: "session_identity_unknown", receipt: null, partialArtifacts: [] }));
    const result = await value.run();
    expect(result.complete).toBe(false); expect(value.state.publishedCount).toBe(100);
  });

  it("retains exact invalid Director closure proof in the successful real handler result", async () => {
    const value = fixture(), backing = createInertNamingHarness({ localPrototype: true });
    backing.jobRow.input = value.input;
    await backing.store.claim("synthetic", 120);
    vi.spyOn(backing.store, "loadProgressiveState").mockImplementation(value.store.loadProgressiveState);
    vi.spyOn(backing.store, "saveProgressiveCallPlan").mockImplementation(value.store.saveProgressiveCallPlan);
    vi.spyOn(backing.store, "publishMicrobatch").mockImplementation(value.store.publishMicrobatch);
    vi.spyOn(backing.store, "resumeExecution").mockImplementation(value.store.resumeExecution);
    vi.spyOn(backing.store, "loadStage").mockImplementation(async () => value.state.stage);
    vi.spyOn(backing.store, "assertContinuation").mockResolvedValue();
    vi.spyOn(backing.store, "authorizeDispatch").mockResolvedValue();
    vi.spyOn(backing.store, "saveArtifact").mockResolvedValue();
    value.setBeforeCall(async request => {
      if (request.role !== "director") return;
      const original = value.completed(request); if (original.status !== "completed") throw new Error("synthetic_completion_missing");
      value.state.stage.artifacts = value.state.stage.artifacts.filter(row => row.providerReceipt.providerCallKey !== request.providerCallKey);
      value.state.stage.receipts.push(original.receipt);
      value.state.stage.providerTurns.push({ providerCallKey: request.providerCallKey, sessionId: original.receipt.sessionId!, turnId: original.receipt.turnId!, turn: { id: original.receipt.turnId!, session_id: original.receipt.sessionId!, agent_id: original.receipt.agentId!, subagent_id: null, status: "completed" } });
      return { status: "failed", code: "provider_output_invalid", receipt: original.receipt, partialArtifacts: [] };
    });
    const handlers = createNamingBrainHandlers({ store: backing.store, localPrototype: true, assertReady: async () => {}, runtime: () => ({
      async runStage(request, hooks) { await hooks.beforeDispatch(); return value.call(request, "synthetic", hooks.signal); },
      async resumeStage() { throw new Error("unexpected_synthetic_resume"); }, async cancelStage() {},
    }) });
    const result = await handlers.get("naming.generate")!.steps(value.job)[0]!.execute({ job: value.job, signal: value.abort.signal });
    expect(result).toMatchObject({ status: "succeeded", result: { partialArtifacts: [{ providerCallKey: "context.direction.director", status: "failed", code: "provider_output_invalid", receipt: { localPipelineVersion: 2, dispatchState: "dispatched" } }] } });
    expect(value.state.stage.artifacts.some(row => row.output.role === "director")).toBe(false);
  });

  it("stops new scheduling after an ordinary failure while issued siblings retain their results", async () => {
    const value = fixture(), started = deferred(), failure = deferred(), drain = deferred();
    let creators = 0; const siblingSignals: AbortSignal[] = [];
    value.setBeforeCall(async (request, signal) => {
      if (request.role !== "creator") return;
      if (++creators === 3) started.resolve();
      if (request.providerCallKey === "part001.creation.creator") { await failure.promise; return { status: "unresolved", code: "synthetic_create_unknown", receipt: null, partialArtifacts: [] }; }
      siblingSignals.push(signal); await drain.promise;
    });
    const pending = value.run(); await started.promise; failure.resolve();
    await vi.waitFor(() => expect(value.calls.filter(row => row.role === "creator")).toHaveLength(3));
    expect(siblingSignals.every(signal => !signal.aborted)).toBe(true);
    drain.resolve(); const result = await pending;
    expect(result.complete).toBe(false); expect(value.calls.filter(row => row.role === "creator")).toHaveLength(3);
    expect(value.state.stage.artifacts.filter(row => row.output.role === "creator")).toHaveLength(2);
    expect(value.published).toEqual([]);
  });

  it("propagates explicit cancellation to every active call and admits no later phase", async () => {
    const value = fixture(), started = deferred(); let creators = 0;
    value.setBeforeCall(async (request, signal) => {
      if (request.role !== "creator") return;
      if (++creators === 3) started.resolve();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "unresolved", code: "observation_cancelled", receipt: null, partialArtifacts: [] };
    });
    const pending = value.run(); await started.promise; value.abort.abort();
    const result = await pending;
    expect(result.complete).toBe(false); expect(value.calls.filter(row => row.role === "creator")).toHaveLength(3);
    expect(value.calls.some(row => row.role === "curator")).toBe(false); expect(value.published).toEqual([]);
  });

  it("freezes exact already-created values only into new requests without expanding the dependency graph", async () => {
    const value = fixture(); expect((await value.run()).complete).toBe(true);
    const first = value.calls.find(row => row.providerCallKey === "part001.creation.creator")!;
    expect(first.input.role === "creator" && first.input.assignment.avoidPatterns.join(" ")).not.toContain("already generated");
    const later = value.calls.find(row => row.role === "creator" && row.input.role === "creator" && row.input.assignment.avoidPatterns.some(pattern => pattern.includes("already generated")))!;
    expect(later).toBeDefined();
    expect(later.dependencyArtifactIds.some(id => value.state.stage.artifacts.some(row => row.artifactId === id && row.output.role === "creator"))).toBe(false);
    const source = value.state.stage.artifacts.find(row => row.output.role === "creator")!;
    expect(source.output.role === "creator" && later.input.role === "creator" && later.input.assignment.avoidPatterns.join(" ")).toContain(source.output.role === "creator" ? JSON.stringify(source.output.candidates[0]!.value) : "missing");
    expect(value.state.plannedRequests.find(row => row.providerCallKey === first.providerCallKey)).toEqual(first);
  });

  it("keeps the native seven-step manifest and uses two real steps only for the versioned local pipeline", async () => {
    const value = fixture(), native = createInertNamingHarness(), authorized = createInertNamingHarness({ localPrototype: true });
    expect(native.handlers.get("naming.generate")!.steps(parseClaimedJob(native.jobRow)).map(row => row.key)).toHaveLength(7);
    authorized.jobRow.input = value.input;
    await authorized.store.claim("synthetic", 120);
    const handlers = createNamingBrainHandlers({ store: authorized.store, assertReady: async () => {} });
    expect(handlers.get("naming.generate")!.steps(value.job).map(row => row.key)).toEqual(["creation", "prepare"]);
  });
});
