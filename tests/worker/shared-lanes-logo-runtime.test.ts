import {qualifiedLogoGenerativeStorageCapability} from "../../worker/logo-generative-storage-authorization";
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {randomUUID,createHash} from 'node:crypto';
import {createSharedStorageFixture,SHARED_STORAGE_ACTOR,SHARED_STORAGE_SESSION,SHARED_STORAGE_ORIGIN,OWNER_A,type SharedStorageFixture} from '../database/shared-storage-fixture';
import {conceptCapability} from '../database/logo-generative-storage-fixture';
import {createSharedLogoLaneEngine} from '../../worker/shared-lanes/logo';
import {createSharedLogoStorageAuthorization} from '../../worker/shared-storage/authorization';
import {sharedPendingExecutionSchema} from '../../worker/shared-pool/contracts';
import {logoCostQuoteSchema,logoDispatchReceiptSchema} from '../../src/domain/logo-jobs';
import {OpenAIImageTransportError} from '../../src/server/logo-creation/openai-image-transport';
import type {IdentityAssetReservation} from '../../src/server/data/identity-asset-store';

let f:SharedStorageFixture;
beforeEach(async()=>{f=await createSharedStorageFixture();},60000);
afterEach(async()=>{await f?.close();});
function engine(options:{reservation?:IdentityAssetReservation;bytes?:Uint8Array}={}){
 const methods:string[]=[];
 const token=[{alg:'HS256',typ:'JWT'},f.claims(),'synthetic-signature'].map(v=>typeof v==='string'?v:Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
 const createImage=vi.fn(async():Promise<never>=>{throw new OpenAIImageTransportError('request_rejected','req_shared_fixture_rejected','a'.repeat(64),
  {input_tokens:0,output_tokens:0,input_tokens_details:{text_tokens:0,image_tokens:0}});});
 const runtime=createSharedLogoLaneEngine({database:{async query(sql,values){await f.db.exec(`set session authorization ${f.roleName}`);
  try{return await f.db.query<Record<string,unknown>>(sql,values);}finally{if(f.db.isInTransaction())await f.db.exec('rollback');await f.db.exec('set session authorization postgres');}}},slot:f.slot,deploymentId:'dpl_shared_storage_fixture',
  workerId:'synthetic-shared-logo',provider:{apiKey:'synthetic-never-live-key',model:conceptCapability.model!,modelVerificationReceipt:'synthetic-image-proof'},
  capabilities:[conceptCapability,{...conceptCapability,operation:'identity.logo_refine'}],storage:async(execution,capability)=>createSharedLogoStorageAuthorization({
   targetOrigin:SHARED_STORAGE_ORIGIN,publishableKey:'sb_publishable_synthetic_fixture',slot:f.slot,execution,capability:(()=>{const value=qualifiedLogoGenerativeStorageCapability(capability);if(!value)throw Error("Non-generative fixture capability");return value;})(),
   session:{authUserId:SHARED_STORAGE_ACTOR,sessionId:SHARED_STORAGE_SESSION,tokenProvider:async()=>token}},
   {fetch:async(incoming,init)=>{
    const url=new URL(String(incoming));methods.push(`${init?.method??'GET'} ${url.pathname}`);
    if(url.pathname==='/auth/v1/user')return Response.json({id:SHARED_STORAGE_ACTOR,is_anonymous:false,email_confirmed_at:'2026-10-01T00:00:00Z'});
    if(url.pathname==='/rest/v1/rpc/authorize_shared_logo_storage'){
     const body=JSON.parse(String(init?.body)) as {p_execution:string;p_reservation:string|null;p_mode:string};
     expect(body.p_execution).toBe(execution.executionId);
     return Response.json(await f.grant(execution,body.p_reservation?options.reservation??null:null,body.p_mode));
    }
    if(options.reservation&&url.pathname===`/storage/v1/object/fluid-assets/${options.reservation.storagePath}`){
     expect(init?.method).toBe('GET');expect(await f.get(options.reservation)).toHaveLength(1);
     return new Response(Buffer.from(options.bytes!),{headers:{'content-type':options.reservation.mimeType}});
    }
    throw Error('Unexpected synthetic Storage request');
   }})},{transport:{createImage}});
 return{runtime,createImage,methods};
}

describe('actual shared Logo engine and SQL with synthetic Auth/Storage/provider transports',()=>{
 it('claims an actual admitted job and runs the existing image handler once through native slot/probe authority',async()=>{
  const workspace=await f.project(),snapshot=(await f.db.query<{id:string}>('select reference_snapshot_id id from public.logo_stage_revisions where id=$1',[workspace.stages.brief_references!.id])).rows[0]!.id;
  const quote=await f.owner(OWNER_A,async()=>logoCostQuoteSchema.parse((await f.db.query<{value:unknown}>("select public.shared_logo_operation($1,'quote',$2) value",[workspace.projectId,{operation:'concepts',expected:workspace.heads,briefRevisionId:workspace.stages.brief_references!.id,referenceSnapshotId:snapshot}])).rows[0]!.value));
  const admitted=await f.owner(OWNER_A,async()=>logoDispatchReceiptSchema.parse((await f.db.query<{value:unknown}>("select public.shared_logo_operation($1,'admit',$2) value",[workspace.projectId,{requestKey:randomUUID(),quoteId:quote.id,expected:workspace.heads}])).rows[0]!.value));
  expect(admitted.jobIds.length).toBeGreaterThan(0);
  const test=engine();try{
   expect(await test.runtime.run()).toEqual({disposition:'ack',state:'failed'});expect(test.createImage).toHaveBeenCalledTimes(1);
   expect((await f.db.query("select state from public.jobs where id=any($1::uuid[]) and state='failed'",[admitted.jobIds])).rows).toHaveLength(1);
   expect((await f.db.query('select * from fluid_private.shared_worker_gateway_context')).rows).toEqual([]);
  }finally{await test.runtime.close();}
 });
 it('recovers only the bytes of a previously issued exact output, preserving an unknown provider outcome',async()=>{
  const p=await f.prepare();await f.grant(p.execution,p.reservation,'write');await f.put(p.reservation);
  const frozen=p.job.input as {slotId:string;attemptId:string};const step=`logo-preview-v1:${frozen.slotId}:${frozen.attemptId}`;
  await f.action(p.execution,'begin',[p.job.id,p.job.leaseToken,step,createHash('sha256').update(`${p.job.id}:${step}`).digest('hex'),p.job.reservedCostMicrousd]);
  // Inject a crash/unknown outcome into stored state; no provider result is
  // fabricated and no generative transport is invoked by recovery.
  await f.db.query("update public.jobs set state='needs_reconciliation',lease_token=null,lease_expires_at=null where id=$1",[p.job.id]);
  const pending={execution:p.execution,job:(await f.db.query<Record<string,unknown>>('select * from public.jobs where id=$1',[p.job.id])).rows[0]!,mode:'observe' as const};
  const row=sharedPendingExecutionSchema.parse(pending),test=engine({reservation:p.reservation,bytes:p.bytes});
  try{
   await expect(test.runtime.recover!([{...row,execution:{...row.execution,executionToken:randomUUID()}}])).rejects.toThrow();expect(test.methods).toHaveLength(0);
   expect(await test.runtime.recover!([row])).toEqual({disposition:'retry',state:'observation_retained'});
   expect(test.createImage).not.toHaveBeenCalled();expect(test.methods.some(m=>m.startsWith('GET /storage/'))).toBe(true);
   expect(test.methods.every(m=>!m.startsWith('POST /storage/'))).toBe(true);
   expect((await f.db.query('select state from public.jobs where id=$1',[p.job.id])).rows).toEqual([{state:'needs_reconciliation'}]);
   expect((await f.db.query('select state from public.job_steps where job_id=$1',[p.job.id])).rows).toEqual([{state:'in_flight'}]);
   expect((await f.db.query('select count(*)::int n from fluid_private.shared_logo_output_observations where execution_id=$1',[p.execution.executionId])).rows).toEqual([{n:1}]);
  }finally{await test.runtime.close();}
 });
});
