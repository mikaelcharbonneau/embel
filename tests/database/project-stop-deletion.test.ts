import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asRole,
  claim,
  createTestDatabase,
  enqueue,
  HASH,
  OWNER_A,
  OWNER_B,
  registerPlan,
  resetFixture,
  seedProject,
  type TestDatabase,
} from "./local-supabase";
import { beginStep, completeStep, finishJob } from "./retired-worker-fixture";

describe("atomic stop-and-delete intent with derived settlement (complete migrated PGlite, synthetic accounts)", () => {
  let db: TestDatabase;
  let project: { id: string; current_revision: number };
  const owner = <T>(run: () => Promise<T>, id: string | null = OWNER_A) => asRole(db, "authenticated", id, run);
  const request = (epoch = 0, revision = 1, user: string | null = OWNER_A) =>
    owner(
      async () =>
        (
          await db.query<{ result: Record<string, unknown> }>(
            "select public.request_project_deletion($1,$2,$3) result",
            [project.id, revision, epoch],
          )
        ).rows[0]!.result,
      user,
    );
  const restore = (epoch = 1) =>
    owner(
      async () =>
        (
          await db.query<{ result: Record<string, unknown> }>(
            "select public.restore_project_deletion($1,1,$2) result",
            [project.id, epoch],
          )
        ).rows[0]!.result,
    );
  const status = () =>
    owner(
      async () =>
        (
          await db.query<{ result: Record<string, unknown> }>("select public.get_project_deletion($1) result", [
            project.id,
          ])
        ).rows[0]!.result,
    );
  const budget = async () =>
    (
      await db.query(
        "select limit_microusd,reserved_microusd,spent_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1",
        [OWNER_A],
      )
    ).rows[0];
  const jobState = async (id: string) =>
    (
      await db.query<{ state: string; cancel_requested_at: Date | null }>(
        "select state,cancel_requested_at from public.jobs where id=$1",
        [id],
      )
    ).rows[0];
  const lease = async () => {
    const job = await claim(db);
    await registerPlan(db, job, [{ key: "first", maximumCostMicrousd: 100 }]);
    return job;
  };
  // Worker progress is written directly; the old worker functions are retired.
  const begin = (job: { id: string; lease_token: string }) => beginStep(db, job, "first", "fixture-provider", 100);
  const complete = (job: { id: string; lease_token: string }, outcome: "succeeded" | "ambiguous" = "succeeded") =>
    completeStep(db, job, "first", outcome, 40, { retained: true }, "fixture-request");
  const finish = (job: { id: string; lease_token: string }, outcome: "partial" | "cancelled" = "cancelled") =>
    finishJob(db, job, outcome);
  beforeAll(async () => {
    db = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await resetFixture(db);
    project = await seedProject(db);
  });

  it("immediately derives deletion with no jobs, preserves immutable history, and withdraws under CAS", async () => {
    const revisions = (await db.query("select * from public.project_revisions")).rows;
    expect(await request()).toMatchObject({
      deleted_at: null,
      deletion_requested_at: expect.any(String),
      deletion_state: "deleted",
      lifecycle_version: 1,
      current_revision: 1,
    });
    expect((await db.query("select * from public.project_revisions")).rows).toEqual(revisions);
    expect(await restore()).toMatchObject({
      deletion_requested_at: null,
      deleted_at: null,
      deletion_state: "active",
      lifecycle_version: 2,
    });
    await expect(request()).rejects.toMatchObject({ code: "PT409", message: "lifecycle_conflict" });
  });
  it("atomically cancels proven queued work and releases only its unused reservation before acknowledging", async () => {
    const job = await enqueue(db, project.id);
    const before = await budget();
    expect(before).toMatchObject({ reserved_microusd: 100, spent_microusd: 0, limit_microusd: 1000 });
    const receipt = await request();
    expect(receipt.deletion_state).toBe("deleted");
    expect(await jobState(job.id)).toMatchObject({ state: "cancelled", cancel_requested_at: expect.any(Date) });
    expect(await budget()).toMatchObject({
      reserved_microusd: 0,
      spent_microusd: 0,
      provider_actual_microusd: 0,
      limit_microusd: 1000,
    });
    const snapshot = (await db.query("select * from public.usage_reservations")).rows;
    // Lost HTTP response: the same observed epoch replays exactly, without another settlement.
    expect(await request()).toEqual(receipt);
    expect((await db.query("select * from public.usage_reservations")).rows).toEqual(snapshot);
    expect(await claim(db)).toBeUndefined();
    await expect(enqueue(db, project.id, "late")).rejects.toMatchObject({ code: "PT409", message: "project_deleted" });
    expect(await budget()).toMatchObject({ reserved_microusd: 0, spent_microusd: 0 });
  });
  it("safely cancels a retried but never-dispatched queued job despite a prior claim attempt", async () => {
    const job = await enqueue(db, project.id);
    const running = await claim(db);
    // The lease expired before any step began, so the job went back to the queue.
    await db.query(
      "update public.jobs set state='queued',lease_token=null,lease_expires_at=null,error_code='lease_expired' where id=$1",
      [running.id],
    );
    expect((await db.query("select state,attempts from public.jobs where id=$1", [job.id])).rows[0]).toMatchObject({
      state: "queued",
      attempts: 1,
    });
    expect((await request()).deletion_state).toBe("deleted");
    expect((await jobState(job.id))?.state).toBe("cancelled");
  });
  it("keeps previously dispatched queued evidence and its reservation unresolved", async () => {
    await enqueue(db, project.id);
    const job = await lease();
    await begin(job);
    await complete(job);
    await db.query("update public.jobs set state='queued',lease_token=null,lease_expires_at=null where id=$1", [
      job.id,
    ]);
    const ledger = await budget(),
      evidence = (await db.query("select * from public.job_steps")).rows;
    expect((await request()).deletion_state).toBe("awaiting_resolution");
    expect(await jobState(job.id)).toMatchObject({
      state: "needs_reconciliation",
      cancel_requested_at: expect.any(Date),
    });
    expect(await budget()).toEqual(ledger);
    expect((await db.query("select * from public.job_steps")).rows).toEqual(evidence);
    expect((await restore()).deletion_state).toBe("active");
    expect((await jobState(job.id))?.state).toBe("needs_reconciliation");
    await expect(request()).rejects.toMatchObject({ code: "PT409" });
  });
  it("requests running cancellation and derives completion after existing worker settlement without a finalizer", async () => {
    await enqueue(db, project.id);
    const job = await lease();
    await begin(job);
    expect((await request()).deletion_state).toBe("stopping");
    expect(await jobState(job.id)).toMatchObject({ state: "cancel_requested", cancel_requested_at: expect.any(Date) });
    await complete(job);
    expect((await status()).deletion_state).toBe("stopping");
    await finish(job);
    expect(await status()).toMatchObject({ deletion_state: "deleted", lifecycle_version: 1, deleted_at: null });
    expect(await budget()).toMatchObject({ reserved_microusd: 0, spent_microusd: 40, provider_actual_microusd: 40 });
    expect((await db.query("select output from public.job_steps")).rows).toEqual([{ output: { retained: true } }]);
  });
  it("allows fully settled partial history rather than trapping it in stopping", async () => {
    await enqueue(db, project.id);
    const job = await lease();
    await begin(job);
    await complete(job);
    await finish(job, "partial");
    expect((await request()).deletion_state).toBe("deleted");
    expect((await jobState(job.id))?.state).toBe("partial");
    expect(await budget()).toMatchObject({ reserved_microusd: 0, spent_microusd: 40 });
  });
  it("honestly retains ambiguous provider outcomes and terminal jobs with active reservations", async () => {
    await enqueue(db, project.id);
    const job = await lease();
    await begin(job);
    await complete(job, "ambiguous");
    const ledger = await budget();
    expect((await request()).deletion_state).toBe("awaiting_resolution");
    expect(await budget()).toEqual(ledger);
    expect((await jobState(job.id))?.state).toBe("needs_reconciliation");
    await restore();
    await db.query("update public.jobs set state='failed' where id=$1", [job.id]);
    expect((await request(2)).deletion_state).toBe("awaiting_resolution");
    expect(await budget()).toEqual(ledger);
  });
  it("withdraws stopping intent without revoking an existing cancellation or restarting the job", async () => {
    await enqueue(db, project.id);
    const job = await lease();
    await request();
    expect(await restore()).toMatchObject({ deletion_state: "active", lifecycle_version: 2 });
    expect((await jobState(job.id))?.state).toBe("cancel_requested");
    await expect(request()).rejects.toMatchObject({ code: "PT409" });
    await finish(job);
    expect((await status()).deletion_state).toBe("active");
  });
  it("freezes stale owner edits and content, retains history reads, and blocks missing-JWT content writes", async () => {
    const asset = (
      await db.query<{ id: string }>(
        "insert into public.assets(owner_id,project_id,kind) values($1,$2,'fixture') returning id",
        [OWNER_A, project.id],
      )
    ).rows[0]!;
    await enqueue(db, project.id);
    await lease();
    await request();
    await expect(
      owner(() => db.query("select public.append_project_revision($1,1,'{}',$2,'Stale')", [project.id, HASH])),
    ).rejects.toMatchObject({ code: "PT409" });
    await expect(
      owner(() => db.query("select public.set_asset_retention($1,0,false,true)", [asset.id])),
    ).rejects.toMatchObject({ code: "PT409" });
    await expect(
      db.query("insert into public.assets(owner_id,project_id,kind) values($1,$2,'fixture')", [OWNER_A, project.id]),
    ).rejects.toMatchObject({ code: "PT409" });
    expect((await owner(() => db.query("select * from public.project_revisions"))).rows).toHaveLength(1);
    expect((await owner(() => db.query("select * from public.projects"), OWNER_B)).rows).toEqual([]);
  });
  it("rolls back intent, queued cancellation and ledger on a late contention failure (fault injection, not native concurrency)", async () => {
    const job = await enqueue(db, project.id);
    const before = await budget();
    await db.exec(`create function public.fixture_delete_contention() returns trigger language plpgsql as $$ begin raise exception 'fixture' using errcode='55P03'; end $$;
      create trigger zz_fixture_delete_contention before update on public.jobs for each row execute function public.fixture_delete_contention();`);
    try {
      await expect(request()).rejects.toMatchObject({ code: "PT409", message: "project_deletion_retry" });
    } finally {
      await db.exec(
        "drop trigger zz_fixture_delete_contention on public.jobs; drop function public.fixture_delete_contention()",
      );
    }
    expect(await status()).toMatchObject({
      deletion_state: "active",
      lifecycle_version: 0,
      deletion_requested_at: null,
    });
    expect(await budget()).toEqual(before);
    expect((await jobState(job.id))?.state).toBe("queued");
    expect((await db.query("select state from public.usage_reservations")).rows).toEqual([{ state: "active" }]);
    expect((await request()).deletion_state).toBe("deleted");
  });
  it("keeps job cancellation provenance after duplicate Delete and Restore and denies normal API marker forgery", async () => {
    await enqueue(db, project.id);
    const job = await lease();
    await owner(() => db.query("select public.request_job_cancel($1)", [job.id]));
    expect(
      (await db.query("select project_deletion_requested_at from public.jobs where id=$1", [job.id])).rows[0],
    ).toEqual({ project_deletion_requested_at: null });
    await request();
    const marked = (
      await db.query("select project_deletion_requested_at,cancel_requested_at from public.jobs where id=$1", [job.id])
    ).rows;
    expect(marked[0]).toMatchObject({
      project_deletion_requested_at: expect.any(Date),
      cancel_requested_at: expect.any(Date),
    });
    await request();
    await restore();
    expect(
      (
        await db.query("select project_deletion_requested_at,cancel_requested_at from public.jobs where id=$1", [
          job.id,
        ])
      ).rows,
    ).toEqual(marked);
    for (const value of [null, "2026-10-16T00:00:00Z"]) {
      await expect(
        owner(() => db.query("update public.jobs set project_deletion_requested_at=$1 where id=$2", [value, job.id])),
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect((await jobState(job.id))?.state).toBe("cancel_requested");
  });
  it("requires owner identity, preserves CAS, and bounds the read-only batch", async () => {
    await expect(request(0, 1, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(request(0, 1, null)).rejects.toMatchObject({ code: "42501" });
    await expect(request(0, 2)).rejects.toMatchObject({ code: "PT409" });
    await request();
    const foreign = await seedProject(db, OWNER_B);
    const batch = () =>
      owner(() => db.query("select * from public.get_project_deletion_states($1)", [[project.id, foreign.id]]));
    expect((await batch()).rows).toMatchObject([
      { id: project.id, owner_id: OWNER_A, deletion_state: "deleted", lifecycle_version: 1 },
    ]);
    await expect(
      owner(() => db.query("select * from public.get_project_deletion_states($1)", [Array(101).fill(project.id)])),
    ).rejects.toMatchObject({ code: "22023" });
    for (const signature of [
      "fluid_private.project_deletion_worker(uuid)",
      "fluid_private.project_deletion_state(uuid,uuid)",
      "fluid_private.project_deletion_summary(uuid,uuid)",
    ]) {
      expect(
        (await db.query("select has_function_privilege('authenticated',$1,'execute') allowed", [signature])).rows,
      ).toEqual([{ allowed: false }]);
    }
    await expect(
      asRole(db, "service_role", null, () => db.query("select public.request_project_deletion($1,1,0)", [project.id])),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it.each(["repeatable read", "serializable"])(
    "rejects stale %s snapshots before intent or cancellation",
    async (isolation) => {
      await enqueue(db, project.id);
      const ledger = await budget();
      await db.exec(`begin isolation level ${isolation}`);
      try {
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [OWNER_A]);
        await expect(db.query("select public.request_project_deletion($1,1,0)", [project.id])).rejects.toMatchObject({
          code: "40001",
        });
      } finally {
        await db.exec("rollback");
      }
      expect((await status()).deletion_state).toBe("active");
      expect(await budget()).toEqual(ledger);
    },
  );
});
