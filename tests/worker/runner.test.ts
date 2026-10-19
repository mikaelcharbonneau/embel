import { describe, expect, it, vi } from "vitest";
import { NotDispatchedError, runOneJob, type JobHandler, type JobStore } from "../../worker/runner";
import type { ClaimedJob, StepOutcome } from "../../src/domain/jobs";

const job: ClaimedJob = { id: "job-1", ownerId: "alice", projectId: "brand-1", operation: "fixture", input: {}, inputRevision: 1, leaseToken: "fence-1", status: "running", reservedCostMicrousd: 100, actualCostMicrousd: 0 };
const success: StepOutcome = { status: "succeeded", result: { label: "TEST FIXTURE, not AI" }, costMicrousd: 20, providerRequestId: "fixture-1" };
function fixture() {
  const results: StepOutcome[] = [];
  const store: JobStore = {
    claim: vi.fn(async () => structuredClone(job)),
    registerPlan: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => ({ cancelled: false })),
    beginStep: vi.fn(async () => "started" as const),
    completeStep: vi.fn(async (_, __, outcome) => { results.push(outcome); }),
    finish: vi.fn(async () => {}),
  };
  const execute = vi.fn(async () => success);
  const handler: JobHandler = { steps: () => [{ key: "first", maximumCostMicrousd: 25, execute }] };
  const handlers = new Map([["fixture", handler]]);
  return { store, results, execute, handler, options: { store, handlers, workerId: "fixture-worker" } };
}

