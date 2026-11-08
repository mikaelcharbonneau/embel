import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedPoolController } from "../../worker/shared-pool/controller";
import type { SharedLaneEngine, SharedSlotLease } from "../../worker/shared-pool/contracts";
import type { SharedPoolSlot } from "../../worker/shared-pool/configuration";
import type { SharedSlotPool } from "../../worker/shared-pool/database";
import type { SharedQueuePort } from "../../worker/shared-pool/queue";
import { sharedConfiguration, sharedInstance, sharedSecrets } from "./shared-pool-fixture";

/** One configuration with a Logo slot per concept: 1 Strategy, 1 Naming, 6 Logo. */
function sixLogoSlots() {
  const config = sharedConfiguration(), logo = config.slots.find(slot => slot.lane === "logo")!;
  for (let index = 2; index <= 6; index++) config.slots.push({ ...structuredClone(logo), slotId: `${index}9999999-9999-4999-8999-999999999999`,
    roleOid: 2000 + index, roleName: `embel_shared_logo_fixture_s${index}`, workerId: `synthetic-logo-slot-${index}` });
  config.capacity.maxConcurrentExecutions = config.slots.length; config.capacity.maxPerTenantPerLane = 6;
  const secrets = sharedSecrets(config);
  // Each Logo slot signs in to Storage as its own service user.
  config.slots.filter(slot => slot.lane === "logo").forEach((slot, index) => {
    const storage = secrets.slots[slot.slotId]!.storage!;
    secrets.slots[slot.slotId] = { ...secrets.slots[slot.slotId]!, storage: { ...storage, authUserId: `5555555${index}-5555-4555-8555-555555555555` } };
  });
  return { config, secrets };
}
const lease = (slot: SharedPoolSlot, instanceId: string): SharedSlotLease => ({ version: 1, slotId: slot.slotId, instanceId, lane: slot.lane, generation: 1,
  leaseToken: "66666666-6666-4666-8666-666666666666", expiresAt: new Date(Date.now() + 45_000).toISOString(), roleName: slot.roleName, roleOid: slot.roleOid });

describe("several Logo slots", () => {
  it("runs one Logo job per slot at the same time, up to six", async () => {
    const { config, secrets } = sixLogoSlots(), stop = new AbortController(), held: Array<() => void> = [];
    let active = 0, maximum = 0;
    const createPool = (_config: unknown, slot: SharedPoolSlot): SharedSlotPool => ({
      qualify: vi.fn(async () => {}), close: vi.fn(async () => {}),
      query: vi.fn(async (sql: string, args: unknown[] = []) => {
        if (sql.includes("claim_shared_worker_slot")) return { rows: [{ lease: lease(slot, String(args[1])) }] };
        if (sql.includes("renew_shared_worker_slot")) return { rows: [{ lease: { ...JSON.parse(String(args[0])), expiresAt: new Date(Date.now() + 45_000).toISOString() } }] };
        if (sql.includes("read_shared_worker_execution_page")) return { rows: [{ page: { version: 1, items: [], nextCursor: null } }] };
        if (sql.includes("list_shared_strategy_dispatches")) return { rows: [] };
        if (sql.includes("fence_shared_worker_slot")) return { rows: [{ fenced: true }] };
        if (sql.includes("release_shared_worker_slot")) return { rows: [{ released: true }] };
        throw Error("Unexpected inert SQL");
      }) as SharedSlotPool["query"],
    });
    const createEngine = async ({ slot }: { slot: SharedPoolSlot }): Promise<SharedLaneEngine> => ({
      async run() {
        if (slot.lane !== "logo" || stop.signal.aborted) return { disposition: "ack", state: "idle" };
        // A Logo job holds its slot until the test releases it.
        active++; maximum = Math.max(maximum, active);
        try { await new Promise<void>(resolve => held.push(resolve)); } finally { active--; }
        return { disposition: "ack", state: "succeeded" };
      },
      async close() {},
    });
    const queue: SharedQueuePort = { receive: vi.fn(async () => { await new Promise<void>(resolve => stop.signal.addEventListener("abort", () => resolve(), { once: true })); return { ok: false as const, reason: "empty" as const }; }),
      send: vi.fn(async () => ({ messageId: "msg_inert" })) };
    const controller = createSharedPoolController(config, secrets, { createPool, createEngine, queue, instanceId: sharedInstance, random: () => 1, onDiagnostic: () => {} });
    const running = controller.run(stop.signal); void running.catch(() => {});

    await vi.waitFor(() => expect(active).toBe(6));
    expect(controller.status().slots.filter(slot => slot.lane === "logo" && slot.busy)).toHaveLength(6);
    stop.abort(); held.splice(0).forEach(release => release());
    await running; await controller.close();
    expect(maximum).toBe(6);
  });
});
