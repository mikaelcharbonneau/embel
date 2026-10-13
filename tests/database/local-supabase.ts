import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fixtureMigrationNames } from "./fixture-migrations";

type BeforeMigration = (db: PGlite, sql: string) => Promise<void>;
const fixtureBeforeMigration = new WeakMap<PGlite, BeforeMigration>();
const appliedFixtureSql = new WeakMap<PGlite, Set<string>>();
const sqlHash = (sql: string) => createHash("sha256").update(sql).digest("hex");

/** LOCAL TEST HARNESS ONLY: minimal Auth/Storage interfaces; no live Supabase services. */
export async function createTestDatabase(options: { before?: string; additionalMigrations?: readonly string[]; beforeMigration?: BeforeMigration } = {}) {
  const db = new PGlite();
  if (options.beforeMigration) fixtureBeforeMigration.set(db, options.beforeMigration);
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    -- Disposable fixture only: candidate helper definitions require a separate
    -- nonlogin owner before migration. No production role or credential setup.
    create role fluid_identity_writer_definer_v1 nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role fixture_subscription_worker_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role fixture_subscription_worker_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    create schema storage;
    create table storage.buckets(id text primary key, name text not null, public boolean not null default false, file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null, owner_id text, unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated, service_role;
    grant select, insert, update, delete on storage.objects to authenticated, service_role;
  `);
  await installStorageOperationFixture(db);
  const migrationsDirectory = new URL("../../supabase/migrations/", import.meta.url);
  const migrations = fixtureMigrationNames(await readdir(migrationsDirectory), options.before);
  const applied = new Set<string>();
  for (const name of migrations) {
    const sql = await readFile(new URL(name, migrationsDirectory), "utf8");
    await options.beforeMigration?.(db, sql);
    await db.exec(sql);
    applied.add(sqlHash(sql));
  }
  for (const sql of options.additionalMigrations ?? []) {
    // A fixture migration is genuinely executed, never assumed from a filename.
    if (!applied.has(sqlHash(sql))) {
      await options.beforeMigration?.(db, sql);
      await db.exec(sql);
    }
    applied.add(sqlHash(sql));
  }
  appliedFixtureSql.set(db, applied);
  return db;
}

export const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const HASH = "a".repeat(64);
export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

export async function asRole<T>(db: TestDatabase, role: "authenticated" | "anon" | "service_role", owner: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner ?? ""]);
  await db.exec(`set role ${role}`);
  try { return await run(); }
  finally { await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub', '', false)"); }
}

/** Local-only direct-login fixture. SET ROLE would leave session_user privileged
 * and cannot validate the production worker's account boundary. No passwords. */
export async function asSubscriptionWorker<T>(db: TestDatabase, owner: string, run: () => Promise<T>): Promise<T> {
  const role = owner === OWNER_A ? "fixture_subscription_worker_a" : owner === OWNER_B ? "fixture_subscription_worker_b" : null;
  if (!role) throw new Error("Unknown local subscription owner fixture");
  await db.query("insert into fluid_private.subscription_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$2::uuid from pg_roles where rolname=$1 on conflict(role_name) do nothing", [role, owner]);
  await db.exec(`
    grant connect on database postgres to ${role};
    grant usage on schema public to ${role};
    grant select(job_id,owner_id,project_id,step_key,state,request_key,reserved_cost_microusd) on public.job_steps to ${role};
    grant execute on function public.configure_subscription_runtime(uuid,text,jsonb,boolean),public.get_subscription_runtime_bindings(),
      public.report_subscription_worker_ready(uuid,text,text,jsonb,integer),public.disable_subscription_runtime(uuid,text),
      public.claim_subscription_job(text,uuid,text,integer),public.append_subscription_partial(uuid,uuid,text),
      public.heartbeat_job(uuid,uuid,integer),public.register_job_plan(uuid,uuid,jsonb),
      public.begin_job_step(uuid,uuid,text,text,bigint),public.complete_job_step(uuid,uuid,text,text,bigint,jsonb,text),
      public.complete_naming_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.configure_subscription_runtime(uuid,jsonb),
      public.finish_job(uuid,uuid,text,text),public.expire_job_leases() to ${role};
    set session authorization ${role};
  `);
  try { return await run(); }
  // PGlite's original session_authorization GUC is empty; RESET does not restore
  // session_user there. The local harness explicitly authenticates as postgres.
  finally { await db.exec("set session authorization postgres"); }
}

export async function resetFixture(db: TestDatabase) {
  await db.exec("truncate public.projects, public.project_revisions, public.assets, public.asset_versions, public.asset_selections, public.jobs, public.job_steps, public.usage_reservations, public.usage_accounts, storage.objects, auth.users cascade");
  await db.query("insert into auth.users(id) values ($1),($2)", [OWNER_A, OWNER_B]);
  await db.query("insert into public.usage_accounts(owner_id, limit_microusd) values ($1,1000),($2,1000)", [OWNER_A, OWNER_B]);
}

export async function seedProject(db: TestDatabase, owner = OWNER_A) {
  return asRole(db, "authenticated", owner, async () => {
    const result = await db.query<{ id: string; current_revision: number }>("select * from public.create_project('complete_brand','Local fixture',$1::jsonb,$2)", [{ description: "Explicit local fixture" }, HASH]);
    return result.rows[0]!;
  });
}

export async function enqueue(db: TestDatabase, project: string, key = "request-one", cost = 100, owner = OWNER_A, attempts = 3) {
  return asRole(db, "service_role", null, async () => {
    const result = await db.query<{ id: string; state: string; actual_cost_microusd: number }>(
      "select * from public.enqueue_job($1,$2,'strategy',1,$3,'{}'::jsonb,$4,$5,$6)", [owner, project, HASH, key, cost, attempts]);
    return result.rows[0]!;
  });
}

export async function claim(db: TestDatabase) {
  return asRole(db, "service_role", null, async () => {
    const result = await db.query<{ id: string; lease_token: string; state: string; attempts: number }>("select * from public.claim_job('local-test-worker',60)");
    return result.rows[0]!;
  });
}

/** Explicit local plan registration, before any step begins. */
export async function registerPlan(db: TestDatabase, job: { id: string; lease_token: string }, manifest: readonly { key: string; maximumCostMicrousd: number }[]) {
  return asRole(db, "service_role", null, async () => {
    const result = await db.query<{ id: string; plan_manifest: unknown; plan_fingerprint: string }>(
      "select * from public.register_job_plan($1,$2,$3::jsonb)", [job.id, job.lease_token, JSON.stringify(manifest)]);
    return result.rows[0]!;
  });
}

/** Disposable provider fixture only. Definitions checked against official Storage
 * tenant migrations 0024-operation-function.sql and 0058-operation-ergonomics.sql
 * on 2026-10-07. Application migrations must never redefine provider functions.
 * https://github.com/supabase/storage/blob/master/migrations/tenant/0024-operation-function.sql
 * https://github.com/supabase/storage/blob/master/migrations/tenant/0058-operation-ergonomics.sql
 */
export async function installStorageOperationFixture(db: PGlite) {
  await db.exec(`
    CREATE OR REPLACE FUNCTION storage.operation()
    RETURNS text AS $$
    BEGIN
      RETURN current_setting('storage.operation', true);
    END;
    $$ LANGUAGE plpgsql STABLE;

    CREATE OR REPLACE FUNCTION storage.allow_only_operation(expected_operation text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      WITH current_operation AS (
        SELECT storage.operation() AS raw_operation
      ), normalized AS (
        SELECT
          CASE WHEN raw_operation LIKE 'storage.%' THEN substr(raw_operation, 9)
            ELSE raw_operation END AS current_operation,
          CASE WHEN expected_operation LIKE 'storage.%' THEN substr(expected_operation, 9)
            ELSE expected_operation END AS requested_operation
        FROM current_operation
      )
      SELECT CASE WHEN requested_operation IS NULL OR requested_operation = '' THEN FALSE
        ELSE COALESCE(current_operation = requested_operation, FALSE) END
      FROM normalized;
    $$;
  `);
}

/** Candidate-only disposable grants, never loaded by ordinary historical suites. */
export async function installApiTextWorkerFixture(db: TestDatabase) {
  await db.exec(`
    create role fixture_api_text_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role fixture_api_text_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    grant connect on database postgres to fixture_api_text_a, fixture_api_text_b;
    grant usage on schema public to fixture_api_text_a, fixture_api_text_b;
    grant select(job_id,owner_id,project_id,step_key,state,request_key,reserved_cost_microusd) on public.job_steps to fixture_api_text_a, fixture_api_text_b;
    grant execute on function public.claim_api_text_job(uuid,text,integer,text,text),public.check_api_text_runtime(text,jsonb,text),
      public.authorize_api_text_dispatch(uuid,uuid,text,text,text),public.heartbeat_job(uuid,uuid,integer),
      public.register_job_plan(uuid,uuid,jsonb),public.begin_job_step(uuid,uuid,text,text,bigint),
      public.complete_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_job(uuid,uuid,text,text),
      public.expire_api_text_job(uuid),public.get_api_text_dispatch(uuid),public.mark_api_text_published(uuid,text,integer,text),
      public.list_pending_api_text_dispatches(integer),public.prepare_api_text_redrive(uuid,text,integer)
      to fixture_api_text_a,fixture_api_text_b;
  `);
}

export async function asApiTextWorker<T>(db: TestDatabase, owner: string, run: () => Promise<T>): Promise<T> {
  const role = owner === OWNER_A ? "fixture_api_text_a" : owner === OWNER_B ? "fixture_api_text_b" : null;
  if (!role) throw new Error("Unknown local API owner fixture");
  await db.exec(`set session authorization ${role}`);
  try { return await run(); }
  finally { await db.exec("set session authorization postgres"); }
}

/** Install the reviewed candidate or verify its byte-identical migrated fixture.
 * Catalog validation prevents an already-present but changed boundary being skipped.
 * This helper never executes against a hosted connection. */
export async function installApiTextRuntimeCandidate(db: TestDatabase, suppliedSql?: string) {
  const sql = suppliedSql ?? await readFile(new URL("../../supabase/candidates/restricted_api_text_runtime.sql", import.meta.url), "utf8");
  const applied = appliedFixtureSql.get(db);
  if (!applied) throw new Error("candidate_fixture_unknown");
  const installed = (await db.query<{ installed: boolean }>("select to_regclass('fluid_private.api_text_worker_principals') is not null or to_regprocedure('public.api_text_worker_owner()') is not null as installed")).rows[0]!.installed;
  if (installed && !applied.has(sqlHash(sql))) throw new Error("candidate_migration_mismatch");
  if (!installed) {
    await fixtureBeforeMigration.get(db)?.(db, sql);
    await db.exec(sql);
    applied.add(sqlHash(sql));
  }
  const definitions = [...sql.matchAll(/create(?:\s+or\s+replace)?\s+function\s+([a-z_]+\.[a-z_]+)\b([\s\S]*?)\bas\s+\$\$([\s\S]*?)\$\$;/gi)];
  if (definitions.length < 20 || new Set(definitions.map(match => match[1])).size !== definitions.length) throw new Error("candidate_definitions_unrecognized");
  const result = await db.query<{ name: string; body: string; definer: boolean; volatility: string; safe_path: boolean }>(`
    select n.nspname||'.'||p.proname as name,p.prosrc as body,p.prosecdef as definer,p.provolatile as volatility,
      coalesce('search_path=""'=any(p.proconfig),false) as safe_path
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname||'.'||p.proname=any($1::text[])
  `, [definitions.map(match => match[1])]);
  if (result.rows.length !== definitions.length) throw new Error("candidate_schema_mismatch");
  for (const [, name, header, body] of definitions) {
    const actual = result.rows.find(row => row.name === name);
    const volatility = /\bimmutable\b/i.test(header!) ? "i" : /\bstable\b/i.test(header!) ? "s" : "v";
    // Recognize only this executed, byte-pinned forward migration and its exact
    // original/successor pair. All other bodies and security checks stay strict.
    const budgetStatusSuccessorApplied = name === "public.get_api_strategy_availability"
      && applied.has("b8977bd44754d78fb3a40b169b8fb1f22adac5dc01611e5eeb33e813134b03b2");
    const knownBudgetStatusSuccessor = budgetStatusSuccessorApplied
      && sqlHash(body!) === "e5e71fbdcf97b0b6c2a649c75a5637b57f1d4ee0f19bde0ba8988d80d5bee94b"
      && actual !== undefined && sqlHash(actual.body) === "b525fd07c0b3558d301103c75815e37841006e10d0fd782ccb7f743ee130a5f9";
    const bodyMatches = budgetStatusSuccessorApplied ? knownBudgetStatusSuccessor : actual?.body === body;
    if (!actual || !bodyMatches || actual.definer !== /\bsecurity\s+definer\b/i.test(header!) || actual.volatility !== volatility || !actual.safe_path) {
      throw new Error("candidate_schema_mismatch");
    }
  }
  const tables = await db.query<{ secure: boolean }>(`
    select c.relrowsecurity and c.relforcerowsecurity as secure from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='fluid_private'
    and c.relname=any($1::text[])
  `, [["api_text_worker_principals", "strategy_billing_routes", "api_strategy_bindings", "api_text_dispatches"]]);
  if (tables.rows.length !== 4 || tables.rows.some(row => !row.secure)) throw new Error("candidate_schema_mismatch");
}
