import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { runOneJob } from "../../worker/runner";
import { namingBrainJobInputSchema, namingPreparedSetSchema } from "../../src/domain/naming-brain";
import { createInertNamingHarness } from "./naming-brain-handler-fixture";

describe("Naming seven-stage scoped worker", () => {
  it.each([true, false])("keeps finite local wave/phased time envelopes without changing ordinary stage limits (%s)", async localPrototype => {
    const test = createInertNamingHarness({ localPrototype });
    const job = (await test.store.claim("synthetic", 120))!;
    const steps = test.handlers.get("naming.generate")!.steps(job);
    for (const step of steps) expect(step.timeoutMs).toBe(localPrototype && ["creation", "gap"].includes(step.key) ? 3_600_000 : 270_000);
    expect(test.dispatched).toEqual([]);
  });
  it.each([true, false])("uses new generous timing only with both local runtime and immutable input witness (%s)", async localPrototype => {
    const test = createInertNamingHarness({ localPrototype });
    test.jobRow.input = namingBrainJobInputSchema.parse({ ...test.input, localTimingVersion: 2 });
    const job = (await test.store.claim("synthetic", 120))!;
    for (const step of test.handlers.get("naming.generate")!.steps(job)) {
      const expected = !localPrototype || step.key === "prepare" ? 270_000 : ["creation", "gap"].includes(step.key) ? 3_600_000 : 1_200_000;
      expect(step.timeoutMs).toBe(expected);
    }
    vi.spyOn(test.store, "claim").mockResolvedValueOnce(job);
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic", localPrototype })).toBe("succeeded");
    expect(test.dispatched.length).toBeGreaterThan(0);
    expect(test.dispatched.every(request => request.policy.deadlineMs === (localPrototype ? 900_000 : 240_000))).toBe(true);
  });
  it("records a retained explicit provider create rejection as a known failure", async () => {
    const test = createInertNamingHarness({ rejectResearch: "retained" });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("failed");
    expect(test.stages.get("research")!.state).toBe("failed");
    expect(test.stageResults.get("research")).toMatchObject({ errorCode: "provider_request_rejected" });
    expect(test.dispatched).toHaveLength(1);
    expect(test.prepared()).toBeNull();
  });
  it.each(["missing_receipt", "unknown_receipt"] as const)("quarantines rejected calls with %s instead of inferring non-execution", async rejectResearch => {
    const test = createInertNamingHarness({ rejectResearch });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("needs_reconciliation");
    expect(test.prepared()).toBeNull();
  });
  it("renders and binds all roles, assembles 100, skips a needless gap and retains provisional accounting", async () => {
    const test = createInertNamingHarness();
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("succeeded");
    const prepared = namingPreparedSetSchema.parse(test.prepared()?.preparedSet);
    expect(prepared.candidateIds).toHaveLength(100); expect(prepared.retainedUnusedIds).toHaveLength(50);
    expect(test.dispatched.map(request => request.role)).toEqual(["researcher", "director", "creator", "creator", "curator", "verifier"]);
    expect(test.dispatched.filter(request => request.role === "creator").reduce((sum, request) => sum + request.policy.sessionLimitCents, 0)).toBe(150);
    expect(test.stages.get("verification")!.artifacts[0]).toMatchObject({ sourceDependencies: [{ artifactId: test.stages.get("research")!.artifacts[0]!.artifactId }] });
    expect(test.finished()).toEqual({ state: "succeeded", errorCode: null });
    expect(test.log.every(call => !call.name.includes("settle") && call.name !== "finish_job")).toBe(true);
    expect(test.prepared()?.candidates).toHaveLength(100);
  });
  it("continues explicitly local creative work with the real partial pack without inventing sources or facts", async () => {
    const test = createInertNamingHarness({ localPrototype: true, partialResearch: true });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic", localPrototype: true })).toBe("succeeded");
    expect(test.stages.get("research")!.artifacts[0]).toMatchObject({ readiness: "partial", sources: [], output: { facts: [] }, providerReceipt: { budgetControl: "local_unlimited_v1" } });
    expect(test.dispatched.map(request => request.role)).toEqual(["researcher", "director", "creator", "creator", "curator", "verifier"]);
    expect(namingPreparedSetSchema.parse(test.prepared()?.preparedSet).candidateIds).toHaveLength(100);
  });
  it("retains the sourced-research requirement for ordinary unmarked execution", async () => {
    const test = createInertNamingHarness({ partialResearch: true });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("partial");
    expect(test.dispatched.map(request => request.role)).toEqual(["researcher"]); expect(test.prepared()).toBeNull();
  });
  it("freezes one gap in ordered 10/40/5/20-cent phases from the saved real deficit", async () => {
    const test = createInertNamingHarness({ initialCount: 60 });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("succeeded");
    const calls = test.dispatched.filter(request => request.stageKey === "gap");
    expect(calls.map(request => request.policy.sessionLimitCents)).toEqual([10, 40, 5, 20]);
    expect(calls.map(request => request.policy.maxWebSearchCalls)).toEqual([0, 0, 0, 8]);
    expect(calls[0]!.input).toMatchObject({ role: "director", gapContext: { missingCount: 40, currentPool: expect.any(Array) } });
    expect(namingPreparedSetSchema.parse(test.prepared()?.preparedSet).candidateIds).toHaveLength(100);
    expect(test.stages.get("gap")!.callPlans.map(plan => plan.phase)).toEqual(["direction", "creation", "curation", "verification"]);
  });
  it("prepares the reviewed partial pool through the real prepare stage after a known gap cap failure", async () => {
    const test = createInertNamingHarness({ initialCount: 60, failGap: true });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("succeeded");
    expect(namingPreparedSetSchema.parse(test.prepared()?.preparedSet).fulfillment.status).toBe("partial");
    expect(test.stages.get("gap")!.artifacts).toHaveLength(0); expect(test.stages.get("prepare")!.state).toBe("succeeded");
    expect(test.dispatched.filter(request => request.stageKey === "gap")).toHaveLength(1);
  });
  it("observes issued uncertainty while readiness is disabled without creating a replacement", async () => {
    const test = createInertNamingHarness({ lostCreator: true });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("needs_reconciliation");
    const dispatched = test.dispatched.length; test.reclaim(); test.setReady(false);
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("needs_reconciliation");
    expect(test.observed.length).toBeGreaterThan(0); expect(test.dispatched).toHaveLength(dispatched); expect(test.prepared()).toBeNull();
  });
});

