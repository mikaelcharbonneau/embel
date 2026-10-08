import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from './local-supabase';

// Real disposable SQL and restricted session_user, not provider qualification.
const concept = {operation:'identity.logo_concept',policyIdentity:'a'.repeat(64),handlerVersion:'logo-image-v1',provider:'openai',model:'gpt-image-2.5-sunburst-2026-09-08',engine:null,maxCostMicrousd:100};
const vector = {operation:'identity.logo_vectorize',policyIdentity:'b'.repeat(64),handlerVersion:'1',provider:null,model:null,engine:{id:'synthetic',version:'1',artifactHash:'c'.repeat(64)},maxCostMicrousd:0};
const operations=['identity.logo_concept','identity.logo_refine','identity.logo_vectorize','identity.logo_directions','identity.logo_export'];
type Capabilities={ownerId:string;projectId:string;observedAt:string;operations:Record<string,{status:string;expiresAt?:string}>};
describe('owned read-only logo capabilities',()=>{
 let db:TestDatabase,projectId:string;
 beforeAll(async()=>{
  db=await createTestDatabase();
  await db.exec(`create role fixture_caps_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create role fixture_caps_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create role fixture_caps_other login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   grant usage on schema public to fixture_caps_a,fixture_caps_b,fixture_caps_other;
   grant execute on function public.report_logo_worker_ready(text,jsonb,integer) to fixture_caps_a,fixture_caps_b,fixture_caps_other;`);
 },60_000);
 afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{
  await resetFixture(db);projectId=(await seedProject(db)).id;
  for(const [role,owner] of [['fixture_caps_a',OWNER_A],['fixture_caps_b',OWNER_A],['fixture_caps_other',OWNER_B]])await db.query('insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$2 from pg_roles where rolname=$1',[role,owner]);
  for(const descriptor of [concept,vector])await db.query('insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,engine,max_cost_microusd,enabled) values($1,$2,$3,$4,$5,$6,$7,$8,true)',[OWNER_A,descriptor.operation,descriptor.policyIdentity,descriptor.handlerVersion,descriptor.provider,descriptor.model,descriptor.engine,descriptor.maxCostMicrousd]);
 });
 async function read(owner:string|null=OWNER_A,project=projectId){return asRole(db,'authenticated',owner,async()=>(await db.query<{value:Capabilities}>('select public.read_logo_capabilities($1) value',[project])).rows[0]!.value);}
 async function report(manifest:unknown[],seconds=90,role='fixture_caps_a',worker='caps'){
  await db.exec(`set session authorization ${role}`);
  try{return(await db.query<{value:boolean}>('select public.report_logo_worker_ready($1,$2,$3) value',[worker,manifest,seconds])).rows[0]!.value;}
  finally{await db.exec('set session authorization postgres');}
 }
 it('exposes only the exact new read signature',async()=>{
  expect((await db.query<{name:string|null}>("select to_regprocedure('public.read_logo_capabilities(uuid)')::text name")).rows[0]!.name).toBe('read_logo_capabilities(uuid)');
 });
 it('returns all five exact operations unavailable without a current report',async()=>{
  const result=await read();expect(Object.keys(result).sort()).toEqual(['observedAt','operations','ownerId','projectId']);
  expect(result).toMatchObject({ownerId:OWNER_A,projectId});expect(Object.keys(result.operations).sort()).toEqual([...operations].sort());
  expect(Object.values(result.operations)).toEqual(operations.map(()=>({status:'unavailable'})));expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
 });
 it('advertises a partial vector-only worker without claiming image, directions, save or upload readiness',async()=>{
  expect(await report([vector])).toBe(true);const result=await read();
  expect(result.operations['identity.logo_vectorize']).toMatchObject({status:'available'});
  for(const op of operations.filter(o=>o!==vector.operation))expect(result.operations[op]).toEqual({status:'unavailable'});
  const until=Date.parse(result.operations[vector.operation]!.expiresAt!),observed=Date.parse(result.observedAt);
  expect(until-observed).toBeGreaterThan(0);expect(until-observed).toBeLessThanOrEqual(30_000);
  const actual=(await db.query<{until:string}>('select ready_until::text until from fluid_private.logo_worker_readiness')).rows[0]!.until;
  expect(until).toBeLessThanOrEqual(Date.parse(actual));
 });
 it('bounds expiry by the actual valid report rather than a later invalid principal report',async()=>{
  await report([vector],8);await report([vector],90,'fixture_caps_b');
  await db.exec('grant authenticated to fixture_caps_b');
  try{const result=await read();expect(Date.parse(result.operations[vector.operation]!.expiresAt!)-Date.parse(result.observedAt)).toBeLessThanOrEqual(8_000);}
  finally{await db.exec('revoke authenticated from fixture_caps_b');}
 });
 it('uses the longest valid report and disables expired or explicitly withdrawn operations',async()=>{
  await report([vector],4);await report([vector],15,'fixture_caps_b');
  const result=await read();expect(Date.parse(result.operations[vector.operation]!.expiresAt!)-Date.parse(result.observedAt)).toBeGreaterThan(10_000);
  await report([]);expect((await read()).operations[vector.operation]!.status).toBe('available');
  await db.exec("update fluid_private.logo_worker_readiness set ready_until=clock_timestamp()-interval '1 second'");
  expect((await read()).operations[vector.operation]).toEqual({status:'unavailable'});
 });
 it('requires a fresh exact report after policy disable/re-enable or a full descriptor change',async()=>{
  await report([concept,vector]);await db.query('update fluid_private.logo_runtime_policies set enabled=false where owner_id=$1 and operation=$2',[OWNER_A,concept.operation]);
  await db.query('update fluid_private.logo_runtime_policies set enabled=true where owner_id=$1 and operation=$2',[OWNER_A,concept.operation]);
  expect((await read()).operations[concept.operation]).toEqual({status:'unavailable'});expect((await read()).operations[vector.operation]!.status).toBe('available');
  await report([concept,vector]);await db.query('update fluid_private.logo_runtime_policies set max_cost_microusd=101 where owner_id=$1 and operation=$2',[OWNER_A,concept.operation]);
  expect((await read()).operations[concept.operation]).toEqual({status:'unavailable'});
 });
 it('revoked principal binding, renamed role, NOLOGIN and membership immediately invalidate the hint',async()=>{
  await report([vector]);await db.exec('alter role fixture_caps_a nologin');
  try{expect((await read()).operations[vector.operation]).toEqual({status:'unavailable'});}finally{await db.exec('alter role fixture_caps_a login');}
  await db.exec('alter role fixture_caps_a rename to fixture_caps_renamed');
  try{expect((await read()).operations[vector.operation]).toEqual({status:'unavailable'});}finally{await db.exec('alter role fixture_caps_renamed rename to fixture_caps_a');}
  await db.exec('grant authenticated to fixture_caps_a');
  try{expect((await read()).operations[vector.operation]).toEqual({status:'unavailable'});}finally{await db.exec('revoke authenticated from fixture_caps_a');}
  await db.exec("delete from fluid_private.logo_worker_principals where role_name='fixture_caps_a'");
  expect((await read()).operations[vector.operation]).toEqual({status:'unavailable'});
 });
 it('rejects foreign, absent and unauthenticated projects before revealing readiness',async()=>{
  await report([vector]);await expect(read(OWNER_B)).rejects.toMatchObject({code:'P0002'});
  await expect(read(null)).rejects.toMatchObject({code:'42501'});
  await expect(read(OWNER_A,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')).rejects.toMatchObject({code:'P0002'});
  const foreign=(await seedProject(db,OWNER_B)).id;await expect(read(OWNER_A,foreign)).rejects.toMatchObject({code:'P0002'});
  expect(Object.values((await read(OWNER_B,foreign)).operations).every(v=>v.status==='unavailable')).toBe(true);
  for(const role of ['anon','service_role'] as const)await expect(asRole(db,role,OWNER_A,()=>db.query('select public.read_logo_capabilities($1)',[projectId]))).rejects.toMatchObject({code:'42501'});
 });
 it('requires exact connected and plan-enabled subscription registration without reviving old reports',async()=>{
  const policy={version:1,billingMode:'chatgpt_subscription',handlerVersion:'logo-directions-v1',adapterVersion:'logo-directions-chatgpt-v1',registrationId:'caps-fixture',model:'fixture-text',apiCharge:'verified_zero',limits:{maxInputBytes:131072,maxOutputBytes:262144,maxStreamBytes:2097152,deadlineMs:240000,maxObservedWebSearchCalls:0,maxRequestsPerHour:10,maxQueuedJobs:2}};
  const hash=(await db.query<{hash:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') hash",[policy])).rows[0]!.hash;
  const descriptor={operation:'identity.logo_directions',policyIdentity:hash,handlerVersion:policy.handlerVersion,provider:'openai',model:policy.model,engine:null,maxCostMicrousd:0,billingMode:'chatgpt_subscription',policy};
  await db.query('insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,engine,max_cost_microusd,enabled,subscription_policy) values($1,$2,$3,$4,$5,$6,null,0,true,$7)',[OWNER_A,descriptor.operation,hash,descriptor.handlerVersion,descriptor.provider,descriptor.model,policy]);
  await db.query('insert into fluid_private.subscription_registrations(registration_id,owner_id,connected,plan_usage_enabled) values($1,$2,true,true)',[policy.registrationId,OWNER_B]);
  expect(await report([descriptor])).toBe(false);expect((await read()).operations[descriptor.operation]).toEqual({status:'unavailable'});
  await db.query('update fluid_private.subscription_registrations set owner_id=$1 where registration_id=$2',[OWNER_A,policy.registrationId]);
  expect(await report([descriptor])).toBe(true);expect((await read()).operations[descriptor.operation]!.status).toBe('available');
  for(const column of ['connected','plan_usage_enabled']){
   await db.query(`update fluid_private.subscription_registrations set ${column}=false where registration_id=$1`,[policy.registrationId]);
   expect((await read()).operations[descriptor.operation]).toEqual({status:'unavailable'});
   await db.query(`update fluid_private.subscription_registrations set ${column}=true where registration_id=$1`,[policy.registrationId]);
   expect((await read()).operations[descriptor.operation]).toEqual({status:'unavailable'});await report([descriptor]);
  }
 });
 it('reads never mutate workspaces, jobs, quotes, receipts, policies or reports',async()=>{
  await report([vector]);
  const snapshot=async()=>{
   const values:unknown[]=[];
   for(const table of ['public.projects','public.logo_workspaces','public.jobs','public.logo_cost_quotes','public.logo_workspace_requests','public.logo_operation_requests','fluid_private.logo_runtime_policies','fluid_private.logo_worker_readiness'])values.push((await db.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows);
   return values;
  };
  const before=await snapshot();await read();await read();expect(await snapshot()).toEqual(before);
 });
});
