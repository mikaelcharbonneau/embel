import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const http = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock("node:http", () => ({ createServer: http.createServer }));
vi.mock("node:timers/promises", () => ({ setTimeout: (milliseconds: number, _value: undefined, options: { signal: AbortSignal }) => new Promise<void>((resolve, reject) => {
  const signal = options.signal;
  const aborted = () => { clearTimeout(timer); reject(new Error("Synthetic timer aborted")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, milliseconds);
  if (signal.aborted) aborted(); else signal.addEventListener("abort", aborted, { once: true });
}) }));
vi.mock("server-only", () => ({}));
import { runLocalRuntimeHost, type LocalRuntimeHostOptions } from "../../worker/local-runtime-host";
import { createLogoWorkerRuntime } from "../../worker/logo-runtime";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
class SyntheticServer extends EventEmitter {
  failure: Error | undefined;
  holdClose = false; holdListen = false; listening = false; generation = 0;
  finishListen = () => {};
  closing: (() => void)[] = [];
  listen = vi.fn((_port: number, _host: string, callback?: () => void) => {
    const generation = ++this.generation;
    this.finishListen = () => {
      // Like Node Server.close(), invalidating the generation cancels a pending bind.
      if (generation !== this.generation) return;
      if (this.failure) this.emit("error", this.failure);
      else { this.listening = true; this.emit("listening"); callback?.(); }
    };
    if (!this.holdListen) queueMicrotask(this.finishListen);
    return this;
  });
  close = vi.fn((callback?: () => void) => {
    this.generation++; this.listening = false;
    if (callback) this.closing.push(callback);
    if (!this.holdClose) this.finishClose();
    return this;
  });
  closeIdleConnections = vi.fn();
  finishClose() { for (const callback of this.closing.splice(0)) callback(); }
}
function fixture() {
  const server = new SyntheticServer(), controller = new AbortController();
  let handle!: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  http.createServer.mockImplementation((_options, callback) => { handle = callback; return server; });
  const runtime = { handle: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("synthetic", { status: 200, headers: { "Cache-Control": "no-store" } })),
    refreshReadiness: vi.fn(async () => {}), tick: vi.fn<(signal: AbortSignal) => Promise<void>>(async () => {}), close: vi.fn() };
  const logoRuntime = { refreshReadiness: vi.fn(async () => true), tick: vi.fn(async () => "idle" as const), close: vi.fn() };
  const options: LocalRuntimeHostOptions = { runtime, logoRuntime, signal: controller.signal };
  return { server, controller, runtime, logoRuntime, options, handle: (...args: Parameters<typeof handle>) => handle(...args) };
}
beforeEach(() => { vi.useFakeTimers(); http.createServer.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("local worker host with explicitly supplied logo runtime", () => {
  it("keeps the default host legacy-only and preserves its listener boundary", async () => {
    const f = fixture(), onListening = vi.fn();
    const running = runLocalRuntimeHost({ runtime: f.runtime, signal: f.controller.signal, onListening });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.server.listen).toHaveBeenCalledWith(3107, "127.0.0.1");
    expect(onListening).toHaveBeenCalledTimes(1); expect(f.runtime.tick).toHaveBeenCalledTimes(1);
    expect(f.logoRuntime.refreshReadiness).not.toHaveBeenCalled(); expect(f.logoRuntime.tick).not.toHaveBeenCalled();
    f.controller.abort(); await running;
    expect(f.runtime.close).toHaveBeenCalledTimes(1); expect(f.logoRuntime.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["readiness", "tick"] as const)("keeps logo work independent of slow legacy %s", async phase => {
    const f = fixture(), slow = deferred();
    if (phase === "readiness") f.runtime.refreshReadiness.mockImplementation(() => slow.promise);
    else f.runtime.tick.mockImplementation(() => slow.promise);
    const running = runLocalRuntimeHost(f.options);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.logoRuntime.refreshReadiness).toHaveBeenCalledTimes(1);
      expect(f.logoRuntime.tick).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.logoRuntime.tick).toHaveBeenCalledTimes(2);
    } finally { f.controller.abort(); slow.resolve(); await running; }
  });
  it("coalesces readiness, fences new work immediately and drains existing work before caller cleanup", async () => {
    const f = fixture(), result = deferred<"idle">(), refresh = deferred<boolean>();
    f.logoRuntime.tick.mockImplementation(() => result.promise); f.server.holdClose = true;
    const callerCleanup = vi.fn(), running = runLocalRuntimeHost(f.options).finally(callerCleanup);
    await vi.advanceTimersByTimeAsync(0);
    f.logoRuntime.refreshReadiness.mockImplementation(() => refresh.promise);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(f.logoRuntime.tick).toHaveBeenCalledTimes(1); expect(f.logoRuntime.tick).toHaveBeenCalledWith();
    expect(f.logoRuntime.refreshReadiness).toHaveBeenCalledTimes(2);
    f.controller.abort(); await vi.advanceTimersByTimeAsync(0);
    expect(f.runtime.close).toHaveBeenCalledTimes(1); expect(f.logoRuntime.close).toHaveBeenCalledTimes(1);
    expect(f.runtime.tick.mock.calls[0]![0].aborted).toBe(true); expect(callerCleanup).not.toHaveBeenCalled();
    const legacyTicks = f.runtime.tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.runtime.tick).toHaveBeenCalledTimes(legacyTicks); expect(f.logoRuntime.tick).toHaveBeenCalledTimes(1);
    expect(f.logoRuntime.refreshReadiness).toHaveBeenCalledTimes(2);
    result.resolve("idle"); await vi.advanceTimersByTimeAsync(0); expect(callerCleanup).not.toHaveBeenCalled();
    refresh.resolve(true); await vi.advanceTimersByTimeAsync(0); expect(callerCleanup).not.toHaveBeenCalled();
    f.server.finishClose(); await running; expect(callerCleanup).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["create", "listen"] as const)("cleans up both supplied runtimes after a %s failure without scheduling them", async phase => {
    const f = fixture(), failure = new Error("Synthetic listener unavailable");
    if (phase === "create") http.createServer.mockImplementation(() => { throw failure; }); else f.server.failure = failure;
    await expect(runLocalRuntimeHost(f.options)).rejects.toBe(failure);
    expect(f.runtime.close).toHaveBeenCalledTimes(1); expect(f.logoRuntime.close).toHaveBeenCalledTimes(1);
    for (const runtime of [f.runtime, f.logoRuntime]) {
      expect(runtime.refreshReadiness).not.toHaveBeenCalled(); expect(runtime.tick).not.toHaveBeenCalled();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["success", "failure"] as const)("drains an unowned internal logo refresh on close after %s", async outcome => {
    const f = fixture(), pending = deferred<{ rows: { value: boolean }[] }>();
    const query = vi.fn(async () => ({ rows: [{ value: true }] }));
    const logo = createLogoWorkerRuntime({ connection: { query } as unknown as LogoWorkerConnection, workerId: "synthetic-host-drain", manifest: [],
      composition: { concepts: null, refinements: null, vector: null, directions: null, exports: null, unavailableReasons: {} } });
    const callerCleanup = vi.fn(), running = runLocalRuntimeHost({ ...f.options, logoRuntime: logo }).finally(callerCleanup);
    await vi.advanceTimersByTimeAsync(0);
    query.mockImplementationOnce(() => pending.promise);
    const internalRefresh = logo.refreshReadiness(); // The host did not start or track this refresh.
    expect(logo.refreshReadiness()).toBe(internalRefresh); // Both reporting paths share one pending operation.
    f.controller.abort(); await vi.advanceTimersByTimeAsync(0);
    try {
      expect(callerCleanup).not.toHaveBeenCalled(); expect(await logo.tick()).toBe("idle");
      expect(await logo.refreshReadiness()).toBe(false); expect(query).toHaveBeenCalledTimes(2);
    } finally {
      if (outcome === "failure") pending.reject(new Error("Synthetic refresh unavailable")); else pending.resolve({ rows: [{ value: true }] });
      expect(await internalRefresh).toBe(false); await running;
    }
    expect(callerCleanup).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a pending listen so late bind completion cannot leave a listener after return", async () => {
    const f = fixture(); f.server.holdListen = true;
    const running = runLocalRuntimeHost(f.options);
    expect(f.server.listen).toHaveBeenCalledTimes(1);
    f.controller.abort(); await running; f.server.finishListen();
    expect(f.server.close).toHaveBeenCalledTimes(1); expect(f.server.listening).toBe(false);
    expect(f.server.listenerCount("listening")).toBe(0); expect(f.server.listenerCount("error")).toBe(0);
    expect(f.runtime.refreshReadiness).not.toHaveBeenCalled(); expect(f.logoRuntime.refreshReadiness).not.toHaveBeenCalled();
    expect(f.logoRuntime.tick).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["before_listen", "on_listening"] as const)("does not schedule after shutdown %s", async phase => {
    const f = fixture(); if (phase === "before_listen") f.controller.abort();
    await runLocalRuntimeHost({ ...f.options, onListening: () => f.controller.abort() });
    if (phase === "before_listen") expect(f.server.listen).not.toHaveBeenCalled();
    expect(f.runtime.tick).not.toHaveBeenCalled(); expect(f.logoRuntime.tick).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalledTimes(1); expect(f.logoRuntime.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("contains failed background refreshes and ticks without stopping the independent lane", async () => {
    const f = fixture(); f.runtime.refreshReadiness.mockRejectedValue(new Error("Synthetic unavailable"));
    f.runtime.tick.mockRejectedValue(new Error("Synthetic unavailable"));
    const running = runLocalRuntimeHost(f.options);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.runtime.tick).toHaveBeenCalledTimes(2); expect(f.logoRuntime.tick).toHaveBeenCalledTimes(2);
    f.controller.abort(); await running; expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves HTTP headers, bounded body forwarding and no-store responses", async () => {
    const f = fixture(), running = runLocalRuntimeHost(f.options); await vi.advanceTimersByTimeAsync(0);
    expect(http.createServer.mock.calls[0]![0]).toEqual({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 8192 });
    const incoming = Object.assign(Readable.from([Buffer.from("synthetic request")]), {
      method: "POST", url: "/bridge/status", rawHeaders: ["Host", "127.0.0.1:3107", "Content-Type", "application/json"],
    });
    const outgoing = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
    await f.handle(incoming as IncomingMessage, outgoing as unknown as ServerResponse);
    const request = f.runtime.handle.mock.calls[0]![0] as Request;
    expect(request.url).toBe("http://127.0.0.1:3107/bridge/status"); expect(request.headers.get("host")).toBe("127.0.0.1:3107");
    expect(await request.text()).toBe("synthetic request");
    expect(outgoing.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "cache-control": "no-store" }));
    const oversized = Object.assign(Readable.from([Buffer.alloc(4097)]), { method: "POST", url: "/bridge/status", rawHeaders: [] });
    await f.handle(oversized as unknown as IncomingMessage, outgoing as unknown as ServerResponse);
    expect(outgoing.writeHead).toHaveBeenLastCalledWith(413, { "Cache-Control": "no-store" }); expect(f.runtime.handle).toHaveBeenCalledTimes(1);
    f.controller.abort(); await running;
  });
});
