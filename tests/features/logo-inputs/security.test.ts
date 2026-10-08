import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { expect, it } from "vitest";
import { fixtureMigrationNames } from "../../database/fixture-migrations";
import { installStorageOperationFixture } from "../../database/local-supabase";
it("scrubs hostile table, column and function grants only from the exact new input inventory", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create role fluid_identity_writer_definer_v1 nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create role fixture_subscription_worker_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create role fixture_subscription_worker_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;
      create schema storage;create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,owner_id text,unique(bucket_id,name));
      alter table storage.objects enable row level security;grant usage on schema storage to authenticated,service_role;grant select,insert,update,delete on storage.objects to authenticated,service_role;`);
    await installStorageOperationFixture(db);
    const directory = new URL("../../../supabase/migrations/", import.meta.url), candidate = "local20261007017000_logo_inputs.sql";
    for (const name of fixtureMigrationNames(await readdir(directory), candidate)) await db.exec(await readFile(new URL(name, directory), "utf8"));
    await db.exec(`create role fixture_input_hostile nologin;create role fixture_input_column nologin;
      alter default privileges in schema public,fluid_private grant all on tables to fixture_input_hostile with grant option;
      alter default privileges in schema public,fluid_private grant all on functions to fixture_input_hostile with grant option;
      create table public.unrelated_input_fixture(id integer);grant select(id) on public.unrelated_input_fixture to fixture_input_column with grant option;
      create function public.read_logo_input_request(text) returns text language sql as $$select $1$$;`);
    const defaults = (await db.query("select defaclnamespace,defaclobjtype,defaclacl::text acl from pg_default_acl order by oid")).rows;
    const sql = await readFile(new URL(candidate, directory), "utf8");
    // Simulate existing column grants immediately before the exact-object scrub;
    // unlike table privileges, PostgreSQL has no column default-privilege command.
    const marker = "do $$ declare t text; s text; r record;";
    expect(sql).toContain(marker);
    await db.exec(sql.replace(marker, () => `grant select(request) on public.logo_input_requests to fixture_input_column with grant option;\n${marker}`));
    const relations = ["public.logo_input_requests", "public.logo_input_rights", "public.logo_input_receipts", "public.logo_input_rejections", "fluid_private.logo_input_font_catalog"];
    for (const relation of relations) {
      for (const permission of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "SELECT WITH GRANT OPTION", "TRUNCATE WITH GRANT OPTION"])
        expect((await db.query<{ v: boolean }>("select has_table_privilege('fixture_input_hostile',$1,$2) v", [relation, permission])).rows[0]!.v, `${relation} ${permission}`).toBe(false);
      expect((await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass", [relation])).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
    expect((await db.query<{ v: boolean }>("select has_column_privilege('fixture_input_column','public.logo_input_requests','request','SELECT WITH GRANT OPTION') v")).rows[0]!.v).toBe(false);
    const functions = ["fluid_private.logo_input_request_valid(jsonb)", "fluid_private.logo_input_state(uuid,uuid,uuid)", "fluid_private.prepare_logo_input(uuid,jsonb)", "fluid_private.commit_logo_input(uuid,jsonb,jsonb,jsonb)", "public.read_logo_input_request(uuid,uuid)", "public.list_logo_input_references(uuid,jsonb)", "public.list_logo_input_fonts(uuid)", "public.list_logo_input_requests(uuid,jsonb)", "public.cancel_logo_input_request(uuid,jsonb)"];
    for (const fn of functions) expect((await db.query<{ v: boolean }>("select has_function_privilege('fixture_input_hostile',$1,'EXECUTE WITH GRANT OPTION') v", [fn])).rows[0]!.v, fn).toBe(false);
    expect((await db.query("select defaclnamespace,defaclobjtype,defaclacl::text acl from pg_default_acl order by oid")).rows).toEqual(defaults);
    expect((await db.query<{ v: boolean }>("select has_table_privilege('fixture_input_hostile','public.unrelated_input_fixture','TRUNCATE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
    expect((await db.query<{ v: boolean }>("select has_column_privilege('fixture_input_column','public.unrelated_input_fixture','id','SELECT WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
    expect((await db.query<{ v: boolean }>("select has_function_privilege('fixture_input_hostile','public.read_logo_input_request(text)','EXECUTE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
  } finally { await db.close(); }
}, 60_000);
