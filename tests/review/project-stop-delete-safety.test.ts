import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getNamingFulfillment } from "../../src/domain/naming-jobs";
import { asRole, asSubscriptionWorker, claim, createTestDatabase, enqueue, HASH, OWNER_A, OWNER_B, registerPlan, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";

const migration = "20261015235900_project_stop_and_delete.sql";
type Summary = { id: string; lifecycle_version: number; deletion_state: string; deletion_requested_at: string | null };
type UsageAccount = { owner_id: string; reserved_microusd: number; spent_microusd: number; provider_actual_microusd: number; limit_microusd: number };

/** Independent disposable PostgreSQL fixtures. No hosted database or provider. */
describe("independent stop-and-delete transaction safety", () => {
  let db: TestDatabase;
  let project: string;
  let oldFunctionIds: number[];
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
    await service(() => db.query("select public.begin_job_step($1,$2,'one','review-provider-request',100)", [job.id, job.lease_token]));
    return job;
  }
  beforeAll(async () => {
    db = await createTestDatabase({ before: migration });
    oldFunctionIds = (await db.query<{ oid: number }>("select oid::int from pg_proc")).rows.map(row => row.oid);
    await db.exec("alter default privileges in schema public grant execute on functions to fixture_subscription_worker_a; alter default privileges in schema fluid_private grant execute on functions to fixture_subscription_worker_a");
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  }, 60_000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await resetFixture(db); project = (await seedProject(db)).id; });

  it("scrubs hostile inherited EXECUTE from every new helper and owner RPC", async () => {
    expect((await db.query("select oid::regprocedure::text signature from pg_proc where oid<>all($1::oid[]) and has_function_privilege('fixture_subscription_worker_a',oid,'EXECUTE')", [oldFunctionIds])).rows).toEqual([]);
  });

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
    await service(() => db.query("select public.complete_job_step($1,$2,'one',$3,40,$4::jsonb,'review-response')", [job.id, job.lease_token, terminal === "partial" ? "succeeded" : "failed", terminal === "partial" ? { retained: "fixture output" } : null]));
    if (terminal === "partial") {
      await service(() => db.query("select public.finish_job($1,$2,'partial')", [job.id, job.lease_token]));
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

  it("fences pending owner edits and new work while preserving worker settlement and real cost", async () => {
    const asset = randomUUID();
    await db.query("insert into public.assets(id,owner_id,project_id,kind) values($1,$2,$3,'fixture')", [asset, OWNER_A, project]);
    const job = await started();
    expect(await request()).toMatchObject({ deletion_state: "stopping" });
    await expect(owner(() => db.query("select public.append_project_revision($1,1,'{}',$2)", [project, HASH]))).rejects.toMatchObject({ message: "project_deleted" });
    await expect(owner(() => db.query("select public.set_asset_retention($1,0,false,true)", [asset]))).rejects.toMatchObject({ message: "project_deleted" });
    await expect(enqueue(db, project, "review-new-work")).rejects.toMatchObject({ message: "project_deleted" });
    await expect(service(() => db.query("select public.begin_job_step($1,$2,'one','review-provider-request',100)", [job.id, job.lease_token]))).rejects.toMatchObject({ message: "cancel_requested" });
    await service(() => db.query("select public.heartbeat_job($1,$2,60)", [job.id, job.lease_token]));
    await service(() => db.query("select public.complete_job_step($1,$2,'one','succeeded',40,'{\"retained\":true}','review-response')", [job.id, job.lease_token]));
    expect(await state()).toMatchObject({ deletion_state: "stopping" });
    await service(() => db.query("select public.finish_job($1,$2,'cancelled')", [job.id, job.lease_token]));
    expect(await state()).toMatchObject({ deletion_state: "deleted", lifecycle_version: 1 });
    const after = await snapshot();
    expect(after.accounts.find(row => row.owner_id === OWNER_A)).toMatchObject({ spent_microusd: 40, provider_actual_microusd: 40, reserved_microusd: 0, limit_microusd: 1000 });
    expect(after.steps[0]).toMatchObject({ state: "succeeded", output: { retained: true } });
    await restore();
    expect((await snapshot()).jobs).toEqual(after.jobs);
  });

  it("retains owner boundaries and denies no-JWT browser or wrong-owner worker completion", async () => {
    const job = await started();
    await request();
    await expect(request(0, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(owner(() => db.query("select public.get_project_deletion($1)", [project]), null)).rejects.toMatchObject({ code: "42501" });
    await expect(asSubscriptionWorker(db, OWNER_B, () => db.query("select public.complete_job_step($1,$2,'one','failed',0)", [job.id, job.lease_token]))).rejects.toMatchObject({ code: "42501" });
    await expect(owner(() => db.query("select public.complete_job_step($1,$2,'one','failed',0)", [job.id, job.lease_token]), null)).rejects.toMatchObject({ code: "42501" });
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
      grant execute on function public.fixture_definer_content(uuid,uuid) to authenticated,fixture_subscription_worker_a,fixture_subscription_worker_b;`);
    const write = () => db.query("select public.fixture_definer_content($1,$2)", [OWNER_A, project]);
    try {
      await expect(owner(write)).rejects.toMatchObject({ message: "project_deleted" });
      await expect(owner(write, null)).rejects.toMatchObject({ message: "project_deleted" });
      await expect(service(write)).rejects.toMatchObject({ message: "project_deleted" });
      await expect(write()).rejects.toMatchObject({ message: "project_deleted" });
      await expect(asSubscriptionWorker(db, OWNER_B, write)).rejects.toMatchObject({ message: "project_deleted" });
      await asSubscriptionWorker(db, OWNER_A, write);
      expect((await db.query("select * from public.assets where project_id=$1", [project])).rows).toHaveLength(1);
    } finally { await db.exec("drop function public.fixture_definer_content(uuid,uuid)"); }
  });

  it.each(["pending", "withdrawn", "ordinary_stop"])("preserves actual Naming settlement authority for %s", async mode => {
    const withdraw = mode === "withdrawn";
    project = await owner(async () => (await db.query<{ id: string }>("select * from public.create_project('naming_only','Review fixture','{\"description\":\"Local Naming fixture\"}',$1)", [HASH])).rows[0]!.id);
    const policy = { version: 1, billingMode: "chatgpt_subscription", handlerVersion: "naming-chatgpt-v1", registrationId: "review-naming-registration", model: "fixture-model", limits: { maxInputBytes: 131072, maxOutputBytes: 262144, deadlineMs: 240000, maxObservedWebSearchCalls: 0, maxRequestsPerHour: 20, maxQueuedJobs: 3 } };
    const worker = <T>(run: () => Promise<T>, identity = OWNER_A) => asSubscriptionWorker(db, identity, run);
    await worker(() => db.query("select public.configure_subscription_runtime($1,'naming.generate',$2::jsonb,true)", [OWNER_A, policy]));
    await worker(() => db.query("select public.report_subscription_worker_ready($1,$2,'naming.generate',$3::jsonb,90)", [OWNER_A, policy.registrationId, policy]));
    const preferences = { version: 1, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null };
    await owner(() => db.query("select public.save_naming_preferences($1,0,$2::jsonb)", [project, preferences]));
    const identity = (await db.query<{ identity: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') identity", [policy])).rows[0]!.identity;
    const batch = await owner(async () => (await db.query<{ result: { batch: { id: string; sequence: number; targetCount: 50 | 100 | 250 } } }>(
      "select public.enqueue_subscription_naming_job($1,1,1,0,'review-naming-deletion-0001',$2) result", [project, identity])).rows[0]!.result.batch);
    const job = await worker(async () => (await db.query<{ id: string; lease_token: string }>("select * from public.claim_subscription_job('review-worker',$1,$2,90)", [OWNER_A, policy.registrationId])).rows[0]!);
    await worker(() => db.query("select public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, [{ key: "names", maximumCostMicrousd: 0 }]]));
    await worker(() => db.query("select public.begin_job_step($1,$2,'names','review-name-request',0)", [job.id, job.lease_token]));
    if (mode === "ordinary_stop") await owner(() => db.query("select public.request_job_cancel($1)", [job.id]));
    else expect(await request()).toMatchObject({ deletion_state: "stopping" });
    if (withdraw) expect(await restore()).toMatchObject({ deletion_state: "active", lifecycle_version: 2 });
    const rejections = { invalid_candidate: 0, empty_identity: 0, below_minimum: 0, above_maximum: 0, duplicate_response: 0, duplicate_history: 0, over_target: 0 };
    const result = { version: 1, operation: "naming.generate", provider: "openai", billingMode: "chatgpt_subscription", model: policy.model, responseId: "review-naming-response", requestId: null, generatedAt: "2026-10-15T23:00:00Z", usage: null,
      batchId: batch.id, sequence: batch.sequence, targetCount: batch.targetCount, accepted: [{ value: "Cedar", identityKey: "cedar", rationale: "Local fixture." }], fulfillment: getNamingFulfillment(batch.targetCount, 1, rejections) };
    const complete = () => db.query("select public.complete_naming_job_step($1,$2,'names','succeeded',0,$3::jsonb,'review-naming-response')", [job.id, job.lease_token, result]);
    await expect(owner(() => db.query("update public.jobs set project_deletion_requested_at=clock_timestamp() where id=$1", [job.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(worker(complete, OWNER_B)).rejects.toMatchObject({ code: "42501" });
    await expect(owner(complete)).rejects.toMatchObject({ code: "42501" });
    await expect(worker(() => db.query("select public.complete_naming_job_step($1,$2,'names','succeeded',0,$3::jsonb,'review-naming-response')", [job.id, randomUUID(), result]))).rejects.toMatchObject({ message: "lease_lost" });
    if (mode === "ordinary_stop") {
      await expect(worker(complete)).rejects.toMatchObject({ message: "subscription_changed" });
      expect((await db.query("select * from public.name_candidates where project_id=$1", [project])).rows).toEqual([]);
      expect((await db.query("select project_deletion_requested_at from public.jobs where id=$1", [job.id])).rows).toEqual([{ project_deletion_requested_at: null }]);
      return;
    }
    await worker(complete);
    await worker(complete);
    expect((await db.query("select value from public.name_candidates where project_id=$1", [project])).rows).toEqual([{ value: "Cedar" }]);
    expect((await db.query("select * from public.naming_batch_results where batch_id=$1", [batch.id])).rows).toHaveLength(1);
    expect(await state()).toMatchObject({ deletion_state: withdraw ? "active" : "stopping" });
    await worker(() => db.query("select public.finish_job($1,$2,'cancelled')", [job.id, job.lease_token]));
    expect(await state()).toMatchObject({ deletion_state: withdraw ? "active" : "deleted" });
    if (!withdraw) {
      await expect(owner(() => db.query("select public.save_naming_preferences($1,1,$2::jsonb)", [project, { ...preferences, notes: "Late edit" }]))).rejects.toMatchObject({ message: "project_deleted" });
      await restore();
    }
    expect((await db.query("select value from public.name_candidates where project_id=$1", [project])).rows).toEqual([{ value: "Cedar" }]);
    expect((await db.query("select state from public.jobs where id=$1", [job.id])).rows).toEqual([{ state: "cancelled" }]);
  });
});
