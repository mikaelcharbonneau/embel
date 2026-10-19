import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseLogoDedicatedConfiguration } from "../../worker/logo-dedicated-config";
import { runLogoDedicatedWorker, type LogoDedicatedDependencies, type LogoDedicatedEvent } from "../../worker/logo-dedicated-launcher";
import type { LogoProductionHost, LogoProductionHostOptions } from "../../worker/logo-production-host";
import { configurationInput, syntheticSecret, identity } from "./logo-dedicated-fixture";
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const signals = new EventEmitter(), entered = deferred<void>(), running = deferred<void>(), drain = deferred<void>(), events: LogoDedicatedEvent[] = [];
  const pool = Object.assign(new EventEmitter(), { connect: vi.fn(async (): Promise<never> => { throw Error("No fixture DB calls expected"); }), end: vi.fn(async () => {}) });
  let received: Extract<LogoProductionHostOptions, { enabled: true }> | undefined;
  const host = { status: "qualified", manifest: [],
    run: vi.fn(async () => { entered.resolve(); await running.promise; }), close: vi.fn(() => { running.resolve(); return drain.promise; }) } satisfies Extract<LogoProductionHost, { status: "qualified" }>;
  const dependencies: LogoDedicatedDependencies = { signals, createPool: vi.fn(() => pool),
    startHost: vi.fn(async options => { if (options?.enabled) received = options; return host; }), emit: event => { events.push(event); } };
  return { signals, entered, running, drain, events, pool, host, dependencies, received: () => received };
}
afterEach(() => { vi.restoreAllMocks(); });
describe("dedicated checked logo process owner", () => {
  it("qualifies and drains in check mode without reporting readiness or claiming work", async () => {
    const f = fixture(); f.drain.resolve();
    const result = await runLogoDedicatedWorker(parseLogoDedicatedConfiguration(configurationInput()), f.dependencies, { checkOnly: true });
    expect(result).toEqual({ status: "qualified", exitCode: 0 });
    expect(f.dependencies.startHost).toHaveBeenCalledTimes(1);
    expect(f.host.run).not.toHaveBeenCalled();
    expect(f.host.close).toHaveBeenCalledTimes(1);
    expect(f.pool.end).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(["drain_complete", "qualified"]);
    expect(f.signals.eventNames()).toEqual([]);
  });
  it("does not acknowledge check qualification after a failed drain", async () => {
    const f = fixture(); f.host.close = vi.fn(async () => { throw Error("synthetic drain failure"); });
    const result = await runLogoDedicatedWorker(parseLogoDedicatedConfiguration(configurationInput()), f.dependencies, { checkOnly: true });
    expect(result).toEqual({ status: "drain_unconfirmed", exitCode: 2 });
    expect(f.host.run).not.toHaveBeenCalled(); expect(f.pool.end).not.toHaveBeenCalled();
    expect(f.events).not.toContain("qualified");
  });
  it("does nothing for disabled or invalid handles", async () => {
    const f = fixture();
    expect(await runLogoDedicatedWorker(parseLogoDedicatedConfiguration(), f.dependencies)).toMatchObject({ status: "disabled", exitCode: 0 });
    expect(await runLogoDedicatedWorker({ status: "configured" }, f.dependencies)).toMatchObject({ status: "unavailable", exitCode: 2 });
    expect(f.dependencies.createPool).not.toHaveBeenCalled(); expect(f.dependencies.startHost).not.toHaveBeenCalled(); expect(f.signals.eventNames()).toEqual([]);
  });
  it("constructs real separate brokers and exactly one shared binding before running the selected union", async () => {
    const f = fixture(), raw = configurationInput(), task = runLogoDedicatedWorker(parseLogoDedicatedConfiguration(raw), f.dependencies);
    await f.entered.promise;
    const received = f.received()!;
    expect(received.binding).toEqual(identity); expect(received.workerId).toBe(raw.workerId); expect(received.pool).toBe(f.pool);
    expect(received.concepts!.authorization!.ownerId).toBe(identity.ownerId);
    expect(received.concepts!.authorization!.capability).toEqual(raw.operations.concepts);
    expect(received.refinements!.authorization!.capability).toEqual(raw.operations.refinements);
    expect(received.vector!.authorization!.capability).toEqual(raw.operations.vector);
    expect(received.exports!.authorization!.capability).toEqual(raw.operations.exports);
    expect(received.concepts!.authorization).not.toBe(received.refinements!.authorization);
    expect(received.vector!.authorization).not.toBe(received.exports!.authorization);
    expect(received.concepts!.image).toEqual(raw.image); expect(received).not.toHaveProperty("directions");
    expect(f.dependencies.startHost).toHaveBeenCalledTimes(1); expect(f.host.run).toHaveBeenCalledTimes(1);
    f.signals.emit("SIGTERM"); f.drain.resolve(); expect(await task).toMatchObject({ status: "drained", exitCode: 0 });
  });
  it.each(["SIGTERM", "SIGINT"])("fences immediately on %s and only disposes after confirmed host drain", async signal => {
    const f = fixture(), task = runLogoDedicatedWorker(parseLogoDedicatedConfiguration(configurationInput()), f.dependencies); await f.entered.promise;
    f.signals.emit(signal);
    expect(f.received()!.signal!.aborted).toBe(true); expect(f.host.close).toHaveBeenCalled();
    await Promise.resolve(); expect(f.pool.end).not.toHaveBeenCalled(); expect(f.events).not.toContain("drain_complete");
    f.signals.emit(signal); f.signals.emit("SIGINT"); f.drain.resolve(); const result = await task;
    expect(result).toEqual({ status: "drained", reason: "signal", exitCode: 0 }); expect(f.pool.end).toHaveBeenCalledTimes(1);
    expect(f.signals.eventNames()).toEqual([]); expect(f.pool.listenerCount("error")).toBe(0);
    expect(f.events.filter(event => event === "stop_requested")).toHaveLength(1);
  });
  it("installs idle-pool error coverage before calling the host and shuts down with fixed diagnostics", async () => {
    const f = fixture(); f.dependencies.startHost = vi.fn(async options => {
      expect(f.pool.listenerCount("error")).toBe(1); f.pool.emit("error", Error(syntheticSecret));
      expect(options?.enabled && options.signal?.aborted).toBe(true); return f.host;
    });
    const task = runLogoDedicatedWorker(parseLogoDedicatedConfiguration(configurationInput()), f.dependencies);
    f.drain.resolve(); const result = await task;
    expect(result).toEqual({ status: "drained", reason: "idle_pool_error", exitCode: 1 }); expect(f.host.run).not.toHaveBeenCalled();
    expect(f.pool.end).toHaveBeenCalledTimes(1); expect(JSON.stringify({ result, events: f.events })).not.toContain(syntheticSecret);
  });
  it("retains a signal received during asynchronous construction and does not start a late host", async () => {
    const f = fixture(), constructing = deferred<LogoProductionHost>(), begun = deferred<void>();
    f.dependencies.startHost = vi.fn(() => { begun.resolve(); return constructing.promise; });
    const task = runLogoDedicatedWorker(parseLogoDedicatedConfiguration(configurationInput()), f.dependencies); await begun.promise;
    f.signals.emit("SIGINT"); constructing.resolve(f.host); f.drain.resolve();
    expect(await task).toMatchObject({ status: "drained", reason: "signal" }); expect(f.host.run).not.toHaveBeenCalled();
  });
  it("does not dispose resources or remove protective handlers when host drain rejects", async () => {
    const f = fixture(), task = runLogoDedicatedWorker(parseLogoDedicatedConfiguration(configurationInput()), f.dependencies); await f.entered.promise;
    f.signals.emit("SIGTERM"); f.drain.reject(Error(syntheticSecret)); const result = await task;
    expect(result).toEqual({ status: "drain_unconfirmed", exitCode: 2 }); expect(f.pool.end).not.toHaveBeenCalled();
    expect(f.pool.listenerCount("error")).toBe(1); expect(f.signals.listenerCount("SIGTERM")).toBe(1);
    expect(() => f.pool.emit("error", Error(syntheticSecret))).not.toThrow(); expect(JSON.stringify(f.events)).not.toContain(syntheticSecret);
  });
  it("treats a throwing host constructor as unconfirmed cleanup instead of assuming zero work", async () => {
    const f = fixture(); f.dependencies.startHost = vi.fn(async () => { throw Error(syntheticSecret); });
    const result = await runLogoDedicatedWorker(parseLogoDedicatedConfiguration(configurationInput()), f.dependencies);
    expect(result).toEqual({ status: "drain_unconfirmed", exitCode: 2 }); expect(f.pool.end).not.toHaveBeenCalled();
    expect(f.pool.listenerCount("error")).toBe(1); expect(JSON.stringify(result)).not.toContain(syntheticSecret);
  });
  it("disposes after a resolved unavailable startup handle but does not claim readiness", async () => {
    const f = fixture(); f.dependencies.startHost = vi.fn(async () => ({ status: "unavailable", phase: "database_identity", reason: "dependency_validation", close: async () => {} } as const));
    const result = await runLogoDedicatedWorker(parseLogoDedicatedConfiguration(configurationInput()), f.dependencies);
    expect(result).toEqual({ status: "unavailable", exitCode: 2 }); expect(f.pool.end).toHaveBeenCalledTimes(1); expect(f.events).not.toContain("running");
  });
  it("retains a runtime error as failure after safe drain without printing its private cause", async () => {
    const f = fixture(); f.host.run = vi.fn(async () => { throw Error(syntheticSecret); }); f.drain.resolve();
    const result = await runLogoDedicatedWorker(parseLogoDedicatedConfiguration(configurationInput()), f.dependencies);
    expect(result).toEqual({ status: "drained", reason: "runtime_failure", exitCode: 1 }); expect(f.pool.end).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ result, events: f.events })).not.toContain(syntheticSecret);
  });
  it("does not falsely claim disposal when pool end rejects", async () => {
    const f = fixture(); f.pool.end.mockRejectedValue(Error(syntheticSecret));
    const task = runLogoDedicatedWorker(parseLogoDedicatedConfiguration(configurationInput()), f.dependencies); await f.entered.promise;
    f.signals.emit("SIGTERM"); f.drain.resolve();
    expect(await task).toEqual({ status: "disposal_unconfirmed", exitCode: 2 }); expect(f.pool.listenerCount("error")).toBe(1);
  });
  it("pins image-free selection and never constructs omitted lane brokers", async () => {
    const f = fixture(), raw = configurationInput();
    const task = runLogoDedicatedWorker(parseLogoDedicatedConfiguration({ ...raw, image: undefined, operations: { vector: raw.operations.vector } }), f.dependencies);
    await f.entered.promise; const options = f.received()!;
    expect(options.concepts).toBeUndefined(); expect(options.refinements).toBeUndefined(); expect(options.exports).toBeUndefined();
    expect(options.vector?.authorization).toBeTruthy(); f.signals.emit("SIGINT"); f.drain.resolve(); await task;
  });
});
