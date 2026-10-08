import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, claim, createTestDatabase, enqueue, OWNER_A, OWNER_B, registerPlan, resetFixture, seedProject, type TestDatabase } from "./local-supabase";

describe("immutable database job plans across worker retries", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); });
  const service = <T>(run: () => Promise<T>) => asRole(db, "service_role", null, run);
  const one = [{ key: "one", maximumCostMicrousd: 50 }];
  const both = [...one, { key: "two", maximumCostMicrousd: 50 }];
  const setup = async () => { await enqueue(db, (await seedProject(db)).id); return claim(db); };
  const begin = (job: { id: string; lease_token: string }, key = "one", cost = 50) => service(() => db.query(
    "select * from public.begin_job_step($1,$2,$3,$4,$5)", [job.id, job.lease_token, key, `fixture-${key}`, cost]));
  const complete = (job: { id: string; lease_token: string }, key = "one") => service(() => db.query(
    "select * from public.complete_job_step($1,$2,$3,'succeeded',10,'{}','fixture-request')", [job.id, job.lease_token, key]));
  const finish = (job: { id: string; lease_token: string }) => service(() => db.query(
    "select * from public.finish_job($1,$2,'succeeded')", [job.id, job.lease_token]));

  it("requires a registered plan before starting any step", async () => {
    const job = await setup();
    await expect(begin(job)).rejects.toThrow(/plan_required/);
    expect((await db.query("select * from public.job_steps")).rows).toHaveLength(0);
  });

  it("registers once with a fingerprint and rejects changed keys, costs, order or omitted units", async () => {
    const job = await setup();
    const first = await registerPlan(db, job, both);
    const again = await registerPlan(db, job, both);
    expect(first.plan_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(again.plan_fingerprint).toBe(first.plan_fingerprint);
    expect(first.plan_manifest).toEqual(both);
    for (const changed of [one, [...both].reverse(), [{ key: "renamed", maximumCostMicrousd: 50 }, both[1]!], [{ key: "one", maximumCostMicrousd: 49 }, both[1]!]]) {
      await expect(registerPlan(db, job, changed)).rejects.toThrow(/plan_conflict/);
    }
    await expect(db.query("update public.jobs set plan_manifest='[]'::jsonb where id=$1", [job.id])).rejects.toThrow(/immutable_job_plan/);
    await expect(db.query("update public.jobs set plan_fingerprint=$1 where id=$2", ["f".repeat(64), job.id])).rejects.toThrow(/immutable_job_plan/);
  });

  it("validates array shape, strict fields, distinct keys, integer bounds, size and total reservation", async () => {
    const job = await setup();
    const invalid = [null, {}, [], [{ key: "one" }], [{ key: "one", maximumCostMicrousd: "1" }],
      [{ key: "one", maximumCostMicrousd: 1, extra: true }], [...one, ...one],
      [{ key: "with spaces", maximumCostMicrousd: 1 }], [{ key: "one", maximumCostMicrousd: -1 }],
      [{ key: "one", maximumCostMicrousd: 0.5 }], [{ key: "one", maximumCostMicrousd: 9_007_199_254_740_992 }],
      Array.from({ length: 1001 }, (_, i) => ({ key: `unit-${i}`, maximumCostMicrousd: 0 }))];
    for (const manifest of invalid) {
      await expect(service(() => db.query("select * from public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify(manifest)]))).rejects.toThrow(/invalid_plan/);
    }
    await expect(registerPlan(db, job, [{ key: "one", maximumCostMicrousd: 60 }, { key: "two", maximumCostMicrousd: 41 }])).rejects.toThrow(/budget_exceeded/);
    expect((await db.query<{ plan_manifest: unknown }>("select plan_manifest from public.jobs where id=$1", [job.id])).rows[0]?.plan_manifest).toBeNull();
  });

  it("requires the exact planned step key and maximum cost", async () => {
    const job = await setup();
    await registerPlan(db, job, one);
    await expect(begin(job, "unplanned", 50)).rejects.toThrow(/plan_step_mismatch/);
    await expect(begin(job, "one", 49)).rejects.toThrow(/plan_step_mismatch/);
    await begin(job);
    expect((await db.query("select * from public.job_steps")).rows).toHaveLength(1);
  });

  it("rejects success after a retry completes only a subset; retains the original plan and outputs", async () => {
    const first = await setup();
    await registerPlan(db, first, both);
    await begin(first);
    await complete(first);
    await expect(finish(first)).rejects.toThrow(/plan_incomplete/);
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [first.id]);
    await service(() => db.query("select public.expire_job_leases()"));
    const next = await claim(db);
    expect(next.id).toBe(first.id);
    await expect(registerPlan(db, next, one)).rejects.toThrow(/plan_conflict/);
    await expect(finish(next)).rejects.toThrow(/plan_incomplete/);
    await registerPlan(db, next, both);
    await begin(next, "two");
    await complete(next, "two");
    await finish(next);
    expect((await db.query<{ state: string }>("select state from public.jobs where id=$1", [next.id])).rows[0]?.state).toBe("succeeded");
    expect((await db.query("select * from public.job_steps where job_id=$1", [next.id])).rows).toHaveLength(2);
  });

  it("keeps plan registration service-only, lease-fenced, and cancellation-aware", async () => {
    const job = await setup();
    await asRole(db, "authenticated", OWNER_A, async () => {
      await expect(db.query("select * from public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify(one)])).rejects.toThrow(/permission denied/);
      await expect(db.query("select plan_manifest from public.jobs where id=$1", [job.id])).rejects.toThrow(/permission denied/);
    });
    await expect(registerPlan(db, { ...job, lease_token: OWNER_B }, one)).rejects.toThrow(/lease_lost/);
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.request_job_cancel($1)", [job.id]));
    await expect(registerPlan(db, job, one)).rejects.toThrow(/cancel_requested/);
  });
});
