import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, claim, createTestDatabase, enqueue, HASH, OWNER_A, OWNER_B, registerPlan, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";
import { beginStep, completeStep, finishJob } from "../database/retired-worker-fixture";

type Summary = { id: string; lifecycle_version: number; deletion_state: string; deletion_requested_at: string | null };
type UsageAccount = { owner_id: string; reserved_microusd: number; spent_microusd: number; provider_actual_microusd: number; limit_microusd: number };

/** Independent disposable PostgreSQL fixtures. No hosted database or provider. */
describe("independent stop-and-delete transaction safety", () => {
  let db: TestDatabase;
  let project: string;
  const owner = <T>(run: () => Promise<T>, identity: string | null = OWNER_A) => asRole(db, "authenticated", identity, run);
  const service = <T>(run: () => Promise<T>) => asRole(db, "service_role", null, run);
  const request = (epoch = 0, identity = OWNER_A) => owner(async () => (await db.query<{ result: Summary }>(
    "select public.request_project_deletion($1,1,$2) result", [project, epoch])).rows[0]!.result, identity);
  const restore = (epoch = 1) => owner(async () => (await db.query<{ result: Summary }>(
    "select public.restore_project_deletion($1,1,$2) result", [project, epoch])).rows[0]!.result);
  const state = () => owner(async () => (await db.query<{ result: Summary }>("select public.get_project_deletion($1) result", [project])).rows[0]!.result);
  const snapshot = async () => ({
    projects: (await db.query("select * from public.projects order by id")).rows,
    jobs: (await db.query("select * from public.jobs order by id")).rows,
    steps: (await db.query("select * from public.job_steps order by id")).rows,
    reservations: (await db.query("select * from public.usage_reservations order by job_id")).rows,
    accounts: (await db.query<UsageAccount>("select * from public.usage_accounts order by owner_id")).rows,
  });
  async function started(key = "review-running") {
    await enqueue(db, project, key);
    const job = await claim(db);
    await registerPlan(db, job, [{ key: "one", maximumCostMicrousd: 100 }]);
    await beginStep(db, job, "one", "review-provider-request", 100);
    return job;
  }
  beforeAll(async () => { db = await createTestDatabase(); }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); project = (await seedProject(db)).id; });

  it("replays only the current deletion epoch and never releases a reservation twice", async () => {
    const job = await enqueue(db, project);
    expect(await request()).toMatchObject({ deletion_state: "deleted", lifecycle_version: 1 });
    const after = await snapshot();
    expect(after.jobs[0]).toMatchObject({ id: job.id, state: "cancelled" });
    expect(after.reservations[0]).toMatchObject({ state: "settled", actual_microusd: 0 });
    expect(after.accounts.find(row => row.owner_id === OWNER_A)).toMatchObject({ reserved_microusd: 0, spent_microusd: 0, provider_actual_microusd: 0, limit_microusd: 1000 });
    expect(await request()).toMatchObject({ lifecycle_version: 1 });
    expect(await snapshot()).toEqual(after);
    expect(await restore()).toMatchObject({ lifecycle_version: 2, deletion_state: "active" });
    await expect(request()).rejects.toMatchObject({ code: "PT409", message: "lifecycle_conflict" });
    expect(await request(2)).toMatchObject({ lifecycle_version: 3 });
    expect((await snapshot()).reservations).toEqual(after.reservations);
    expect((await snapshot()).accounts).toEqual(after.accounts);
    expect((await snapshot()).jobs).toEqual(after.jobs);
  });

  it("rolls back intent and earlier cancellation/ledger writes if a later cancellation is contended", async () => {
    await enqueue(db, project, "review-rollback-first");
    await enqueue(db, project, "review-rollback-second");
    const before = await snapshot();
    // Inject a deterministic later 55P03, not a claim of two-session concurrency.
    await db.exec(`create function public.fixture_delete_late_contention() returns trigger language plpgsql as $$ begin
      if NEW.state='cancelled' and exists(select 1 from public.jobs where project_id=NEW.project_id and id<>NEW.id and state='cancelled') then
        raise exception 'fixture contention' using errcode='55P03'; end if; return NEW; end $$;
      create trigger fixture_delete_late_contention before update on public.jobs for each row execute function public.fixture_delete_late_contention();`);
    try {
      await expect(request()).rejects.toMatchObject({ code: "PT409", message: "project_deletion_retry" });
      expect(await snapshot()).toEqual(before);
    } finally { await db.exec("drop trigger fixture_delete_late_contention on public.jobs; drop function public.fixture_delete_late_contention()"); }
    expect(await request()).toMatchObject({ deletion_state: "deleted", lifecycle_version: 1 });
  });

  it("keeps queued jobs with prior step evidence and their reservations unresolved", async () => {
    const job = await started();
    // Model a historical/recovery queued row carrying durable provider evidence.
    await db.query("update public.jobs set state='queued',lease_token=null,lease_expires_at=null where id=$1", [job.id]);
    const before = await snapshot();
    expect(await request()).toMatchObject({ deletion_state: "awaiting_resolution" });
    const after = await snapshot();
    expect(after.jobs[0]).toMatchObject({ state: "needs_reconciliation", cancel_requested_at: expect.any(Date) });
    expect(after.steps).toEqual(before.steps);
    expect(after.reservations).toEqual(before.reservations);
    expect(after.accounts).toEqual(before.accounts);
  });

  it("cancels a queued predispatch retry with no provider evidence without resetting attempts", async () => {
    const job = await enqueue(db, project);
    await db.query("update public.jobs set attempts=1 where id=$1", [job.id]);
    expect(await request()).toMatchObject({ deletion_state: "deleted" });
    expect((await snapshot()).jobs[0]).toMatchObject({ attempts: 1, state: "cancelled" });
  });

  it.each(["partial", "failed"])("derives %s completion from actual reservation/step evidence", async terminal => {
    const job = await started();
    await completeStep(db, job, "one", terminal === "partial" ? "succeeded" : "failed", 40, terminal === "partial" ? { retained: "fixture output" } : null, "review-response");
    if (terminal === "partial") {
      await finishJob(db, job, "partial");
    } else {
      // Mirrors an adjudicated terminal row whose uncertain reservation remains.
      await db.query("update public.jobs set state='failed',lease_token=null,lease_expires_at=null where id=$1", [job.id]);
    }
    const before = await snapshot();
    expect(await request()).toMatchObject({ deletion_state: terminal === "partial" ? "deleted" : "awaiting_resolution" });
    const after = await snapshot();
    expect(after.jobs).toEqual(before.jobs);
    expect(after.steps).toEqual(before.steps);
    expect(after.reservations).toEqual(before.reservations);
    expect(after.accounts).toEqual(before.accounts);
  });

  it("fences pending owner edits and new work while preserving settlement and real cost", async () => {
    const asset = randomUUID();
    await db.query("insert into public.assets(id,owner_id,project_id,kind) values($1,$2,$3,'fixture')", [asset, OWNER_A, project]);
    const job = await started();
    expect(await request()).toMatchObject({ deletion_state: "stopping" });
    await expect(owner(() => db.query("select public.append_project_revision($1,1,'{}',$2)", [project, HASH]))).rejects.toMatchObject({ message: "project_deleted" });
    await expect(owner(() => db.query("select public.set_asset_retention($1,0,false,true)", [asset]))).rejects.toMatchObject({ message: "project_deleted" });
    await expect(enqueue(db, project, "review-new-work")).rejects.toMatchObject({ message: "project_deleted" });
    await completeStep(db, job, "one", "succeeded", 40, { retained: true }, "review-response");
    expect(await state()).toMatchObject({ deletion_state: "stopping" });
    await finishJob(db, job, "cancelled");
    expect(await state()).toMatchObject({ deletion_state: "deleted", lifecycle_version: 1 });
    const after = await snapshot();
    expect(after.accounts.find(row => row.owner_id === OWNER_A)).toMatchObject({ spent_microusd: 40, provider_actual_microusd: 40, reserved_microusd: 0, limit_microusd: 1000 });
    expect(after.steps[0]).toMatchObject({ state: "succeeded", output: { retained: true } });
    await restore();
    expect((await snapshot()).jobs).toEqual(after.jobs);
  });

  it("retains owner boundaries and denies no-JWT browser reads", async () => {
    await started();
    await request();
    await expect(request(0, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(owner(() => db.query("select public.get_project_deletion($1)", [project]), null)).rejects.toMatchObject({ code: "42501" });
    expect((await snapshot()).steps[0]).toMatchObject({ state: "in_flight" });
  });

  it("uses the verified original caller even inside a definer-owned content write", async () => {
    await started();
    await request();
    // This extra entrypoint exists only inside this disposable fixture so the
    // lifecycle guard itself is exercised independently of earlier RPC checks.
    await db.exec(`create function public.fixture_definer_content(p_owner uuid,p_project uuid) returns uuid
      language plpgsql security definer set search_path='' as $$ declare asset uuid; begin
      insert into public.assets(owner_id,project_id,kind) values(p_owner,p_project,'fixture') returning id into asset;
      return asset; end $$;
      grant execute on function public.fixture_definer_content(uuid,uuid) to authenticated;`);
    const write = () => db.query("select public.fixture_definer_content($1,$2)", [OWNER_A, project]);
    try {
      await expect(owner(write)).rejects.toMatchObject({ message: "project_deleted" });
      await expect(owner(write, null)).rejects.toMatchObject({ message: "project_deleted" });
      await expect(service(write)).rejects.toMatchObject({ message: "project_deleted" });
      await expect(write()).rejects.toMatchObject({ message: "project_deleted" });
      expect((await db.query("select * from public.assets where project_id=$1", [project])).rows).toHaveLength(0);
    } finally { await db.exec("drop function public.fixture_definer_content(uuid,uuid)"); }
  });
});
