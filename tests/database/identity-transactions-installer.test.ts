import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { createTestDatabase,type TestDatabase } from './local-supabase';
const source=new URL('../../supabase/candidates/identity_transactions.sql',import.meta.url);
const bodyHashes={identity_web_owner:'49895b45e6a1cafd7aee6966881f462ab74fba3d024c2385563f0a13efb93721',prepare_identity_transaction:'f6db4c816fa1418cb76b40f7d9f9b43effacfec3bbdcaa462325c52c1eabf166',commit_identity_transaction:'63febf976e3504873425fc3d388c319e320291d83a6bc048a4fb56a36a671f6a'};
describe('unapplied production Identity helper installer without fixture principals',()=>{
 let db:TestDatabase;
 beforeAll(async()=>{db=await createTestDatabase();},60_000);
 afterAll(async()=>{await db?.close();});
 it('rejects an unqualified predecessor before creating boundary objects or granting access',async()=>{
  await db.exec('begin; alter function fluid_private.identity_time_key(text) rename to changed_identity_time_key');
  await expect(db.exec((await readFile(source,'utf8')).replace(/^begin;$/m,''))).rejects.toMatchObject({code:'55000'});
  await db.exec('rollback');
  expect((await db.query<{absent:boolean}>("select to_regclass('fluid_private.identity_web_principals') is null absent")).rows[0]!.absent).toBe(true);
 });
 it('installs exact qualified bodies, restricted owner and fixed ACLs while removing hostile defaults',async()=>{
  await db.exec('create role fixture_identity_installer_acl_probe nologin; alter default privileges grant all on tables to fixture_identity_installer_acl_probe; alter default privileges grant all on functions to fixture_identity_installer_acl_probe');
  const before=(await db.query<{rolname:string}>('select rolname from pg_roles where rolcanlogin order by rolname')).rows;
  const packet=await readFile(source,'utf8');expect(packet).not.toMatch(/fixture_identity|create role[^;]*\blogin\b/iu);
  await db.exec(packet);
  expect((await db.query('select rolname from pg_roles where rolcanlogin order by rolname')).rows).toEqual(before);
  const functions=(await db.query<{proname:keyof typeof bodyHashes;prosrc:string;owner:string;prosecdef:boolean;public_exec:boolean;hostile_exec:boolean}>(`select p.proname,p.prosrc,pg_get_userbyid(p.proowner) owner,p.prosecdef,
   has_function_privilege('anon',p.oid,'EXECUTE') public_exec,has_function_privilege('fixture_identity_installer_acl_probe',p.oid,'EXECUTE') hostile_exec
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='fluid_private' and p.proname=any($1::text[])`,[Object.keys(bodyHashes)])).rows;
  expect(functions).toHaveLength(3);
  for(const fn of functions){expect(createHash('sha256').update(fn.prosrc).digest('hex')).toBe(bodyHashes[fn.proname]);expect(fn.owner).toBe(fn.proname==='identity_web_owner'?'postgres':'fluid_identity_writer_definer_v1');expect(fn.public_exec).toBe(false);expect(fn.hostile_exec).toBe(false);}
  const binding=(await db.query<{relrowsecurity:boolean;relforcerowsecurity:boolean;hostile:boolean;count:number}>(`select relrowsecurity,relforcerowsecurity,has_table_privilege('fixture_identity_installer_acl_probe',oid,'SELECT') hostile,
   (select count(*)::integer from fluid_private.identity_web_principals) count from pg_class where oid='fluid_private.identity_web_principals'::regclass`)).rows[0];
  expect(binding).toEqual({relrowsecurity:true,relforcerowsecurity:true,hostile:false,count:0});
  const role=(await db.query<{rolcanlogin:boolean;rolsuper:boolean;rolcreaterole:boolean;rolbypassrls:boolean;public_create:boolean;private_create:boolean}>("select rolcanlogin,rolsuper,rolcreaterole,rolbypassrls,has_schema_privilege(oid,'public','CREATE') public_create,has_schema_privilege(oid,'fluid_private','CREATE') private_create from pg_roles where rolname='fluid_identity_writer_definer_v1'")).rows[0];
  expect(role).toEqual({rolcanlogin:false,rolsuper:false,rolcreaterole:false,rolbypassrls:false,public_create:false,private_create:false});
 });
 it('refuses an existing boundary instead of overwriting bindings or helper authority',async()=>{
  await expect(db.exec(await readFile(source,'utf8'))).rejects.toMatchObject({code:'55000'});await db.exec('rollback');
  expect((await db.query('select * from fluid_private.identity_web_principals')).rows).toHaveLength(0);
 });
});
