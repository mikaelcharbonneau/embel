import { afterEach, describe, expect, it, vi } from "vitest";
import { runOneJob, type JobStore } from "../../worker/runner";
import type { ClaimedJob, StepOutcome } from "../../src/domain/jobs";

// Explicit local fixtures. No real provider, credential, or billing request is used.
const job: ClaimedJob = {
  id: "11111111-1111-4111-8111-111111111111", ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId: "22222222-2222-4222-8222-222222222222", operation: "qa_fixture",
  input: {}, inputRevision: 1, leaseToken: "33333333-3333-4333-8333-333333333333",
  status: "running", reservedCostMicrousd: 100, actualCostMicrousd: 0,
};
const result = { fixture: true, retainedResult: "An original, locally generated test result" };
function fixture() {
  const outcomes: StepOutcome[] = [];
  const store: JobStore = {
    claim: vi.fn(async () => ({ ...job })),
    registerPlan: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => ({ cancelled: false })),
    beginStep: vi.fn(async () => "started" as const),
    completeStep: vi.fn(async (_job, _key, outcome) => { outcomes.push(outcome); }),
    finish: vi.fn(async () => {}),
  };
  return { store, outcomes };
}

afterEach(() => { vi.useRealTimers(); });

describe("independent adversarial worker checks", () => {
  it("retains a successful provider result when unexpected cost requires reconciliation", async () => {
    const { store, outcomes } = fixture();
    const handlers = new Map([[job.operation, { steps: () => [{ key: "first", maximumCostMicrousd: 100,
      execute: async () => ({ status: "succeeded" as const, result, costMicrousd: 120, providerRequestId: "qa-fixture-request" }),
    }] }]]);
    expect(await runOneJob({ store, handlers, workerId: "qa-local" })).toBe("needs_reconciliation");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ costMicrousd: 120, providerRequestId: "qa-fixture-request", result });
    expect(store.finish).not.toHaveBeenCalled();
  });

  it("bounds cancellation even when a provider ignores AbortSignal", async () => {
    vi.useFakeTimers();
    const { store } = fixture();
    let completeProvider!: (outcome: StepOutcome) => void;
    const provider = new Promise<StepOutcome>(resolve => { completeProvider = resolve; });
    let providerSignal: AbortSignal | undefined;
    let settled = false;
    const handlers = new Map([[job.operation, { steps: () => [{ key: "first", maximumCostMicrousd: 100,
      execute: ({ signal }: { signal: AbortSignal }) => { providerSignal = signal; return provider; },
    }] }]]);
    const running = runOneJob({ store, handlers, workerId: "qa-local", leaseSeconds: 10, heartbeatMs: 100, abortGraceMs: 20 })
      .then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(providerSignal).toBeDefined();
    vi.mocked(store.heartbeat).mockResolvedValue({ cancelled: true });
    await vi.advanceTimersByTimeAsync(200);
    const snapshot = { aborted: providerSignal?.aborted, settled, heartbeats: vi.mocked(store.heartbeat).mock.calls.length };
    // Always release the fixture before asserting, so a detected defect leaves no hanging work.
    completeProvider({ status: "succeeded", result, costMicrousd: 1, providerRequestId: "qa-local" });
    await running;
    expect(snapshot.aborted).toBe(true);
    expect(snapshot.settled, `A cancelled provider held its lease across ${snapshot.heartbeats} renewals`).toBe(true);
  });

  it("bounds an unresponsive provider without cancellation and fences its late success", async () => {
    vi.useFakeTimers();
    const { store, outcomes } = fixture();
    let completeProvider!: (outcome: StepOutcome) => void;
    const provider = new Promise<StepOutcome>(resolve => { completeProvider = resolve; });
    let providerSignal: AbortSignal | undefined;
    let settled = false;
    const handlers = new Map([[job.operation, { steps: () => [{ key: "first", maximumCostMicrousd: 100, timeoutMs: 25,
      execute: ({ signal }: { signal: AbortSignal }) => { providerSignal = signal; return provider; },
    }] }]]);
    const running = runOneJob({ store, handlers, workerId: "qa-local", heartbeatMs: 100, abortGraceMs: 20 })
      .then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(50);
    const snapshot = { settled, aborted: providerSignal?.aborted, completions: vi.mocked(store.completeStep).mock.calls.length };
    completeProvider({ status: "succeeded", result, costMicrousd: 1, providerRequestId: "qa-late-result" });
    await running;
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toEqual({ settled: true, aborted: true, completions: 1 });
    expect(outcomes[0]).toMatchObject({ status: "needs_reconciliation" });
    expect(store.completeStep).toHaveBeenCalledTimes(1);
    expect(store.finish).not.toHaveBeenCalled();
  });

  it("returns on lease loss despite an abort-ignoring provider and never persists late output", async () => {
    vi.useFakeTimers();
    const { store } = fixture();
    let completeProvider!: (outcome: StepOutcome) => void;
    const provider = new Promise<StepOutcome>(resolve => { completeProvider = resolve; });
    const handlers = new Map([[job.operation, { steps: () => [{ key: "first", maximumCostMicrousd: 100, execute: () => provider }] }]]);
    let settled = false;
    const running = runOneJob({ store, handlers, workerId: "qa-local", heartbeatMs: 100, abortGraceMs: 20 })
      .then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(store.heartbeat).mockRejectedValue(new Error("qa-lost-lease"));
    await vi.advanceTimersByTimeAsync(200);
    const settledBeforeProvider = settled;
    completeProvider({ status: "succeeded", result, costMicrousd: 1, providerRequestId: "qa-late-result" });
    const returned = await running;
    expect(settledBeforeProvider).toBe(true);
    expect(returned).toBe("lease_lost");
    expect(store.completeStep).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
  });

  it("does not dispatch after shutdown occurs while the step intent is being persisted", async () => {
    const { store } = fixture();
    const shutdown = new AbortController();
    vi.mocked(store.beginStep).mockImplementation(async () => { shutdown.abort(); return "started"; });
    const execute = vi.fn(async () => ({ status: "succeeded" as const, result, costMicrousd: 1, providerRequestId: null }));
    const handlers = new Map([[job.operation, { steps: () => [{ key: "first", maximumCostMicrousd: 100, execute }] }]]);
    await runOneJob({ store, handlers, workerId: "qa-local", signal: shutdown.signal, abortGraceMs: 0 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unsafe timer values and leases outside the database limits before claiming work", async () => {
    const { store } = fixture();
    const execute = vi.fn(async () => ({ status: "succeeded" as const, result, costMicrousd: 1, providerRequestId: null }));
    const handlers = new Map([[job.operation, { steps: () => [{ key: "first", maximumCostMicrousd: 100, execute }] }]]);
    const invalid = [
      { leaseSeconds: NaN }, { leaseSeconds: Infinity }, { leaseSeconds: 301 }, { leaseSeconds: 9 }, { leaseSeconds: 10.5 },
      { heartbeatMs: NaN }, { heartbeatMs: Infinity }, { heartbeatMs: 0 },
      { abortGraceMs: -1 }, { abortGraceMs: 0.5 }, { abortGraceMs: 30_001 },
    ];
    for (const options of invalid) await expect(runOneJob({ store, handlers, workerId: "qa-local", ...options })).rejects.toThrow();
    expect(store.claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an unbounded or malformed provider deadline before dispatch", async () => {
    for (const timeoutMs of [NaN, Infinity, -1, 0, 0.5, 3_600_001]) {
      const { store } = fixture();
      const execute = vi.fn(async () => ({ status: "succeeded" as const, result, costMicrousd: 1, providerRequestId: null }));
      const handlers = new Map([[job.operation, { steps: () => [{ key: "first", maximumCostMicrousd: 100, timeoutMs, execute }] }]]);
      expect(await runOneJob({ store, handlers, workerId: "qa-local" })).toBe("failed");
      expect(store.beginStep).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    }
  });
});