describe("Naming original unissued allocation recovery", () => {
  it.each([false, true])("observes every issued initial Creator before aggregating a known cancellation (unknown sibling: %s)", async unknownSibling => {
    const test = createInertNamingHarness({ lostCreator: true });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("needs_reconciliation");
    const stage = test.stages.get("creation")!, dispatched = test.dispatched.length;
    expect(stage.requests).toHaveLength(2); test.reclaim(); test.setReady(false);
    let observed = 0;
    vi.spyOn(test.runtime, "resumeStage").mockImplementation(async (receipt, hooks) => {
      const current = observed++;
      if (unknownSibling && current === 1) return { status: "unresolved", code: "synthetic_unknown_sibling", receipt, partialArtifacts: [] };
      if (receipt.protocol !== "openai_agents" || !receipt.sessionId || !receipt.turnId || !receipt.agentId) throw Error("Synthetic issued identity missing");
      await hooks.onArtifact({ kind: "provider_turn", providerCallKey: receipt.providerCallKey, sessionId: receipt.sessionId, turnId: receipt.turnId,
        turn: { id: receipt.turnId, session_id: receipt.sessionId, agent_id: receipt.agentId, subagent_id: null, object: "agent.session.turn", status: "cancelled" } });
      return { status: "cancelled", code: "provider_turn_cancelled", receipt, partialArtifacts: [] };
    });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe(unknownSibling ? "needs_reconciliation" : "partial");
    expect(observed).toBe(2); expect(test.dispatched).toHaveLength(dispatched);
    expect(stage.state).toBe(unknownSibling ? "ambiguous" : "failed"); expect(test.prepared()).toBeNull();
    expect(test.jobRow.reserved_cost_microusd).toBe(5_000_000);
  });
  it("reuses the completed assignment and unlocks only the original unissued call", async () => {
    const test = createInertNamingHarness({ stopBeforePrepare: true });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("lease_lost");
    const creation = test.stages.get("creation")!, retained = creation.artifacts[0]!, retainedCall = retained.providerReceipt.providerCallKey;
    creation.artifacts = [retained]; creation.requests = creation.requests.filter(row => row.providerCallKey === retainedCall); creation.receipts = creation.receipts.filter(row => row.providerCallKey === retainedCall); creation.providerTurns = creation.providerTurns.filter(row => row.providerCallKey === retainedCall); creation.state = "ambiguous";
    for (const key of ["curation", "verification", "gap", "prepare"] as const) { const stage = test.stages.get(key)!; stage.state = "pending"; stage.startedAt = null; stage.artifacts = []; stage.requests = []; stage.receipts = []; stage.providerTurns = []; stage.callPlans = []; }
    const before = test.dispatched.length; test.reclaim();
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("succeeded");
    const repeated = test.dispatched.slice(before);
    expect(repeated.filter(row => row.role === "creator")).toHaveLength(1);
    expect(repeated.every(row => row.providerCallKey !== retainedCall)).toBe(true);
    expect(test.log.some(row => row.action === "resume_execution")).toBe(true);
  });
});

