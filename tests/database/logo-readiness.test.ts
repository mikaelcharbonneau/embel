import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from './local-supabase';
import { logoWorkspaceV2Schema } from '../../src/domain/logo-workspace';
import { logoCostQuoteSchema, logoDispatchReceiptSchema } from '../../src/domain/logo-jobs';

// Disposable PostgreSQL, restricted session_user and explicit synthetic policies.
// These reports exercise real SQL authentication; they do not certify providers.
const image = { operation:'identity.logo_concept', policyIdentity:'a'.repeat(64), handlerVersion:'logo-image-v1', provider:'openai', model:'gpt-image-2.5-sunburst-2026-09-08', engine:null, maxCostMicrousd:100 };
const vector = { operation:'identity.logo_vectorize', policyIdentity:'b'.repeat(64), handlerVersion:'1', provider:null, model:null, engine:{id:'synthetic',version:'1',artifactHash:'c'.repeat(64)}, maxCostMicrousd:0 };
describe('owner-bound logo runtime readiness in actual disposable SQL', () => {
 let db:TestDatabase;
 beforeAll(async()=>{
  db=await createTestDatabase();
  await db.exec(`create role fixture_ready_a login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create role fixture_ready_b login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   create role fixture_ready_c login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   grant usage on schema public,fluid_private to fixture_ready_a,fixture_ready_b,fixture_ready_c;
   grant execute on function public.claim_logo_job(text,integer),public.begin_logo_job_step(uuid,uuid,text,text,bigint),public.heartbeat_logo_job(uuid,uuid,integer),public.read_leased_logo_record(uuid,uuid,text,jsonb),public.record_logo_provider_response(uuid,uuid,jsonb),public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_logo_job(uuid,uuid,text),fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid) to fixture_ready_a,fixture_ready_b,fixture_ready_c;`);
  if((await db.query<{id:string|null}>("select to_regprocedure('public.report_logo_worker_ready(text,jsonb,integer)')::text id")).rows[0]!.id)await db.exec('grant execute on function public.report_logo_worker_ready(text,jsonb,integer) to fixture_ready_a,fixture_ready_b,fixture_ready_c');
 },60_000);
 afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{
  await resetFixture(db);
  for(const [role,owner] of [['fixture_ready_a',OWNER_A],['fixture_ready_b',OWNER_B],['fixture_ready_c',OWNER_A]])await db.query('insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$2 from pg_roles where rolname=$1',[role,owner]);
  for(const descriptor of [image,vector])await db.query('insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,engine,max_cost_microusd,enabled) values($1,$2,$3,$4,$5,$6,$7,$8,true)',[OWNER_A,descriptor.operation,descriptor.policyIdentity,descriptor.handlerVersion,descriptor.provider,descriptor.model,descriptor.engine,descriptor.maxCostMicrousd]);
 });
 async function worker<T>(run:()=>Promise<T>,role='fixture_ready_a'){await db.exec(`set session authorization ${role}`);try{return await run();}finally{await db.exec('set session authorization postgres');}}
 const report=(manifest:unknown,workerId='worker-a',seconds=60,role='fixture_ready_a')=>worker(async()=>(await db.query<{v:boolean}>('select public.report_logo_worker_ready($1,$2,$3) v',[workerId,manifest,seconds])).rows[0]!.v,role);
 const claim=(workerId='worker-a',role='fixture_ready_a')=>worker(async()=>(await db.query<{id:string;lease_token:string;plan_manifest:{key:string;maximumCostMicrousd:number}[];input:Record<string,unknown>}>('select * from public.claim_logo_job($1,60)',[workerId])).rows,role);
 const rpc=(name:string,args:unknown[],owner=OWNER_A)=>asRole(db,'authenticated',owner,async()=>(await db.query<{v:unknown}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) v`,args)).rows[0]!.v);
 async function workspace(){const w=logoWorkspaceV2Schema.parse(await rpc('start_logo_project',[{requestKey:randomUUID(),brief:{name:'Readiness fixture',activity:'Synthetic test',audience:'Test',personality:'Calm',logoTypes:['wordmark']}}]));const r=(await db.query<{reference_snapshot_id:string}>('select reference_snapshot_id from public.logo_stage_revisions where id=$1',[w.stages.brief_references!.id])).rows[0]!;return{w,request:{operation:'concepts',expected:w.heads,briefRevisionId:w.stages.brief_references!.id,referenceSnapshotId:r.reference_snapshot_id}};}
 async function admission(){await report([image]);const{w,request}=await workspace();const q=logoCostQuoteSchema.parse(await rpc('quote_logo_operation',[w.projectId,request]));const intent={requestKey:randomUUID(),quoteId:q.id,acceptedMaxCostMicrousd:q.maxCostMicrousd,expected:w.heads};const receipt=logoDispatchReceiptSchema.parse(await rpc('admit_logo_operation',[w.projectId,intent]));return{w,q,request,intent,receipt};}
 it('refuses a new quote when a configured policy has no matching live worker',async()=>{const{w,request}=await workspace();await expect(rpc('quote_logo_operation',[w.projectId,request])).rejects.toMatchObject({code:'55000',message:'logo_runtime_unavailable'});expect((await db.query('select * from public.logo_cost_quotes')).rows).toHaveLength(0);});
 async function vectorJob(projectId:string){
  // Synthetic frozen quote and zero-cost job isolate scheduling from raster QA.
  const id=randomUUID(),quote=randomUUID(),inputHash='d'.repeat(64),plan=[{key:'convert-vector',maximumCostMicrousd:0}];
  await db.query("insert into public.logo_cost_quotes(id,owner_id,project_id,operation,record,input_revisions,source_inputs,expires_at) values($1,$2,$3,$4,$5,'[]','{}',clock_timestamp()+interval '1 minute')",[quote,OWNER_A,projectId,vector.operation,{...vector,inputHash}]);
  await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,plan_manifest,plan_fingerprint,plan_registered_at,reserved_cost_microusd) values($1,$2,$3,$4,1,$5,$6,$7,$8,$5,clock_timestamp(),0)",[id,OWNER_A,projectId,vector.operation,inputHash,{quoteId:quote,policyIdentity:vector.policyIdentity,handlerVersion:vector.handlerVersion},`fixture-${id}`,plan]);
  return id;
 }
 it('vector-only readiness skips older concepts without touching attempts or reservations',async()=>{
  const f=await admission(),id=await vectorJob(f.w.projectId);
  const before=(await db.query('select id,state,attempts,reserved_cost_microusd from public.jobs where id=any($1) order by id',[f.receipt.jobIds])).rows;
  expect(await report([vector])).toBe(true);expect((await claim()).map(j=>j.id)).toEqual([id]);
  expect((await db.query('select id,state,attempts,reserved_cost_microusd from public.jobs where id=any($1) order by id',[f.receipt.jobIds])).rows).toEqual(before);
  expect((await db.query('select reserved_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0]).toEqual({reserved_microusd:600});
 });
 it('worker IDs have independent complete manifests and empty reports withdraw only their own rows',async()=>{
  const f=await admission(),id=await vectorJob(f.w.projectId);await report([image],'images');await report([vector],'vectors');await report([]);
  expect(await claim('unreported')).toEqual([]);expect((await claim('vectors'))[0]!.id).toBe(id);expect(await report([],'vectors')).toBe(true);expect((await claim('images'))).toHaveLength(1);
  expect((await db.query('select distinct worker_id from fluid_private.logo_worker_readiness')).rows).toEqual([{worker_id:'images'}]);
 });
 it('bounds heartbeat with database time without changing immutable quote policy identity',async()=>{
  await report([image],'worker-a',90);const window=(await db.query<{seconds:number}>("select extract(epoch from (ready_until-clock_timestamp()))::float seconds from fluid_private.logo_worker_readiness")).rows[0]!.seconds;expect(window).toBeGreaterThan(85);expect(window).toBeLessThanOrEqual(90);
  const before=(await db.query('select to_jsonb(p) policy from fluid_private.logo_runtime_policies p order by operation')).rows;
  expect(await report([image],'worker-a',1)).toBe(true);expect((await db.query('select to_jsonb(p) policy from fluid_private.logo_runtime_policies p order by operation')).rows).toEqual(before);
  for(const seconds of [0,91,301]){expect(await report([image],'worker-a',seconds)).toBe(false);expect((await db.query('select * from fluid_private.logo_worker_readiness')).rows).toHaveLength(0);}
 });
 it('expiry and operation removal block claims and beginStep but not the valid lease heartbeat',async()=>{
  await admission();const held=(await claim())[0]!;await db.exec("update fluid_private.logo_worker_readiness set ready_until=clock_timestamp()-interval '1 second'");
  expect(await claim()).toEqual([]);
  await worker(async()=>{expect((await db.query<{v:boolean}>("select public.read_leased_logo_record($1,$2,'runtime_readiness',null) v",[held.id,held.lease_token])).rows[0]!.v).toBe(false);await expect(db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[held.id,held.lease_token,held.plan_manifest[0]!.key,'not-dispatched'])).rejects.toMatchObject({code:'55000',message:'logo_runtime_unavailable'});await db.query('select public.heartbeat_logo_job($1,$2,60)',[held.id,held.lease_token]);});
  await report([image,vector]);await report([vector]);expect(await claim()).toEqual([]);expect((await db.query('select * from public.job_steps')).rows).toHaveLength(0);
 });
 it('policy mutation and disable/reenable require a fresh matching report and never revive old queued policy',async()=>{
  await admission();await db.query("update fluid_private.logo_runtime_policies set enabled=false where owner_id=$1 and operation=$2",[OWNER_A,image.operation]);await db.query("update fluid_private.logo_runtime_policies set enabled=true where owner_id=$1 and operation=$2",[OWNER_A,image.operation]);expect(await claim()).toEqual([]);expect(await report([image])).toBe(true);
  await db.query('update fluid_private.logo_runtime_policies set max_cost_microusd=101 where owner_id=$1 and operation=$2',[OWNER_A,image.operation]);expect(await claim()).toEqual([]);expect(await report([image])).toBe(false);expect(await report([{...image,maxCostMicrousd:101}])).toBe(true);expect(await claim()).toEqual([]);
 });
 it('same-policy no-op updates preserve readiness, while a stale legitimate report withdraws old readiness',async()=>{
  await admission();await db.query('update fluid_private.logo_runtime_policies set enabled=enabled where owner_id=$1',[OWNER_A]);expect((await claim())).toHaveLength(1);
  expect(await report([{...image,handlerVersion:'stale'}])).toBe(false);expect((await db.query('select * from fluid_private.logo_worker_readiness')).rows).toHaveLength(0);expect(await claim()).toEqual([]);
 });
 it('rejects forged, duplicate, extra-field and oversized manifests without keeping old readiness',async()=>{
  for(const manifest of [[{...image,ownerId:OWNER_B}],[image,image],[{...image,provider:null}],Array(6).fill(image),{},null,[{...image,engine:{padding:'x'.repeat(32768)}}]]){
   await report([image]);expect(await report(manifest)).toBe(false);expect((await db.query('select * from fluid_private.logo_worker_readiness')).rows).toHaveLength(0);
  }
 });
 it('binds reports and claims to the actual restricted login rather than JWT, SET ROLE or a foreign owner',async()=>{
  const f=await admission();expect(await report([image],'worker-a',60,'fixture_ready_b')).toBe(false);expect(await claim('worker-a','fixture_ready_b')).toEqual([]);
  for(const role of ['authenticated','anon','service_role'] as const)await expect(asRole(db,role,OWNER_A,()=>db.query('select public.report_logo_worker_ready($1,$2,60)',['forged',[image]]))).rejects.toMatchObject({code:'42501'});
  await db.exec('set role fixture_ready_a');try{await expect(db.query('select public.report_logo_worker_ready($1,$2,60)',['forged',[image]])).rejects.toMatchObject({code:'42501',message:'logo_worker_unauthorized'});}finally{await db.exec('reset role');}
  expect((await db.query('select attempts from public.jobs where id=any($1)',[f.receipt.jobIds])).rows.every(j=>(j as {attempts:number}).attempts===0)).toBe(true);
 });
 it('one owner cannot borrow another actual login OID manifest by reusing its worker ID',async()=>{
  await admission();await report([]);expect(await report([image],'shared-id',60,'fixture_ready_c')).toBe(true);expect(await claim('shared-id')).toEqual([]);expect((await claim('shared-id','fixture_ready_c'))).toHaveLength(1);
 });
 it('invalidated principal OIDs, role names and privilege membership cannot authorize readiness',async()=>{
  const f=await admission();const oid=(await db.query<{oid:number}>("select oid from pg_roles where rolname='fixture_ready_a'")).rows[0]!.oid;
  await db.query("update fluid_private.logo_worker_principals set role_oid=0 where role_name='fixture_ready_a'");await expect(claim()).rejects.toMatchObject({code:'42501'});await expect(report([image])).rejects.toMatchObject({code:'42501'});await expect(rpc('quote_logo_operation',[f.w.projectId,f.request])).rejects.toMatchObject({code:'55000'});
  await db.query("update fluid_private.logo_worker_principals set role_oid=$1 where role_name='fixture_ready_a'",[oid]);await db.exec('alter role fixture_ready_a rename to fixture_ready_renamed');try{await expect(report([image],'worker-a',60,'fixture_ready_renamed')).rejects.toMatchObject({code:'42501'});await expect(rpc('quote_logo_operation',[f.w.projectId,f.request])).rejects.toMatchObject({code:'55000'});}finally{await db.exec('alter role fixture_ready_renamed rename to fixture_ready_a');}
  await db.exec('grant authenticated to fixture_ready_a');try{await expect(report([image])).rejects.toMatchObject({code:'42501'});await expect(rpc('quote_logo_operation',[f.w.projectId,f.request])).rejects.toMatchObject({code:'55000'});}finally{await db.exec('revoke authenticated from fixture_ready_a');}
 });
 it('offline exact admission and durable rejection recovery run before readiness, without fabricating new rejection',async()=>{
  const f=await admission();const next=logoCostQuoteSchema.parse(await rpc('quote_logo_operation',[f.w.projectId,f.request]));const rejectedInput={...f.intent,requestKey:randomUUID(),quoteId:next.id,acceptedMaxCostMicrousd:0};const rejected=await rpc('admit_logo_operation',[f.w.projectId,rejectedInput]);expect(rejected).toMatchObject({kind:'logo_admission_rejected'});
  const pending=logoCostQuoteSchema.parse(await rpc('quote_logo_operation',[f.w.projectId,f.request]));await report([]);
  expect(await rpc('admit_logo_operation',[f.w.projectId,f.intent])).toEqual(f.receipt);expect(await rpc('admit_logo_operation',[f.w.projectId,rejectedInput])).toEqual(rejected);
  await expect(rpc('admit_logo_operation',[f.w.projectId,{...f.intent,requestKey:randomUUID(),quoteId:pending.id}])).rejects.toMatchObject({code:'55000',message:'logo_runtime_unavailable'});
  expect((await db.query('select * from public.logo_operation_rejections')).rows).toHaveLength(1);expect((await db.query('select * from public.jobs')).rows).toHaveLength(6);
 });
 it('readiness loss after dispatch preserves provider response, verified publication and final completion',async()=>{
  const f=await admission(),j=(await claim())[0]!,step=j.plan_manifest[0]!.key;await worker(()=>db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,step,'paid-once']));await report([]);
  await worker(async()=>{
   const inputRevisions=(await db.query<{v:unknown}>("select public.read_leased_logo_record($1,$2,'input_revisions',null) v",[j.id,j.lease_token])).rows[0]!.v;
   const provider=(await db.query<{v:{id:string}}>('select public.record_logo_provider_response($1,$2,$3) v',[j.id,j.lease_token,{provider:image.provider,model:image.model,providerRequestId:'paid-fixture',responseHash:'e'.repeat(64),artifactHash:'e'.repeat(64),normalizedPixelHash:'e'.repeat(64),observedAt:new Date().toISOString(),billing:{status:'recorded',confirmedMicrousd:60}}])).rows[0]!.v;
   const asset=(await db.query<{v:{id:string}}>('select fluid_private.prepare_logo_asset($1,$2,$3,$4) v',[f.w.projectId,{kind:'stage',publication:{requestKey:randomUUID(),inputRevisions,mimeType:'image/png',contentHash:'e'.repeat(64),byteLength:100,source:{kind:'concept',sourceId:j.input.attemptId}}},j.id,j.lease_token])).rows[0]!.v;
   await db.query('select fluid_private.observe_logo_asset($1,$2,$3,$4)',[asset.id,{status:'verified',checkedAt:new Date().toISOString(),contentHash:'e'.repeat(64),mimeType:'image/png',byteLength:100},j.id,j.lease_token]);
   await db.query("select public.complete_logo_job_step($1,$2,$3,'succeeded',60,$4,'paid-fixture')",[j.id,j.lease_token,step,{version:2,kind:'logo_concept',batchId:j.input.batchId,slotId:j.input.slotId,attemptId:j.input.attemptId,publicationId:asset.id,providerResponseReceiptId:provider.id}]);
   expect((await db.query<{v:string}>('select public.begin_logo_job_step($1,$2,$3,$4,100) v',[j.id,j.lease_token,step,'paid-once'])).rows[0]!.v).toBe('already_succeeded');
   await db.query("select public.finish_logo_job($1,$2,'succeeded')",[j.id,j.lease_token]);
  });
  expect((await db.query('select state,actual_cost_microusd from public.jobs where id=$1',[j.id])).rows[0]).toEqual({state:'succeeded',actual_cost_microusd:60});expect((await db.query('select * from public.asset_versions')).rows).toHaveLength(1);
 });
 it('fresh readiness does not bypass budget, wrong worker ID, cancellation or expired-lease fences',async()=>{
  await admission();const j=(await claim())[0]!;expect(await claim('other')).toEqual([]);await db.query('update public.usage_accounts set limit_microusd=0 where owner_id=$1',[OWNER_A]);expect(await claim()).toEqual([]);
  await worker(()=>expect(db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,j.plan_manifest[0]!.key,'over-budget'])).rejects.toMatchObject({code:'P0001'}));
  await db.query("update public.jobs set state='cancel_requested' where id=$1",[j.id]);await worker(async()=>{expect((await db.query<{v:boolean}>("select public.read_leased_logo_record($1,$2,'runtime_readiness',null) v",[j.id,j.lease_token])).rows[0]!.v).toBe(false);await expect(db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,j.plan_manifest[0]!.key,'cancelled'])).rejects.toMatchObject({message:'cancel_requested'});});
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[j.id]);await worker(()=>expect(db.query("select public.read_leased_logo_record($1,$2,'runtime_readiness',null)",[j.id,j.lease_token])).rejects.toMatchObject({code:'40001'}));
 });

});
