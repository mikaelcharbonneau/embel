import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { createSharedAdvancedLogoFixture, type SharedAdvancedLogoFixture } from "./shared-advanced-logo-fixture";
import { sharedExecutionSchema } from "../../worker/shared-pool/contracts";
import { OWNER_A, OWNER_B } from "./local-supabase";

describe("shared advanced Logo runtime proof and finite gateway (disposable SQL fixture)", () => {
 let f: SharedAdvancedLogoFixture;
 beforeAll(async () => { f = await createSharedAdvancedLogoFixture(); }, 90_000);
 afterAll(async () => { await f?.close(); });
 it("does not advertise advanced operations from a claimed slot or policy rows alone", async () => {
  const w = await f.project();
  const result = await f.owner(OWNER_A, async () => (await f.db.query<{ value: { operations: Record<string, { status: string }> } }>("select public.shared_logo_operation($1,'capabilities') value", [w.projectId])).rows[0]!.value);
  expect(result.operations["identity.logo_vectorize"]!.status).toBe("unavailable");
  expect(result.operations["identity.logo_directions"]!.status).toBe("unavailable");
  expect((await f.db.query<{ ready: boolean }>("select fluid_private.shared_logo_slot_runtime_ready($1) ready", [f.slotId])).rows[0]!.ready).toBe(false);
 });
 it("requires a complete exact capability set bound to the actual slot lease", async () => {
  await expect(f.runtimeReady([f.directionsCapability])).rejects.toMatchObject({ code: "42501" });
  expect(await f.runtimeReady()).toBe(true);
  expect((await f.db.query<{ ready: boolean }>("select fluid_private.shared_logo_slot_runtime_ready($1) ready", [f.slotId])).rows[0]!.ready).toBe(true);
  const bad = { ...f.slot(), generation: f.slot().generation + 1 };
  await expect(f.action(null, "runtime_ready", [[f.directionsCapability]], bad)).rejects.toMatchObject({ code: "42501" });
 });
 it("rejects unknown money/provider/tool fields in new uncapped policies", async () => {
  for (const change of [{ maxCostMicrousd: 1 }, { apiPolicy: { ...f.directionsCapability.apiPolicy, maximumCostMicrousd: 1 } },
   { apiPolicy: { ...f.directionsCapability.apiPolicy, model: "other-model" } }, { apiPolicy: { ...f.directionsCapability.apiPolicy, maxTools: 1 } }]) {
   const result = await f.db.query<{ value: boolean }>("select fluid_private.shared_logo_advanced_policy_valid('identity.logo_directions',$1) value", [{ ...f.directionsCapability, ...change }]);
   expect(result.rows[0]!.value).toBe(false);
  }
 });
 it("claims a zero-cost vector request through the same fixed Logo lane and denies operation/tenant widening", async () => {
  const p = await f.prepareVector(), result = await f.action(null, "claim", ["shared-advanced-fixture", 120]), execution = sharedExecutionSchema.parse(result.execution);
  expect(execution.jobId).toBe(p.jobId); expect(execution.operation).toBe("identity.logo_vectorize"); expect(execution.ownerId).toBe(OWNER_A);
  const input = await f.action(execution, "read", [execution.jobId, execution.leaseToken, "vector_input", null]); expect(input.result).toHaveProperty("reference");
  await expect(f.action(execution, "direction_inputs", [execution.jobId, execution.leaseToken])).rejects.toMatchObject({ code: "42501" });
  await expect(f.action({ ...execution, ownerId: OWNER_B }, "read", [execution.jobId, execution.leaseToken, "vector_input", null])).rejects.toMatchObject({ code: "42501" });
  await expect(f.action(execution, "read", [execution.jobId, execution.leaseToken, "arbitrary-data", null])).rejects.toMatchObject({ code: "42501" });
  await f.owner(OWNER_A, () => f.db.query("select public.request_job_cancel($1)", [execution.jobId]));
  await f.action(execution, "finish", [execution.jobId, execution.leaseToken, "cancelled"]);
  const recovery = (await f.action(execution, "recovery", [])).result as { capability: unknown; remaining: boolean };
  expect(recovery.capability).toEqual(p.capability); expect(recovery.remaining).toBe(false);
 });
 it("withdraws runtime readiness after actual lease takeover until the new process advertises its full set", async () => {
  await f.takeover(); expect((await f.db.query<{ ready: boolean }>("select fluid_private.shared_logo_slot_runtime_ready($1) ready", [f.slotId])).rows[0]!.ready).toBe(false);
  expect(await f.runtimeReady()).toBe(true);
  await expect(f.action(null, "direction_inputs", [randomUUID(), randomUUID()])).rejects.toMatchObject({ code: "22023" });
 });
});
