import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { composeDevelopmentSchema, developmentEventCapacity, developmentStorageRepair, CATALOG_FINGERPRINT_SQL } from '../../scripts/development/shared-schema.mjs';
import { provisionDevelopmentSchema, developmentDatabase, installDevelopmentSchema } from '../../scripts/development/shared-schema-install.mjs';
import { defaults, repositoryRoot } from '../../scripts/development/config.mjs';

const settings={version:1,projectId:'embel-dev-123456789abc',...defaults,apiPort:55421};
test('portable composer retains reviewed source and pins only the selected local services',async()=>{
 const bundle=await composeDevelopmentSchema(settings);
 assert.equal(bundle.manifest.length,33);
 assert.ok(bundle.sql.startsWith('begin;'));
 assert.ok(bundle.sql.endsWith('commit;\n'));
 assert.ok(bundle.sql.includes("values('development','http://127.0.0.1:55421')"));
 assert.ok(!bundle.sql.includes("values('hosted'"));
 assert.ok(!bundle.sql.includes("q.mode='hosted'AND q.origin='https://fricsfwqibyhemknqgyf.supabase.co'"));
 assert.ok(!bundle.sql.includes("t.singleton AND t.origin='https://fricsfwqibyhemknqgyf.supabase.co'"));
 assert.equal((bundle.sql.match(/current_setting\('embel.portable_development'\)='true'/g)||[]).length,3);
 assert.equal(bundle.manifest.filter(p=>p.source.startsWith('activation/')).length,1);
 assert.ok(!bundle.manifest.some(p=>p.source.includes('production_storage.sql')));
});

test('changed historical packets fail before any SQL execution',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'embel-reviewed-schema-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const bundle=await composeDevelopmentSchema(settings);
 for(const entry of bundle.manifest){
  const dest=path.join(root,'supabase',entry.source);await mkdir(path.dirname(dest),{recursive:true});
  await writeFile(dest,await readFile(path.join(repositoryRoot,'supabase',entry.source)));
 }
 const corrupted=path.join(root,'supabase/candidates/shared_worker_pool.sql');
 await writeFile(corrupted,(await readFile(corrupted,'utf8'))+'\n-- unreviewed edit\n');
 await assert.rejects(composeDevelopmentSchema(settings,root),/Reviewed development SQL changed/);
});

test('operational retargeting refuses absent or ambiguous target predicates',()=>{
 const naming="q.singleton AND q.mode='hosted'AND q.origin='https://fricsfwqibyhemknqgyf.supabase.co'";
 const storage="t.singleton AND t.origin='https://fricsfwqibyhemknqgyf.supabase.co'";
 for(const [retarget,predicate] of [[developmentEventCapacity,naming],[developmentStorageRepair,storage]]){
  assert.throws(()=>retarget('no target'));
  assert.throws(()=>retarget(predicate+' OR '+predicate));
  assert.ok(retarget('prefix '+predicate+' suffix').startsWith('prefix '));
  assert.ok(retarget('prefix '+predicate+' suffix').endsWith(' suffix'));
 }
});

test('real isolated Supabase: repeated provisioning and restricted web logins',{
 skip:process.env.EMBEL_TEST_PORTABLE_SQL!=='1',timeout:90_000,
},async()=>{
 const first=await provisionDevelopmentSchema(),second=await provisionDevelopmentSchema();
 assert.deepEqual(first,second,'a repeat must not rotate credentials');
 assert.deepEqual(first.httpPrincipals.map(p=>p.lane),['identity','home','logo']);
 assert.equal(first.slots,undefined,'the old worker slots were retired');
 const db=await developmentDatabase();
 const catalog=await db.sql(CATALOG_FINGERPRINT_SQL);
 const marker=JSON.parse(await db.sql('select row_to_json(i) from fluid_private.portable_development_installation i;'));
 // The retired brainstorm development add-on is no longer installed.
 assert.equal(marker.brainstorm_supplement_v1,undefined);
 // Recorded when the packets were installed; later migrations (the old worker retirement) change the catalog.
 assert.match(marker.catalog_sha256,/^[0-9a-f]{64}$/);
 assert.equal((await installDevelopmentSchema()).settings.projectId,first.target.deploymentId);
 assert.equal(await db.sql(CATALOG_FINGERPRINT_SQL),catalog);
 for(const principal of first.httpPrincipals){
  const client=new pg.Client({connectionString:principal.databaseUrl});
  try{
   await client.connect();
   await assert.rejects(client.query('select * from public.projects'),e=>e.code==='42501');
   await assert.rejects(client.query('select * from fluid_private.shared_http_principals'),e=>e.code==='42501');
   const result=await client.query("select has_schema_privilege(current_user,'fluid_private','USAGE') as private_usage,has_database_privilege(current_user,current_database(),'CREATE') as db_create");
   assert.deepEqual(result.rows,[{private_usage:false,db_create:false}]);
  }finally{await client.end();}
 }
 await assert.rejects(db.sql("begin; update fluid_private.shared_http_target set origin='http://127.0.0.1:99999'; rollback;"));
 await assert.rejects(db.sql("begin; update fluid_private.shared_http_target set origin='http://localhost:55421'; rollback;"));
 assert.equal(await db.sql("select mode||' '||origin from fluid_private.shared_http_target;"),'development '+first.target.supabaseOrigin);
 assert.equal(await db.sql(CATALOG_FINGERPRINT_SQL),catalog);
});
