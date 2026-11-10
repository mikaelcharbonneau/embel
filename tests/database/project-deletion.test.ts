import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asRole,
  createTestDatabase,
  enqueue,
  HASH,
  OWNER_A,
  OWNER_B,
  resetFixture,
  seedProject,
  type TestDatabase,
} from "./local-supabase";

const migrationName = "20261015232500_project_soft_deletion.sql";
describe("reversible project lifecycle on complete migrated PGlite schema (synthetic local accounts)", () => {
  let db: TestDatabase;
  let project: { id: string; current_revision: number };
  const run = <T>(fn: () => Promise<T>, owner: string | null = OWNER_A) => asRole(db, "authenticated", owner, fn);
  // set_project_deleted is revoked from every API role (20261110160000). The lifecycle
  // rules are still tested directly, as the database owner with the owner's JWT subject.
  const asSubject = async <T>(owner: string | null, fn: () => Promise<T>) => {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner ?? ""]);
    try {
      return await fn();
    } finally {
      await db.query("select set_config('request.jwt.claim.sub', '', false)");
    }
  };
  const change = (deleted = true, lifecycle = 0, revision = 1, owner: string | null = OWNER_A, id = project.id) =>
    asSubject(
      owner,
      async () =>
        (await db.query("select * from public.set_project_deleted($1,$2,$3,$4)", [id, revision, lifecycle, deleted]))
          .rows[0]!,
    );
  const snapshot = async () => ({
    projects: (await db.query("select * from public.projects order by id")).rows,
    revisions: (await db.query("select * from public.project_revisions order by project_id,revision")).rows,
    assets: (await db.query("select * from public.assets order by id")).rows,
    versions: (await db.query("select * from public.asset_versions order by id")).rows,
    jobs: (await db.query("select * from public.jobs order by id")).rows,
    accounts: (await db.query("select * from public.usage_accounts order by owner_id")).rows,
    reservations: (await db.query("select * from public.usage_reservations order by job_id")).rows,
  });
  const insertJob = async (state: string, id = project.id, owner = OWNER_A) => {
    const activeLease = state === "running" || state === "cancel_requested";
    return (
      await db.query<{ id: string }>(
        `insert into public.jobs(owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd,lease_token,lease_expires_at)
      values($1,$2,'synthetic.lifecycle',1,$3,'{}',gen_random_uuid()::text,$4,0,case when $5 then gen_random_uuid() end,case when $5 then clock_timestamp()+interval '1 hour' end) returning id`,
        [owner, id, HASH, state, activeLease],
      )
    ).rows[0]!;
  };
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

  it("moves and restores only lifecycle metadata, preserving context, assets, outputs, jobs and usage", async () => {
    const asset = (
      await db.query<{ id: string }>(
        "insert into public.assets(owner_id,project_id,kind,saved) values($1,$2,'fixture',true) returning id",
        [OWNER_A, project.id],
      )
    ).rows[0]!;
    await db.query(
      "insert into public.asset_versions(owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance) values($1,$2,$3,1,1,$4,$4,'application/json','{}')",
      [OWNER_A, project.id, asset.id, HASH],
    );
    await insertJob("succeeded");
    const before = await snapshot();
    expect(await change()).toMatchObject({
      id: project.id,
      owner_id: OWNER_A,
      current_revision: 1,
      lifecycle_version: 1,
    });
    const deleted = await snapshot();
    expect(deleted.projects[0]).toMatchObject({ deleted_at: expect.any(Date) });
    expect({ ...deleted, projects: undefined }).toEqual({ ...before, projects: undefined });
    expect(await change(false, 1)).toMatchObject({ deleted_at: null, lifecycle_version: 2, current_revision: 1 });
    expect({ ...(await snapshot()), projects: undefined }).toEqual({ ...before, projects: undefined });
    await expect(
      db.query("update public.project_revisions set context='{}' where project_id=$1", [project.id]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(db.query("delete from public.asset_versions where asset_id=$1", [asset.id])).rejects.toMatchObject({
      code: "55000",
    });
  });
  it("requires owner identity and hides foreign lifecycle transitions", async () => {
    await expect(change(true, 0, 1, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
    await expect(change(true, 0, 1, null)).rejects.toMatchObject({ code: "42501" });
    expect((await run(() => db.query("select * from public.projects"), OWNER_B)).rows).toEqual([]);
    expect((await run(() => db.query("select * from public.project_revisions"), OWNER_B)).rows).toEqual([]);
    await change();
    expect((await run(() => db.query("select id,deleted_at from public.projects"))).rows).toHaveLength(1);
    expect((await run(() => db.query("select * from public.project_revisions"))).rows).toHaveLength(1);
    await expect(change(false, 1, 1, OWNER_B)).rejects.toMatchObject({ code: "P0002" });
  });
  it("uses both context and lifecycle CAS, including old delete/restore retries after another lifecycle", async () => {
    await expect(change(true, 0, 2)).rejects.toMatchObject({ code: "PT409" });
    await expect(change(true, 1)).rejects.toMatchObject({ code: "PT409" });
    await change();
    await expect(change()).rejects.toMatchObject({ code: "PT409" });
    await expect(change(true, 1)).rejects.toMatchObject({ code: "PT409" });
    await change(false, 1);
    await expect(change()).rejects.toMatchObject({ code: "PT409" });
    await change(true, 2);
    await expect(change(false, 1)).rejects.toMatchObject({ code: "PT409" });
    expect((await snapshot()).projects[0]).toMatchObject({ lifecycle_version: 3, current_revision: 1 });
  });
  it.each(["queued", "running", "partial", "cancel_requested", "needs_reconciliation"])(
    "blocks deletion with %s work without cancelling or settling it",
    async (state) => {
      await insertJob(state);
      const before = await snapshot();
      await expect(change()).rejects.toMatchObject({ code: "PT409", message: "project_busy" });
      expect(await snapshot()).toEqual(before);
    },
  );
  it.each(["succeeded", "failed", "cancelled"])("allows %s history and keeps it intact", async (state) => {
    await insertJob(state);
    const before = await snapshot();
    await change();
    expect((await snapshot()).jobs).toEqual(before.jobs);
  });
  it("covers direct job insertion and service RPC admission, rolling back any reservation", async () => {
    await change();
    const before = await snapshot();
    await expect(insertJob("queued")).rejects.toMatchObject({ code: "PT409", message: "project_deleted" });
    await expect(enqueue(db, project.id)).rejects.toMatchObject({ code: "PT409", message: "project_deleted" });
    expect(await snapshot()).toEqual(before);
  });
  it("blocks terminal job reactivation while permitting later accounting evidence", async () => {
    const job = await insertJob("failed");
    await change();
    await expect(db.query("update public.jobs set state='queued' where id=$1", [job.id])).rejects.toMatchObject({
      code: "PT409",
      message: "project_deleted",
    });
    await db.query("update public.jobs set error_code='fixture_reviewed' where id=$1", [job.id]);
    expect((await db.query("select error_code from public.jobs where id=$1", [job.id])).rows).toEqual([
      { error_code: "fixture_reviewed" },
    ]);
  });
  it("fences stale context append, scope expansion, direct head updates, and content after deletion", async () => {
    await change();
    const before = await snapshot();
    await expect(
      run(() => db.query("select public.append_project_revision($1,1,'{}',$2,'Changed')", [project.id, HASH])),
    ).rejects.toMatchObject({ code: "PT409", message: "project_deleted" });
    await expect(
      db.query("update public.projects set title='Changed' where id=$1", [project.id]),
    ).rejects.toMatchObject({ code: "PT409", message: "project_deleted" });
    await expect(
      db.query("insert into public.assets(owner_id,project_id,kind) values($1,$2,'fixture')", [OWNER_A, project.id]),
    ).rejects.toMatchObject({ code: "PT409", message: "project_deleted" });
    await expect(
      db.query("insert into public.project_inspiration_heads(project_id,owner_id) values($1,$2)", [
        project.id,
        OWNER_A,
      ]),
    ).rejects.toMatchObject({ code: "PT409", message: "project_deleted" });
    expect(await snapshot()).toEqual(before);
    await change(false, 1);
    expect(
      (
        await run(() =>
          db.query("select * from public.append_project_revision($1,1,'{}',$2,'Restored edit')", [project.id, HASH]),
        )
      ).rows[0],
    ).toMatchObject({ revision: 2 });
  });
  it("blocks deletion even when a terminal job still has an active reservation", async () => {
    const job = await insertJob("failed");
    await db.query(
      "insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd) values($1,$2,$3,0)",
      [job.id, OWNER_A, project.id],
    );
    const before = await snapshot();
    await expect(change()).rejects.toMatchObject({ code: "PT409", message: "project_busy" });
    expect(await snapshot()).toEqual(before);
    await db.query("update public.usage_reservations set state='settled' where job_id=$1", [job.id]);
    await change();
  });
  it("keeps a project busy while a Creative directions round runs on the engine, and frees it when the round ends", async () => {
    // 20261110170000: the round's job runs under the run's lease until finish_generation_run closes it.
    const job = await insertJob("running");
    await db.query("update public.jobs set operation='identity.image', idempotency_key='engine:' || $2 where id=$1", [
      job.id,
      job.id,
    ]);
    const runId = (
      await db.query<{ id: string }>(
        `insert into public.generation_runs(owner_id,project_id,kind,status,idempotency_key,input,credits,workflow_run_id,started_at)
      values($1,$2,'identity.directions','running',$3,$4,3,'wrun_lifecycle',now()) returning id`,
        [
          OWNER_A,
          project.id,
          `directions-${job.id}`,
          JSON.stringify({ version: 1, revision: 1, batchId: job.id, jobId: job.id }),
        ],
      )
    ).rows[0]!.id;
    await expect(change()).rejects.toMatchObject({ code: "PT409", message: "project_busy" });
    await db.query("select fluid_private.finish_generation_run($1,'cancelled','cancelled')", [runId]);
    expect((await db.query("select state, lease_token from public.jobs where id=$1", [job.id])).rows).toEqual([
      { state: "cancelled", lease_token: null },
    ]);
    expect(
      (await db.query("select delta from public.credit_entries where run_id=$1 and kind='refund'", [runId])).rows,
    ).toEqual([{ delta: 3 }]);
    await change();
  });
  it("does not mistake another owned or foreign project's work for this project's work", async () => {
    const own = await seedProject(db),
      foreign = await seedProject(db, OWNER_B);
    await insertJob("queued", own.id);
    await insertJob("needs_reconciliation", foreign.id, OWNER_B);
    expect(await change()).toMatchObject({ id: project.id, lifecycle_version: 1 });
  });
  it("blocks context appends, mutable preferences and asset-retention writes", async () => {
    const narrow = await run(
      async () =>
        (await db.query<{ id: string }>("select * from public.create_project('naming_only','Narrow','{}',$1)", [HASH]))
          .rows[0]!,
    );
    await change(true, 0, 1, OWNER_A, narrow.id);
    await expect(
      run(() => db.query("select * from public.append_project_revision($1,1,'{}',$2)", [narrow.id, HASH])),
    ).rejects.toMatchObject({ code: "PT409", message: "project_deleted" });
    const asset = (
      await db.query<{ id: string }>(
        "insert into public.assets(owner_id,project_id,kind) values($1,$2,'fixture') returning id",
        [OWNER_A, project.id],
      )
    ).rows[0]!;
    await db.query("insert into public.project_inspiration_heads(project_id,owner_id) values($1,$2)", [
      project.id,
      OWNER_A,
    ]);
    await change();
    await expect(
      run(() => db.query("select public.set_asset_retention($1,0,false,true)", [asset.id])),
    ).rejects.toMatchObject({ code: "PT409", message: "project_deleted" });
    await expect(
      db.query("update public.project_inspiration_heads set revision=1 where project_id=$1", [project.id]),
    ).rejects.toMatchObject({ code: "PT409", message: "project_deleted" });
    await expect(
      db.query("delete from public.project_inspiration_heads where project_id=$1", [project.id]),
    ).rejects.toMatchObject({ code: "PT409", message: "project_deleted" });
  });
  it("leaves unlinked staged attachments usable but refuses linking them to deleted projects", async () => {
    await change();
    const staged = (
      await db.query<{ id: string }>(
        `insert into public.home_attachments(owner_id,request_key,input,name,mime_type,content_hash,byte_length)
      values($1,gen_random_uuid(),'{}','fixture.txt','text/plain',$2,1) returning id`,
        [OWNER_A, HASH],
      )
    ).rows[0]!;
    await db.query("update public.home_attachments set verified=true where id=$1", [staged.id]);
    await expect(
      db.query("update public.home_attachments set project_id=$1,project_revision=1 where id=$2", [
        project.id,
        staged.id,
      ]),
    ).rejects.toMatchObject({ code: "PT409", message: "project_deleted" });
    expect(
      (await db.query("select verified,project_id from public.home_attachments where id=$1", [staged.id])).rows,
    ).toEqual([{ verified: true, project_id: null }]);
  });
  it.each(["repeatable read", "serializable"])(
    "fails closed for %s lifecycle snapshots rather than missing concurrent admission",
    async (isolation) => {
      await db.exec(`begin isolation level ${isolation}`);
      try {
        await db.query("select set_config('request.jwt.claim.sub',$1,true)", [OWNER_A]);
        await expect(db.query("select public.set_project_deleted($1,1,0,true)", [project.id])).rejects.toMatchObject({
          code: "40001",
          message: "lifecycle_requires_read_committed",
        });
      } finally {
        await db.exec("rollback");
      }
      expect((await snapshot()).projects[0]).toMatchObject({ deleted_at: null, lifecycle_version: 0 });
    },
  );
  it("keeps RLS forced, denies direct lifecycle writes and restricts every new helper", async () => {
    expect(
      (await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.projects'::regclass"))
        .rows,
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    await expect(
      run(() =>
        db.query("update public.projects set deleted_at=clock_timestamp(),lifecycle_version=1 where id=$1", [
          project.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(run(() => db.query("delete from public.projects where id=$1", [project.id]))).rejects.toMatchObject({
      code: "42501",
    });
    for (const role of ["anon", "authenticated", "service_role"] as const)
      await expect(
        asRole(db, role, OWNER_A, () => db.query("select public.set_project_deleted($1,1,0,true)", [project.id])),
      ).rejects.toMatchObject({ code: "42501" });
    for (const signature of [
      "fluid_private.require_active_project(uuid,uuid)",
      "fluid_private.guard_project_content_lifecycle()",
      "fluid_private.guard_project_job_admission()",
      "fluid_private.guard_project_storage_lifecycle()",
      "fluid_private.guard_project_lifecycle_change()",
    ]) {
      expect(
        (await db.query("select has_function_privilege('authenticated',$1,'execute') allowed", [signature])).rows,
      ).toEqual([{ allowed: false }]);
    }
  });
  it("guards every existing keyed content table, explicitly excluding only settlement/streaming audit tables", async () => {
    const unguarded = (
      await db.query<{ table_name: string }>(`select c.table_name from information_schema.columns c
      where c.table_schema='public' and c.column_name='project_id' and exists(select 1 from information_schema.columns o
      where o.table_schema=c.table_schema and o.table_name=c.table_name and o.column_name='owner_id')
      and not exists(select 1 from pg_trigger t where t.tgrelid=('public.'||c.table_name)::regclass and t.tgname in ('project_content_lifecycle','project_job_admission')) order by c.table_name`)
    ).rows.map((row) => row.table_name);
    // generation_runs settles credits: the engine must finish and refund a run even while its
    // project is being deleted. start_generation itself refuses deleted projects.
    expect(unguarded).toEqual(["generation_runs", "job_steps", "subscription_job_partials", "usage_reservations"]);
    expect(
      (await db.query<{ n: number }>("select count(*)::int n from pg_trigger where tgname='project_content_lifecycle'"))
        .rows[0]!.n,
    ).toBeGreaterThan(50);
    expect(migrationName).toMatch(/project_soft_deletion/);
  });
});