describe("RT1/RT3 bounded terminal outcomes", () => {
  it.each(["json", "schema"] as const)("retains exact known-completed invalid %s evidence for an initial Director", async invalidInitialDirector => {
    const test = createInertNamingHarness({ invalidInitialDirector });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("partial");
    const stage = test.stages.get("direction")!;
    expect(stage.state).toBe("failed"); expect(stage.artifacts).toEqual([]);
    expect(stage.providerTurns).toContainEqual(expect.objectContaining({ turn: expect.objectContaining({ status: "completed" }) }));
    expect(test.stageResults.get("direction")).toMatchObject({ errorCode: "provider_output_invalid", partialArtifacts: expect.arrayContaining([
      expect.objectContaining({ providerCallKey: "direction-director", status: "failed", code: "provider_output_invalid", receipt: expect.objectContaining({ dispatchState: "dispatched", confirmedActualCostMicrousd: null }) }),
    ]) });
    expect(test.dispatched.some(request => request.role === "creator")).toBe(false);
    expect(test.prepared()).toBeNull(); expect(test.jobRow.reserved_cost_microusd).toBe(5_000_000);
  });
  it("blocks later inference when the real SDK reports overrun only after the Creator Turn", async () => {
    const test = createInertNamingHarness({ lateCreatorOverrun: true });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("needs_reconciliation");
    expect(test.dispatched.some(request => ["curator", "verifier"].includes(request.role))).toBe(false);
    expect(test.stages.get("creation")!.receipts.some(receipt => receipt.providerCostCounters.some(counter => counter.value > receipt.sessionLimitCents))).toBe(true);
    expect(test.stages.get("creation")!.providerItems.length).toBeGreaterThan(0);
    expect(test.prepared()).toBeNull(); expect(test.jobRow.reserved_cost_microusd).toBe(5_000_000);
    expect(test.stages.get("creation")!.receipts.every(receipt => receipt.confirmedActualCostMicrousd === null)).toBe(true);
  });
  it.each([ ["director", "json"], ["director", "schema"], ["verifier", "json"], ["verifier", "schema"] ] as const)("prepares the initial reviewed pool after genuine completed gap %s has invalid %s output", async (role, kind) => {
    const test = createInertNamingHarness({ initialCount: 60, invalidGap: { role, kind } });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("succeeded");
    const prepared = namingPreparedSetSchema.parse(test.prepared()?.preparedSet);
    expect(prepared.fulfillment).toMatchObject({ status: "partial", acceptedCount: 60, missingCount: 40 });
    expect(test.stages.get("gap")!.artifacts.some(artifact => artifact.output.role === role)).toBe(false);
    const failure = test.stageResults.get("gap")!;
    expect(failure).toMatchObject({ errorCode: "gap_incomplete", partialArtifacts: expect.arrayContaining([expect.objectContaining({ providerCallKey: `gap-${role}`, status: "failed", code: "provider_output_invalid", receipt: expect.objectContaining({ dispatchState: "dispatched", confirmedActualCostMicrousd: null }) })]) });
    const invalid = failure.partialArtifacts!.find(value => value && typeof value === "object" && "code" in value && value.code === "provider_output_invalid");
    if (!invalid || typeof invalid !== "object" || !("receipt" in invalid)) throw Error("Missing exact invalid-output evidence");
    expect(test.stages.get("gap")!.receipts).toContainEqual(invalid.receipt);
    expect(test.dispatched.filter(request => request.stageKey === "gap")).toHaveLength(role === "director" ? 1 : 4);
    expect(test.stages.get("prepare")!.state).toBe("succeeded");
    expect(test.jobRow.reserved_cost_microusd).toBe(5_000_000);
    expect(test.stages.get("gap")!.receipts.every(receipt => receipt.confirmedActualCostMicrousd === null)).toBe(true);
  });
  it("recovers completed-invalid gap evidence in observe-only mode and runs only registered prepare without paid readiness", async () => {
    const test = createInertNamingHarness({ initialCount: 60, invalidGap: { role: "director", kind: "json", recover: true } });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("needs_reconciliation");
    const before = test.dispatched.length; test.reclaim(); test.setReady(false);
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("succeeded");
    expect(test.dispatched).toHaveLength(before); expect(test.log.some(row => row.action === "resume_execution")).toBe(false);
    expect(namingPreparedSetSchema.parse(test.prepared()?.preparedSet).candidateIds).toHaveLength(60);
    expect(test.stages.get("prepare")!.state).toBe("succeeded");
  });
  it.each(["unknownGap", "inflightGap", "lateGapOverrun"] as const)("keeps %s held and cannot prepare the partial pool", async failure => {
    const test = createInertNamingHarness({ initialCount: 60, [failure]: true });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("needs_reconciliation");
    expect(test.prepared()).toBeNull(); expect(test.stages.get("prepare")!.state).toBe("pending");
    expect(test.jobRow.reserved_cost_microusd).toBe(5_000_000);
  });
});


