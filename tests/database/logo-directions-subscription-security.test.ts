import { PGlite } from '@electric-sql/pglite';
import { readFile,readdir } from 'node:fs/promises';
import { expect,it } from 'vitest';

it('applies exact subscription SQL under hostile defaults without granting or activating anything',async()=>{
 const db=new PGlite();
 try{
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
  const directory=new URL('../../supabase/migrations/',import.meta.url),candidate='20261007020000_logo_directions_subscription.sql';
  for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')&&n<candidate).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
  await db.exec(`create role fixture_subscription_hostile nologin;
   alter default privileges in schema public,fluid_private grant all on functions to fixture_subscription_hostile with grant option;
   create function fluid_private.logo_subscription_registration_ready(text) returns text language sql as $$select $1$$;
   grant execute on function public.begin_logo_job_step(uuid,uuid,text,text,bigint) to fixture_subscription_worker_a;
   grant select(job_id,owner_id,project_id,step_key,state,request_key,reserved_cost_microusd) on public.job_steps to fixture_subscription_worker_a;`);
  const catalog=await readFile(new URL(candidate,directory),'utf8');
  const replaced=[...catalog.matchAll(/create or replace function ([\w.]+)\(/g)].map(m=>m[1]!);
  const acls=(await db.query('select oid,proowner,proacl::text from pg_proc where pronamespace in(\'public\'::regnamespace,\'fluid_private\'::regnamespace) and (pronamespace::regnamespace::text||\'.\'||proname)=any($1) order by oid',[replaced])).rows;
  const untouched=(await db.query("select oid,pg_get_functiondef(oid) definition from pg_proc where oid in ('public.claim_subscription_job(text,uuid,text,integer)'::regprocedure,'fluid_private.lock_leased_job(uuid,uuid)'::regprocedure,'fluid_private.settle_reservation(uuid)'::regprocedure,'public.configure_subscription_runtime(uuid,text,jsonb,boolean)'::regprocedure,'public.configure_subscription_runtime(uuid,jsonb)'::regprocedure) order by oid")).rows;
  const defaults=(await db.query('select defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid')).rows;
  const roles=(await db.query('select oid,rolname from pg_roles order by oid')).rows;
  await db.exec(catalog);
  expect((await db.query('select oid,proowner,proacl::text from pg_proc where pronamespace in(\'public\'::regnamespace,\'fluid_private\'::regnamespace) and (pronamespace::regnamespace::text||\'.\'||proname)=any($1) order by oid',[replaced])).rows).toEqual(acls);
  expect((await db.query("select oid,pg_get_functiondef(oid) definition from pg_proc where oid in ('public.claim_subscription_job(text,uuid,text,integer)'::regprocedure,'fluid_private.lock_leased_job(uuid,uuid)'::regprocedure,'fluid_private.settle_reservation(uuid)'::regprocedure,'public.configure_subscription_runtime(uuid,text,jsonb,boolean)'::regprocedure,'public.configure_subscription_runtime(uuid,jsonb)'::regprocedure) order by oid")).rows).toEqual(untouched);
  expect((await db.query('select defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid')).rows).toEqual(defaults);
  expect((await db.query('select oid,rolname from pg_roles order by oid')).rows).toEqual(roles);
  const helpers=['fluid_private.valid_logo_directions_subscription_policy(jsonb)','fluid_private.logo_subscription_registration_ready(uuid,jsonb)','fluid_private.logo_subscription_quota_available(uuid,jsonb,uuid)','fluid_private.invalidate_logo_subscription_readiness()','fluid_private.logo_subscription_observation_valid(public.jobs,jsonb)','fluid_private.logo_response_identity_complete(public.jobs,jsonb)'];
  for(const signature of helpers)for(const role of ['fixture_subscription_hostile','fixture_subscription_worker_a','anon','authenticated','service_role'])expect((await db.query<{v:boolean}>('select has_function_privilege($1,$2,\'EXECUTE\') v',[role,signature])).rows[0]!.v,`${role} ${signature}`).toBe(false);
  for(const table of ['fluid_private.logo_runtime_policies','fluid_private.subscription_registrations','fluid_private.logo_worker_readiness'])for(const role of ['fixture_subscription_hostile','fixture_subscription_worker_a','anon','authenticated','service_role'])expect((await db.query<{v:boolean}>('select has_table_privilege($1,$2,\'SELECT\') v',[role,table])).rows[0]!.v).toBe(false);
  for(const table of ['logo_runtime_policies','subscription_registrations','logo_worker_principals','subscription_worker_principals','logo_worker_readiness'])expect((await db.query(`select * from fluid_private.${table}`)).rows).toEqual([]);
  expect((await db.query<{v:boolean}>("select has_function_privilege('fixture_subscription_hostile','fluid_private.logo_subscription_registration_ready(text)','EXECUTE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
  await db.exec('create function public.subscription_after_defaults() returns boolean language sql as $$select true$$');
  expect((await db.query<{v:boolean}>("select has_function_privilege('fixture_subscription_hostile','public.subscription_after_defaults()','EXECUTE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
 }finally{await db.close();}
},60000);
