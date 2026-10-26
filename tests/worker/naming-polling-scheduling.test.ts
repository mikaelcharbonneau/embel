import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { runOneJob } from "../../worker/runner";
import { namingErrorDelay, runNamingPolling } from "../../services/naming-worker/scheduling";

afterEach(() => vi.useRealTimers());
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const controller = new AbortController(), calls: { operation: string; at: number }[] = [];
  const database = { query: vi.fn(async (sql: string) => {
    const operation = sql.match(/public\.([a-z_]+)/)?.[1];
    if (!operation) throw new Error("unexpected_synthetic_sql");
    calls.push({ operation, at: Date.now() });
    return { rows: [{ result: operation === "get_naming_brain_preference_work" ? []
      : operation === "claim_naming_brain_job" ? null : 0 }] };
  }) };
  const store = new NamingBrainJobStore(database, "synthetic-polling-deployment");
  const handlers = new Map([["naming.generate", { steps: () => [] }]]);
  const options = { signal: controller.signal, generation: () => 1,
    attestPreferences: () => store.attestPendingPreferences(), expireLeases: () => store.expireLeases("fixture-worker"),
    runJob: () => runOneJob({ store, handlers, workerId: "fixture-worker", signal: controller.signal }),
    now: () => Date.now(), random: () => 1 };
  return { controller, calls, database, store, options };
}

