import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { expect, it } from "vitest";

it("scrubs only new cancellation object ACLs and preserves trusted helpers, unrelated overloads and defaults", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create role fluid_identity_writer_definer_v1 nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create role fixture_subscription_worker_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create role fixture_subscription_worker_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to anon,authenticated,service_role; grant execute on function auth.uid() to anon,authenticated,service_role;
      create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,owner_id text,unique(bucket_id,name));
      alter table storage.objects enable row level security; grant usage on schema storage to authenticated,service_role; grant select,insert,update,delete on storage.objects to authenticated,service_role;`);
    const directory = new URL("../../supabase/migrations/", import.meta.url), candidate = "20261007018000_logo_vector_edit_cancellation.sql";
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql") && name < candidate).sort()) await db.exec(await readFile(new URL(name, directory), "utf8"));
    await db.exec(`create role fixture_cancel_hostile nologin; create role fixture_cancel_column nologin; create role fixture_cancel_existing nologin;
      grant execute on function fluid_private.read_logo_trusted_request(uuid,jsonb),fluid_private.commit_logo_vector_edit(uuid,uuid,jsonb,jsonb),fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb) to fixture_cancel_existing;
      alter default privileges in schema public,fluid_private grant all on tables to fixture_cancel_hostile with grant option;
      alter default privileges in schema public,fluid_private grant all on functions to fixture_cancel_hostile with grant option;
      create table public.unrelated_cancel_fixture(id integer); grant select(id) on public.unrelated_cancel_fixture to fixture_cancel_column with grant option;
      create function public.cancel_logo_vector_edit(text) returns text language sql as $$select $1$$;
      create function public.fixture_cancel_column_grant() returns event_trigger language plpgsql as $$declare c record;begin
        for c in select * from pg_event_trigger_ddl_commands() loop
          if c.command_tag='CREATE TABLE' and c.object_identity='public.logo_vector_edit_cancellations' then
            grant select(command) on public.logo_vector_edit_cancellations to fixture_cancel_column with grant option;
          end if;
        end loop;
      end$$;
      create event trigger fixture_cancel_column_grant on ddl_command_end execute function public.fixture_cancel_column_grant();`);
    const defaults = (await db.query("select defaclnamespace,defaclobjtype,defaclacl::text acl from pg_default_acl order by oid")).rows;
    const oldAcl = (await db.query("select oid,proowner,proacl::text from pg_proc where oid in('fluid_private.read_logo_trusted_request(uuid,jsonb)'::regprocedure,'fluid_private.commit_logo_vector_edit(uuid,uuid,jsonb,jsonb)'::regprocedure,'fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)'::regprocedure) order by oid")).rows;
    // Apply exact source unchanged, including the hostile column-grant event.
    await db.exec(await readFile(new URL(candidate, directory), "utf8"));
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "SELECT WITH GRANT OPTION", "TRUNCATE WITH GRANT OPTION"]) {
      expect((await db.query<{ v: boolean }>("select has_table_privilege('fixture_cancel_hostile','public.logo_vector_edit_cancellations',$1) v", [privilege])).rows[0]!.v, privilege).toBe(false);
    }
    expect((await db.query<{ v: boolean }>("select has_column_privilege('fixture_cancel_column','public.logo_vector_edit_cancellations','command','SELECT') v")).rows[0]!.v).toBe(false);
    expect((await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.logo_vector_edit_cancellations'::regclass")).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    for (const fn of ["fluid_private.logo_vector_edit_cancel_command_valid(jsonb)", "fluid_private.logo_vector_edit_request_state(uuid,uuid,uuid)", "fluid_private.prevent_cancelled_logo_vector_receipt()", "fluid_private.prevent_cancelled_logo_vector_operation()", "public.cancel_logo_vector_edit(uuid,jsonb)", "public.read_logo_vector_edit_request(uuid,uuid)"]) {
      expect((await db.query<{ v: boolean }>("select has_function_privilege('fixture_cancel_hostile',$1,'EXECUTE') v", [fn])).rows[0]!.v, fn).toBe(false);
    }
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "SELECT WITH GRANT OPTION"]) expect((await db.query<{ v: boolean }>("select has_table_privilege('authenticated','public.logo_vector_edit_cancellations',$1) v", [privilege])).rows[0]!.v, privilege).toBe(false);
    expect((await db.query("select oid,proowner,proacl::text from pg_proc where oid in('fluid_private.read_logo_trusted_request(uuid,jsonb)'::regprocedure,'fluid_private.commit_logo_vector_edit(uuid,uuid,jsonb,jsonb)'::regprocedure,'fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)'::regprocedure) order by oid")).rows).toEqual(oldAcl);
    expect((await db.query("select defaclnamespace,defaclobjtype,defaclacl::text acl from pg_default_acl order by oid")).rows).toEqual(defaults);
    expect((await db.query<{ v: boolean }>("select has_table_privilege('fixture_cancel_hostile','public.unrelated_cancel_fixture','TRUNCATE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
    expect((await db.query<{ v: boolean }>("select has_column_privilege('fixture_cancel_column','public.unrelated_cancel_fixture','id','SELECT WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
    expect((await db.query<{ v: boolean }>("select has_function_privilege('fixture_cancel_hostile','public.cancel_logo_vector_edit(text)','EXECUTE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
    await db.exec("create table public.after_cancel_fixture(id integer)");
    expect((await db.query<{ v: boolean }>("select has_table_privilege('fixture_cancel_hostile','public.after_cancel_fixture','TRUNCATE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
  } finally { await db.close(); }
}, 60_000);
