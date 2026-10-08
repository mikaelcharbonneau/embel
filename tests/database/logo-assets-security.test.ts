import { PGlite } from '@electric-sql/pglite';
import { readFile,readdir } from 'node:fs/promises';
import { expect,it } from 'vitest';

it('scrubs hostile default ACLs only on the new P1 asset and stage inventory',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`
   create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create role fluid_identity_writer_definer_v1 nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create role fixture_subscription_worker_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create role fixture_subscription_worker_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth,public to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;
   create schema storage;create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint);
   create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,owner_id text,unique(bucket_id,name));
   alter table storage.objects enable row level security;grant usage on schema storage to authenticated,service_role;grant select,insert,update,delete on storage.objects to authenticated,service_role;
  `);
  const directory=new URL('../../supabase/migrations/',import.meta.url),candidate='20261007010000_logo_stage_mutations.sql';
  for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')&&n<candidate).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
  await db.exec(`create role fixture_hostile nologin;alter default privileges in schema public,fluid_private grant all on tables to fixture_hostile with grant option;alter default privileges in schema public,fluid_private grant all on functions to fixture_hostile with grant option;create table public.unrelated_logo_security_fixture(id integer);create function public.read_logo_asset(text) returns text language sql as $$select $1$$;`);
  const defaults=(await db.query('select defaclnamespace,defaclobjtype,defaclacl::text acl from pg_default_acl order by oid')).rows;
  await db.exec(await readFile(new URL(candidate,directory),'utf8'));
  const names=['fluid_private.logo_asset_web_principals','public.logo_asset_publications','public.logo_vector_revisions','public.logo_approvals','public.logo_font_records'];
  for(const name of names)for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])expect((await db.query<{v:boolean}>('select has_table_privilege(\'fixture_hostile\',$1,$2) v',[name,privilege])).rows[0]!.v,`${name} ${privilege}`).toBe(false);
  for(const fn of ['fluid_private.logo_asset_web_owner()','fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid)','fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb)','public.read_logo_asset(jsonb)'])expect((await db.query<{v:boolean}>('select has_function_privilege(\'fixture_hostile\',$1,\'EXECUTE\') v',[fn])).rows[0]!.v,fn).toBe(false);
  expect((await db.query('select defaclnamespace,defaclobjtype,defaclacl::text acl from pg_default_acl order by oid')).rows).toEqual(defaults);
  expect((await db.query<{v:boolean}>("select has_table_privilege('fixture_hostile','public.unrelated_logo_security_fixture','TRUNCATE') v")).rows[0]!.v).toBe(true);
  expect((await db.query<{v:boolean}>("select has_function_privilege('fixture_hostile','public.read_logo_asset(text)','EXECUTE') v")).rows[0]!.v).toBe(true);
  await db.exec('create table public.after_logo_security_fixture(id integer)');expect((await db.query<{v:boolean}>("select has_table_privilege('fixture_hostile','public.after_logo_security_fixture','TRUNCATE') v")).rows[0]!.v).toBe(true);
 }finally{await db.close();}
},60_000);
