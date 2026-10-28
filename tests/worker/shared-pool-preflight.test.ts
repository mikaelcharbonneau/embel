import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { preflightSharedPool } from "../../worker/shared-pool/preflight";
import type { SharedPoolConfiguration, SharedPoolSlot } from "../../worker/shared-pool/configuration";
import { sharedConfiguration, sharedEnvironment } from "./shared-pool-fixture";

describe("read-only prerequisite qualification, never active readiness", () => {
 it("qualifies and closes only the three fixed database pools, without a claim/query or engine", async () => {
  const config = sharedConfiguration(), events: string[] = [];
  const query = vi.fn(async () => { throw Error("No direct queries permitted by this port test"); });
  const createPool = vi.fn((_config: SharedPoolConfiguration, slot: SharedPoolSlot) => ({ query,
   qualify: async () => { events.push("qualify:" + slot.slotId); },
   close: async () => { events.push("close:" + slot.slotId); } }));
  const result = await preflightSharedPool(sharedEnvironment(config), { ...config.artifact, sourceClean: false }, { createPool });
  expect(result).toMatchObject({ mode: "read_only", activationReady: false, qualifiedSlotIds: config.slots.map(slot => slot.slotId) });
  expect(result.unchecked).toContain("slot_deployment_and_policy_binding");
  expect(result.unchecked).toContain("provider_access");
  expect(createPool).toHaveBeenCalledTimes(3);
  expect(events).toEqual(config.slots.flatMap(slot => ["qualify:" + slot.slotId, "close:" + slot.slotId]));
  expect(query).not.toHaveBeenCalled();
 });
 it("closes after qualification failure, preserves the error and does not open subsequent pools", async () => {
  const config = sharedConfiguration(), close = vi.fn(async () => {});
  const createPool = vi.fn(() => ({ query: vi.fn(), qualify: async () => { throw Error("inert_catalog_failure"); }, close }));
  await expect(preflightSharedPool(sharedEnvironment(config), { ...config.artifact, sourceClean: false }, { createPool })).rejects.toThrow("inert_catalog_failure");
  expect(close).toHaveBeenCalledOnce(); expect(createPool).toHaveBeenCalledOnce();
 });
 it("rejects disabled or mismatched artifact settings before opening any pool", async () => {
  const config = sharedConfiguration(), createPool = vi.fn();
  await expect(preflightSharedPool({}, { ...config.artifact, sourceClean: false }, { createPool })).rejects.toThrow("disabled");
  await expect(preflightSharedPool(sharedEnvironment(config), { ...config.artifact, artifactSha256: "f".repeat(64), sourceClean: false }, { createPool })).rejects.toThrow("configuration");
  expect(createPool).not.toHaveBeenCalled();
 });
});
