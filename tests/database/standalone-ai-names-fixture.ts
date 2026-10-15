import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Naming-only synthetic DB, usable from both Node and JSDOM route-chain tests.
 * Filesystem strings avoid Vite's browser asset rewrite of import.meta URLs. */
export async function createStandaloneNamesDatabase(onStage: (stage: string) => void = () => {}) {
  onStage("initializing PGlite and synthetic Auth/Storage");
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create role fixture_subscription_worker_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    create role fixture_subscription_worker_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
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
  onStage("replaying installed subscription and Naming migrations");
  const directory = resolve(process.cwd(), "supabase/migrations");
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql") && (name <= "20261004160000_project_naming.sql" || name.endsWith("_naming_initial_250.sql"))).sort()) {
    await db.exec(await readFile(resolve(directory, name), "utf8"));
  }
  onStage("applying standalone Names candidate");
  await db.exec(await readFile(resolve(process.cwd(), "supabase/candidates/standalone_ai_names.sql"), "utf8"));
  onStage("database fixture ready");
  return db;
}