it("cannot prepare completed-invalid gap work after durable Stop during observation recovery", async () => {
  const test = createInertNamingHarness({ initialCount: 60, invalidGap: { role: "director", kind: "json", recover: true } });
  expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("needs_reconciliation");
  const before = test.dispatched.length; test.reclaim(); test.setReady(false); test.jobRow.state = "cancel_requested";
  await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" });
  expect(test.dispatched).toHaveLength(before); expect(test.prepared()).toBeNull();
  expect(test.stages.get("prepare")!.state).toBe("pending"); expect(test.finished()).toMatchObject({ state: "cancelled" });
  expect(test.jobRow.reserved_cost_microusd).toBe(5_000_000);
});

it("decodes the coordinated immutable stage-result history and rejects a foreign run binding", async () => {
  const test = createInertNamingHarness();
  const job = (await test.store.claim("synthetic", 120))!;
  const stage = test.stages.get("gap")!, result = { id: crypto.randomUUID(), run_id: test.input.runId, stage_key: "gap" as const, state: "ambiguous" as const, output: { artifactIds: [], errorCode: "synthetic_incomplete" }, created_at: new Date().toISOString() };
  stage.stageResults = [result]; stage.observationDeadlineAt = new Date(Date.now() + 60_000).toISOString();
  expect(await test.store.loadStage(job, "gap")).toMatchObject({ stageResults: [result], observationDeadlineAt: stage.observationDeadlineAt });
  stage.stageResults = [{ ...result, run_id: crypto.randomUUID() }];
  await expect(test.store.loadStage(job, "gap")).rejects.toThrow("naming_stage_result_mismatch");
});

