import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresJobStore } from "../../worker/postgres-store";
import { NotDispatchedError, runOneJob, type JobHandler } from "../../worker/runner";
import { asRole, createTestDatabase, enqueue, OWNER_A, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";

describe("worker integrated with actual PostgreSQL RPCs", () => {
  let db: TestDatabase;
  let store: PostgresJobStore;
  beforeAll(async () => {
    db = await createTestDatabase();
    const pool = { query: (text: string, values?: unknown[]) => asRole(db, "service_role", null, () => db.query(text, values)) };
    store = new PostgresJobStore(pool as unknown as Pick<Pool, "query">);
  }, 30000);
  beforeEach(async () => { await resetFixture(db); });
  afterAll(async () => { await db?.close(); });
  const row = async (id: string) => (await db.query<{ state: string; progress: number; actual_cost_microusd: number }>("select state,progress,actual_cost_microusd from public.jobs where id=$1", [id])).rows[0];
  const run = (handler: JobHandler) => runOneJob({ store, handlers: new Map([["strategy", handler]]), workerId: "local-integration" });

  it("retains two successful outputs when the third unit cannot dispatch", async () => {
    const job = await enqueue(db, (await seedProject(db)).id);
    const output = (number: number) => async () => ({ status: "succeeded" as const, result: { number, fixture: true }, costMicrousd: 20, providerRequestId: `fixture-${number}` });
    expect(await run({ steps: () => [
      { key: "one", maximumCostMicrousd: 30, execute: output(1) },
      { key: "two", maximumCostMicrousd: 30, execute: output(2) },
      { key: "three", maximumCostMicrousd: 30, execute: async () => { throw new NotDispatchedError(); } },
    ] })).toBe("partial");
    expect(await row(job.id)).toMatchObject({ state: "partial", actual_cost_microusd: 40 });
    expect((await db.query("select output from public.job_steps where job_id=$1 and state='succeeded'", [job.id])).rows).toHaveLength(2);
  });

  it("quarantines an uncertain paid request without finalizing or redispatching", async () => {
    const job = await enqueue(db, (await seedProject(db)).id);
    const execute = vi.fn(async () => { throw new Error("fixture timeout after sending"); });
    const handler = { steps: () => [{ key: "one", maximumCostMicrousd: 100, execute }] };
    expect(await run(handler)).toBe("needs_reconciliation");
    expect(await row(job.id)).toMatchObject({ state: "needs_reconciliation" });
    expect(await run(handler)).toBe("idle");
    expect(execute).toHaveBeenCalledTimes(1);
    const account = (await db.query<{ reserved_microusd: number }>("select reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0];
    expect(account?.reserved_microusd).toBe(100);
  });

  it("recovers after a process stops between units, skips completed work, and captures each result once", async () => {
    const job = await enqueue(db, (await seedProject(db)).id);
    const firstLease = (await store.claim("prior-process", 60))!;
    await store.registerPlan(firstLease, [{ key: "one", maximumCostMicrousd: 90 }, { key: "two", maximumCostMicrousd: 10 }]);
    await store.beginStep(firstLease, "one", 90);
    await store.completeStep(firstLease, "one", { status: "succeeded", result: { fixture: "already persisted" }, costMicrousd: 90, providerRequestId: "fixture-first" });
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    expect(await store.expireLeases()).toBe(1);
    const neverAgain = vi.fn(async () => ({ status: "succeeded" as const, result: {}, costMicrousd: 90, providerRequestId: null }));
    expect(await run({ steps: () => [
      { key: "one", maximumCostMicrousd: 90, execute: neverAgain },
      { key: "two", maximumCostMicrousd: 10, execute: async () => ({ status: "succeeded", result: { fixture: "new result" }, costMicrousd: 5, providerRequestId: "fixture-second" }) },
    ] })).toBe("succeeded");
    expect(neverAgain).not.toHaveBeenCalled();
    expect(await row(job.id)).toMatchObject({ state: "succeeded", progress: 100, actual_cost_microusd: 95 });
    const account = (await db.query<{ spent_microusd: number; reserved_microusd: number }>("select spent_microusd,reserved_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0];
    expect(account).toEqual({ spent_microusd: 95, reserved_microusd: 0 });
  });
});
