import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {createSharedIdentityFixture,OWNER_A,OWNER_B,hash,type SharedIdentityFixture} from './shared-identity-generation-fixture';
import {specification,textPolicy} from '../worker/identity-generation-fixture';
import {pngChunk,syntheticPng} from '../features/logo-vector/raster-fixtures';
import {identityBatchStateSchema,identityAvailabilitySchema} from '../../src/domain/identity-jobs';
describe('shared Identity generation actual SQL/Storage RLS, synthetic provider evidence',()=>{
 let f:SharedIdentityFixture;
 beforeAll(async()=>{f=await createSharedIdentityFixture();},60_000);afterAll(async()=>{await f?.db.close();});
 it('registers actual owned committed reference uploads without implicit selection and retains exact lost-ACK replay',async()=>{
  const p=await f.project(OWNER_A,false),{key,metadata,entry}=p.source;
  expect(entry.reaction).toMatchObject({revision:0,ensemble:false,elements:[]});
  expect(await f.rpc(OWNER_A,'read_shared_identity_reference_upload',[p.projectId,key])).toEqual(entry);
  expect(await f.rpc(OWNER_A,'register_shared_identity_reference',[p.projectId,key,metadata])).toEqual(entry);
  await expect(f.rpc(OWNER_A,'register_shared_identity_reference',[p.projectId,key,{...metadata,tags:['changed']}])).rejects.toThrow(/conflict/);
  await expect(f.rpc(OWNER_B,'register_shared_identity_reference',[p.projectId,key,metadata])).rejects.toThrow(/project_missing/);
  expect(identityAvailabilitySchema.parse(await f.rpc(OWNER_A,'get_shared_identity_availability',[p.projectId]))).toMatchObject({status:'unavailable',reason:'references_unavailable'});
 });
 it('admits one exact four-head input and completes three actual distinct observed boards with linked roots',async()=>{
  const p=await f.project(),intent=f.intent();
  expect(identityAvailabilitySchema.parse(await f.rpc(OWNER_A,'get_shared_identity_availability',[p.projectId]))).toMatchObject({status:'available',spendControl:'uncapped',maxReferenceImages:4});
  const started=await f.admit(p,intent);
  expect(await f.rpc(OWNER_A,'ensure_shared_identity_batch',[p.projectId,intent])).toEqual({...started.batch,status:'running'});
  for(let n=1;n<=3;n++){await f.system(started,n);const loaded=(await f.action('identity_input',[started.job.id,started.job.leaseToken],started.execution)).result as {systems:{id:string}[]};expect(loaded.systems.map(s=>s.id)).toEqual(started.input.systemIds.slice(0,n));}
  await f.action('finish',[started.job.id,started.job.leaseToken,'succeeded'],started.execution);
  const state=identityBatchStateSchema.parse(await f.rpc(OWNER_A,'get_shared_identity_batch',[p.projectId,started.batch.batchId,null]));
  expect(state).toMatchObject({status:'succeeded',terminal:true,fulfillment:{targetCount:3,acceptedCount:3,status:'complete'}});
  expect(new Set(state.systems.map(s=>s.board.asset.contentHash)).size).toBe(3);
  expect(state.systems.every(s=>s.productionFiles.length===0)).toBe(true);
  expect((await f.db.query<{n:number}>('select count(*)::int n from fluid_private.shared_identity_calls where job_id=$1',[started.job.id])).rows).toEqual([{n:6}]);
  await expect(f.rpc(OWNER_B,'get_shared_identity_batch',[p.projectId,started.batch.batchId,null])).rejects.toThrow(/project_missing/);
 });
 it('rejects foreign/stale/sessionless upload intents and preserves a generic project without creating Logo stages',async()=>{
  const p=await f.project(OWNER_A,false),request=p.source.request;
  expect((await f.db.query<{n:number}>('select count(*)::int n from public.logo_stage_revisions where project_id=$1',[p.projectId])).rows).toEqual([{n:0}]);
  expect(await f.rpc(OWNER_A,'prepare_shared_identity_reference_upload',[p.projectId,request])).toMatchObject({ownerId:OWNER_A,projectId:p.projectId,requestKey:p.source.key});
  await expect(f.rpc(OWNER_A,'prepare_shared_identity_reference_upload',[p.projectId,{...request,file:{...request.file,contentHash:'b'.repeat(64)}}])).rejects.toThrow(/intent_conflict/);
  for(const file of [{...request.file,mimeType:'text/html'},{...request.file,byteLength:0},{...request.file,contentHash:'bad'}])await expect(f.rpc(OWNER_A,'prepare_shared_identity_reference_upload',[p.projectId,{...request,file}])).rejects.toThrow(/intent_invalid/);
  await expect(f.rpc(OWNER_A,'prepare_shared_identity_reference_upload',[p.projectId,{...request,kind:'font_upload'}])).rejects.toThrow(/intent_invalid/);
  await expect(f.rpc(OWNER_A,'prepare_shared_identity_reference_upload',[p.projectId,{...request,input:{...request.input,requestKey:randomUUID(),expected:{...request.input.expected,projectRevision:999}}}])).rejects.toThrow(/heads_changed/);
  await expect(f.rpc(OWNER_B,'prepare_shared_identity_reference_upload',[p.projectId,request])).rejects.toThrow(/project_missing/);
  await expect(f.asAuth(OWNER_A,()=>f.db.query('select public.prepare_shared_identity_reference_upload($1,$2)',[p.projectId,JSON.stringify(request)]),{session_id:randomUUID()})).rejects.toThrow(/account_unavailable/);
  expect((await f.db.query<{n:number}>('select count(*)::int n from public.logo_stage_revisions where project_id=$1',[p.projectId])).rows).toEqual([{n:0}]);
 });
 it('checks all four admission heads and rejects missing or forged runtime readiness before any job',async()=>{
  const p=await f.project();
  for(const field of ['expectedProjectRevision','expectedReferenceRevision','expectedPreferencesRevision','expectedIdentityRevision']){
   const intent={...f.intent(),[field]:999};await expect(f.rpc(OWNER_A,'ensure_shared_identity_batch',[p.projectId,intent])).rejects.toThrow(/head_conflict|snapshot_conflict/);
  }
  await f.db.query('delete from fluid_private.shared_logo_slot_runtime_readiness where slot_id=$1',[f.slotId]);
  expect(await f.rpc(OWNER_A,'get_shared_identity_availability',[p.projectId])).toMatchObject({status:'unavailable',reason:'runtime_unavailable'});
  await expect(f.rpc(OWNER_A,'ensure_shared_identity_batch',[p.projectId,f.intent()])).rejects.toThrow(/unavailable/);
  await expect(f.action('runtime_ready',[[{...f.capability,policyIdentity:'f'.repeat(64)}]])).rejects.toThrow(/manifest_mismatch/);
  await f.ready();
  expect((await f.db.query<{n:number}>("select count(*)::int n from public.jobs where project_id=$1 and operation='identity.image'",[p.projectId])).rows).toEqual([{n:0}]);
 });
 it('retains an accepted system after Stop and never starts its later provider calls',async()=>{
  const started=await f.admit(await f.project());await f.system(started,1);
  await f.rpc(OWNER_A,'cancel_shared_identity_batch',[started.projectId,started.batch.batchId]);
  await expect(f.action('begin',[started.job.id,started.job.leaseToken,'identity-system-v1:2','must-not-start',0],started.execution)).rejects.toThrow(/fenced|dispatch_closed|execution_denied/);
  await f.action('finish',[started.job.id,started.job.leaseToken,'cancelled'],started.execution);
  const state=identityBatchStateSchema.parse(await f.rpc(OWNER_A,'get_shared_identity_batch',[started.projectId,started.batch.batchId,null]));
  expect(state).toMatchObject({status:'cancelled',terminal:true,fulfillment:{acceptedCount:1,status:'partial'}});
  expect(state.systems.map(s=>s.id)).toEqual([started.input.systemIds[0]]);
  expect((await f.db.query<{n:number}>('select count(*)::int n from fluid_private.shared_identity_calls where job_id=$1',[started.job.id])).rows).toEqual([{n:2}]);
 });
 it('closes an absent exact intent durably and rejects a late original admission without fabricating a job',async()=>{
  const p=await f.project(),intent=f.intent();
  const close=await f.rpc(OWNER_A,'close_shared_identity_generation_intent',[p.projectId,intent]);
  expect(close).toEqual({status:'not_admitted',ownerId:OWNER_A,projectId:p.projectId,intent});
  expect(await f.rpc(OWNER_A,'close_shared_identity_generation_intent',[p.projectId,intent])).toEqual(close);
  await expect(f.rpc(OWNER_A,'ensure_shared_identity_batch',[p.projectId,intent])).rejects.toThrow(/intent_closed/);
  await expect(f.rpc(OWNER_A,'close_shared_identity_generation_intent',[p.projectId,{...intent,expectedReferenceRevision:2}])).rejects.toThrow(/intent_conflict/);
  await expect(f.rpc(OWNER_B,'close_shared_identity_generation_intent',[p.projectId,intent])).rejects.toThrow(/project_missing/);
  expect(await f.rpc(OWNER_A,'get_shared_identity_batch',[p.projectId,null,intent.idempotencyKey])).toBeNull();
  expect((await f.db.query<{n:number}>('select count(*)::int n from public.jobs where project_id=$1',[p.projectId])).rows).toEqual([{n:0}]);
 });
 it('retains issued uncertainty when closing an already-admitted exact intent and never issues again',async()=>{
  const started=await f.admit(await f.project()),e=started.execution,key='identity-system-v1:1',requestKey=hash('uncertain-call'),requestHash=hash('uncertain-body');
  await f.action('begin',[e.jobId,e.leaseToken,key,'uncertain-step',0],e);
  const issued=(await f.action('identity_authorize',[e.jobId,e.leaseToken,key,'specifications',requestKey,requestHash],e)).result;
  expect(issued).toMatchObject({disposition:'started'});
  expect((await f.action('identity_authorize',[e.jobId,e.leaseToken,key,'specifications',requestKey,requestHash],e)).result).toMatchObject({disposition:'already_issued'});
  await f.action('complete',[e.jobId,e.leaseToken,key,'ambiguous',0,{error:'provider_outcome_unknown'},null],e);
  expect(await f.rpc(OWNER_A,'close_shared_identity_generation_intent',[started.projectId,started.intent])).toMatchObject({status:'admitted',batch:{status:'needs_reconciliation',terminal:false,fulfillment:{acceptedCount:0,status:'none'}}});
  await expect(f.action('identity_authorize',[e.jobId,e.leaseToken,key,'specifications',requestKey,requestHash],e)).rejects.toThrow(/execution_denied|dispatch_closed|fenced/);
  expect((await f.db.query<{n:number}>('select count(*)::int n from fluid_private.shared_identity_calls where job_id=$1',[e.jobId])).rows).toEqual([{n:1}]);
 });
 it('recovers only the exact known staged system after takeover/deployment change without a new provider call',async()=>{
  const started=await f.admit(await f.project()),prepared=await f.system(started,1,false),before=(await f.db.query('select * from fluid_private.shared_identity_calls where job_id=$1 order by id',[started.job.id])).rows;
  await f.takeover('dpl_identity_recovery_next');
  const recovery=(await f.action('recovery',[],started.execution)).result as {outputs:unknown[];capability:unknown;remaining:boolean};
  expect(recovery.outputs).toHaveLength(1);expect(recovery.capability).toEqual(f.capability);expect(recovery.remaining).toBe(false);
  await f.grant(started.execution,prepared.reservation,'observe');
  await expect(f.grant(started.execution,prepared.reservation,'write')).rejects.toThrow(/execution_denied/);
  await f.action('observe_recovered_asset',[started.job.leaseToken,prepared.reservation.id,prepared.verification],started.execution);
  expect((await f.action('recovery',[],started.execution)).result).toMatchObject({outputs:[]});
  await f.action('finish_known',[],started.execution);
  const state=identityBatchStateSchema.parse(await f.rpc(OWNER_A,'get_shared_identity_batch',[started.projectId,started.batch.batchId,null]));
  expect(state.systems.map(s=>s.id)).toEqual([started.input.systemIds[0]]);expect(state.fulfillment).toMatchObject({acceptedCount:1,status:'partial'});
  expect((await f.db.query('select * from fluid_private.shared_identity_calls where job_id=$1 order by id',[started.job.id])).rows).toEqual(before);
  await f.rpc(OWNER_A,'cancel_shared_identity_batch',[started.projectId,started.batch.batchId]);
  await f.action('finish_known',[],started.execution);
 });

 it('rejects grafted systems, components, files and receipts while retaining the exact prepared output',async()=>{
  const started=await f.admit(await f.project()),prepared=await f.system(started,1,false),identity=prepared.output.identity,system=identity.systems[0]!;
  const textCall=(await f.action('identity_call',[started.job.id,started.job.leaseToken,prepared.key,'specifications'],started.execution)).result as {callId:string};
  await expect(f.action('identity_receipt',[started.job.id,started.job.leaseToken,textCall.callId,{...prepared.text,billing:{status:'recorded',confirmedMicrousd:999}}],started.execution)).rejects.toThrow(/observation_invalid/);
  const imageCall=(await f.action('identity_call',[started.job.id,started.job.leaseToken,prepared.key,'board'],started.execution)).result as {callId:string};
  await expect(f.action('identity_receipt',[started.job.id,started.job.leaseToken,imageCall.callId,{...prepared.image,usage:{input_tokens:10,output_tokens:10,input_tokens_details:{text_tokens:10,image_tokens:0},output_tokens_details:{text_tokens:1,image_tokens:9}}}],started.execution)).rejects.toThrow(/observation_invalid/);
  const changed=[{...prepared.output,identity:{...identity,ownerId:OWNER_B}},{...prepared.output,identity:{...identity,input:{...identity.input,description:'forged'}}},
   {...prepared.output,identity:{...identity,systems:[{...system,ownerId:OWNER_B}]}},
   {...prepared.output,identity:{...identity,systems:[{...system,components:{...system.components,colors:{...system.components.colors,summary:'forged'}}}]}},
   {...prepared.output,identity:{...identity,systems:[{...system,board:{...system.board,asset:{...system.board.asset,contentHash:'f'.repeat(64)}}}]}}];
  for(const output of changed)await expect(f.action('identity_stage',[started.job.id,started.job.leaseToken,prepared.key,output,prepared.evidence],started.execution)).rejects.toThrow(/identity_/);
  for(const evidence of [{...prepared.evidence,textReceiptId:prepared.evidence.imageReceiptId},{...prepared.evidence,imageReceiptId:randomUUID()},{...prepared.evidence,publicationId:randomUUID()}])await expect(f.action('identity_stage',[started.job.id,started.job.leaseToken,prepared.key,prepared.output,evidence],started.execution)).rejects.toThrow(/provenance/);
  await expect(f.action('complete',[started.job.id,started.job.leaseToken,prepared.key,'succeeded',469,prepared.output,prepared.image.providerRequestId],started.execution)).rejects.toThrow(/cost_mismatch/);
  await f.action('complete',[started.job.id,started.job.leaseToken,prepared.key,'succeeded',470,prepared.output,prepared.image.providerRequestId],started.execution);
  await f.rpc(OWNER_A,'cancel_shared_identity_batch',[started.projectId,started.batch.batchId]);await f.action('finish',[started.job.id,started.job.leaseToken,'cancelled'],started.execution);
 });
 it('preserves all five saved selections and rejects generation instead of truncating the reference count',async()=>{
  const p=await f.project(OWNER_B);for(let n=2;n<=5;n++){const uploaded=await f.upload(p.projectId,OWNER_B,n);await f.rpc(OWNER_B,'set_identity_reference_reaction',[p.projectId,uploaded.entry.reference.id,{expectedRevision:0,ensemble:true,elements:[]}]);}
  expect(await f.rpc(OWNER_B,'get_shared_identity_availability',[p.projectId])).toMatchObject({status:'unavailable',reason:'reference_limit_exceeded'});
  await expect(f.rpc(OWNER_B,'ensure_shared_identity_batch',[p.projectId,{...f.intent(),expectedReferenceRevision:5}])).rejects.toThrow(/unavailable/);
  expect((await f.db.query<{n:number}>('select count(*)::int n from public.identity_references where project_id=$1',[p.projectId])).rows).toEqual([{n:5}]);
 });
 it('rejects more than20MiB of actual committed reference bytes before admission without dropping selections',async()=>{
  const p=await f.project(OWNER_B,false),small=syntheticPng(1,1,()=>[0,0,0,255]);
  // A valid ancillary PNG text chunk makes each real file11MiB. The SQL proof
  // consumes its exact observed length/hash, not an invented metadata size.
  const bytes=Buffer.concat([small.subarray(0,-12),pngChunk('tEXt',Buffer.from('Comment\0'+'x'.repeat(11*1024*1024))),small.subarray(-12)]);
  expect(bytes.byteLength).toBeLessThan(20_971_520);
  for(let n=1;n<=2;n++){const uploaded=await f.upload(p.projectId,OWNER_B,n+10,bytes);await f.rpc(OWNER_B,'set_identity_reference_reaction',[p.projectId,uploaded.entry.reference.id,{expectedRevision:0,ensemble:true,elements:[]}]);}
  expect(await f.rpc(OWNER_B,'get_shared_identity_availability',[p.projectId])).toMatchObject({status:'unavailable',reason:'reference_bytes_exceeded'});
  await expect(f.rpc(OWNER_B,'ensure_shared_identity_batch',[p.projectId,{...f.intent(),expectedReferenceRevision:2}])).rejects.toThrow(/unavailable/);
  expect((await f.db.query<{n:number}>('select count(*)::int n from public.jobs where project_id=$1',[p.projectId])).rows).toEqual([{n:0}]);
 });

 it('closes a cancelled zero-authorized in-flight step with an honest absence witness',async()=>{
  const started=await f.admit(await f.project(OWNER_B)),e=started.execution,key='identity-system-v1:1';
  await f.action('begin',[e.jobId,e.leaseToken,key,hash('cancel-before-authorize'),0],e);
  await f.rpc(OWNER_B,'cancel_shared_identity_batch',[started.projectId,started.batch.batchId]);
  await expect(f.action('identity_authorize',[e.jobId,e.leaseToken,key,'specifications',hash('late-key'),hash('late-body')],e)).rejects.toThrow(/execution_denied|dispatch_closed|fenced/);
  expect((await f.action('finish_known',[],e)).result).toMatchObject({status:'terminal',state:'cancelled'});
  expect(await f.rpc(OWNER_B,'get_shared_identity_batch',[started.projectId,started.batch.batchId,null])).toMatchObject({status:'cancelled',terminal:true,fulfillment:{acceptedCount:0}});
  expect((await f.db.query<{mode:string;receipt_id:null;original_step:{state:string;output:null};known_cost_microusd:number}>('select mode,receipt_id,original_step,known_cost_microusd from fluid_private.shared_identity_specification_cancellations where job_id=$1',[e.jobId])).rows[0]).toMatchObject({mode:'no_provider_authorized',receipt_id:null,original_step:{state:'in_flight',output:null},known_cost_microusd:0});
 });
 it('resolves cancelled known specifications without a board call or double-counting the observed charge',async()=>{
  const started=await f.admit(await f.project(OWNER_B)),e=started.execution,key='identity-system-v1:1',requestKey=hash('known-spec-key'),requestHash=hash('known-spec-body');
  await f.action('begin',[e.jobId,e.leaseToken,key,hash('known-spec-step'),0],e);
  const issued=(await f.action('identity_authorize',[e.jobId,e.leaseToken,key,'specifications',requestKey,requestHash],e)).result as {callId:string};
  const observation={version:1,phase:'specifications',provider:'openai',model:textPolicy.model,requestKey,requestHash,responseId:'resp_known_cancelled',providerRequestId:null,responseHash:hash('known-spec-response'),observedAt:new Date().toISOString(),responseComplete:true,serviceTier:'default',usage:{inputTokens:10,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:10},billing:{status:'recorded',confirmedMicrousd:120},specification:specification(1),artifactHash:null};
  await f.action('identity_receipt',[e.jobId,e.leaseToken,issued.callId,observation],e);
  const costBefore=(await f.db.query<{cost:number}>('select provider_actual_microusd cost from public.usage_accounts where owner_id=$1',[OWNER_B])).rows[0]!.cost;
  const originalOutput={error:'cancelled_after_specifications'};
  await f.action('complete',[e.jobId,e.leaseToken,key,'failed',120,originalOutput,null],e);
  expect((await f.action('finish_known',[],e)).result).toMatchObject({status:'retained_unknown'});
  await f.rpc(OWNER_B,'cancel_shared_identity_batch',[started.projectId,started.batch.batchId]);
  expect((await f.action('finish_known',[],e)).result).toMatchObject({status:'terminal',state:'cancelled'});
  expect((await f.db.query<{cost:number}>('select actual_cost_microusd cost from public.jobs where id=$1',[e.jobId])).rows[0]!.cost).toBe(120);
  expect((await f.db.query<{cost:number}>('select provider_actual_microusd cost from public.usage_accounts where owner_id=$1',[OWNER_B])).rows[0]!.cost).toBe(costBefore);
  expect((await f.db.query<{mode:string;original_step:{state:string;output:unknown};known_cost_microusd:number}>('select mode,original_step,known_cost_microusd from fluid_private.shared_identity_specification_cancellations where job_id=$1',[e.jobId])).rows[0]).toMatchObject({mode:'specifications_only',original_step:{state:'ambiguous',output:originalOutput},known_cost_microusd:120});
  expect((await f.db.query<{n:number}>('select count(*)::int n from fluid_private.shared_identity_calls where job_id=$1',[e.jobId])).rows).toEqual([{n:1}]);
 });

});
