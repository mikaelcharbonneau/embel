import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readNamingBrainConfiguration, startNamingReadiness } from "../../worker/naming-brain-configuration";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.useRealTimers(); });

describe("Naming independent configuration and readiness", () => {
  it("requires explicit Naming configuration and never borrows Strategy permissions", () => {
    expect(readNamingBrainConfiguration({ FLUID_PAID_CALLS_APPROVED: "true", OPENAI_API_KEY: "synthetic-fixture-key", FLUID_TEXT_MODEL_STRATEGY: "fixture" })).toBeNull();
    const config = readNamingBrainConfiguration({ FLUID_PAID_CALLS_APPROVED: "true", FLUID_NAMING_BRAIN_ENABLED: "true", OPENAI_API_KEY: "synthetic-fixture-key", FLUID_NAMING_BRAIN_MODEL: "fixture", FLUID_OPENAI_VERIFIED_MODELS: "fixture", FLUID_NAMING_BRAIN_DATABASE_URL: "postgresql://synthetic.invalid/database", FLUID_NAMING_BRAIN_DEPLOYMENT_ID: "fixture-deployment" });
    expect(config?.policy.model).toBe("fixture"); expect(config?.policy.protocol).toBe("openai_agents");
  });
  it("refreshes readiness during long stages independently of lease heartbeat", async () => {
    vi.useFakeTimers(); let refreshes = 0, stopped = false;
    const readiness = await startNamingReadiness(async () => { refreshes++; return true; }, () => { stopped = true; });
    await vi.advanceTimersByTimeAsync(65_000); expect(refreshes).toBe(4); expect(stopped).toBe(false);
    await readiness.stop(); await vi.advanceTimersByTimeAsync(60_000); expect(refreshes).toBe(4); vi.useRealTimers();
  });
});

describe("Naming shared readiness refresh lifecycle", () => {
  it("coalesces concurrent assertions and timer ticks into one manual refresh", async () => {
    vi.useFakeTimers();
    const pending = deferred<boolean>(), report = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true).mockReturnValueOnce(pending.promise);
    const gate = await startNamingReadiness(report);
    const assertions = Promise.all([gate.assertReady(), gate.assertReady(), gate.assertReady()]);
    void assertions.catch(() => {});
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(report).toHaveBeenCalledTimes(2);
    pending.resolve(true);
    await expect(assertions).resolves.toEqual([undefined, undefined, undefined]);
    await gate.stop();
  });

  it("lets manual assertions join the timer's already-started refresh without a second probe", async () => {
    vi.useFakeTimers();
    const pending = deferred<boolean>(), report = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true).mockReturnValueOnce(pending.promise);
    const gate = await startNamingReadiness(report);
    await vi.advanceTimersByTimeAsync(20_000);
    const assertions = Promise.all([gate.assertReady(), gate.assertReady(), gate.assertReady()]);
    void assertions.catch(() => {});
    await vi.advanceTimersByTimeAsync(40_000);
    expect(report).toHaveBeenCalledTimes(2);
    pending.resolve(true);
    await assertions;
    expect(report).toHaveBeenCalledTimes(2);
    await gate.stop();
  });

  it.each(["ready", "unready", "rejected"] as const)("fences and drains a manual refresh with a late %s result", async result => {
    vi.useFakeTimers();
    const pending = deferred<boolean>(), unavailable = vi.fn(), report = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true).mockReturnValueOnce(pending.promise);
    const gate = await startNamingReadiness(report, unavailable);
    // Observe rejections immediately so delayed completion cannot be unhandled.
    const assertions = Promise.allSettled([gate.assertReady()]);
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(2);
    let drained = false;
    const stopping = gate.stop().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drained).toBe(false);
    await expect(gate.assertReady()).rejects.toThrow("naming_readiness_stopped");
    expect(report).toHaveBeenCalledTimes(2);
    if (result === "rejected") pending.reject(new Error("synthetic-private-readiness-error"));
    else pending.resolve(result === "ready");
    await stopping;
    expect(drained).toBe(true);
    for (const assertion of await assertions) expect(assertion).toMatchObject({ status: "rejected", reason: new Error("naming_readiness_stopped") });
    expect(unavailable).not.toHaveBeenCalled();
    await gate.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(gate.assertReady()).rejects.toThrow("naming_readiness_stopped");
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("drains a timer refresh and fences assertions waiting on it", async () => {
    vi.useFakeTimers();
    const pending = deferred<boolean>(), report = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true).mockReturnValueOnce(pending.promise);
    const gate = await startNamingReadiness(report);
    await vi.advanceTimersByTimeAsync(20_000);
    const assertion = gate.assertReady();
    const outcome = Promise.allSettled([assertion]);
    let drained = false;
    const stopping = gate.stop().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drained).toBe(false); expect(report).toHaveBeenCalledTimes(2);
    pending.resolve(true); await stopping;
    expect(await outcome).toEqual([{ status: "rejected", reason: new Error("naming_readiness_stopped") }]);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("does not start an enqueued manual report after synchronous stop", async () => {
    vi.useFakeTimers();
    const report = vi.fn(async () => true), gate = await startNamingReadiness(report);
    const assertion = gate.assertReady();
    const outcome = Promise.allSettled([assertion]);
    await gate.stop();
    expect(await outcome).toEqual([{ status: "rejected", reason: new Error("naming_readiness_stopped") }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(report).toHaveBeenCalledOnce();
  });

  it.each(["false", "rejected", "synchronous_throw"] as const)("keeps shared %s reports fail-closed without retrying each waiter", async failure => {
    vi.useFakeTimers();
    const pending = deferred<boolean>(), unavailable = vi.fn(), report = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true);
    if (failure === "synchronous_throw") report.mockImplementationOnce(() => { throw new Error("synthetic-private-query-error"); });
    else report.mockReturnValueOnce(pending.promise);
    const gate = await startNamingReadiness(report, unavailable);
    const outcomes = Promise.allSettled([gate.assertReady(), gate.assertReady(), gate.assertReady()]);
    await Promise.resolve();
    if (failure === "false") pending.resolve(false);
    if (failure === "rejected") pending.reject(new Error("synthetic-private-query-error"));
    for (const outcome of await outcomes) expect(outcome).toEqual({ status: "rejected", reason: new Error("naming_readiness_unavailable") });
    expect(report).toHaveBeenCalledTimes(2); expect(unavailable).toHaveBeenCalledOnce();
    report.mockResolvedValueOnce(true);
    await expect(gate.assertReady()).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledTimes(3);
    await gate.stop();
  });
});

describe("Naming observation remains available", () => {
  it("keeps observation alive when readiness is disabled, while rejecting paid work", async () => {
    vi.useFakeTimers(); let ready = false;
    const gate = await startNamingReadiness(async () => ready);
    await expect(gate.assertReady()).rejects.toThrow("naming_readiness_unavailable");
    await vi.advanceTimersByTimeAsync(65_000);
    ready = true; await expect(gate.assertReady()).resolves.toBeUndefined();
    await gate.stop(); vi.useRealTimers();
  });
});
