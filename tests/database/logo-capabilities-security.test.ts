import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('limits the new owned read grant under hostile defaults without changing existing ACLs, overloads or defaults',async()=>{
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
  const directory=new URL('../../supabase/migrations/',import.meta.url),candidate='20261007021000_logo_capabilities.sql';
  for(const name of(await readdir(directory)).filter(name=>name.endsWith('.sql')&&name<candidate).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
  await db.exec(`create role fixture_caps_hostile nologin;create role fixture_caps_existing nologin;
   grant execute on function fluid_private.logo_operation_ready(uuid,text),public.report_logo_worker_ready(text,jsonb,integer) to fixture_caps_existing;
   alter default privileges in schema public,fluid_private grant all on functions to fixture_caps_hostile,authenticated,anon,service_role with grant option;
   alter default privileges in schema public,fluid_private grant all on tables to fixture_caps_hostile with grant option;
   create function public.read_logo_capabilities(text) returns text language sql as $$select $1$$;
   create table public.unrelated_caps_fixture(id integer);grant select(id) on public.unrelated_caps_fixture to fixture_caps_existing with grant option;`);
  const functions=async()=>(await db.query("select oid,proowner,proacl::text from pg_proc where pronamespace in('public'::regnamespace,'fluid_private'::regnamespace) and oid<>coalesce(to_regprocedure('public.read_logo_capabilities(uuid)'),0) order by oid")).rows;
  const tables=async()=>(await db.query("select oid,relowner,relacl::text from pg_class where relnamespace in('public'::regnamespace,'fluid_private'::regnamespace) order by oid")).rows;
  const defaults=async()=>(await db.query('select defaclnamespace,defaclobjtype,defaclacl::text acl from pg_default_acl order by oid')).rows;
  const beforeFunctions=await functions(),beforeTables=await tables(),beforeDefaults=await defaults();
  await db.exec(await readFile(new URL(candidate,directory),'utf8'));
  const signature='public.read_logo_capabilities(uuid)';
  expect((await db.query<{v:boolean}>("select has_function_privilege('authenticated',$1,'EXECUTE') v",[signature])).rows[0]!.v).toBe(true);
  expect((await db.query<{v:boolean}>("select has_function_privilege('authenticated',$1,'EXECUTE WITH GRANT OPTION') v",[signature])).rows[0]!.v).toBe(false);
  for(const role of ['anon','service_role','fixture_caps_hostile','fixture_caps_existing','fixture_subscription_worker_a']){
   expect((await db.query<{v:boolean}>("select has_function_privilege($1,$2,'EXECUTE') v",[role,signature])).rows[0]!.v,role).toBe(false);
  }
  expect((await db.query<{proconfig:string[]}>('select proconfig from pg_proc where oid=$1::regprocedure',[signature])).rows[0]!.proconfig).toContain('search_path=""');
  for(const table of ['fluid_private.logo_worker_readiness','fluid_private.logo_runtime_policies','fluid_private.logo_worker_principals','fluid_private.subscription_registrations']){
   expect((await db.query<{v:boolean}>("select has_table_privilege('authenticated',$1,'SELECT') v",[table])).rows[0]!.v,table).toBe(false);
  }
  expect(await functions()).toEqual(beforeFunctions);expect(await tables()).toEqual(beforeTables);expect(await defaults()).toEqual(beforeDefaults);
  expect((await db.query<{v:boolean}>("select has_function_privilege('fixture_caps_hostile','public.read_logo_capabilities(text)','EXECUTE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
  expect((await db.query<{v:boolean}>("select has_column_privilege('fixture_caps_existing','public.unrelated_caps_fixture','id','SELECT WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
  await db.exec('create function public.after_caps_fixture() returns boolean language sql as $$select true$$;create table public.after_caps_fixture(id integer)');
  expect((await db.query<{v:boolean}>("select has_function_privilege('fixture_caps_hostile','public.after_caps_fixture()','EXECUTE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
  expect((await db.query<{v:boolean}>("select has_table_privilege('fixture_caps_hostile','public.after_caps_fixture','TRUNCATE WITH GRANT OPTION') v")).rows[0]!.v).toBe(true);
 }finally{await db.close();}
},60_000);
