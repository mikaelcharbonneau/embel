import { reportLogoFixtureReady, SYNTHETIC_CONCEPT_READINESS } from './logo-readiness-fixture';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asRole, createTestDatabase, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from './local-supabase';
import { logoConceptBatchSchema, legacyLogoCostQuoteSchema as logoCostQuoteSchema, logoDispatchReceiptSchema, logoRequestStateSchema } from '../../src/domain/logo-jobs';
import { logoWorkspaceV2Schema } from '../../src/domain/logo-workspace';
import { planSixConcepts } from '../../src/server/logo-creation/concept-plan';
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";

// Every provider value in this suite is SYNTHETIC LOCAL evidence; no network calls.
describe('durable logo jobs in disposable PostgreSQL',()=>{
 let db:TestDatabase;
 beforeAll(async()=>{db=await createTestDatabase();await db.exec(`create role fixture_logo_worker login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls; grant usage on schema public to fixture_logo_worker;`);},60_000);
 afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{await resetFixture(db);await db.query(`insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname='fixture_logo_worker' on conflict(role_name) do nothing`,[OWNER_A]);await db.query(`insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled) values($1,'identity.logo_concept',$2,'logo-image-v1','openai','gpt-image-2.5-sunburst-2026-09-08',100,true) on conflict(owner_id,operation) do update set enabled=true`,[OWNER_A,'a'.repeat(64)]);await reportLogoFixtureReady(db,'fixture_logo_worker',['fixture','logo'],[SYNTHETIC_CONCEPT_READINESS]);});
 const rpc=(name:string,args:unknown[],owner=OWNER_A)=>asRole(db,'authenticated',owner,async()=>(await db.query<{value:unknown}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) value`,args)).rows[0]!.value);
 async function worker<T>(run:()=>Promise<T>){await db.exec(`grant execute on function public.claim_logo_job(text,integer),public.heartbeat_logo_job(uuid,uuid,integer),public.register_logo_job_plan(uuid,uuid,jsonb),public.begin_logo_job_step(uuid,uuid,text,text,bigint),public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_logo_job(uuid,uuid,text),public.read_leased_logo_record(uuid,uuid,text,jsonb),public.record_logo_provider_response(uuid,uuid,jsonb),public.expire_logo_job_leases() to fixture_logo_worker; set session authorization fixture_logo_worker;`);try{return await run();}finally{await db.exec('set session authorization postgres');}}
 async function setup(){const w=logoWorkspaceV2Schema.parse(await startLogoFixture(ownerQuery(db), {requestKey:randomUUID(),brief:{name:'Local jobs',activity:'Test',audience:'Test',personality:'Precise',logoTypes:['wordmark','mascot']}}));const r=(await db.query<{reference_snapshot_id:string}>('select reference_snapshot_id from public.logo_stage_revisions where id=$1',[w.stages.brief_references!.id])).rows[0]!;const request={operation:'concepts',expected:w.heads,briefRevisionId:w.stages.brief_references!.id,referenceSnapshotId:r.reference_snapshot_id};const q=logoCostQuoteSchema.parse(await rpc('quote_logo_operation',[w.projectId,request]));return{w,q,request,intent:{requestKey:randomUUID(),quoteId:q.id,acceptedMaxCostMicrousd:q.maxCostMicrousd,expected:w.heads}};}
 it('quotes the real deterministic plan and admits six independent single-step jobs',async()=>{const{w,q,intent}=await setup();expect(q.conceptPlan).toEqual(planSixConcepts({types:['wordmark','mascot'],priorSlotCount:0}));expect(q.maxCostMicrousd).toBe(600);const receipt=logoDispatchReceiptSchema.parse(await rpc('admit_logo_operation',[w.projectId,intent]));expect(receipt.jobIds).toHaveLength(6);const rows=(await db.query<{plan_manifest:unknown[];max_attempts:number}>('select plan_manifest,max_attempts from public.jobs')).rows;expect(rows).toHaveLength(6);expect(rows.every(r=>r.plan_manifest.length===1&&r.max_attempts===3)).toBe(true);const batch=logoConceptBatchSchema.parse((await db.query<{v:unknown}>('select fluid_private.logo_job_record($1,$2,\'concept_batch\',$3) v',[OWNER_A,w.projectId,receipt.batchId])).rows[0]!.v);expect(batch.slots.every(s=>s.attempts.length===1)).toBe(true);});
 it('exact admission replay wins before later head changes and policy disablement',async()=>{const{w,intent}=await setup();const first=await rpc('admit_logo_operation',[w.projectId,intent]);await db.query('update public.logo_workspaces set revision=revision+1 where project_id=$1',[w.projectId]);await db.query('update fluid_private.logo_runtime_policies set enabled=false where owner_id=$1',[OWNER_A]);expect(await rpc('admit_logo_operation',[w.projectId,intent])).toEqual(first);await expect(rpc('admit_logo_operation',[w.projectId,{...intent,acceptedMaxCostMicrousd:601}])).rejects.toMatchObject({code:'PT409'});expect((await db.query('select * from public.jobs')).rows).toHaveLength(6);});
 it('foreign and under-cap admissions create no jobs',async()=>{const{w,intent}=await setup();await expect(rpc('admit_logo_operation',[w.projectId,intent],OWNER_B)).rejects.toMatchObject({code:'P0002'});expect(await rpc('admit_logo_operation',[w.projectId,{...intent,acceptedMaxCostMicrousd:599}])).toMatchObject({kind:'logo_admission_rejected',errorCode:'conflict',rejection:{requestKey:intent.requestKey,quoteId:intent.quoteId}});expect((await db.query('select * from public.jobs')).rows).toHaveLength(0);});
 it('known failed children stay isolated, then ambiguous paid outcomes pause new spending and retain evidence',async()=>{
  const{w,intent}=await setup();const receipt=logoDispatchReceiptSchema.parse(await rpc('admit_logo_operation',[w.projectId,intent]));
  const jobs=await worker(async()=>{
   const done=[];
   for(const state of ['failed','ambiguous']){
    const j=(await db.query<{id:string;lease_token:string;plan_manifest:{key:string;maximumCostMicrousd:number}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!;
    expect(j).toBeDefined(); // The first known failure does not suppress its next sibling.
    const step=j.plan_manifest[0]!;
    await db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,step.key,`request-${j.id}`]);
    await db.query('select public.complete_logo_job_step($1,$2,$3,$4,0,$5,null)',[j.id,j.lease_token,step.key,state,{error:state==='failed'?'not_dispatched':'provider_outcome_unknown'}]);
    if(state==='failed')await db.query("select public.finish_logo_job($1,$2,'failed')",[j.id,j.lease_token]);
    done.push(j);
   }
   expect(done[0]!.id).not.toBe(done[1]!.id);
   return done;
  });
  const state=logoRequestStateSchema.parse(await rpc('read_logo_request',[w.projectId,intent.requestKey]));
  expect(state.status).toBe('needs_reconciliation');
  expect(state).toMatchObject({billing:{status:'unknown',confirmedMicrousd:null}});
  const ledger=()=>db.query('select reserved_microusd,spent_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1',[OWNER_A]);
  expect((await ledger()).rows).toEqual([{reserved_microusd:500,spent_microusd:0,provider_actual_microusd:0}]);
  const slots=(await db.query<{slot_id:string;job_id:string}>('select slot_id,job_id from public.logo_concept_attempts where job_id=any($1)',[jobs.map(j=>j.id)])).rows;
  const retry=(jobId:string)=>rpc('quote_logo_operation',[w.projectId,{operation:'retry_failed',expected:w.heads,sourceBatchId:receipt.batchId,failedSlotIds:[slots.find(slot=>slot.job_id===jobId)!.slot_id]}]);
  await expect(retry(jobs[1]!.id)).rejects.toMatchObject({code:'PT409'});
  // Shared trial-budget policy pauses every new paid operation until the unknown
  // charge is reconciled, including retrying another independently failed child.
  const before=(await db.query<{id:string;state:string;actual_cost_microusd:number;reserved_cost_microusd:number}>('select id,state,actual_cost_microusd,reserved_cost_microusd from public.jobs order by id')).rows;
  const stepsBefore=(await db.query('select job_id,state,output from public.job_steps order by job_id')).rows;
  const quotesBefore=(await db.query('select id from public.logo_cost_quotes order by id')).rows;
  await expect(retry(jobs[0]!.id)).rejects.toMatchObject({code:'55000',message:'logo_runtime_unavailable'});
  await worker(async()=>expect((await db.query("select * from public.claim_logo_job('fixture',60)")).rows).toEqual([]));
  expect((await db.query('select id,state,actual_cost_microusd,reserved_cost_microusd from public.jobs order by id')).rows).toEqual(before);
  expect(before).toHaveLength(6);
  expect(before.filter(row=>row.state==='queued')).toHaveLength(4);
  expect((await db.query('select job_id,state,output from public.job_steps order by job_id')).rows).toEqual(stepsBefore);
  expect(stepsBefore).toHaveLength(2);
  expect((await db.query('select id from public.logo_cost_quotes order by id')).rows).toEqual(quotesBefore);
  expect((await ledger()).rows).toEqual([{reserved_microusd:500,spent_microusd:0,provider_actual_microusd:0}]);
 });
 it('reads and reconciliation never enqueue or reset a lease',async()=>{const{w,intent}=await setup();await rpc('admit_logo_operation',[w.projectId,intent]);const before=(await db.query('select id,state,lease_token from public.jobs order by id')).rows;expect(await rpc('reconcile_logo_request',[w.projectId,intent.requestKey])).toEqual(await rpc('read_logo_request',[w.projectId,intent.requestKey]));expect((await db.query('select id,state,lease_token from public.jobs order by id')).rows).toEqual(before);});
 it('does not expose worker functions to JWT, service role or forged owner claims',async()=>{await setup();for(const role of ['authenticated','anon','service_role'] as const)await expect(asRole(db,role,OWNER_A,()=>db.query("select public.claim_logo_job('forged',60)"))).rejects.toMatchObject({code:'42501'});});
 it('five committed previews survive a sixth unknown bill with all exact source and provider receipts',async()=>{
  const{w,intent}=await setup();const receipt=logoDispatchReceiptSchema.parse(await rpc('admit_logo_operation',[w.projectId,intent]));
  await db.exec(`grant usage on schema fluid_private to fixture_logo_worker;grant execute on function fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid) to fixture_logo_worker;`);
  await worker(async()=>{
   for(let i=0;i<6;i++){
    const j=(await db.query<{id:string;lease_token:string;input:{attemptId:string;batchId:string;slotId:string};plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!;const step=j.plan_manifest[0]!.key;
    await db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,step,`request-${j.id}`]);
    const inputRevisions=(await db.query<{v:unknown}>("select public.read_leased_logo_record($1,$2,'input_revisions',null) v",[j.id,j.lease_token])).rows[0]!.v;
    const hash=String(i+1).repeat(64),observation={provider:'openai',model:'gpt-image-2.5-sunburst-2026-09-08',providerRequestId:`fixture-response-${i}`,responseHash:hash,observedAt:'2026-10-07T00:00:00Z',billing:i===5?{status:'unknown',confirmedMicrousd:null}:{status:'recorded',confirmedMicrousd:60},artifactHash:hash,normalizedPixelHash:hash};
    const provider=(await db.query<{v:{id:string}}>('select public.record_logo_provider_response($1,$2,$3) v',[j.id,j.lease_token,observation])).rows[0]!.v;
    const write={kind:'stage',publication:{requestKey:randomUUID(),inputRevisions,mimeType:'image/png',contentHash:hash,byteLength:100,source:{kind:'concept',sourceId:j.input.attemptId}}};
    if(i===0){await expect(db.query('select fluid_private.prepare_logo_asset($1,$2,$3,$4)',[w.projectId,{...write,publication:{...write.publication,inputRevisions:[]}},j.id,j.lease_token])).rejects.toMatchObject({code:'42501'});await expect(db.query('select fluid_private.prepare_logo_asset($1,$2,$3,$4)',[w.projectId,{...write,publication:{...write.publication,source:{kind:'concept',sourceId:provider.id}}},j.id,j.lease_token])).rejects.toMatchObject({code:'42501'});}
    const publication=(await db.query<{v:{id:string}}>('select fluid_private.prepare_logo_asset($1,$2,$3,$4) v',[w.projectId,write,j.id,j.lease_token])).rows[0]!.v;
    await db.query('select fluid_private.observe_logo_asset($1,$2,$3,$4)',[publication.id,{status:'verified',checkedAt:'2026-10-07T00:00:00Z',contentHash:hash,mimeType:'image/png',byteLength:100},j.id,j.lease_token]);
    const result={version:2,kind:'logo_concept',batchId:j.input.batchId,slotId:j.input.slotId,attemptId:j.input.attemptId,publicationId:publication.id,providerResponseReceiptId:provider.id};
    await db.query('select public.complete_logo_job_step($1,$2,$3,$4,$5,$6,$7)',[j.id,j.lease_token,step,i===5?'ambiguous':'succeeded',i===5?0:60,i===5?{error:'billing_unknown',result}:result,`fixture-response-${i}`]);
    if(i<5)await db.query("select public.finish_logo_job($1,$2,'succeeded')",[j.id,j.lease_token]);
   }
  });
  const state=logoRequestStateSchema.parse(await rpc('read_logo_request',[w.projectId,intent.requestKey]));expect(state).toMatchObject({status:'needs_reconciliation',reason:'billing_unknown',billing:{status:'unknown',confirmedMicrousd:null}});if(state.status==='not_found')throw new Error('Missing request');expect(state.outputs).toHaveLength(6);
  const batch=logoConceptBatchSchema.parse((await db.query<{v:unknown}>("select fluid_private.logo_job_record($1,$2,'concept_batch',$3) v",[OWNER_A,w.projectId,receipt.batchId])).rows[0]!.v);expect(batch.slots.filter(s=>s.attempts[0]!.state==='succeeded')).toHaveLength(5);expect(batch.slots.filter(s=>s.attempts[0]!.state==='needs_reconciliation')).toHaveLength(1);expect((await db.query('select * from public.asset_versions')).rows).toHaveLength(6);expect((await db.query('select reserved_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0]).toEqual({reserved_microusd:100});expect((await rpc('get_logo_workspace',[w.projectId]))).toMatchObject({heads:w.heads});
 });
 it('canonical-pixel duplicates remain confirmed failed while keeping real charge evidence',async()=>{
  const{w,intent}=await setup();const receipt=logoDispatchReceiptSchema.parse(await rpc('admit_logo_operation',[w.projectId,intent]));
  await db.exec(`grant usage on schema fluid_private to fixture_logo_worker;grant execute on function fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid) to fixture_logo_worker;`);
  await worker(async()=>{
   for(let i=0;i<6;i++){
    const j=(await db.query<{id:string;lease_token:string;input:{attemptId:string;batchId:string;slotId:string};plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!;const step=j.plan_manifest[0]!.key;
    await db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,step,`request-${j.id}`]);
    const inputRevisions=(await db.query<{v:unknown}>("select public.read_leased_logo_record($1,$2,'input_revisions',null) v",[j.id,j.lease_token])).rows[0]!.v;
    const hash=String(i+1).repeat(64),observation={provider:'openai',model:'gpt-image-2.5-sunburst-2026-09-08',providerRequestId:`fixture-response-${i}`,responseHash:hash,observedAt:'2026-10-07T00:00:00Z',billing:{status:'recorded',confirmedMicrousd:60},artifactHash:hash,normalizedPixelHash:i===5?String(1).repeat(64):hash};
    const provider=(await db.query<{v:{id:string}}>('select public.record_logo_provider_response($1,$2,$3) v',[j.id,j.lease_token,observation])).rows[0]!.v;
    const write={kind:'stage',publication:{requestKey:randomUUID(),inputRevisions,mimeType:'image/png',contentHash:hash,byteLength:100,source:{kind:'concept',sourceId:j.input.attemptId}}};
    const publication=(await db.query<{v:{id:string}}>('select fluid_private.prepare_logo_asset($1,$2,$3,$4) v',[w.projectId,write,j.id,j.lease_token])).rows[0]!.v;
    await db.query('select fluid_private.observe_logo_asset($1,$2,$3,$4)',[publication.id,{status:'verified',checkedAt:'2026-10-07T00:00:00Z',contentHash:hash,mimeType:'image/png',byteLength:100},j.id,j.lease_token]);
    const result={version:2,kind:'logo_concept',batchId:j.input.batchId,slotId:j.input.slotId,attemptId:j.input.attemptId,publicationId:publication.id,providerResponseReceiptId:provider.id};
    await db.query('select public.complete_logo_job_step($1,$2,$3,$4,$5,$6,$7)',[j.id,j.lease_token,step,'succeeded',60,result,`fixture-response-${i}`]);
    if(i<5)await db.query("select public.finish_logo_job($1,$2,'succeeded')",[j.id,j.lease_token]);
   }
  });
  const state=logoRequestStateSchema.parse(await rpc('read_logo_request',[w.projectId,intent.requestKey]));expect(state).toMatchObject({status:'partial',billing:{status:'recorded',confirmedMicrousd:360}});if(state.status==='not_found')throw new Error('Missing request');expect(state.outputs).toHaveLength(5);
  const batch=logoConceptBatchSchema.parse((await db.query<{v:unknown}>("select fluid_private.logo_job_record($1,$2,'concept_batch',$3) v",[OWNER_A,w.projectId,receipt.batchId])).rows[0]!.v);expect(batch.slots.filter(s=>s.attempts[0]!.state==='succeeded')).toHaveLength(5);expect(batch.slots.filter(s=>s.attempts[0]!.state==='failed')).toHaveLength(1);expect((await db.query('select * from public.asset_versions')).rows).toHaveLength(5);expect((await db.query('select reserved_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0]).toEqual({reserved_microusd:0});expect((await rpc('get_logo_workspace',[w.projectId]))).toMatchObject({heads:w.heads});
 });
 it('cancellation fences the next dispatch and expired in-flight work can never be re-claimed',async()=>{
  const{w,intent}=await setup();await rpc('admit_logo_operation',[w.projectId,intent]);
  const first=await worker(async()=>(await db.query<{id:string;lease_token:string;plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!);
  await rpc('request_job_cancel',[first.id]);
  await worker(async()=>{await expect(db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[first.id,first.lease_token,first.plan_manifest[0]!.key,'fenced'])).rejects.toMatchObject({code:'55000'});await db.query("select public.finish_logo_job($1,$2,'cancelled')",[first.id,first.lease_token]);});
  const second=await worker(async()=>{const j=(await db.query<{id:string;lease_token:string;plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!;await db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,j.plan_manifest[0]!.key,'in-flight']);return j;});
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[second.id]);
  await worker(()=>db.query('select public.expire_logo_job_leases()'));
  expect((await db.query('select state from public.jobs where id=$1',[second.id])).rows[0]).toEqual({state:'needs_reconciliation'});expect((await db.query('select state from public.usage_reservations where job_id=$1',[second.id])).rows[0]).toEqual({state:'active'});
  await worker(async()=>{await expect(db.query('select public.complete_logo_job_step($1,$2,$3,\'failed\',0,$4,null)',[second.id,second.lease_token,second.plan_manifest[0]!.key,{error:'not_dispatched'}])).rejects.toMatchObject({code:'40001'});});
 });

 it('unstarted work has zero recorded spend without releasing its admission reservation',async()=>{
  const{w,intent}=await setup();await rpc('admit_logo_operation',[w.projectId,intent]);const state=await rpc('read_logo_request',[w.projectId,intent.requestKey]);expect(state).toMatchObject({status:'admitted',billing:{status:'recorded',confirmedMicrousd:0}});expect((await db.query('select reserved_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0]).toEqual({reserved_microusd:600});
 });

 it('direct RPC rejects malformed local engine settings before resolving a raster',async()=>{
  const{w}=await setup();await expect(rpc('quote_logo_operation',[w.projectId,{operation:'vectorize',expected:w.heads,source:{kind:'refinement',rasterRevisionId:randomUUID()},settings:{preset:'bw',simplify:0,filterSpeckle:0,maxColors:32}}])).rejects.toMatchObject({code:'22023'});
 });
 it('a revoked policy cannot cross the first provider boundary',async()=>{
  const{w,intent}=await setup();await rpc('admit_logo_operation',[w.projectId,intent]);const j=await worker(async()=>(await db.query<{id:string;lease_token:string;plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!);await db.query('update fluid_private.logo_runtime_policies set enabled=false where owner_id=$1',[OWNER_A]);
  await worker(async()=>{expect((await db.query("select * from public.claim_logo_job('fixture',60)")).rows).toHaveLength(0);await expect(db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,j.plan_manifest[0]!.key,'disabled-policy'])).rejects.toMatchObject({code:'55000'});});expect((await db.query('select * from public.job_steps')).rows).toHaveLength(0);
 });

 it('an expired original quote cannot dispatch and quote records are immutable',async()=>{
  const{w,q,intent}=await setup();const expired=randomUUID();
  await db.query("insert into public.logo_cost_quotes(id,owner_id,project_id,operation,record,input_revisions,source_inputs,expires_at) select $2::uuid,owner_id,project_id,operation,record||jsonb_build_object('id',($2::uuid)::text,'expiresAt','2026-01-01T00:00:00Z'),input_revisions,source_inputs,'2026-01-01T00:00:00Z' from public.logo_cost_quotes where id=$1",[q.id,expired]);
  expect(await rpc('admit_logo_operation',[w.projectId,{...intent,quoteId:expired}])).toMatchObject({kind:'logo_admission_rejected',errorCode:'conflict'});await expect(db.query('update public.logo_cost_quotes set source_inputs=$2 where id=$1',[q.id,{}])).rejects.toMatchObject({code:'55000'});expect((await db.query('select * from public.jobs')).rows).toHaveLength(0);
 });

 it('partial means terminal children, never an unfinished queued batch',async()=>{
  const{w,intent}=await setup();await rpc('admit_logo_operation',[w.projectId,intent]);await worker(async()=>{const j=(await db.query<{id:string;lease_token:string;plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!;const key=j.plan_manifest[0]!.key;await db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,key,'first-failed']);await db.query("select public.complete_logo_job_step($1,$2,$3,'failed',0,$4,null)",[j.id,j.lease_token,key,{error:'not_dispatched'}]);await db.query("select public.finish_logo_job($1,$2,'failed')",[j.id,j.lease_token]);});expect(await rpc('read_logo_request',[w.projectId,intent.requestKey])).toMatchObject({status:'running',billing:{status:'recorded',confirmedMicrousd:0}});
 });

 it('rejects null-valued billing status at the actual worker SQL boundary',async()=>{
  const{w,intent}=await setup();await rpc('admit_logo_operation',[w.projectId,intent]);await worker(async()=>{const j=(await db.query<{id:string;lease_token:string;plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!;await db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,j.plan_manifest[0]!.key,'null-billing']);await expect(db.query('select public.record_logo_provider_response($1,$2,$3)',[j.id,j.lease_token,{provider:'openai',model:'gpt-image-2.5-sunburst-2026-09-08',providerRequestId:'fixture',responseHash:'a'.repeat(64),artifactHash:null,observedAt:'2026-10-07T00:00:00Z',billing:{status:null,confirmedMicrousd:0}}])).rejects.toMatchObject({code:'22023'});});expect((await db.query('select * from public.logo_provider_responses')).rows).toHaveLength(0);
 });
 it('rejects null local conversion preset before any source lookup',async()=>{
  const{w}=await setup();await expect(rpc('quote_logo_operation',[w.projectId,{operation:'vectorize',expected:w.heads,source:{kind:'refinement',rasterRevisionId:randomUUID()},settings:{preset:null,simplify:0,filterSpeckle:0,maxColors:2}}])).rejects.toMatchObject({code:'22023'});
 });

 it('discovers unselected admitted batches using bounded owned summaries',async()=>{
  const{w,intent}=await setup();const receipt=logoDispatchReceiptSchema.parse(await rpc('admit_logo_operation',[w.projectId,intent]));const page=(await db.query<{v:{ownerId:string;projectId:string;items:unknown[];nextCursor:string|null}}>("select fluid_private.logo_job_records($1,$2,'concept_batch',$3) v",[OWNER_A,w.projectId,{limit:20}])).rows[0]!.v;expect(page).toMatchObject({ownerId:OWNER_A,projectId:w.projectId,items:[{id:receipt.batchId,requestKey:intent.requestKey}],nextCursor:null});expect(Object.keys(page.items[0] as object).sort()).toEqual(['createdAt','id','requestKey']);expect((await db.query<{v:{items:unknown[]}}>("select fluid_private.logo_job_records($1,$2,'concept_batch',$3) v",[OWNER_B,w.projectId,{}])).rows[0]!.v.items).toEqual([]);expect(await rpc('get_logo_workspace',[w.projectId])).toMatchObject({stages:{concepts:null}});
 });

 it('commits rejection once so a delayed original cannot admit after budget recovers',async()=>{
  const{w,intent}=await setup();await db.query('update public.usage_accounts set limit_microusd=500 where owner_id=$1',[OWNER_A]);const rejected=await rpc('admit_logo_operation',[w.projectId,intent]);expect(rejected).toEqual({kind:'logo_admission_rejected',errorCode:'conflict',rejection:{status:'rejected',ownerId:OWNER_A,projectId:w.projectId,requestKey:intent.requestKey,quoteId:intent.quoteId}});await db.query('update public.usage_accounts set limit_microusd=1000 where owner_id=$1',[OWNER_A]);expect(await rpc('admit_logo_operation',[w.projectId,intent])).toEqual(rejected);await expect(rpc('admit_logo_operation',[w.projectId,{...intent,acceptedMaxCostMicrousd:601}])).rejects.toMatchObject({code:'PT409'});expect((await db.query('select * from public.jobs')).rows).toHaveLength(0);expect(await rpc('read_logo_request',[w.projectId,intent.requestKey])).toMatchObject({status:'failed',reason:'admission_rejected',receipt:null,billing:{status:'recorded',confirmedMicrousd:0}});expect((await db.query('select * from public.logo_operation_rejections')).rows).toHaveLength(1);
 });

 it('overlapping exact rejection submissions converge to one immutable record',async()=>{
  const{w,intent}=await setup();await db.query('update public.usage_accounts set limit_microusd=500 where owner_id=$1',[OWNER_A]);
  // PGlite serializes statements on one connection; real two-connection locking
  // remains a separate acceptance gate, not evidence asserted by this fixture.
  const responses=await asRole(db,'authenticated',OWNER_A,()=>Promise.all(Array.from({length:3},()=>db.query<{v:unknown}>('select public.admit_logo_operation($1,$2) v',[w.projectId,intent]))));expect(responses[1]!.rows[0]!.v).toEqual(responses[0]!.rows[0]!.v);expect(responses[2]!.rows[0]!.v).toEqual(responses[0]!.rows[0]!.v);expect((await db.query('select * from public.logo_operation_rejections')).rows).toHaveLength(1);expect((await db.query('select * from public.jobs')).rows).toHaveLength(0);
 });
 it('a late retry rejection rolls back earlier children before committing its tombstone',async()=>{
  const{w,intent}=await setup();const admitted=logoDispatchReceiptSchema.parse(await rpc('admit_logo_operation',[w.projectId,intent]));const failed:string[]=[];
  await worker(async()=>{for(let i=0;i<2;i++){const j=(await db.query<{id:string;lease_token:string;input:{slotId:string};plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!;failed.push(j.input.slotId);await db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,j.plan_manifest[0]!.key,`failed-${i}`]);await db.query("select public.complete_logo_job_step($1,$2,$3,'failed',0,$4,null)",[j.id,j.lease_token,j.plan_manifest[0]!.key,{error:'not_dispatched'}]);await db.query("select public.finish_logo_job($1,$2,'failed')",[j.id,j.lease_token]);}});
  const both=logoCostQuoteSchema.parse(await rpc('quote_logo_operation',[w.projectId,{operation:'retry_failed',expected:w.heads,sourceBatchId:admitted.batchId,failedSlotIds:failed}]));const one=logoCostQuoteSchema.parse(await rpc('quote_logo_operation',[w.projectId,{operation:'retry_failed',expected:w.heads,sourceBatchId:admitted.batchId,failedSlotIds:[failed[1]]}]));await rpc('admit_logo_operation',[w.projectId,{requestKey:randomUUID(),quoteId:one.id,acceptedMaxCostMicrousd:100,expected:w.heads}]);const before=(await db.query('select id from public.jobs order by id')).rows;
  const rejected=await rpc('admit_logo_operation',[w.projectId,{requestKey:randomUUID(),quoteId:both.id,acceptedMaxCostMicrousd:200,expected:w.heads}]);expect(rejected).toMatchObject({kind:'logo_admission_rejected'});expect((await db.query('select id from public.jobs order by id')).rows).toEqual(before);expect((await db.query('select * from public.logo_operation_rejections')).rows).toHaveLength(1);expect((await db.query('select reserved_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0]).toEqual({reserved_microusd:500});
 });

 it('a rejected dispatch key cannot be reused for a manual mutation',async()=>{
  const{w,intent}=await setup();await db.query('update public.usage_accounts set limit_microusd=500 where owner_id=$1',[OWNER_A]);await rpc('admit_logo_operation',[w.projectId,intent]);await expect(rpc('apply_logo_workspace_command',[w.projectId,{method:'saveLogoBrief',body:{requestKey:intent.requestKey,expected:w.heads,brief:{name:'Conflicting manual request',activity:'Test',audience:'Test',personality:'Precise',logoTypes:['wordmark']}}}])).rejects.toMatchObject({code:'PT409'});expect(await rpc('get_logo_workspace',[w.projectId])).toMatchObject({heads:w.heads});
 });

 it('a confirmed provider overrun blocks both queued and already-claimed paid siblings',async()=>{
  const{w,intent}=await setup();await rpc('admit_logo_operation',[w.projectId,intent]);
  const held=await worker(async()=>{const first=(await db.query<{id:string;lease_token:string;plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!;const claimed=(await db.query<{id:string;lease_token:string;plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!;await db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[first.id,first.lease_token,first.plan_manifest[0]!.key,'overrun']);await db.query('select public.record_logo_provider_response($1,$2,$3)',[first.id,first.lease_token,{provider:'openai',model:'gpt-image-2.5-sunburst-2026-09-08',providerRequestId:'overrun-fixture',responseHash:'a'.repeat(64),artifactHash:null,observedAt:'2026-10-07T00:00:00Z',billing:{status:'recorded',confirmedMicrousd:800}}]);await db.query("select public.complete_logo_job_step($1,$2,$3,'ambiguous',800,$4,'overrun-fixture')",[first.id,first.lease_token,first.plan_manifest[0]!.key,{error:'provider_cost_exceeded'}]);return claimed;});
  expect((await db.query('select limit_microusd,reserved_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0]).toEqual({limit_microusd:1000,reserved_microusd:500,provider_actual_microusd:800});
  await worker(async()=>{expect((await db.query("select * from public.claim_logo_job('fixture',60)")).rows).toHaveLength(0);await expect(db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[held.id,held.lease_token,held.plan_manifest[0]!.key,'blocked-sibling'])).rejects.toMatchObject({code:'55000',message:'logo_runtime_unavailable'});});expect((await db.query('select * from public.job_steps')).rows).toHaveLength(1);
 });
 it('direct concept quote rejects null or noncanonical source UUIDs without a quote write',async()=>{
  const{w,request}=await setup();const before=(await db.query('select id from public.logo_cost_quotes')).rows;
  for(const field of ['briefRevisionId','referenceSnapshotId'])for(const value of [null,42,'not-a-uuid','AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'])await expect(rpc('quote_logo_operation',[w.projectId,{...request,[field]:value}])).rejects.toMatchObject({code:'22023'});
  expect((await db.query('select id from public.logo_cost_quotes')).rows).toEqual(before);
 });
 it('direct refinement text validation uses UTF16 units before any source lookup',async()=>{
  const{w}=await setup(),source={kind:'refinement',rasterRevisionId:randomUUID()};
  for(const instruction of ['😀'.repeat(2001),'a'.repeat(4001),''])await expect(rpc('quote_logo_operation',[w.projectId,{operation:'refine_preview',expected:w.heads,source,instruction}])).rejects.toMatchObject({code:'22023'});
  await expect(rpc('quote_logo_operation',[w.projectId,{operation:'refine_preview',expected:w.heads,source,instruction:'😀'.repeat(2000)}])).rejects.toMatchObject({code:'P0002'});
 });
 it('legacy API workers cannot claim or mutate logo leases, and logo workers skip legacy jobs',async()=>{
  const{w,intent}=await setup();await rpc('admit_logo_operation',[w.projectId,intent]);expect(await asRole(db,'service_role',null,async()=>(await db.query("select * from public.claim_job('legacy',60)")).rows)).toHaveLength(0);
  const claimed=await worker(async()=>(await db.query<{id:string;lease_token:string;plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('logo',60)")).rows[0]!);
  await asRole(db,'service_role',null,async()=>{for(const [sql,args] of [["select public.heartbeat_job($1,$2,60)",[claimed.id,claimed.lease_token]],["select public.register_job_plan($1,$2,$3)",[claimed.id,claimed.lease_token,[]]],["select public.begin_job_step($1,$2,$3,$4,100)",[claimed.id,claimed.lease_token,claimed.plan_manifest[0]!.key,'wrong-worker']],["select public.complete_job_step($1,$2,$3,'failed',0,$4,null)",[claimed.id,claimed.lease_token,claimed.plan_manifest[0]!.key,{error:'not_dispatched'}]],["select public.report_job_progress($1,$2,20)",[claimed.id,claimed.lease_token]],["select public.finish_job($1,$2,'failed',null)",[claimed.id,claimed.lease_token]]] as const)await expect(db.query(sql,[...args])).rejects.toMatchObject({code:'42501'});});
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[claimed.id]);expect(await asRole(db,'service_role',null,async()=>(await db.query<{v:number}>('select public.expire_job_leases() v')).rows[0]!.v)).toBe(0);expect((await db.query('select state from public.jobs where id=$1',[claimed.id])).rows[0]).toEqual({state:'running'});
  const legacy=await asRole(db,'service_role',null,async()=>(await db.query<{id:string}>("select * from public.enqueue_job($1,$2,'identity.image',1,$3,'{}',$4,100,3)",[OWNER_A,w.projectId,'b'.repeat(64),`legacy-${randomUUID()}`])).rows[0]!);
  const legacyClaim=await asRole(db,'service_role',null,async()=>(await db.query<{id:string;lease_token:string}>("select * from public.claim_job('legacy',60)")).rows[0]!);expect(legacyClaim.id).toBe(legacy.id);
  await worker(async()=>{await expect(db.query('select public.heartbeat_logo_job($1,$2,60)',[legacyClaim.id,legacyClaim.lease_token])).rejects.toMatchObject({code:'40001'});});
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[legacy.id]);await worker(()=>db.query('select public.expire_logo_job_leases()'));expect((await db.query('select state from public.jobs where id=$1',[legacy.id])).rows[0]).toEqual({state:'running'});expect(await asRole(db,'service_role',null,async()=>(await db.query<{v:number}>('select public.expire_job_leases() v')).rows[0]!.v)).toBe(1);
 });

 it('only export requests may omit a quote and their project ownership remains enforced',async()=>{
  const{w,q,intent}=await setup();
  for(const [quoteId,operation] of [[null,'identity.logo_concept'],[q.id,'identity.logo_export'],[null,null]] as const)await expect(db.query('insert into public.logo_operation_requests(owner_id,project_id,request_key,quote_id,input,receipt) values($1,$2,$3,$4,$5,$6)',[OWNER_A,w.projectId,randomUUID(),quoteId,intent,{operation}])).rejects.toMatchObject({code:'23514'});
  // The lifecycle guard rejects inaccessible projects before the composite FK.
  await expect(db.query('insert into public.logo_operation_requests(owner_id,project_id,request_key,quote_id,input,receipt) values($1,$2,$3,null,$4,$5)',[OWNER_B,w.projectId,randomUUID(),{}, {operation:'identity.logo_export'}])).rejects.toMatchObject({code:'P0002',message:'project_not_found'});
  expect((await db.query('select request_key from public.logo_operation_requests where owner_id=$1 and project_id=$2',[OWNER_B,w.projectId])).rows).toEqual([]);
 });
 it('direct SQL cannot publish another logo operation through a failed-result export envelope',async()=>{
  const{w,intent}=await setup();await rpc('admit_logo_operation',[w.projectId,intent]);await worker(async()=>{const j=(await db.query<{id:string;lease_token:string;plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!;const step=j.plan_manifest[0]!.key;await db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,step,'wrong-operation-partial']);await expect(db.query("select public.complete_logo_job_step($1,$2,$3,'failed',0,$4,null)",[j.id,j.lease_token,step,{error:'export_file_failed',result:{version:2,kind:'logo_export_partial',publicationId:randomUUID()}}])).rejects.toMatchObject({code:'22023'});});expect((await db.query('select state from public.job_steps')).rows).toEqual([{state:'in_flight'}]);expect((await db.query('select * from public.asset_versions')).rows).toHaveLength(0);
 });

 it('a committed failed step survives a lost finish acknowledgement without being requeued',async()=>{
  const{w,intent}=await setup();await rpc('admit_logo_operation',[w.projectId,intent]);const claimed=await worker(async()=>{const j=(await db.query<{id:string;lease_token:string;plan_manifest:{key:string}[]}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!;await db.query('select public.begin_logo_job_step($1,$2,$3,$4,100)',[j.id,j.lease_token,j.plan_manifest[0]!.key,'known-failure']);await db.query("select public.complete_logo_job_step($1,$2,$3,'failed',0,$4,null)",[j.id,j.lease_token,j.plan_manifest[0]!.key,{error:'not_dispatched'}]);return j;});await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[claimed.id]);await worker(()=>db.query('select public.expire_logo_job_leases()'));expect((await db.query('select state from public.jobs where id=$1',[claimed.id])).rows[0]).toEqual({state:'failed'});expect((await db.query('select state from public.usage_reservations where job_id=$1',[claimed.id])).rows[0]).toEqual({state:'settled'});expect((await db.query('select reserved_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0]).toEqual({reserved_microusd:500});
 });
 it('lease recovery preserves earlier succeeded steps as terminal partial after a later known failure',async()=>{
  const{w}=await setup(),jobId=randomUUID(),lease=randomUUID(),plan=[{key:'generate-refinement',maximumCostMicrousd:100},{key:'convert-refinement',maximumCostMicrousd:0}];
  // Synthetic internal two-step lifecycle fixture. It asserts recovery state and
  // accounting only; it does not certify a provider response or vector output.
  await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,lease_token,lease_expires_at,attempts,reserved_cost_microusd,actual_cost_microusd,plan_manifest,plan_fingerprint,plan_registered_at) values($1,$2,$3,'identity.logo_refine',1,$4,'{}',$5,'running',$6,clock_timestamp()-interval '1 second',1,100,60,$7,$4,clock_timestamp())",[jobId,OWNER_A,w.projectId,'a'.repeat(64),`synthetic-two-step-${jobId}`,lease,plan]);
  await db.query("insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,actual_cost_microusd,output) values($1,$2,$3,'generate-refinement','synthetic-first','succeeded',100,60,'{}'),($1,$2,$3,'convert-refinement','synthetic-second','failed',0,0,'{\"error\":\"conversion_failed\"}')",[jobId,OWNER_A,w.projectId]);await db.query('insert into public.usage_reservations(job_id,owner_id,project_id,reserved_microusd,actual_microusd,captured_microusd) values($1,$2,$3,100,60,60)',[jobId,OWNER_A,w.projectId]);await db.query('update public.usage_accounts set reserved_microusd=40,spent_microusd=60,provider_actual_microusd=60 where owner_id=$1',[OWNER_A]);await worker(()=>db.query('select public.expire_logo_job_leases()'));expect((await db.query('select state,actual_cost_microusd from public.jobs where id=$1',[jobId])).rows[0]).toEqual({state:'partial',actual_cost_microusd:60});expect((await db.query('select state from public.job_steps where job_id=$1 order by step_key',[jobId])).rows).toEqual([{state:'failed'},{state:'succeeded'}]);expect((await db.query('select reserved_microusd,spent_microusd from public.usage_accounts where owner_id=$1',[OWNER_A])).rows[0]).toEqual({reserved_microusd:0,spent_microusd:60});
 });
 it('an untouched expired lease remains resumable with no second operation identity',async()=>{
  const{w,intent}=await setup();await rpc('admit_logo_operation',[w.projectId,intent]);const first=await worker(async()=>(await db.query<{id:string;lease_token:string}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!);await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[first.id]);await worker(()=>db.query('select public.expire_logo_job_leases()'));expect((await db.query('select state from public.jobs where id=$1',[first.id])).rows[0]).toEqual({state:'queued'});const resumed=await worker(async()=>(await db.query<{id:string;lease_token:string}>("select * from public.claim_logo_job('fixture',60)")).rows[0]!);expect(resumed.id).toBe(first.id);expect(resumed.lease_token).not.toBe(first.lease_token);expect((await db.query('select * from public.job_steps')).rows).toHaveLength(0);
 });

});
