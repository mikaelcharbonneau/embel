import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { superviseLocalPrototype, type LocalSupervisorEvent } from "../../scripts/local-supervisor.mjs";

let nextPid = 1;
class Child extends EventEmitter {
  alive = true;
  constructor(readonly pid: number | undefined, readonly closes = true) { super(); }
  kill = vi.fn((signal: NodeJS.Signals) => { if (this.closes || signal === "SIGKILL") this.exit(null, signal); return true; });
  exit(code: number | null, signal: NodeJS.Signals | null = null) { this.alive = false; this.emit("exit", code, signal); }
}
const supervisors: ReturnType<typeof superviseLocalPrototype>[] = [];
afterEach(() => { for (const supervisor of supervisors.splice(0)) supervisor.stop(); vi.clearAllTimers(); vi.useRealTimers(); });
function fixture(options: { stuck?: boolean; firstSpawnError?: boolean } = {}) {
  vi.useFakeTimers();
  const workers: Child[] = [], web = new Child(nextPid++, !options.stuck), events: LocalSupervisorEvent[] = [], exit = vi.fn();
  const supervisor = superviseLocalPrototype({ startWeb: () => web, startWorker: () => {
    const child = new Child(options.firstSpawnError && !workers.length ? undefined : nextPid++, !options.stuck);
    workers.push(child); return child;
  }, onEvent: event => events.push(event), onExitCode: exit });
  supervisors.push(supervisor);
  return { supervisor, workers, web, events, exit };
}

describe("strict local prototype process supervision (synthetic children only)", () => {
  it("keeps the web alive and permits only three sequential worker restarts with bounded backoff", async () => {
    const value = fixture();
    for (const [index, delay] of [1_000, 2_000, 4_000].entries()) {
      value.workers[index]!.exit(index);
      expect(value.web.alive).toBe(true); expect(value.web.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(delay - 1); expect(value.workers).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1); expect(value.workers).toHaveLength(index + 2);
      expect(value.workers.filter(child => child.alive)).toHaveLength(1);
    }
    value.workers[3]!.exit(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(value.workers).toHaveLength(4); expect(value.web.alive).toBe(true);
    expect(value.events).toContainEqual(expect.objectContaining({ event: "local_worker_unavailable", attempts: 3 }));
    expect(value.exit).toHaveBeenLastCalledWith(1);
  });

  it("cancels pending worker replacement and forwards an explicit interrupt to the surviving web", async () => {
    const value = fixture(); value.workers[0]!.exit(1);
    value.supervisor.stop(0, "SIGINT");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(value.workers).toHaveLength(1); expect(value.web.kill).toHaveBeenCalledExactlyOnceWith("SIGINT");
    expect(value.events.filter(event => event.event === "local_shutdown")).toHaveLength(1);
  });

  it("forwards shutdown once to both owned children and removes the force timer after they exit", async () => {
    const value = fixture(); value.supervisor.stop(); value.supervisor.stop();
    expect(value.workers[0]!.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(value.web.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(value.events.some(event => event.event === "local_shutdown_forced")).toBe(false);
  });

  it("bounds shutdown of only its own unresponsive children after a twenty-second graceful drain", async () => {
    const value = fixture({ stuck: true }); value.supervisor.stop();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(value.web.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(value.web.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(value.workers[0]!.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(value.workers).toHaveLength(1);
  });

  it("contains a failed spawn without logging its private Error or double-counting a later exit", async () => {
    const value = fixture({ firstSpawnError: true });
    value.workers[0]!.emit("error", Object.assign(new Error("synthetic-private-message"), { config: "synthetic-private-config" }));
    value.workers[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(value.workers).toHaveLength(2);
    expect(value.events.filter(event => event.event === "local_child_exit")).toHaveLength(1);
    expect(value.events).toContainEqual(expect.objectContaining({ event: "local_child_exit", role: "worker", code: null, signal: null, cause: "spawn_error" }));
    expect(JSON.stringify(value.events)).not.toContain("synthetic-private");
  });

  it("never starts a duplicate worker when an existing process emits an error without an exit", async () => {
    const value = fixture({ stuck: true });
    value.workers[0]!.emit("error", new Error("synthetic-private-kill-error"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(value.workers).toHaveLength(1); expect(value.exit).toHaveBeenLastCalledWith(1);
    expect(JSON.stringify(value.events)).not.toContain("synthetic-private");
  });

  it("shuts down the worker when its sole web process exits unexpectedly", async () => {
    const value = fixture(); value.web.exit(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(value.workers).toHaveLength(1); expect(value.workers[0]!.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(value.exit).toHaveBeenLastCalledWith(1);
  });

  it("does not launch a worker after the web factory fails before a process exists", async () => {
    vi.useFakeTimers();
    const worker = vi.fn(() => new Child(nextPid++)), events: LocalSupervisorEvent[] = [], exit = vi.fn();
    const supervisor = superviseLocalPrototype({ startWeb: () => { throw new Error("synthetic-private-spawn-error"); },
      startWorker: worker, onEvent: event => events.push(event), onExitCode: exit });
    supervisors.push(supervisor);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(worker).not.toHaveBeenCalled(); expect(exit).toHaveBeenLastCalledWith(1);
    expect(events).toContainEqual(expect.objectContaining({ event: "local_child_exit", role: "web", cause: "spawn_error" }));
    expect(JSON.stringify(events)).not.toContain("synthetic-private");
  });

  it("emits only bounded exit classifications instead of arbitrary event values", () => {
    const value = fixture(); value.workers[0]!.emit("exit", "synthetic-private-code", "synthetic-private-signal");
    expect(value.events).toContainEqual(expect.objectContaining({ event: "local_child_exit", role: "worker", code: null, signal: "other" }));
    expect(JSON.stringify(value.events)).not.toContain("synthetic-private");
  });
});
