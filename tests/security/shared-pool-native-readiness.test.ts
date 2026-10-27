import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedPoolController, type SharedEngineFactory } from "../../worker/shared-pool/controller";
import type { SharedPoolSlot } from "../../worker/shared-pool/configuration";
import type { SharedSlotPool } from "../../worker/shared-pool/database";
import type { SharedQueuePort } from "../../worker/shared-pool/queue";
import { sharedConfiguration, sharedInstance, sharedLease, sharedSecrets } from "../worker/shared-pool-fixture";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture(options: { heldConstructor?: boolean; readinessFailure?: boolean; changedGeneration?: boolean } = {}) {
  const config = sharedConfiguration(), stop = new AbortController(), events: string[] = [];
  config.capacity.idlePollMs = 1000;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const refresh = vi.fn(async () => {
    events.push("refresh:logo");
    if (options.readinessFailure) throw Error("Readiness acknowledgement unavailable");
  });
  const createPool = (_config: unknown, slot: SharedPoolSlot): SharedSlotPool => ({
    qualify: vi.fn(async () => {}), close: vi.fn(async () => {}),
    query: vi.fn(async (sql: string, args: unknown[] = []) => {
      if (sql.includes("claim_shared_worker_slot")) return { rows: [{ lease: sharedLease(config, slot.lane, String(args[1])) }] };
      if (sql.includes("renew_shared_worker_slot")) {
        events.push(`renew:${slot.lane}`);
        const before = JSON.parse(String(args[0]));
        return { rows: [{ lease: { ...before, expiresAt: new Date(Date.now() + 45_000).toISOString(),
          ...(options.changedGeneration && slot.lane === "logo" ? { generation: before.generation + 1 } : {}) } }] };
      }
      if (sql.includes("read_shared_worker_execution_page")) return { rows: [{ page: { version: 1, items: [], nextCursor: null } }] };
      if (sql.includes("list_shared_strategy_dispatches")) return { rows: [] };
      if (sql.includes("fence_shared_worker_slot")) { events.push(`fence:${slot.lane}`); return { rows: [{ fenced: true }] }; }
      if (sql.includes("release_shared_worker_slot")) return { rows: [{ released: true }] };
      throw Error("Unexpected inert readiness statement");
    }),
  });
  const createEngine: SharedEngineFactory = async ({ slot }) => {
    if (slot.lane === "logo" && options.heldConstructor) await held;
    return { run: vi.fn(async () => ({ disposition: "ack" as const, state: "idle" })), close: vi.fn(async () => {}),
      ...(slot.lane === "logo" ? { renewReadiness: refresh } : {}) };
  };
  const queue: SharedQueuePort = { send: vi.fn(async () => ({ messageId: "msg_inert" })), receive: vi.fn(async () => {
    if (!stop.signal.aborted) await new Promise<void>(resolve => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { ok: false as const, reason: "empty" as const };
  }) };
  const controller = createSharedPoolController(config, sharedSecrets(config), { createPool, createEngine, queue, instanceId: sharedInstance });
  const running = controller.run(stop.signal); void running.catch(() => {});
  return { controller, running, stop, events, refresh, release,
    async close() { stop.abort(); release(); await vi.advanceTimersByTimeAsync(0); await running; await controller.close(); } };
}

describe("Independent native readiness lifecycle fences (inert ports)", () => {
  it("does not refresh readiness while native engine construction remains unconfirmed", async () => {
    vi.useFakeTimers(); const f = fixture({ heldConstructor: true });
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(f.events).toContain("renew:logo");
      expect(f.refresh).not.toHaveBeenCalled();
      expect(f.controller.status().slots.find(s => s.lane === "logo")!.state).not.toBe("qualified");
      f.release(); await vi.advanceTimersByTimeAsync(0);
      expect(f.controller.status().slots.find(s => s.lane === "logo")!.state).toBe("qualified");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.refresh).toHaveBeenCalledTimes(1);
      expect(f.events.indexOf("renew:logo")).toBeLessThan(f.events.indexOf("refresh:logo"));
    } finally { await f.close(); }
  });

  it("withdraws the slot when qualified readiness renewal cannot be acknowledged", async () => {
    vi.useFakeTimers(); const f = fixture({ readinessFailure: true });
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(f.refresh).toHaveBeenCalledTimes(1);
      expect(f.events).toContain("fence:logo");
      expect(f.controller.status().slots.find(s => s.lane === "logo")!.state).not.toBe("qualified");
    } finally { await f.close(); }
  });

  it("does not refresh readiness from a renewal that substituted a new generation", async () => {
    vi.useFakeTimers(); const f = fixture({ changedGeneration: true });
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(f.events).toContain("renew:logo");
      expect(f.events).toContain("fence:logo");
      expect(f.refresh).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
