import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { expect, it } from "vitest";

it("scrubs exact readiness objects under hostile defaults, preserving prior ACLs and cancellation fences", async () => {
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
    const directory = new URL("../../supabase/migrations/", import.meta.url), candidate = "20261007019000_logo_worker_readiness.sql";
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql") && name < candidate).sort()) await db.exec(await readFile(new URL(name, directory), "utf8"));
    await db.exec(`create role fixture_ready_hostile nologin; create role fixture_ready_column nologin; create role fixture_ready_existing nologin;
      grant execute on function fluid_private.read_logo_trusted_request(uuid,jsonb),fluid_private.commit_logo_vector_edit(uuid,uuid,jsonb,jsonb),fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb) to fixture_ready_existing;
      alter default privileges in schema public,fluid_private grant all on tables to fixture_ready_hostile with grant option;
      alter default privileges in schema public,fluid_private grant all on functions to fixture_ready_hostile with grant option;
      create table public.unrelated_ready_fixture(id integer); grant select(id) on public.unrelated_ready_fixture to fixture_ready_column with grant option;
      create function public.report_logo_worker_ready(text) returns text language sql as $$select $1$$;
      create function public.fixture_ready_column_grant() returns event_trigger language plpgsql as $$declare c record;begin
        for c in select * from pg_event_trigger_ddl_commands() loop
          if c.command_tag='CREATE TABLE' and c.object_identity='fluid_private.logo_worker_readiness' then
            grant select(descriptor) on fluid_private.logo_worker_readiness to fixture_ready_column with grant option;
          end if;
        end loop;
      end$$;
      create event trigger fixture_ready_column_grant on ddl_command_end execute function public.fixture_ready_column_grant();`);
    const defaults = (await db.query("select defaclnamespace,defaclobjtype,defaclacl::text acl from pg_default_acl order by oid")).rows;
    const oldAcl = (await db.query("select oid,proowner,proacl::text from pg_proc where oid in('fluid_private.read_logo_trusted_request(uuid,jsonb)'::regprocedure,'fluid_private.commit_logo_vector_edit(uuid,uuid,jsonb,jsonb)'::regprocedure,'fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)'::regprocedure,'public.claim_logo_job(text,integer)'::regprocedure,'public.begin_logo_job_step(uuid,uuid,text,text,bigint)'::regprocedure,'public.quote_logo_operation(uuid,jsonb)'::regprocedure,'public.admit_logo_operation(uuid,jsonb)'::regprocedure,'public.request_logo_export(uuid,jsonb)'::regprocedure,'public.read_leased_logo_record(uuid,uuid,text,jsonb)'::regprocedure) order by oid")).rows;
    const fences = (await db.query("select oid,pg_get_triggerdef(oid) definition from pg_trigger where tgname in('logo_workspace_requests_vector_cancellation','logo_operation_requests_vector_cancellation','logo_operation_rejections_vector_cancellation') order by oid")).rows;
    const cancellation = (await db.query("select pg_get_functiondef('fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)'::regprocedure) definition")).rows;
    // Apply exact source unchanged, including the hostile column-grant event.
    await db.exec(await readFile(new URL(candidate, directory), "utf8"));
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "SELECT WITH GRANT OPTION", "TRUNCATE WITH GRANT OPTION"]) {
      expect((await db.query<{ v: boolean }>("select has_table_privilege('fixture_ready_hostile','fluid_private.logo_worker_readiness',$1) v", [privilege])).rows[0]!.v, privilege).toBe(false);
    }
    expect((await db.query<{ v: boolean }>("select has_column_privilege('fixture_ready_column','fluid_private.logo_worker_readiness','descriptor','SELECT') v")).rows[0]!.v).toBe(false);
    expect((await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='fluid_private.logo_worker_readiness'::regclass")).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    for (const fn of ["fluid_private.logo_policy_descriptor(fluid_private.logo_runtime_policies)","fluid_private.logo_operation_ready(uuid,text)","public.report_logo_worker_ready(text,jsonb,integer)","fluid_private.invalidate_logo_worker_readiness()","fluid_private.logo_job_policy_matches(public.jobs,fluid_private.logo_runtime_policies)","fluid_private.logo_job_ready(public.jobs,text)","fluid_private.lock_logo_job_readiness(public.jobs,text)"]) {
      expect((await db.query<{ v: boolean }>("select has_function_privilege('fixture_ready_hostile',$1,'EXECUTE') v", [fn])).rows[0]!.v, fn).toBe(false);
    }
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "SELECT WITH GRANT OPTION"]) expect((await db.query<{ v: boolean }>("select has_table_privilege('authenticated','fluid_private.logo_worker_readiness',$1) v", [privilege])).rows[0]!.v, privilege).toBe(false);
    expect((await db.query("select oid,proowner,proacl::text from pg_proc where oid in('fluid_private.read_logo_trusted_request(uuid,jsonb)'::regprocedure,'fluid_private.commit_logo_vector_edit(uuid,uuid,jsonb,jsonb)'::regprocedure,'fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)'::regprocedure,'public.claim_logo_job(text,integer)'::regprocedure,'public.begin_logo_job_step(uuid,uuid,text,text,bigint)'::regprocedure,'public.quote_logo_operation(uuid,jsonb)'::regprocedure,'public.admit_logo_operation(uuid,jsonb)'::regprocedure,'public.request_logo_export(uuid,jsonb)'::regprocedure,'public.read_leased_logo_record(uuid,uuid,text,jsonb)'::regprocedure) order by oid")).rows).toEqual(oldAcl);
    expect((await db.query("select oid,pg_get_triggerdef(oid) definition from pg_trigger where tgname in('logo_workspace_requests_vector_cancellation','logo_operation_requests_vector_cancellation','logo_operation_rejections_vector_cancellation') order by oid")).rows).toEqual(fences);
    expect((await db.query("select pg_get_functiondef('fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)'::regprocedure) definition")).rows).toEqual(cancellation);
    for(const role of ['anon','authenticated','service_role','fixture_subscription_worker_a']) expect((await db.query<{v:boolean}>("select has_function_privilege($1,'public.report_logo_worker_ready(text,jsonb,integer)','EXECUTE') v",[role])).rows[0]!.v).toBe(false);
    expect((await db.query("select defaclnamespace,defaclobjtype,defaclacl::text acl from pg_default_acl order by oid")).rows).toEqual(defaults);
    expect((await db.query<{ v: boolean }>("select has_table_privilege('fixture_ready_hostile','public.unrelated_ready_fixture','TRUNCATE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
    expect((await db.query<{ v: boolean }>("select has_column_privilege('fixture_ready_column','public.unrelated_ready_fixture','id','SELECT WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
    expect((await db.query<{ v: boolean }>("select has_function_privilege('fixture_ready_hostile','public.report_logo_worker_ready(text)','EXECUTE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
    await db.exec("create table public.after_ready_fixture(id integer)");
    expect((await db.query<{ v: boolean }>("select has_table_privilege('fixture_ready_hostile','public.after_ready_fixture','TRUNCATE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
  } finally { await db.close(); }
}, 60_000);
