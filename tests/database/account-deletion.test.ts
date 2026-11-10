import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, enqueue, HASH, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "./local-supabase";

// Synthetic local accounts on the complete migrated PGlite schema. No live
// Supabase service, Storage API or Auth API is involved.
let db: TestDatabase;

async function failure(run: () => Promise<unknown>) {
  try { await run(); } catch (error) { return error as { message: string; code?: string }; }
  throw new Error("Expected a failure");
}
const asService = <T>(run: () => Promise<T>) => asRole(db, "service_role", null, run);
const call = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  asService(async () => (await db.query<{ r: T }>(sql, params)).rows[0]!.r);

/** Every table in the app's schemas that carries an owner column. */
async function ownerTables() {
  return (await db.query<{ rel: string; cols: string[] }>(`
    select c.relnamespace::regnamespace::text || '.' || c.relname as rel, array_agg(a.attname::text order by a.attname) as cols
      from pg_class c join pg_attribute a on a.attrelid = c.oid
     where c.relnamespace in ('public'::regnamespace, 'fluid_private'::regnamespace) and c.relkind in ('r','p')
       and a.attname in ('owner_id','auth_user_id') and a.atttypid = 'uuid'::regtype and not a.attisdropped
     group by c.oid order by 1`)).rows;
}
async function ownedRows(owner: string) {
  const counts: Record<string, number> = {};
  for (const table of await ownerTables()) {
    const filter = table.cols.map(col => `${col} = $1`).join(" or ");
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from ${table.rel} where ${filter}`, [owner]);
    if (rows[0]!.n > 0) counts[table.rel] = rows[0]!.n;
  }
  return counts;
}
async function ownedSnapshot(owner: string) {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of await ownerTables()) {
    const filter = table.cols.map(col => `${col} = $1`).join(" or ");
    const { rows } = await db.query(`select to_jsonb(t) as row from ${table.rel} t where ${filter} order by to_jsonb(t)::text`, [owner]);
    if (rows.length) snapshot[table.rel] = rows;
  }
  return snapshot;
}

/** A person with a project, history, a finished paid run with provider cost, an
 * active run, an immutable asset version, a legacy job, a profile, an export
 * request and two Storage objects. */
async function seedAccount(owner: string) {
  const project = await seedProject(db, owner);
  const asset = (await db.query<{ id: string }>("insert into public.assets(owner_id,project_id,kind,saved) values($1,$2,'fixture',true) returning id", [owner, project.id])).rows[0]!;
  const version = (await db.query<{ id: string }>(`insert into public.asset_versions(owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,provenance)
    values($1,$2,$3,1,1,$4,$4,'image/png','{}') returning id`, [owner, project.id, asset.id, HASH])).rows[0]!;
  await db.query("update public.asset_versions set storage_path = owner_id::text||'/'||project_id::text||'/'||asset_id::text||'/'||id::text where id = $1 and storage_path is null", [version.id]).catch(() => undefined);
  const start = (kind: string, key: string) => asRole(db, "authenticated", owner, async () =>
    (await db.query<{ id: string }>("select * from public.start_generation($1,$2,$3,'{}'::jsonb)", [project.id, kind, key])).rows[0]!);
  const paid = await start("test.paid", `deletion-run-${owner.slice(0, 8)}-0001`);
  await db.query("select fluid_private.engine_claim($1, 'wrun_fixture_1')", [paid.id]);
  await db.query("select fluid_private.engine_save_output($1, 'echo', '{\"text\":\"private\"}'::jsonb, null, 1234)", [paid.id]);
  await db.query("select fluid_private.engine_finish($1, 'succeeded', null)", [paid.id]);
  const active = await start("engine.probe", `deletion-run-${owner.slice(0, 8)}-0002`);
  await db.query("select fluid_private.engine_claim($1, 'wrun_fixture_2')", [active.id]);
  const job = await enqueue(db, project.id, `legacy-${owner.slice(0, 8)}`, 100, owner);
  await db.query("update public.jobs set actual_cost_microusd = 77 where id = $1", [job.id]);
  await asRole(db, "authenticated", owner, () => db.query("insert into public.account_profiles(owner_id, full_name, time_zone, date_format) values($1,'Private Person','UTC','iso')", [owner]));
  await asRole(db, "authenticated", owner, () => db.query("select public.admit_account_export()"));
  await db.query("insert into storage.objects(bucket_id, name, owner_id) values('fluid-assets', $1, $2), ('fluid-assets', $3, $2)",
    [`${owner}/${project.id}/${asset.id}/${version.id}`, owner, `${owner}/home/${crypto.randomUUID()}/${crypto.randomUUID()}`]);
  return { project, paid, active };
}

beforeAll(async () => {
  db = await createTestDatabase();
  // The real storage.objects has created_at; the shared minimal fixture does not.
  await db.exec("alter table storage.objects add column created_at timestamptz not null default now()");
  await db.exec("insert into storage.buckets(id, name) values('fluid-assets','fluid-assets') on conflict do nothing");
}, 180_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await resetFixture(db);
  await db.exec("truncate fluid_private.deleted_account_usage, fluid_private.account_deletion_receipts, fluid_private.account_export_requests, public.account_profiles, public.credit_entries, public.credit_accounts cascade");
  await db.exec("delete from fluid_private.generation_kinds where kind like 'test.%'");
  await db.exec("insert into fluid_private.generation_kinds (kind, credits, enabled, max_per_day) values ('test.paid', 10, true, 50)");
});

describe("account purge", () => {
  it("removes every row of a person with projects, runs, files and history, and leaves another person untouched", async () => {
    await seedAccount(OWNER_A);
    await seedAccount(OWNER_B);
    const before = await ownedRows(OWNER_A);
    for (const table of ["public.projects", "public.project_revisions", "public.asset_versions", "public.generation_runs", "public.generation_outputs", "public.credit_entries", "public.jobs", "public.account_profiles", "fluid_private.account_export_requests"]) {
      expect(before[table], table).toBeGreaterThan(0);
    }
    const otherBefore = await ownedSnapshot(OWNER_B);

    const begun = await call<{ receiptId: string; state: string }>("select public.account_deletion_begin($1) as r", [OWNER_A]);
    expect(begun.state).toBe("started");
    const purged = await call<{ deletedRows: number }>("select public.account_deletion_purge($1) as r", [OWNER_A]);
    expect(purged.deletedRows).toBeGreaterThan(10);
    expect(await ownedRows(OWNER_A)).toEqual({});
    expect(await ownedSnapshot(OWNER_B)).toEqual(otherBefore);

    // Accounting keeps amounts and times, never the person or their content.
    const usage = (await db.query<Record<string, unknown>>("select source, kind, status, credits, cost_microusd from fluid_private.deleted_account_usage order by source, kind")).rows;
    expect(usage).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "generation_run", kind: "test.paid", status: "succeeded", credits: 10, cost_microusd: 1234 }),
      expect.objectContaining({ source: "credit_entry", kind: "charge", credits: -10 }),
      expect.objectContaining({ source: "legacy_job", cost_microusd: 77 }),
    ]));
    const retained = JSON.stringify((await db.query("select * from fluid_private.deleted_account_usage")).rows) + JSON.stringify((await db.query("select id, subject_hash, state from fluid_private.account_deletion_receipts")).rows);
    expect(retained).not.toContain(OWNER_A);
    expect(retained).not.toContain("private");

    // Files are listed for the Storage API; only the person's own prefix.
    const files = await asService(async () => (await db.query<{ name: string }>("select public.account_storage_objects($1) as name", [OWNER_A])).rows.map(row => row.name));
    expect(files).toHaveLength(2);
    expect(files.every(name => name.startsWith(`${OWNER_A}/`))).toBe(true);

    // Repeating the purge is harmless; the Auth user can then be deleted and the receipt finished.
    expect((await call<{ deletedRows: number }>("select public.account_deletion_purge($1) as r", [OWNER_A])).deletedRows).toBe(0);
    expect((await failure(() => call("select public.account_deletion_complete($1) as r", [OWNER_A]))).message).toContain("account_still_exists");
    await db.query("delete from storage.objects where name like $1", [`${OWNER_A}/%`]);
    await db.query("delete from auth.users where id = $1", [OWNER_A]);
    const completed = await call<{ state: string }>("select public.account_deletion_complete($1) as r", [OWNER_A]);
    expect(completed.state).toBe("completed");
    const receipt = (await db.query<Record<string, unknown>>("select * from fluid_private.account_deletion_receipts")).rows[0]!;
    expect(receipt).toMatchObject({ pending_owner_id: null, state: "completed" });
    expect(JSON.stringify(receipt)).not.toContain(OWNER_A);
    expect((await call<{ state: string }>("select public.account_deletion_complete($1) as r", [OWNER_A])).state).toBe("completed");
    expect(await ownedSnapshot(OWNER_B)).toEqual(otherBefore);
  });

  it("keeps history immutable outside the purge, even with the purge setting forged", async () => {
    await seedAccount(OWNER_B);
    expect((await failure(() => db.query("delete from public.project_revisions where owner_id = $1", [OWNER_B]))).message).toContain("immutable_history");
    await db.exec("begin");
    try {
      await db.query("select set_config('embel.account_purge', $1, true)", [OWNER_B]);
      expect((await failure(() => db.query("delete from public.asset_versions where owner_id = $1", [OWNER_B]))).message).toContain("immutable_history");
    } finally { await db.exec("rollback"); }
    // An API role that forges the setting cannot call the private check at all.
    await db.query("select set_config('embel.account_purge', $1, false)", [OWNER_B]);
    try {
      const error = await failure(() => asRole(db, "authenticated", OWNER_B, () => db.query("delete from public.project_revisions where owner_id = $1", [OWNER_B])));
      expect(error.message).toMatch(/permission denied|immutable_history/);
    } finally { await db.query("select set_config('embel.account_purge', '', false)"); }
    expect((await ownedRows(OWNER_B))["public.project_revisions"]).toBeGreaterThan(0);
  });

  it("requires a started deletion and is callable only by the server role", async () => {
    await seedAccount(OWNER_A);
    expect((await failure(() => call("select public.account_deletion_purge($1) as r", [OWNER_A]))).message).toContain("deletion_not_started");
    for (const role of ["authenticated", "anon"] as const) {
      for (const sql of ["select public.account_deletion_begin($1)", "select public.account_deletion_purge($1)", "select public.account_storage_objects($1)", "select public.account_deletion_complete($1)"]) {
        const error = await failure(() => asRole(db, role, OWNER_A, () => db.query(sql, [OWNER_B])));
        expect(error.message, `${role}: ${sql}`).toContain("permission denied");
      }
      expect((await failure(() => asRole(db, role, OWNER_A, () => db.query("select public.orphaned_storage_objects()"))))).toMatchObject({ message: expect.stringContaining("permission denied") });
    }
    expect((await failure(() => asRole(db, "authenticated", OWNER_A, () => db.query("select * from fluid_private.account_deletion_receipts"))))).toMatchObject({ message: expect.stringContaining("permission denied") });
  });
});

describe("orphaned files", () => {
  it("lists only old objects whose account or project no longer exists", async () => {
    const { project } = await seedAccount(OWNER_A);
    const gone = crypto.randomUUID(), goneProject = crypto.randomUUID(), id = () => crypto.randomUUID();
    const old = "now() - interval '2 days'";
    await db.query(`insert into storage.objects(bucket_id, name, created_at) values
      ('fluid-assets', $1, ${old}), ('fluid-assets', $2, ${old}), ('fluid-assets', $3, now()), ('fluid-assets', $4, ${old}), ('fluid-assets', $5, ${old})`, [
      `${gone}/${id()}/${id()}/${id()}`,                   // account deleted
      `${OWNER_A}/${goneProject}/${id()}/${id()}`,          // project row gone
      `${OWNER_A}/${goneProject}/${id()}/${id()}-recent`,   // too recent to judge
      `${OWNER_A}/${project.id}/${id()}/${id()}`,           // live project
      `${OWNER_A}/home/${id()}/${id()}`,                    // live account's Home file
    ]);
    const names = await asService(async () => (await db.query<{ name: string }>("select public.orphaned_storage_objects() as name")).rows.map(row => row.name));
    expect(names.filter(name => name.startsWith(`${gone}/`))).toHaveLength(1);
    expect(names.filter(name => name.startsWith(`${OWNER_A}/${goneProject}/`) && !name.endsWith("-recent"))).toHaveLength(1);
    expect(names).toHaveLength(2);
  });
});

describe("export", () => {
  it("rate-limits downloads per account and lists only owner tables the person can read", async () => {
    const admit = (owner: string) => asRole(db, "authenticated", owner, async () => (await db.query<{ r: { remainingToday: number } }>("select public.admit_account_export() as r")).rows[0]!.r);
    expect((await admit(OWNER_A)).remainingToday).toBe(2);
    await admit(OWNER_A); await admit(OWNER_A);
    const limited = await failure(() => admit(OWNER_A));
    expect(limited).toMatchObject({ message: expect.stringContaining("export_rate_limited"), code: "PT429" });
    expect((await admit(OWNER_B)).remainingToday).toBe(2);
    expect((await failure(() => asRole(db, "anon", null, () => db.query("select public.admit_account_export()"))))).toMatchObject({ message: expect.stringContaining("permission denied") });
    const tables = await asRole(db, "authenticated", OWNER_A, async () => (await db.query<{ table_name: string; key_columns: string[] | null }>("select * from public.account_export_tables()")).rows);
    expect(tables.find(row => row.table_name === "projects")?.key_columns).toEqual(["id"]);
    const names = tables.map(row => row.table_name);
    expect(names).toEqual(expect.arrayContaining(["projects", "project_revisions", "generation_runs", "account_profiles"]));
    expect(names).not.toContain("account_export_requests");
  });
});
