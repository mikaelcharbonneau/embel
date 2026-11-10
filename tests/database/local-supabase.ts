import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";

/** LOCAL TEST HARNESS ONLY: the minimal Auth and Storage interfaces the baseline needs
 * (the columns its auth.users trigger watches, auth.sessions and the Storage tables its
 * policies fence); no live Supabase services. Shared with the native fixture. */
export const fixtureSchemaSql = `
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean not null default false, banned_until timestamptz, deleted_at timestamptz);
    create table auth.sessions(id uuid primary key, user_id uuid references auth.users(id) on delete cascade, not_after timestamptz);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    grant usage on schema auth, public to anon, authenticated, service_role;
    grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
    create schema storage;
    create table storage.buckets(id text primary key, name text not null, public boolean not null default false, file_size_limit bigint);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null, owner_id text, created_at timestamptz default now(), unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated, service_role;
    grant select, insert, update, delete on storage.objects to authenticated, service_role;
`;

/** The baseline is a pg_dump: its session settings (row_security off, an empty search_path)
 * must not outlive the migration, as they do not in a migration runner's own session. */
export const afterMigrationsSql = "reset check_function_bodies; reset client_min_messages; reset row_security; reset search_path";

/** Every migration in supabase/migrations, in name order (today the single baseline). */
export async function migrationFiles() {
  const directory = new URL("../../supabase/migrations/", import.meta.url);
  const names = (await readdir(directory)).filter(name => name.endsWith(".sql")).sort();
  return names.map(name => ({ name, url: new URL(name, directory) }));
}

/** LOCAL TEST HARNESS ONLY: a disposable PGlite database with the fixture Auth/Storage
 * interfaces and every migration applied. */
export async function createTestDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    -- Disposable unrelated logins for privilege checks. No production role or credential setup.
    create role fixture_subscription_worker_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role fixture_subscription_worker_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    ${fixtureSchemaSql}
  `);
  await installStorageOperationFixture(db);
  for (const { url } of await migrationFiles()) await db.exec(await readFile(url, "utf8"));
  await db.exec(afterMigrationsSql);
  // The local Supabase target; shared fixtures may replace it with a hosted origin.
  await db.query("insert into fluid_private.shared_http_target(mode, origin) values ('development', $1)", [fixtureAuthOrigin]);
  return db;
}

export const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const HASH = "a".repeat(64);
export const fixtureAuthOrigin = "http://127.0.0.1:54321";
/** The fixture session of an owner (one per owner, created by resetFixture for OWNER_A/B). */
export const sessionIdFor = (owner: string) => `${owner.slice(0, 24)}5e5510000000`;
export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

/** Runs as a PostgREST request would: the database role plus the verified session's JWT
 * claims, which the Storage and shared account policies check for signed-in owners. */
export async function asRole<T>(db: TestDatabase, role: "authenticated" | "anon" | "service_role", owner: string | null, run: () => Promise<T>): Promise<T> {
  const claims = owner && role === "authenticated" ? { sub: owner, role, aud: role, iss: `${fixtureAuthOrigin}/auth/v1`, is_anonymous: false, session_id: sessionIdFor(owner), exp: Math.floor(Date.now() / 1000) + 3600 } : null;
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [owner ?? "", claims ? JSON.stringify(claims) : ""]);
  await db.exec(`set role ${role}`);
  try { return await run(); }
  finally { await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '', false)"); }
}

/** Empties the fixture's data. The cascade reaches the operator audit tables that reference
 * jobs, whose immutability triggers would refuse; the disposable fixture bypasses user
 * triggers for this one statement (foreign-key cascades do not depend on them). */
export async function resetFixture(db: TestDatabase) {
  await db.exec(`begin; set local session_replication_role = replica;
    truncate public.projects, public.project_revisions, public.assets, public.asset_versions, public.asset_selections, public.jobs, public.job_steps, public.usage_reservations, public.usage_accounts, storage.objects, auth.users cascade;
    commit`);
  await db.query("insert into auth.users(id, email_confirmed_at) values ($1, clock_timestamp()),($2, clock_timestamp())", [OWNER_A, OWNER_B]);
  await db.query("insert into auth.sessions(id, user_id) values ($1,$2),($3,$4)", [sessionIdFor(OWNER_A), OWNER_A, sessionIdFor(OWNER_B), OWNER_B]);
  await db.query("insert into public.usage_accounts(owner_id, limit_microusd) values ($1,1000),($2,1000)", [OWNER_A, OWNER_B]);
}

export async function seedProject(db: TestDatabase, owner = OWNER_A) {
  return asRole(db, "authenticated", owner, async () => {
    const result = await db.query<{ id: string; current_revision: number }>("select * from public.create_project('complete_brand','Local fixture',$1::jsonb,$2)", [{ description: "Explicit local fixture" }, HASH]);
    return result.rows[0]!;
  });
}

/** A queued job as the retired queue (enqueue_job) wrote it: the job, its reservation
 * and the account's reserved total. Fixture setup only, as the database owner. */
export async function enqueue(db: TestDatabase, project: string, key = "request-one", cost = 100, owner = OWNER_A, attempts = 3) {
  const result = await db.query<{ id: string; state: string; actual_cost_microusd: number }>(`
    with job as (
      insert into public.jobs(owner_id, project_id, operation, input_revision, input_hash, input, idempotency_key, reserved_cost_microusd, max_attempts)
      select $1, $2, 'strategy', 1, $3, '{}'::jsonb, $4, $5, $6 from public.projects where id = $2 and owner_id = $1
      returning *
    ), reservation as (
      insert into public.usage_reservations(job_id, owner_id, project_id, reserved_microusd)
      select id, owner_id, project_id, reserved_cost_microusd from job
    ), account as (
      update public.usage_accounts set reserved_microusd = reserved_microusd + $5 where owner_id = $1
    )
    select id, state, actual_cost_microusd from job`, [owner, project, HASH, key, cost, attempts]);
  if (!result.rows[0]) throw new Error("enqueue fixture: project not found");
  return result.rows[0];
}

/** Leases the oldest queued job, as the retired claim_job did. */
export async function claim(db: TestDatabase) {
  const result = await db.query<{ id: string; lease_token: string; state: string; attempts: number }>(`
    update public.jobs set state = 'running', lease_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() + interval '60 seconds', worker_id = 'local-test-worker', attempts = attempts + 1
    where id = (select id from public.jobs where state = 'queued' order by created_at, id limit 1)
    returning id, lease_token, state, attempts`);
  return result.rows[0]!;
}

/** Saves a job's plan, as the retired register_job_plan did. */
export async function registerPlan(db: TestDatabase, job: { id: string; lease_token: string }, manifest: readonly { key: string; maximumCostMicrousd: number }[]) {
  const result = await db.query<{ id: string; plan_manifest: unknown; plan_fingerprint: string }>(`
    update public.jobs set plan_manifest = $3::jsonb, plan_fingerprint = encode(sha256(convert_to($3::jsonb::text, 'UTF8')), 'hex'),
      plan_registered_at = clock_timestamp()
    where id = $1 and lease_token = $2 returning id, plan_manifest, plan_fingerprint`, [job.id, job.lease_token, JSON.stringify(manifest)]);
  return result.rows[0]!;
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
