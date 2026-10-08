import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresJobStore } from "../../worker/postgres-store";
import { runOneJob, type JobHandler } from "../../worker/runner";
import { asRole, createTestDatabase, enqueue, OWNER_A, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";

describe("independent worker and PostgreSQL recovery checks", () => {
  let db: TestDatabase;
  let store: PostgresJobStore;
  beforeAll(async () => {
    db = await createTestDatabase();
    const pool = { query: (query: string, values?: unknown[]) => asRole(db, "service_role", null, () => db.query(query, values)) };
    store = new PostgresJobStore(pool as unknown as Pick<Pool, "query">);
  }, 30_000);
  beforeEach(async () => { await resetFixture(db); });
  afterAll(async () => { await db?.close(); });
  const run = (handler: JobHandler) => runOneJob({ store, handlers: new Map([["strategy", handler]]), workerId: "qa-local-worker" });

  it("persists cost-overrun output and real expense while freezing reconciliation", async () => {
    const job = await enqueue(db, (await seedProject(db)).id);
    const generated = { fixture: true, retained: "Explicit local content, not a provider result" };
    const execute = vi.fn(async () => ({ status: "succeeded" as const, result: generated, costMicrousd: 120, providerRequestId: "qa-cost-overrun" }));
    const handler = { steps: () => [{ key: "one", maximumCostMicrousd: 100, execute }] };
    expect(await run(handler)).toBe("needs_reconciliation");
    const step = (await db.query<{ output: unknown; actual_cost_microusd: number }>("select output,actual_cost_microusd from public.job_steps where job_id=$1", [job.id])).rows[0];
    expect(step).toEqual({ output: { error: "provider_cost_exceeded", result: generated }, actual_cost_microusd: 120 });
    expect((await db.query("select state,lease_token from public.jobs where id=$1", [job.id])).rows).toEqual([{ state: "needs_reconciliation", lease_token: null }]);
    expect((await db.query("select spent_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ spent_microusd: 100, provider_actual_microusd: 120 }]);
    expect(await run(handler)).toBe("idle");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("holds an uncertain timed-out request reservation and fences late output", async () => {
    const job = await enqueue(db, (await seedProject(db)).id);
    let completeProvider!: () => void;
    const pending = new Promise<{ status: "succeeded"; result: { lateFixture: boolean }; costMicrousd: number; providerRequestId: string }>(resolve => {
      completeProvider = () => resolve({ status: "succeeded", result: { lateFixture: true }, costMicrousd: 10, providerRequestId: "qa-late" });
    });
    const handler = { steps: () => [{ key: "one", maximumCostMicrousd: 100, timeoutMs: 20, execute: () => pending }] };
    expect(await run(handler)).toBe("needs_reconciliation");
    completeProvider();
    await pending;
    expect((await db.query("select reserved_microusd,spent_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ reserved_microusd: 100, spent_microusd: 0 }]);
    expect((await db.query("select state,output from public.job_steps where job_id=$1", [job.id])).rows).toEqual([{ state: "ambiguous", output: { error: "provider_outcome_unknown" } }]);
    expect(await run(handler)).toBe("idle");
  });

  it("cannot call a changed recovery handler or mark its shorter plan succeeded", async () => {
    const job = await enqueue(db, (await seedProject(db)).id);
    const lease = (await store.claim("qa-before-process-loss", 60))!;
    await store.registerPlan(lease, [{ key: "one", maximumCostMicrousd: 40 }, { key: "two", maximumCostMicrousd: 60 }]);
    await store.beginStep(lease, "one", 40);
    await store.completeStep(lease, "one", { status: "succeeded", result: { originalFixture: true }, costMicrousd: 10, providerRequestId: "qa-first" });
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    await store.expireLeases();
    const execute = vi.fn(async () => ({ status: "succeeded" as const, result: {}, costMicrousd: 0, providerRequestId: null }));
    expect(await run({ steps: () => [{ key: "one", maximumCostMicrousd: 40, execute }] })).not.toBe("succeeded");
    expect(execute).not.toHaveBeenCalled();
    expect((await db.query("select state from public.jobs where id=$1", [job.id])).rows[0]).not.toEqual({ state: "succeeded" });
    expect((await db.query("select output from public.job_steps where job_id=$1", [job.id])).rows).toEqual([{ output: { originalFixture: true } }]);
  });
});
