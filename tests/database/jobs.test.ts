import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, claim, createTestDatabase, enqueue, OWNER_A, OWNER_B, registerPlan, resetFixture, seedProject, type TestDatabase } from "./local-supabase";

describe("local PostgreSQL durable job invariants", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); }, 30_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); });
  const service = <T>(run: () => Promise<T>) => asRole(db, "service_role", null, run);
  const lease = async (plan = [{ key: "first", maximumCostMicrousd: 100 }]) => {
    const job = await claim(db);
    if (job) await registerPlan(db, job, plan);
    return job;
  };
  const budget = async () => (await db.query<{ reserved_microusd: number; spent_microusd: number }>("select reserved_microusd, spent_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0];
  const state = async (id: string) => (await db.query<{ state: string }>("select state from public.jobs where id=$1", [id])).rows[0]?.state;
  const expire = async (id: string) => {
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [id]);
    return service(() => db.query("select public.expire_job_leases()"));
  };
  const begin = (job: { id: string; lease_token: string }, key = "first", cost = 100) =>
    service(() => db.query("select * from public.begin_job_step($1,$2,$3,$4,$5)", [job.id, job.lease_token, key, `provider-${key}`, cost]));
  const complete = (job: { id: string; lease_token: string }, key = "first", outcome = "succeeded", cost = 40, output: unknown = { result: "local_fixture" }) =>
    service(() => db.query("select * from public.complete_job_step($1,$2,$3,$4,$5,$6,'local-request-id')", [job.id, job.lease_token, key, outcome, cost, output]));
  const finish = (job: { id: string; lease_token: string }, outcome = "succeeded") =>
    service(() => db.query("select * from public.finish_job($1,$2,$3)", [job.id, job.lease_token, outcome]));

  it("reserves atomically, returns the same job for identical requests, rejects changed or excess requests", async () => {
    const p = await seedProject(db);
    const job = await enqueue(db, p.id, "same", 700);
    expect((await enqueue(db, p.id, "same", 700)).id).toBe(job.id);
    expect(await budget()).toEqual({ reserved_microusd: 700, spent_microusd: 0 });
    await expect(enqueue(db, p.id, "same", 701)).rejects.toThrow(/idempotency_conflict/);
    await expect(enqueue(db, p.id, "excess", 301)).rejects.toThrow(/budget_exceeded/);
    expect((await db.query("select * from public.jobs")).rows).toHaveLength(1);
  });

  it("gives a single lease, fences stale tokens, and cannot heartbeat an expired lease", async () => {
    await enqueue(db, (await seedProject(db)).id);
    const first = await lease();
    expect(await lease()).toBeUndefined();
    await expect(service(() => db.query("select * from public.heartbeat_job($1,$2,60)", [first.id, OWNER_B]))).rejects.toThrow(/lease_lost/);
    await expire(first.id);
    const second = await lease();
    expect(second.lease_token).not.toBe(first.lease_token);
    expect(second.attempts).toBe(2);
    await expect(begin(first)).rejects.toThrow(/lease_lost/);
    await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [second.id]);
    await expect(service(() => db.query("select * from public.heartbeat_job($1,$2,60)", [second.id, second.lease_token]))).rejects.toThrow(/lease_lost/);
  });

  it("bounds step reservations and forbids resending a previously started request", async () => {
    await enqueue(db, (await seedProject(db)).id);
    const job = await lease([{ key: "first", maximumCostMicrousd: 80 }, { key: "second", maximumCostMicrousd: 20 }]);
    await begin(job, "first", 80);
    await expect(begin(job, "second", 21)).rejects.toThrow(/plan_step_mismatch/);
    await expect(begin(job, "first", 80)).rejects.toThrow(/step_already_started/);
    await expect(finish(job)).rejects.toThrow(/unresolved_steps/);
  });

  it("records partial results once, charges actual usage once, and settles unused reservation", async () => {
    await enqueue(db, (await seedProject(db)).id);
    const job = await lease();
    await begin(job);
    await complete(job);
    await complete(job); // Idempotent acknowledgment, no duplicate charge.
    expect(await budget()).toEqual({ reserved_microusd: 60, spent_microusd: 40 });
    await expect(complete(job, "first", "succeeded", 41)).rejects.toThrow(/immutable_result/);
    await finish(job, "partial");
    expect(await state(job.id)).toBe("partial");
    expect(await budget()).toEqual({ reserved_microusd: 0, spent_microusd: 40 });
    expect((await db.query<{ output: unknown }>("select output from public.job_steps where job_id=$1", [job.id])).rows[0]?.output).toEqual({ result: "local_fixture" });
  });

  it("cancels queued jobs immediately and running jobs at the next boundary, preserving completed outputs", async () => {
    const p = await seedProject(db);
    const queued = await enqueue(db, p.id);
    await asRole(db, "authenticated", OWNER_A, () => db.query("select * from public.request_job_cancel($1)", [queued.id]));
    expect(await state(queued.id)).toBe("cancelled");
    expect(await budget()).toEqual({ reserved_microusd: 0, spent_microusd: 0 });
    await enqueue(db, p.id, "running");
    const running = await lease();
    await begin(running);
    await asRole(db, "authenticated", OWNER_A, () => db.query("select * from public.request_job_cancel($1)", [running.id]));
    await expect(begin(running, "extra", 0)).rejects.toThrow(/cancel_requested/);
    await complete(running);
    await expect(finish(running)).rejects.toThrow(/cancel_requested/);
    await finish(running, "cancelled");
    expect(await state(running.id)).toBe("cancelled");
    expect((await db.query("select * from public.job_steps where job_id=$1", [running.id])).rows).toHaveLength(1);
    expect(await budget()).toEqual({ reserved_microusd: 0, spent_microusd: 40 });
  });

  it("quarantines expired in-flight requests for reconciliation without retrying or releasing their budget", async () => {
    await enqueue(db, (await seedProject(db)).id);
    const job = await lease();
    await begin(job);
    await expire(job.id);
    expect(await state(job.id)).toBe("needs_reconciliation");
    expect(await lease()).toBeUndefined();
    expect(await budget()).toEqual({ reserved_microusd: 100, spent_microusd: 0 });
    await expect(complete(job)).rejects.toThrow(/lease_lost/);
    await asRole(db, "authenticated", OWNER_A, () => db.query("select * from public.request_job_cancel($1)", [job.id]));
    expect(await state(job.id)).toBe("needs_reconciliation");
  });

  it("records ambiguous outcomes and blocks follow-up calls without pretending the request was free", async () => {
    await enqueue(db, (await seedProject(db)).id);
    const job = await lease();
    await begin(job);
    await complete(job, "first", "ambiguous", 10, { retained: "partial evidence" });
    expect(await state(job.id)).toBe("needs_reconciliation");
    expect(await budget()).toEqual({ reserved_microusd: 90, spent_microusd: 10 });
    await expect(begin(job, "again", 10)).rejects.toThrow(/lease_lost/);
    expect(await lease()).toBeUndefined();
  });

  it("retains unexpected billing overruns as evidence and stops execution", async () => {
    await enqueue(db, (await seedProject(db)).id);
    const job = await lease();
    await begin(job);
    await complete(job, "first", "succeeded", 120);
    expect(await state(job.id)).toBe("needs_reconciliation");
    expect(await budget()).toEqual({ reserved_microusd: 0, spent_microusd: 100 });
    expect((await db.query<{ provider_actual_microusd: number }>("select provider_actual_microusd from public.usage_accounts where owner_id=$1", [OWNER_A])).rows[0]?.provider_actual_microusd).toBe(120);
    expect((await db.query<{ captured_microusd: number }>("select captured_microusd from public.usage_reservations where job_id=$1", [job.id])).rows[0]?.captured_microusd).toBe(100);
    await expect(begin(job, "extra", 0)).rejects.toThrow(/lease_lost/);
  });

  it("stops other reserved work when an observed provider overrun exhausts the account guard", async () => {
    const project = await seedProject(db);
    await enqueue(db, project.id, "overrun", 100);
    const overrun = await lease();
    await enqueue(db, project.id, "other-reserved", 900);
    const other = await lease();
    await begin(overrun);
    await complete(overrun, "first", "succeeded", 150);
    expect(await lease()).toBeUndefined();
    expect(await budget()).toEqual({ reserved_microusd: 900, spent_microusd: 100 });
    const ledger = () => db.query("select reserved_microusd,spent_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1", [OWNER_A]);
    const ledgerBefore = (await ledger()).rows;
    expect(ledgerBefore).toEqual([{ reserved_microusd: 900, spent_microusd: 100, provider_actual_microusd: 150 }]);
    const steps = () => db.query("select to_jsonb(step) value from public.job_steps step order by job_id,step_key");
    const stepsBefore = (await steps()).rows;
    expect(stepsBefore).toHaveLength(1);
    // A valid planned sibling step must stop at the owner-wide paid uncertainty
    // fence, before affordability or a new provider-dispatch row is considered.
    await expect(begin(other)).rejects.toMatchObject({ code: "P0001", message: "paid_outcome_unresolved" });
    await expect(enqueue(db, project.id, "new-work", 1)).rejects.toMatchObject({ code: "P0001", message: "budget_exceeded" });
    expect(await state(overrun.id)).toBe("needs_reconciliation");
    expect(await state(other.id)).toBe("running");
    expect((await steps()).rows).toEqual(stepsBefore);
    expect((await ledger()).rows).toEqual(ledgerBefore);
    expect((await db.query("select id from public.jobs")).rows).toHaveLength(2);
  });

  it("bounds retries for safely unstarted jobs and releases exhausted reservations", async () => {
    await enqueue(db, (await seedProject(db)).id, "bounded", 100, OWNER_A, 1);
    const job = await lease();
    await expire(job.id);
    expect(await state(job.id)).toBe("failed");
    expect(await lease()).toBeUndefined();
    expect(await budget()).toEqual({ reserved_microusd: 0, spent_microusd: 0 });
  });

  it("preserves prior outputs on a safe retry and keeps progress monotone and fenced", async () => {
    await enqueue(db, (await seedProject(db)).id);
    const job = await lease();
    await begin(job);
    await complete(job);
    await service(() => db.query("select * from public.report_job_progress($1,$2,50)", [job.id, job.lease_token]));
    await expect(service(() => db.query("select * from public.report_job_progress($1,$2,49)", [job.id, job.lease_token]))).rejects.toThrow(/invalid_progress/);
    await expire(job.id);
    const retry = await lease();
    expect(retry.id).toBe(job.id);
    await expect(service(() => db.query("select * from public.report_job_progress($1,$2,60)", [job.id, job.lease_token]))).rejects.toThrow(/lease_lost/);
    expect((await db.query("select output from public.job_steps where job_id=$1", [job.id])).rows).toHaveLength(1);
    await finish(retry);
    expect(await budget()).toEqual({ reserved_microusd: 0, spent_microusd: 40 });
  });

  it("does not claim success without a completed result", async () => {
    await enqueue(db, (await seedProject(db)).id);
    const job = await lease();
    await expect(finish(job)).rejects.toThrow(/invalid_outcome/);
    await finish(job, "failed");
    expect(await state(job.id)).toBe("failed");
  });
});