describe("Naming polling schedules through the actual scoped store adapter", () => {
  it("bounds a steady idle minute to12 claims,4 preference scans and4 expiry RPCs", async () => {
    const f = fixture(), pending = runNamingPolling(f.options);
    await vi.advanceTimersByTimeAsync(120_000);
    const minute = f.calls.filter(call => call.at >= 60_000 && call.at < 120_000);
    expect(minute.filter(call => call.operation === "claim_naming_brain_job")).toHaveLength(12);
    expect(minute.filter(call => call.operation === "get_naming_brain_preference_work")).toHaveLength(4);
    expect(minute.filter(call => call.operation === "expire_naming_brain_leases")).toHaveLength(4);
    const claims = f.calls.filter(call => call.operation === "claim_naming_brain_job").map(call => call.at);
    expect(claims.slice(0, 5)).toEqual([0, 1000, 3000, 7000, 12000]);
    expect(Math.max(...claims.slice(1).map((at, index) => at - claims[index]!))).toBe(5000);
    f.controller.abort(); await pending;
  });

  it("keeps maintenance due during one long job, with no overlapping attestation/expiry or catch-up burst", async () => {
    const f = fixture(), job = deferred<"needs_reconciliation">();
    let maintenanceActive = 0, maximum = 0;
    const attestPreferences = vi.fn(async () => { maximum = Math.max(maximum, ++maintenanceActive);
      await new Promise(resolve => setTimeout(resolve, 20_000)); maintenanceActive--; });
    const expireLeases = vi.fn(async () => { maximum = Math.max(maximum, ++maintenanceActive);
      await new Promise(resolve => setTimeout(resolve, 1000)); maintenanceActive--; });
    const runJob = vi.fn(() => job.promise);
    const pending = runNamingPolling({ ...f.options, attestPreferences, expireLeases, runJob });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(runJob).toHaveBeenCalledOnce(); expect(maximum).toBe(1);
    expect(attestPreferences).toHaveBeenCalledTimes(2); expect(expireLeases).toHaveBeenCalledTimes(2);
    f.controller.abort(); job.resolve("needs_reconciliation"); await vi.advanceTimersByTimeAsync(1000); await pending;
  });

  it("backs off each failed control-plane operation without a hot loop or private-error diagnostics", async () => {
    const f = fixture(), diagnostics = vi.fn();
    f.database.query.mockRejectedValue(new Error("synthetic-private-connection-detail"));
    const pending = runNamingPolling({ ...f.options, onError: diagnostics });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.database.query).toHaveBeenCalledTimes(21); // seven attempts per lane:0,1,3,7,15,31,63s
    expect(new Set(diagnostics.mock.calls.map(([operation]) => operation))).toEqual(new Set(["preferences", "expiry", "claim"]));
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("private");
    f.controller.abort(); await pending;
  });

  it("performs no Naming RPC while a follower, then wakes within five seconds of authority", async () => {
    const f = fixture(); let leader = false;
    const pending = runNamingPolling({ ...f.options, generation: () => leader ? 1 : null });
    await vi.advanceTimersByTimeAsync(120_000); expect(f.database.query).not.toHaveBeenCalled();
    leader = true; await vi.advanceTimersByTimeAsync(5000);
    expect(f.calls.find(call => call.operation === "claim_naming_brain_job")!.at).toBeLessThanOrEqual(125_000);
    f.controller.abort(); await pending;
  });

  it("treats lease loss as backoff and never retries a paid create itself", async () => {
    const f = fixture(), runJob = vi.fn(async () => "lease_lost" as const);
    const pending = runNamingPolling({ ...f.options, runJob });
    await vi.advanceTimersByTimeAsync(60_000); expect(runJob).toHaveBeenCalledTimes(6);
    expect(f.calls.every(call => !call.operation.includes("authorize") && !call.operation.includes("receipt"))).toBe(true);
    f.controller.abort(); await pending;
  });

  it("fences new work immediately on stop and drains already-running maintenance and job work", async () => {
    const f = fixture(), attestation = deferred<void>(), job = deferred<"needs_reconciliation">();
    const expireLeases = vi.fn(async () => 0), runJob = vi.fn(() => job.promise);
    const attestPreferences = vi.fn<() => Promise<void>>().mockResolvedValueOnce(undefined).mockReturnValueOnce(attestation.promise);
    let stopped = false;
    const pending = runNamingPolling({ ...f.options, attestPreferences, expireLeases, runJob }).then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(15_001); f.controller.abort(); await vi.advanceTimersByTimeAsync(120_000);
    expect(stopped).toBe(false); expect(expireLeases).toHaveBeenCalledOnce(); expect(runJob).toHaveBeenCalledOnce();
    attestation.resolve(); job.resolve("needs_reconciliation"); await pending;
    expect(stopped).toBe(true); await vi.advanceTimersByTimeAsync(120_000); expect(runJob).toHaveBeenCalledOnce();
  });

  it("never claims when stopped during the initial scoped preference pass", async () => {
    const f = fixture(), attestation = deferred<void>(), runJob = vi.fn(async () => "idle" as const);
    const pending = runNamingPolling({ ...f.options, attestPreferences: () => attestation.promise, runJob });
    await vi.advanceTimersByTimeAsync(1); expect(runJob).not.toHaveBeenCalled();
    f.controller.abort(); attestation.resolve(); await pending; expect(runJob).not.toHaveBeenCalled();
  });

  it("bootstraps a new generation before claims after leader loss and reacquisition", async () => {
    const f = fixture(), secondPass = deferred<void>(); let generation: number | null = 1;
    const events: string[] = [];
    const attestPreferences = vi.fn(async () => { events.push(`preferences:${generation}`); if (generation === 2) await secondPass.promise; });
    const runJob = vi.fn(async () => { events.push(`claim:${generation}`); return "idle" as const; });
    const pending = runNamingPolling({ ...f.options, generation: () => generation, attestPreferences, runJob });
    await vi.advanceTimersByTimeAsync(2000); generation = null; await vi.advanceTimersByTimeAsync(1001);
    generation = 2; await vi.advanceTimersByTimeAsync(5000);
    expect(events).toContain("preferences:2"); expect(events).not.toContain("claim:2");
    secondPass.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(events.indexOf("claim:2")).toBeGreaterThan(events.indexOf("preferences:2"));
    f.controller.abort(); await pending;
  });

  it("does not let a late old-generation preference result release the new generation's claim lane", async () => {
    const f = fixture(), old = deferred<void>(), fresh = deferred<void>(); let generation = 1;
    const attestPreferences = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const runJob = vi.fn(async () => "idle" as const);
    const pending = runNamingPolling({ ...f.options, generation: () => generation, attestPreferences, runJob });
    await vi.advanceTimersByTimeAsync(1); generation = 2; await vi.advanceTimersByTimeAsync(5000);
    old.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(attestPreferences).toHaveBeenCalledTimes(2); expect(runJob).not.toHaveBeenCalled();
    fresh.resolve(); await vi.advanceTimersByTimeAsync(0); expect(runJob).toHaveBeenCalledOnce();
    f.controller.abort(); await pending;
  });

  it.each(["error", "lease_lost"] as const)("discards old-generation job %s backoff after a new generation bootstraps, without overlapping runners", async result => {
    const f = fixture(), old = deferred<"lease_lost">(); let generation = 1, active = 0, maximum = 0;
    const events: { generation: number; at: number }[] = [];
    const runJob = vi.fn(async () => {
      maximum = Math.max(maximum, ++active); events.push({ generation, at: Date.now() });
      try {
        if (events.length <= 6) return "lease_lost" as const;
        if (generation === 1) return await old.promise;
        return "idle" as const;
      } finally { active--; }
    });
    const attestPreferences = vi.fn(async () => 0);
    const pending = runNamingPolling({ ...f.options, generation: () => generation, runJob, attestPreferences });
    await vi.advanceTimersByTimeAsync(63_001); expect(runJob).toHaveBeenCalledTimes(7);
    generation = 2; await vi.advanceTimersByTimeAsync(2000);
    const settledAt = Date.now(); if (result === "error") old.reject(new Error("synthetic_old_generation_failure")); else old.resolve("lease_lost");
    await vi.advanceTimersByTimeAsync(0);
    expect(events.find(event => event.generation === 2)?.at).toBeLessThanOrEqual(settledAt + 5000);
    expect(maximum).toBe(1); f.controller.abort(); await pending;
  });

  it("uses monotonic deadlines despite a backwards wall-clock jump", async () => {
    const f = fixture(); let monotonic = 0;
    const pending = runNamingPolling({ ...f.options, now: () => monotonic });
    for (let i = 0; i < 60; i++) { monotonic += 1000; await vi.advanceTimersByTimeAsync(1000); }
    const before = f.calls.length; vi.setSystemTime(-1_000_000);
    for (let i = 0; i < 60; i++) { monotonic += 1000; await vi.advanceTimersByTimeAsync(1000); }
    expect(f.calls.length - before).toBe(20);
    f.controller.abort(); await pending;
  });
});

it("keeps outage jitter bounded and nonzero even for bad random sources", () => {
  expect(namingErrorDelay(0, () => 0)).toBe(800); expect(namingErrorDelay(0, () => 1)).toBe(1000);
  expect(namingErrorDelay(100, () => 1)).toBe(60_000); expect(namingErrorDelay(100, () => NaN)).toBe(60_000);
});