describe("durable worker boundaries", () => {
  it("does not consume jobs until a real handler is registered", async () => {
    const f = fixture();
    expect(await runOneJob({ ...f.options, handlers: new Map() })).toBe("idle");
    expect(f.store.claim).not.toHaveBeenCalled();
  });
  it("persists an intent before executing, then records output before success", async () => {
    const f = fixture();
    expect(await runOneJob(f.options)).toBe("succeeded");
    expect(vi.mocked(f.store.beginStep).mock.invocationCallOrder[0]).toBeLessThan(f.execute.mock.invocationCallOrder[0]!);
    expect(vi.mocked(f.store.completeStep).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.store.finish).mock.invocationCallOrder[0]!);
    expect(f.results).toEqual([success]);
  });
  it("does not dispatch or publish after a lost lease", async () => {
    const f = fixture(); vi.mocked(f.store.heartbeat).mockRejectedValue(new Error("lost"));
    expect(await runOneJob(f.options)).toBe("lease_lost");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.store.finish).not.toHaveBeenCalled();
  });
  it("retains partial results when a later step definitely did not dispatch", async () => {
    const f = fixture();
    f.handler.steps = () => [{ key: "one", maximumCostMicrousd: 25, execute: f.execute }, { key: "two", maximumCostMicrousd: 25, execute: async () => { throw new NotDispatchedError(); } }];
    expect(await runOneJob(f.options)).toBe("partial");
    expect(f.results[0]).toEqual(success);
    expect(f.results[1]?.status).toBe("failed");
  });
  it("does not retry an ambiguous provider timeout", async () => {
    const f = fixture(); f.execute.mockRejectedValue(new Error("timeout after submission"));
    expect(await runOneJob(f.options)).toBe("needs_reconciliation");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.results[0]?.status).toBe("needs_reconciliation");
  });
  it.each(["53300", "57014"])("contains %s after dispatch so maintenance cannot repeat a leased execution", async code => {
    const f = fixture(); f.execute.mockRejectedValue(Object.assign(new Error("synthetic database failure after dispatch"), { code }));
    expect(await runOneJob({ ...f.options, localPrototype: true })).toBe("needs_reconciliation");
    expect(f.store.claim).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce();
    expect(f.results[0]?.status).toBe("needs_reconciliation");
  });
  it.each(["timeout expired", "Query read timeout", "timeout exceeded when trying to connect"])("retains a client timeout after dispatch (%s) without leaking it into maintenance retry", async message => {
    const f = fixture(); f.execute.mockRejectedValue(new Error(message));
    expect(await runOneJob({ ...f.options, localPrototype: true })).toBe("needs_reconciliation");
    expect(f.store.claim).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce();
    expect(f.results[0]?.status).toBe("needs_reconciliation");
  });
  it("cancels before dispatch without discarding earlier outputs", async () => {
    const f = fixture(); vi.mocked(f.store.heartbeat).mockResolvedValue({ cancelled: true });
    expect(await runOneJob(f.options)).toBe("cancelled");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("skips already succeeded steps on recovery", async () => {
    const f = fixture(); vi.mocked(f.store.beginStep).mockResolvedValue("already_succeeded");
    expect(await runOneJob(f.options)).toBe("succeeded");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.store.completeStep).not.toHaveBeenCalled();
  });
  it("guards budget before any new request", async () => {
    const f = fixture(); f.handler.steps = () => [{ key: "one", maximumCostMicrousd: 101, execute: f.execute }];
    expect(await runOneJob(f.options)).toBe("failed");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([false, true])("retains actual overage and applies monetary quarantine only outside local prototype (%s)", async localPrototype => {
    const f = fixture(); const overage = { ...success, costMicrousd: 150 };
    f.execute.mockResolvedValue(overage);
    expect(await runOneJob({ ...f.options, localPrototype })).toBe(localPrototype ? "succeeded" : "needs_reconciliation");
    expect(f.results).toEqual([localPrototype ? overage : { ...overage, status: "needs_reconciliation", code: "provider_cost_exceeded" }]);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("executes a local plan and subsequent steps beyond nominal reservations without bypassing intent persistence", async () => {
    const f = fixture(); f.execute.mockResolvedValue({ ...success, costMicrousd: 150 });
    f.handler.steps = () => [{ key: "one", maximumCostMicrousd: 60, execute: f.execute }, { key: "two", maximumCostMicrousd: 60, execute: f.execute }];
    expect(await runOneJob({ ...f.options, localPrototype: true })).toBe("succeeded");
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.results.map(outcome => outcome.costMicrousd)).toEqual([150, 150]);
    expect(vi.mocked(f.store.beginStep).mock.invocationCallOrder[1]).toBeLessThan(f.execute.mock.invocationCallOrder[1]!);
  });
  it.each([-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("retains numeric plan validation in local prototype (%s)", async maximumCostMicrousd => {
    const f = fixture(); f.handler.steps = () => [{ key: "invalid", maximumCostMicrousd, execute: f.execute }];
    expect(await runOneJob({ ...f.options, localPrototype: true })).toBe("failed");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("still quarantines unknown provider execution in local prototype without retry", async () => {
    const f = fixture(); f.execute.mockRejectedValue(new Error("synthetic lost acknowledgement"));
    expect(await runOneJob({ ...f.options, localPrototype: true })).toBe("needs_reconciliation");
    expect(f.results).toMatchObject([{ status: "needs_reconciliation", code: "provider_outcome_unknown" }]);
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.store.finish).not.toHaveBeenCalled();
  });
  it("does not re-reserve the cost of a completed step during recovery", async () => {
    const f = fixture();
    vi.mocked(f.store.claim).mockResolvedValue({ ...job, actualCostMicrousd: 90 });
    vi.mocked(f.store.beginStep).mockResolvedValue("already_succeeded");
    expect(await runOneJob(f.options)).toBe("succeeded");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("continues heartbeat during a long provider call and fences late output", async () => {
    const f = fixture();
    vi.mocked(f.store.heartbeat).mockResolvedValueOnce({ cancelled: false }).mockRejectedValue(new Error("expired"));
    f.execute.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 25)); return success; });
    expect(await runOneJob({ ...f.options, heartbeatMs: 5 })).toBe("lease_lost");
    expect(f.store.completeStep).not.toHaveBeenCalled();
    expect(f.store.finish).not.toHaveBeenCalled();
  });
  it("reconciles malformed outputs rather than silently retrying paid work", async () => {
    const f = fixture(); f.execute.mockResolvedValue({ status: "succeeded", costMicrousd: -1 } as never);
    expect(await runOneJob(f.options)).toBe("needs_reconciliation");
  });
  it("never charges the customer a second time on a lost persistence response", async () => {
    const f = fixture(); vi.mocked(f.store.completeStep).mockRejectedValue(new Error("database disconnected"));
    expect(await runOneJob(f.options)).toBe("lease_lost");
    expect(f.store.completeStep).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.store.finish).not.toHaveBeenCalled();
  });
});
