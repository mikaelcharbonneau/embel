import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Client, types } from "pg";
import { createTestDatabase, installStorageOperationFixture, type TestDatabase } from "./local-supabase";
import { fixtureMigrationNames } from "./fixture-migrations";

// Local fixture setup only. Actual query/assertion timeouts remain unchanged.
export const VISUAL_DATABASE_SETUP_TIMEOUT_MS = 300_000;
export const visualFixtureRole = (purpose: "writer" | "acl") => `fixture_visual_${purpose}_${randomUUID().replaceAll("-", "")}`;

/** Native fallback is opt-in and confined to a disposable loopback database.
 * These two fixture suites pass objects/arrays only to JSON/JSONB parameters;
 * this is not a generic adapter for SQL array parameters. Application SQL and
 * behavioral assertions are replayed unchanged. */
async function nativeDatabase(url: string, label: string, roles: readonly string[], beforeMigration: (sql: string) => void) {
  let target: URL;
  try { target = new URL(url); } catch { throw new Error("A valid disposable loopback PostgreSQL fixture URL is required"); }
  if (!["127.0.0.1", "localhost"].includes(target.hostname) || !["postgres:", "postgresql:"].includes(target.protocol) || target.search || target.hash) throw new Error("A disposable loopback PostgreSQL fixture without connection overrides is required");
  if (roles.some(role => !/^fixture_visual_(writer|acl)_[a-f0-9]{32}$/.test(role))) throw new Error("Expected uniquely owned disposable fixture roles");
  const database = `fluid_visual_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: target.href, connectionTimeoutMillis: 5000 });
  let setup: Client | undefined, created = false, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    let cleanupError: unknown;
    try {
      try { await setup?.end(); } catch (error) { cleanupError = error; }
    } finally {
      try {
        if (created) {
          await admin.query(`drop database if exists ${database} with(force)`);
          for (const role of roles) {
            try { await admin.query(`drop role if exists ${role}`); } catch (error) { cleanupError ??= error; }
          }
        }
      } catch (error) { cleanupError ??= error; }
      finally { try { await admin.end(); } catch (error) { cleanupError ??= error; } }
    }
    if (cleanupError) throw cleanupError;
  };
  try {
    await admin.connect();
    await admin.query(`create database ${database}`); created = true; target.pathname = `/${database}`;
    console.info(`[Identity DB timing: ${label}] created disposable database ${database}`);
    setup = new Client({ connectionString: target.href, connectionTimeoutMillis: 5000, types: { getTypeParser(oid, format) {
      if (oid === 20 && format !== "binary") return (value: string) => {
        const parsed = BigInt(value);
        return parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER) ? parsed : Number(parsed);
      };
      return types.getTypeParser(oid, format);
    } } });
    await setup.connect(); await setup.query("set statement_timeout='20s'");
    const connection = setup;
    const adapter = {
      async query(sql: string, parameters: unknown[] = []) {
        return connection.query(sql, parameters.map(value => value !== null && typeof value === "object" && !(value instanceof Date) && !ArrayBuffer.isView(value)
          ? JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item) : value));
      },
      async exec(sql: string) { const result = await connection.query(sql); return Array.isArray(result) ? result : [result]; },
      close,
    } as unknown as TestDatabase;
    await setup.query(`
      do $$ begin
        if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin;end if;
        if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin;end if;
        if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls;end if;
      end $$;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth,public to anon,authenticated,service_role;
      grant execute on function auth.uid() to anon,authenticated,service_role;
      create schema storage;
      create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,owner_id text,unique(bucket_id,name));
      alter table storage.objects enable row level security;
      grant usage on schema storage to authenticated,service_role;
      grant select,insert,update,delete on storage.objects to authenticated,service_role;
    `);
    await installStorageOperationFixture(adapter);
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    for (const name of fixtureMigrationNames(await readdir(directory))) {
      const sql = await readFile(new URL(name, directory), "utf8"); beforeMigration(sql); await setup.query(sql);
    }
    await setup.query("set statement_timeout='10s'");
    console.info(`[Identity DB timing: ${label}] native PostgreSQL; disposable database ${database}; ${roles.length} uniquely owned roles cleaned on close`);
    return adapter;
  } catch (error) {
    try { await close(); } catch { console.error(`[Identity DB cleanup: ${label}] cleanup unconfirmed for owned database ${database}`); }
    throw error;
  }
}

/** Report engine/setup and exact migration timings without logging SQL or data. */
export async function createVisualDirectionTestDatabase(label: string, roles: readonly string[] = []) {
  const directory = new URL("../../supabase/migrations/", import.meta.url);
  const digest = (sql: string) => createHash("sha256").update(sql).digest("hex");
  const filenames = (await readdir(directory)).filter(name => name.endsWith(".sql"));
  const names = new Map(await Promise.all(filenames.map(async name =>
    [digest(await readFile(new URL(name, directory), "utf8")), name] as const)));
  const started = performance.now();
  const nativeUrl = process.env.FLUID_IDENTITY_POSTGRES_TEST_URL;
  let phase = `${nativeUrl ? "Native PostgreSQL" : "PGlite"} engine and auth/storage fixture`, phaseStarted = started, index = 0;
  const report = () => console.info(`[Identity DB timing: ${label}] ${phase}: ${((performance.now() - phaseStarted) / 1000).toFixed(3)}s`);
  try {
    const beforeMigration = (sql: string) => {
      report();
      phase = `migration ${++index}: ${names.get(digest(sql)) ?? "additional fixture SQL"}`;
      phaseStarted = performance.now();
    };
    const db = nativeUrl ? await nativeDatabase(nativeUrl, label, roles, beforeMigration)
      : await createTestDatabase({ beforeMigration: async (_db, sql) => { beforeMigration(sql); } });
    report();
    console.info(`[Identity DB timing: ${label}] complete: ${index} migrations in ${((performance.now() - started) / 1000).toFixed(3)}s`);
    return db;
  } catch (error) {
    report();
    console.info(`[Identity DB timing: ${label}] setup failed during ${phase}`);
    throw error;
  }
}
