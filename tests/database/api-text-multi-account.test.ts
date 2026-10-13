import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { asApiTextWorker, asRole, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { admit, availability, createMultiAccountFixture, enableLegacyOwner, enableSyntheticCohort,
  multiAccountSnapshot, MULTI_DEPLOYMENT, MULTI_POLICY, resetMultiAccountFixture } from "./api-text-multi-account-fixture";

describe("disabled-by-default multi-account API admission and restricted gateway", () => {
  let db: TestDatabase; let projects: { a: string; b: string };
  // Cold PGlite initialization in the cloud runner can exceed two minutes.
  // This bounds fixture setup only; admission and gateway assertions retain
  // their normal test deadlines.
  beforeAll(async () => { db = await createMultiAccountFixture(); }, 300_000);
  beforeEach(async () => { projects = await resetMultiAccountFixture(db); });
  afterAll(async () => { await db?.close(); });
  const call = async <T = unknown>(descriptor: unknown, action: string, args: unknown[] = []) => asApiTextWorker(db, OWNER_A,
    async () => (await db.query<{ result: T }>("select public.api_text_dispatch_action($1,$2,$3) result", [descriptor, action, args])).rows[0]!.result);
  it("keeps rollout unfunded and unavailable without mutating a new account", async () => {
    const before = await multiAccountSnapshot(db);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(admit(db, OWNER_B, projects.b)).rejects.toThrow("runtime_unavailable");
    expect(await multiAccountSnapshot(db)).toEqual(before);
  });
  it("preserves the old owner's configured admission and direct worker path while disabled", async () => {
    await enableLegacyOwner(db);
    expect((await availability(db, OWNER_A, projects.a)).status).toBe("available");
    const result = await admit(db, OWNER_A, projects.a);
    expect((await db.query("select * from fluid_private.api_text_owner_entitlements")).rows).toEqual([]);
    expect((await db.query("select * from fluid_private.api_text_allowance_admissions")).rows).toEqual([]);
    const read = await asApiTextWorker(db, OWNER_A, () => db.query<{ descriptor: { jobId: string } }>("select public.get_api_text_dispatch($1) descriptor", [result.id]));
    expect(read.rows[0]?.descriptor.jobId).toBe(result.id);
  });
  it("offers configured access without funding on read, then atomically admits one bounded owned job", async () => {
    await enableSyntheticCohort(db);
    const before = await multiAccountSnapshot(db);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("available");
    expect(await multiAccountSnapshot(db)).toEqual(before);
    const result = await admit(db, OWNER_B, projects.b);
    expect(result.dispatch.jobId).toBe(result.id);
    expect((await db.query("select attempts_used,cost_committed from fluid_private.api_text_owner_entitlements")).rows).toEqual([{ attempts_used: 1, cost_committed: 122880 }]);
    expect((await db.query("select accounts_used,attempts_used,cost_committed from fluid_private.api_text_allowance_rollout")).rows).toEqual([{ accounts_used: 1, attempts_used: 1, cost_committed: 122880 }]);
    expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_B])).rows).toEqual([{ reserved_microusd: 122880 }]);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(admit(db, OWNER_B, projects.b, "second-multi-account-fixture")).rejects.toThrow();
  });
  it("rolls back enrollment, policy binding, credit and every counter on failed accepted-cost admission", async () => {
    await enableSyntheticCohort(db); const before = await multiAccountSnapshot(db);
    await expect(admit(db, OWNER_B, projects.b, "invalid-cap-account-fixture", 1)).rejects.toThrow("accepted_cap_exceeded");
    expect(await multiAccountSnapshot(db)).toEqual(before);
  });
  it.each([
    "update auth.users set email_confirmed_at=null",
    "update auth.users set created_at=clock_timestamp()-interval '10 days'",
    "update fluid_private.api_text_allowance_cohorts set enabled=false",
    "update fluid_private.api_text_allowance_cohorts set owner_cost_limit=1",
    "update fluid_private.api_text_allowance_cohorts set expires_at=clock_timestamp()-interval '1 hour'",
    "update fluid_private.api_text_allowance_rollout set cost_limit=1",
    "update public.usage_accounts set limit_microusd=1",
  ])("fails closed for ineligible signup or limits: %s", async sql => {
    await enableSyntheticCohort(db); await db.exec(sql); const before = await multiAccountSnapshot(db);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    await expect(admit(db, OWNER_B, projects.b)).rejects.toThrow();
    expect(await multiAccountSnapshot(db)).toEqual(before);
  });
  it("keeps exact replay stable after rollout disable and quota exhaustion without consuming another attempt", async () => {
    await enableSyntheticCohort(db); const first = await admit(db, OWNER_B, projects.b);
    await db.exec("update fluid_private.api_text_allowance_rollout set enabled=false");
    const before = await multiAccountSnapshot(db);
    expect(await admit(db, OWNER_B, projects.b)).toEqual(first);
    expect(await multiAccountSnapshot(db)).toEqual(before);
    await expect(admit(db, OWNER_B, projects.b, "multi-account-fixture-request", 200000)).rejects.toThrow("idempotency_conflict");
  });
  it("does not give the worker raw access to the newly entitled owner's job, but accepts its exact admitted descriptor", async () => {
    await enableSyntheticCohort(db); const admitted = await admit(db, OWNER_B, projects.b);
    await asApiTextWorker(db, OWNER_A, async () => {
      expect((await db.query("select public.get_api_text_dispatch($1) result", [admitted.id])).rows).toEqual([{ result: null }]);
      await expect(db.query("select * from public.jobs")).rejects.toThrow();
      await expect(db.query("select * from fluid_private.api_text_gateway_context")).rejects.toThrow();
    });
    expect(await call(admitted.dispatch, "descriptor")).toMatchObject({ jobId: admitted.id, state: "queued" });
    expect((await db.query("select * from fluid_private.api_text_gateway_context")).rows).toEqual([]);
    expect(await asApiTextWorker(db, OWNER_A, async () => (await db.query<{ owner: string }>("select public.api_text_worker_owner() owner")).rows[0]?.owner)).toBe(OWNER_A);
  });
  it("refuses forged descriptor fields, another worker and caller-supplied owner/context/action", async () => {
    await enableSyntheticCohort(db); const admitted = await admit(db, OWNER_B, projects.b);
    for (const change of [{ jobId: crypto.randomUUID() }, { policyIdentity: "0".repeat(64) }, { deploymentId: "dpl_other" },
      { dispatchIdentity: "0".repeat(64) }, { ownerId: OWNER_A }, { version: 2 }]) {
      await expect(call({ ...admitted.dispatch, ...change }, "descriptor")).rejects.toThrow();
    }
    await expect(call(admitted.dispatch, "set_owner", [OWNER_B])).rejects.toThrow("invalid_dispatch_action");
    await expect(call(admitted.dispatch, "descriptor", [OWNER_B])).rejects.toThrow("invalid_dispatch_action");
    await expect(asApiTextWorker(db, OWNER_B, () => db.query("select public.api_text_dispatch_action($1,'descriptor')", [admitted.dispatch]))).rejects.toThrow("worker_owner_mismatch");
    expect((await db.query("select * from fluid_private.api_text_gateway_context")).rows).toEqual([]);
  });
  it("does not borrow authorization using JWT or custom session settings", async () => {
    await enableSyntheticCohort(db); const admitted = await admit(db, OWNER_B, projects.b);
    await asApiTextWorker(db, OWNER_A, async () => {
      await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('fluid.owner_id',$1,false)", [OWNER_B]);
      expect((await db.query("select public.get_api_text_dispatch($1) result", [admitted.id])).rows).toEqual([{ result: null }]);
    });
    await expect(asRole(db, "authenticated", OWNER_B, () => db.query("select public.api_text_dispatch_action($1,'descriptor')", [admitted.dispatch]))).rejects.toThrow();
  });
  it("retains cancellation and spent-attempt caps while exact replay remains available", async () => {
    await enableSyntheticCohort(db); const admitted = await admit(db, OWNER_B, projects.b);
    await asRole(db, "authenticated", OWNER_B, () => db.query("select public.request_job_cancel($1)", [admitted.id]));
    expect(await call(admitted.dispatch, "descriptor")).toMatchObject({ state: "cancelled" });
    expect((await db.query("select reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_B])).rows).toEqual([{ reserved_microusd: 0 }]);
    expect((await availability(db, OWNER_B, projects.b)).status).toBe("unavailable");
    expect((await admit(db, OWNER_B, projects.b)).id).toBe(admitted.id);
  });
  it("uses current enablement for dispatch but frozen authorization for settlement after withdrawal", async () => {
    await enableSyntheticCohort(db); const admitted = await admit(db, OWNER_B, projects.b);
    const claimed = await call<{ job: { lease_token: string } }>(admitted.dispatch, "claim", ["fixture-worker", 60]);
    const lease = claimed.job.lease_token;
    await call(admitted.dispatch, "plan", [lease, [{ key: "respond", maximumCostMicrousd: 122880 }]]);
    await call(admitted.dispatch, "begin", [lease, "respond", "fixture-request-key", 122880]);
    expect(await call(admitted.dispatch, "authorize", [lease, "respond"])).toBe(true);
    await db.exec("update fluid_private.api_text_allowance_rollout set enabled=false");
    expect(await call(admitted.dispatch, "authorize", [lease, "respond"])).toBe(false);
    await call(admitted.dispatch, "complete", [lease, "respond", "succeeded", 1000, {}, "synthetic-response"]);
    await call(admitted.dispatch, "finish", [lease, "succeeded", null]);
    expect((await db.query("select spent_microusd,reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_B])).rows).toEqual([{ spent_microusd: 1000, reserved_microusd: 0 }]);
    expect((await db.query("select cost_committed from fluid_private.api_text_owner_entitlements")).rows).toEqual([{ cost_committed: 122880 }]);
  });
  it("cleans context after an inner error and rejects foreign leases", async () => {
    await enableSyntheticCohort(db); const admitted = await admit(db, OWNER_B, projects.b);
    await expect(call(admitted.dispatch, "heartbeat", [crypto.randomUUID(), 60])).rejects.toThrow("lease_lost");
    expect((await db.query("select * from fluid_private.api_text_gateway_context")).rows).toEqual([]);
    expect(await call(admitted.dispatch, "descriptor")).toMatchObject({ jobId: admitted.id });
  });
  it("makes quota-independent protected readiness available only for exactly configured bounded operations", async () => {
    await enableSyntheticCohort(db);
    const result = await asApiTextWorker(db, OWNER_A, () => db.query("select * from public.api_text_multi_account_readiness($1,$2)",
      [[{ operation: "strategy.reformulate", policy: MULTI_POLICY }], MULTI_DEPLOYMENT]));
    expect(result.rows).toEqual([{ operation: "strategy.reformulate", ready: true }]);
  });
});