describe("RT3 complete issued Creator closure during observation recovery", () => {
  it.each(["both_invalid", "invalid_valid", "invalid_unknown", "invalid_inflight"] as const)("classifies both existing calls for %s without funding or dispatching more work", async gapCreatorRecovery => {
    const test = createInertNamingHarness({ initialCount: 60, gapCreatorRecovery });
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("needs_reconciliation");
    const gap = test.stages.get("gap")!, creators = gap.requests.filter(request => request.role === "creator");
    expect(creators).toHaveLength(2); expect(creators.map(request => request.policy.sessionLimitCents)).toEqual([20, 20]);
    expect(gap.artifacts.filter(artifact => artifact.output.role === "creator")).toHaveLength(0);
    const before = test.dispatched.length, logOffset = test.log.length; test.reclaim(); test.setReady(false);
    const state = await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" });
    expect(test.observed).toEqual(creators.map(request => request.providerCallKey));
    expect(test.dispatched).toHaveLength(before); expect(test.providerToolReplies()).toBe(0);
    expect(test.log.slice(logOffset).some(row => row.action === "call_plan" || row.action === "resume_execution" || row.name === "authorize_naming_brain_dispatch")).toBe(false);
    expect(test.jobRow.reserved_cost_microusd).toBe(5_000_000);
    expect(gap.receipts.every(receipt => receipt.confirmedActualCostMicrousd === null)).toBe(true);
    const failures = test.stageResults.get("gap")!.partialArtifacts!.filter(value => value && typeof value === "object" && "code" in value && value.code === "provider_output_invalid");
    expect(failures).toHaveLength(gapCreatorRecovery === "both_invalid" ? 2 : 1);
    if (gapCreatorRecovery === "both_invalid" || gapCreatorRecovery === "invalid_valid") {
      expect(state).toBe("succeeded");
      expect(namingPreparedSetSchema.parse(test.prepared()?.preparedSet).fulfillment).toMatchObject({ status: "partial", acceptedCount: 60, missingCount: 40 });
      expect(test.stages.get("prepare")!.state).toBe("succeeded");
      expect(gap.artifacts.filter(artifact => artifact.output.role === "creator")).toHaveLength(gapCreatorRecovery === "invalid_valid" ? 1 : 0);
      expect(gap.artifacts.some(artifact => artifact.output.role === "curator" || artifact.output.role === "verifier")).toBe(false);
    } else {
      expect(state).toBe("needs_reconciliation"); expect(test.prepared()).toBeNull(); expect(test.stages.get("prepare")!.state).toBe("pending");
    }
  });
});

it("reuses committed preparation after a lost ACK before own prepared names enter reassembly", async () => {
  const test = createInertNamingHarness({ lostPrepareAck: true });
  expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("partial");
  const original = structuredClone(test.prepared());
  expect(namingPreparedSetSchema.parse(original?.preparedSet).candidateIds).toHaveLength(100);
  expect(test.historicalIdentityKeys()).toHaveLength(100);
  const before = test.dispatched.length, logOffset = test.log.length;
  test.reclaim(); test.setReady(false);
  expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("succeeded");
  expect(test.prepared()).toEqual(original); expect(test.dispatched).toHaveLength(before);
  expect(test.stages.get("prepare")!.state).toBe("succeeded");
  expect(test.log.slice(logOffset).some(row => ["index_page", "identities", "prepare", "resume_execution"].includes(row.action ?? ""))).toBe(false);
  expect(test.historicalIdentityKeys()).toHaveLength(100); expect(test.jobRow.reserved_cost_microusd).toBe(5_000_000);
});


it.each(["run", "snapshot", "stage"] as const)("rejects an existing preparation with a foreign %s binding", async field => {
  const test = createInertNamingHarness({ lostPrepareAck: true });
  await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" });
  const saved = test.stages.get("prepare")!.preparation!;
  if (field === "run") saved.preparedSet = { ...saved.preparedSet, runId: crypto.randomUUID() };
  if (field === "snapshot") saved.preparedSet = { ...saved.preparedSet, snapshotHash: "b".repeat(64) };
  if (field === "stage") test.stages.get("gap")!.preparation = saved;
  test.reclaim(); const job = (await test.store.claim("synthetic", 120))!;
  await expect(test.store.loadStage(job, field === "stage" ? "gap" : "prepare")).rejects.toThrow("naming_preparation_mismatch");
});
