import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { composeDevelopmentSchema, developmentEventCapacity, developmentStorageRepair, CATALOG_FINGERPRINT_SQL } from '../../scripts/development/shared-schema.mjs';
import { composeSupplementalUpgrade, SUPPLEMENTAL_PACKET } from '../../scripts/development/shared-schema-upgrade.mjs';
import { provisionDevelopmentSchema, developmentDatabase, installDevelopmentSchema } from '../../scripts/development/shared-schema-install.mjs';
import { defaults, repositoryRoot } from '../../scripts/development/config.mjs';

const settings={version:1,projectId:'embel-dev-123456789abc',...defaults,apiPort:55421};
test('portable composer retains reviewed source and pins only the selected local services',async()=>{
 const bundle=await composeDevelopmentSchema(settings);
 assert.equal(bundle.manifest.length,25);
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

test('a changed supplemental packet cannot use the reviewed forward-upgrade path', async t => {
 const root=await mkdtemp(path.join(os.tmpdir(),'embel-supplemental-source-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const dest=path.join(root,'supabase',SUPPLEMENTAL_PACKET.source);
 await mkdir(path.dirname(dest),{recursive:true});
 const source=await readFile(path.join(repositoryRoot,'supabase',SUPPLEMENTAL_PACKET.source),'utf8');
 const base=await composeDevelopmentSchema(settings);
 await writeFile(dest,source+'\n-- unrelated edit\n');
 await assert.rejects(composeSupplementalUpgrade(settings,base.manifestHash,root),/reviewed_source_hash_mismatch/);
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

test('real isolated Supabase: repeated provisioning, restricted logins, source and service-account isolation',{
 skip:process.env.EMBEL_TEST_PORTABLE_SQL!=='1',timeout:90_000,
},async()=>{
 const first=await provisionDevelopmentSchema(),second=await provisionDevelopmentSchema();
 assert.deepEqual(first,second,'a repeat must not rotate credentials, slots or the service actor');
 const db=await developmentDatabase();
 const catalog=await db.sql(CATALOG_FINGERPRINT_SQL);
 const marker=JSON.parse(await db.sql('select row_to_json(i) from fluid_private.portable_development_installation i;'));
 assert.equal(marker.brainstorm_supplement_v1.source,SUPPLEMENTAL_PACKET.sha256);
 assert.equal(marker.brainstorm_supplement_v1.predecessor,marker.catalog_sha256);
 assert.equal(marker.brainstorm_supplement_v1.catalog,catalog);
 assert.equal((await installDevelopmentSchema()).settings.projectId,first.target.deploymentId);
 assert.equal(await db.sql(CATALOG_FINGERPRINT_SQL),catalog);
 for(const principal of [...first.slots,...first.httpPrincipals]){
  const client=new pg.Client({connectionString:principal.databaseUrl});
  try{
   await client.connect();
   await assert.rejects(client.query('select * from public.projects'),e=>e.code==='42501');
   await assert.rejects(client.query('select * from fluid_private.shared_worker_slots'),e=>e.code==='42501');
   const result=await client.query("select has_schema_privilege(current_user,'fluid_private','USAGE') as private_usage,has_database_privilege(current_user,current_database(),'CREATE') as db_create");
   assert.deepEqual(result.rows,[{private_usage:false,db_create:false}]);
  }finally{await client.end();}
 }
 await assert.rejects(db.sql("begin; update fluid_private.shared_http_target set origin='http://127.0.0.1:99999'; rollback;"));
 await assert.rejects(db.sql("begin; update fluid_private.shared_http_target set origin='http://localhost:55421'; rollback;"));
 assert.equal(await db.sql("select mode||' '||origin from fluid_private.shared_http_target;"),'development '+first.target.supabaseOrigin);
 const storage=first.storage;
 const response=await fetch(first.target.supabaseOrigin+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:storage.publishableKey,'Content-Type':'application/json'},body:JSON.stringify({email:storage.email,password:storage.password})});
 assert.equal(response.status,200,'the provisioned actor uses actual local Auth');
 const session=await response.json();
 try{
  const headers={apikey:storage.publishableKey,Authorization:'Bearer '+session.access_token,'Content-Type':'application/json'};
  const enrollment=await fetch(first.target.supabaseOrigin+'/rest/v1/rpc/get_shared_account_enrollment',{method:'POST',headers,body:'{}'});
  assert.equal(enrollment.status,200);
  assert.equal((await enrollment.json()).eligible,false,'storage service actor cannot become a customer');
 }finally{
  await fetch(first.target.supabaseOrigin+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:storage.publishableKey,Authorization:'Bearer '+session.access_token}});
 }
 assert.equal(await db.sql(CATALOG_FINGERPRINT_SQL),catalog);
});
