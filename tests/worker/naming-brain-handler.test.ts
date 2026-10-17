import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { runOneJob } from "../../worker/runner";
import { namingPreparedSetSchema } from "../../src/domain/naming-brain";
import { createInertNamingHarness } from "./naming-brain-handler-fixture";

describe("Naming seven-stage scoped worker", () => {
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
  it("reuses the completed assignment and unlocks only the original unissued call", async () => {
    const test = createInertNamingHarness();
    expect(await runOneJob({ store: test.store, handlers: test.handlers, workerId: "synthetic" })).toBe("succeeded");
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
