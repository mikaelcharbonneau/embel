import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, claim, createTestDatabase, enqueue, OWNER_A, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";

// Local database-boundary tests for the plan-registration contract specified during QA.
const manifest = [{ key: "one", maximumCostMicrousd: 40 }, { key: "two", maximumCostMicrousd: 60 }];
describe("independent immutable job plan attacks", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  beforeEach(async () => { await resetFixture(db); });
  afterAll(async () => { await db?.close(); });
  const service = <T>(run: () => Promise<T>) => asRole(db, "service_role", null, run);
  const register = (job: { id: string; lease_token: string }, plan: unknown = manifest) =>
    service(() => db.query("select * from public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify(plan)]));
  const begin = (job: { id: string; lease_token: string }, key: string, cost: number) =>
    service(() => db.query("select * from public.begin_job_step($1,$2,$3,$4,$5)", [job.id, job.lease_token, key, `qa-${key}`, cost]));
  const complete = (job: { id: string; lease_token: string }, key: string) =>
    service(() => db.query("select * from public.complete_job_step($1,$2,$3,'succeeded',10,'{\"qa_fixture\":true}','qa-local')", [job.id, job.lease_token, key]));
  const finish = (job: { id: string; lease_token: string }) =>
    service(() => db.query("select * from public.finish_job($1,$2,'succeeded')", [job.id, job.lease_token]));
  const fixture = async () => { await enqueue(db, (await seedProject(db)).id); return claim(db); };

  it("requires an immutable declared plan and exact keys and costs before dispatch", async () => {
    const job = await fixture();
    await expect(begin(job, "one", 40)).rejects.toThrow(/plan_required/);
    await register(job);
    await expect(begin(job, "extra", 0)).rejects.toThrow(/plan_step_mismatch/);
    await expect(begin(job, "one", 39)).rejects.toThrow(/plan_step_mismatch/);
    await expect(begin(job, "one", 41)).rejects.toThrow(/plan_step_mismatch/);
    expect((await db.query("select * from public.job_steps where job_id=$1", [job.id])).rows).toHaveLength(0);
    await begin(job, "one", 40);
  });

  it("rejects success with only a prefix of the persisted plan completed", async () => {
    const job = await fixture();
    await register(job);
    await begin(job, "one", 40);
    await complete(job, "one");
    await expect(finish(job)).rejects.toThrow(/plan_incomplete/);
    await begin(job, "two", 60);
    await complete(job, "two");
    await finish(job);
    expect((await db.query("select state,progress from public.jobs where id=$1", [job.id])).rows).toEqual([{ state: "succeeded", progress: 100 }]);
  });

  it("rejects removed, added, reordered, and recosted plans while accepting identical registration", async () => {
    const job = await fixture();
    await register(job);
    await register(job, structuredClone(manifest));
    for (const changed of [manifest.slice(0, 1), [...manifest, { key: "extra", maximumCostMicrousd: 0 }], [...manifest].reverse(), [{ key: "one", maximumCostMicrousd: 39 }, manifest[1]]]) {
      await expect(register(job, changed)).rejects.toThrow(/plan_conflict/);
    }
    expect((await db.query<{ plan_manifest: unknown }>("select plan_manifest from public.jobs where id=$1", [job.id])).rows[0]?.plan_manifest).toEqual(manifest);
  });

  it("preserves the original plan across process loss and rejects stale registration", async () => {
    const job = await fixture();
    await register(job);
    await begin(job, "one", 40);
    await complete(job, "one");
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    await service(() => db.query("select public.expire_job_leases()"));
    const next = await claim(db);
    expect(next.id).toBe(job.id);
    await expect(register(job)).rejects.toThrow(/lease_lost/);
    await expect(register(next, manifest.slice(0, 1))).rejects.toThrow(/plan_conflict/);
    await expect(finish(next)).rejects.toThrow(/plan_incomplete/);
    await register(next);
    expect((await db.query("select * from public.job_steps where job_id=$1", [job.id])).rows).toHaveLength(1);
  });

  it("rejects malformed or over-budget plans atomically", async () => {
    const job = await fixture();
    const invalid = [null, {}, [], [{ key: "one", maximumCostMicrousd: -1 }], [{ key: "one", maximumCostMicrousd: 0.5 }],
      [{ key: "one", maximumCostMicrousd: 101 }], [{ key: "one", maximumCostMicrousd: 0, unexpected: true }],
      [{ key: "one", maximumCostMicrousd: 0 }, { key: "one", maximumCostMicrousd: 0 }], [{ key: "bad key", maximumCostMicrousd: 0 }]];
    for (const plan of invalid) await expect(register(job, plan)).rejects.toThrow();
    expect((await db.query<{ plan_manifest: unknown }>("select plan_manifest from public.jobs where id=$1", [job.id])).rows[0]?.plan_manifest).toBeNull();
    expect((await db.query("select reserved_microusd,spent_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([{ reserved_microusd: 100, spent_microusd: 0 }]);
  });

  it("enforces plan immutability even on an administrative update and hides it from clients", async () => {
    const job = await fixture();
    await register(job);
    await expect(db.query("update public.jobs set plan_manifest='[]' where id=$1", [job.id])).rejects.toThrow(/immutable/);
    await expect(db.query("update public.jobs set plan_fingerprint=$1 where id=$2", ["f".repeat(64), job.id])).rejects.toThrow(/immutable/);
    await asRole(db, "authenticated", OWNER_A, async () => {
      await expect(db.query("select plan_manifest from public.jobs where id=$1", [job.id])).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify(manifest)])).rejects.toThrow(/permission denied/);
    });
  });

  it("rejects retroactive registration after persisted work and success with extra output", async () => {
    const job = await fixture();
    const owner = (await db.query<{ owner_id: string; project_id: string }>("select owner_id,project_id from public.jobs where id=$1", [job.id])).rows[0]!;
    // Deliberately corrupted administrative fixture to test final validation independently of begin.
    await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values($1,$2,$3,'extra','qa-extra','succeeded',0)", [job.id, owner.owner_id, owner.project_id]);
    await expect(register(job)).rejects.toThrow(/plan_already_started/);
    await db.query("delete from public.job_steps where job_id=$1", [job.id]);
    await register(job);
    for (const step of manifest) { await begin(job, step.key, step.maximumCostMicrousd); await complete(job, step.key); }
    await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd) values($1,$2,$3,'extra','qa-extra','succeeded',0)", [job.id, owner.owner_id, owner.project_id]);
    await expect(finish(job)).rejects.toThrow(/plan_incomplete/);
  });
});
