import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {applySharedImageModel} from './shared-image-model-fixture';
import {createSharedLogoFixture} from './shared-account-logo-fixture';
import {OWNER_A,OWNER_B} from './local-supabase';
import {capability,specification,textPolicy} from '../fixtures/identity-generation';
import {syntheticPng} from '../features/logo-vector/raster-fixtures';
import {parseClaimedJob,sharedExecutionSchema,sharedSlotLeaseSchema,type SharedExecution} from '../fixtures/shared-worker-contracts';
import {identityBatchStateSchema,identityGenerationJobInputSchema,type IdentityGenerationObservation,type IdentitySystemSpecification} from '../../src/domain/identity-jobs';
import {logoWorkspaceV2Schema} from '../../src/domain/logo-workspace';
import {identityReferenceEntrySchema} from '../../src/domain/identity-references';
import type {IdentityAssetReservation} from '../../src/server/data/identity-asset-store';
import { reviewedStrategy } from "../fixtures/reviewed-strategy";
export {OWNER_A,OWNER_B,capability};
export const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
/** Real SQL/RLS, synthetic Auth sessions/provider observations and local PNG
 * bytes. No network, credentials, persistent roles or paid provider calls. */
export async function createSharedIdentityFixture(){
 const f=await createSharedLogoFixture(),{db}=f;
 try{
  await db.exec(await readFile(new URL('../../supabase/candidates/shared_logo_advanced.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../supabase/candidates/shared_identity_generation.sql',import.meta.url),'utf8'));
  await applySharedImageModel(db);
  const role='embel_shared_logo_identity_fixture',slotId=randomUUID(),actor=randomUUID(),actorSession=randomUUID();let deployment='dpl_identity_synthetic';
  await db.exec(`create role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4;
   grant usage on schema public to ${role};grant execute on function public.shared_logo_worker_action(jsonb,jsonb,text,jsonb),public.claim_shared_worker_slot(uuid,uuid,text,integer),public.renew_shared_worker_slot(jsonb,integer),public.fence_shared_worker_slot(jsonb) to ${role};`);
  await db.query("insert into fluid_private.shared_worker_slots(slot_id,lane,slot_index,role_name,role_oid,deployment_id,enabled) select $1,'logo',1,rolname,oid,$2,true from pg_roles where rolname=$3",[slotId,deployment,role]);
  await db.query('insert into fluid_private.shared_worker_policies values($1,$2,$3,$4)',[slotId,capability.operation,capability.policyIdentity,capability]);
  await db.query("insert into fluid_private.shared_service_actors values($1,'logo_storage')",[actor]);
  await db.query('insert into auth.users(id,email_confirmed_at,is_anonymous) values($1,clock_timestamp(),false)',[actor]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[actorSession,actor]);f.sessions[actor]=actorSession;
  await db.query('insert into fluid_private.shared_storage_target values(true,$1)',[new URL((await db.query<{origin:string}>('select origin from fluid_private.shared_http_target')).rows[0]!.origin).origin]);
  await db.query('insert into fluid_private.shared_storage_actors(auth_user_id,slot_id,enabled) values($1,$2,true)',[actor,slotId]);
  let lease=sharedSlotLeaseSchema.parse(await f.asSession(role,async()=>(await db.query<{value:unknown}>('select public.claim_shared_worker_slot($1,$2,$3,120) value',[slotId,randomUUID(),deployment])).rows[0]!.value));
  await f.asAuth(actor,()=>db.query('select public.shared_logo_storage_session()'));
  async function action(name:string,args:unknown[],execution:SharedExecution|null=null,captured=lease){
   return f.asSession(role,async()=>(await db.query<{value:{execution:unknown;result:unknown}}>('select public.shared_logo_worker_action($1,$2,$3,$4) value',[captured,execution,name,JSON.stringify(args)])).rows[0]!.value);
  }
  const ready=()=>action('runtime_ready',[[capability]]);await ready();
  async function rpc<T=unknown>(owner:string,name:string,args:unknown[]){if(!/^[a-z_]+$/.test(name))throw Error('Invalid fixture RPC');return f.asAuth(owner,async()=>(await db.query<{value:T}>(`select to_jsonb(public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')})) value`,args.map(x=>x&&typeof x==='object'?JSON.stringify(x):x))).rows[0]!.value);}
  async function upload(project:string,owner=OWNER_A,index=1,suppliedBytes?:Uint8Array){
   const workspace=logoWorkspaceV2Schema.parse(await rpc(owner,'get_logo_workspace',[project]));
   const key=randomUUID(),bytes=suppliedBytes??syntheticPng(8,8,(x,y)=>[x*20,y*20,110+index,255]);
   const rights='Synthetic local fixture; user supplied with no license verification';
   const request={kind:'reference_upload',input:{requestKey:key,expected:workspace.heads,aspects:['overall_feel'],rightsDeclaration:rights},file:{contentHash:hash(bytes),mimeType:'image/png',byteLength:bytes.byteLength}};
   await rpc(owner,'prepare_shared_identity_reference_upload',[project,request]);
   await f.executeLogo(owner,'input_prepare',project,request);
   const reservation=await f.executeLogo(owner,'asset_prepare',project,{kind:'upload',intent:{requestKey:key,usage:'logo_reference',mimeType:'image/png',contentHash:hash(bytes),rightsDeclaration:rights},byteLength:bytes.byteLength}) as IdentityAssetReservation;
   const verification={status:'verified',checkedAt:new Date().toISOString(),contentHash:hash(bytes),mimeType:'image/png',byteLength:bytes.byteLength};
   const receipt=await f.executeLogo(owner,'asset_readback',project,reservation.id,verification);
   await f.executeLogo(owner,'input_commit',project,request,{receipt,evidence:null});
   const metadata={attribution:{label:'Synthetic owned reference',creator:null,sourceUrl:null,rightsNote:rights},relevantElements:['colors'],tags:[]};
   const entry=identityReferenceEntrySchema.parse(await rpc(owner,'register_shared_identity_reference',[project,key,metadata]));
   return {key,metadata,entry,reservation,bytes,request,receipt};
  }
  async function project(owner=OWNER_A,select=true){
   const created=await rpc<{id:string}>(owner,'create_project',['complete_brand','Synthetic Identity',reviewedStrategy({description:'Clearly synthetic Identity SQL brief',selectedName:'Fixture',intake:{suppliedName:'Fixture'}}),'a'.repeat(64)]),p=created.id,source=await upload(p,owner);
   if(select)await rpc(owner,'set_identity_reference_reaction',[p,source.entry.reference.id,{expectedRevision:0,ensemble:true,elements:[]}]);
   return {projectId:p,source,owner};
  }
  function intent(key=`synthetic-identity-${randomUUID()}`){return{version:2,spendControl:'uncapped',expectedProjectRevision:1,expectedReferenceRevision:1,expectedPreferencesRevision:0,expectedIdentityRevision:0,idempotencyKey:key,acceptedPolicyIdentity:capability.policyIdentity};}
  async function admit(p:Awaited<ReturnType<typeof project>>,value=intent()){
   const batch=identityBatchStateSchema.parse(await rpc(p.owner,'ensure_shared_identity_batch',[p.projectId,value]));
   const claimed=await action('claim',['synthetic-identity',120]),execution=sharedExecutionSchema.parse(claimed.execution),job=parseClaimedJob((claimed.result as unknown[])[0]);
   const input=identityGenerationJobInputSchema.parse(job.input);if(job.ownerId!==p.owner||job.projectId!==p.projectId||input.batchId!==batch.batchId)throw Error('Foreign synthetic claim');
   return{...p,batch,job,input,execution,intent:value};
  }
  async function grant(e:SharedExecution,reservation:{id:string}|null,mode:string){return f.asAuth(actor,async()=>(await db.query<{value:unknown}>('select public.authorize_shared_logo_storage($1,$2,$3,$4,$5,$6) value',[e.executionId,e.executionToken,e.jobId,e.leaseToken,reservation?.id??null,mode])).rows[0]!.value);}
  async function system(p:Pick<Awaited<ReturnType<typeof admit>>,'owner'|'projectId'|'execution'|'input'|'batch'>,ordinal=1,complete=true,suppliedSpecification?:IdentitySystemSpecification){
   const e=p.execution,key=`identity-system-v1:${ordinal}`;const spec:IdentitySystemSpecification=suppliedSpecification??specification(ordinal);
   await action('begin',[e.jobId,e.leaseToken,key,hash(`${e.jobId}:${key}`),0],e);
   const requestKey=hash(`${e.jobId}:${key}:spec`),requestHash=hash(JSON.stringify(spec));
   const call=(await action('identity_authorize',[e.jobId,e.leaseToken,key,'specifications',requestKey,requestHash],e)).result as {callId:string;disposition:string};
   const text:IdentityGenerationObservation={version:1,phase:'specifications',provider:'openai',model:textPolicy.model,requestKey,requestHash,responseId:`resp_synthetic_${ordinal}`,providerRequestId:null,responseHash:hash('synthetic-response-'+ordinal),observedAt:new Date().toISOString(),responseComplete:true,serviceTier:'default',usage:{inputTokens:10,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:10},billing:{status:'recorded',confirmedMicrousd:120},specification:spec,artifactHash:null};
   const t=(await action('identity_receipt',[e.jobId,e.leaseToken,call.callId,text],e)).result as {id:string};
   const bytes=syntheticPng(8,8,(x,y)=>[x*20,y*20,ordinal*60,255]);
   const imageKey=hash(`${e.jobId}:${key}:board`),imageHash=hash(`synthetic-board-body-${ordinal}`);
   const imageCall=(await action('identity_authorize',[e.jobId,e.leaseToken,key,'board',imageKey,imageHash],e)).result as {callId:string};
   const image:IdentityGenerationObservation={...text,phase:'board',requestKey:imageKey,requestHash:imageHash,model:capability.model,serviceTier:'standard',responseId:null,providerRequestId:`req_image_${ordinal}`,usage:{input_tokens:10,output_tokens:10,input_tokens_details:{text_tokens:10,image_tokens:0}},billing:{status:'recorded',confirmedMicrousd:350},specification:null,artifactHash:hash(bytes)};
   const i=(await action('identity_receipt',[e.jobId,e.leaseToken,imageCall.callId,image],e)).result as {id:string};
   const systemId=p.input.systemIds[ordinal-1]!,publication={requestKey:systemId,inputRevisions:[],source:{kind:'identity_system',sourceId:systemId},mimeType:'image/png',contentHash:hash(bytes),byteLength:bytes.byteLength};
   const reservation=(await action('prepare_asset',[e.projectId,{kind:'stage',publication},e.jobId,e.leaseToken],e)).result as IdentityAssetReservation;
   await grant(e,reservation,'write');
   await db.query("select set_config('storage.operation','object.upload',false)");
   await f.asAuth(actor,()=>db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)",[reservation.storagePath,actor]));
   await grant(e,reservation,'observe');
   await db.query("select set_config('storage.operation','object.get_authenticated',false)");
   const readback=await f.asAuth(actor,()=>db.query('select name from storage.objects where name=$1',[reservation.storagePath]));if(readback.rows.length!==1)throw Error('Owned board readback denied');
   const verification={status:'verified',checkedAt:new Date().toISOString(),contentHash:hash(bytes),mimeType:'image/png',byteLength:bytes.byteLength};
   await action('observe_asset',[reservation.id,verification,e.jobId,e.leaseToken],e);
   const output={identity:{version:1,operation:'identity.image',ownerId:p.owner,projectId:p.projectId,batchId:p.batch.batchId,jobId:e.jobId,stepKey:key,targetCount:3,input:p.input.input,systems:[{id:systemId,ownerId:p.owner,projectId:p.projectId,createdAt:new Date().toISOString(),input:p.input.input,source:{kind:'generated',batchId:p.batch.batchId,jobId:e.jobId,stepKey:key},components:spec.components,...(spec.applicationDesign?{applicationDesign:spec.applicationDesign}:{}),board:{asset:{...reservation.reference,purpose:'brand_asset',mimeType:'image/png'},depictsSystemVersionId:systemId,staleComponents:[]},productionFiles:[]}]}};
   const evidence={textReceiptId:t.id,imageReceiptId:i.id,publicationId:reservation.id};
   await action('identity_stage',[e.jobId,e.leaseToken,key,output,evidence],e);
   if(complete)await action('complete',[e.jobId,e.leaseToken,key,'succeeded',470,output,image.providerRequestId],e);
   return{key,output,evidence,reservation,publication,verification,text,image,cost:470};
  }
  return{...f,capability,role,slotId,actor,action,rpc,project,upload,intent,admit,system,grant,ready,slot:()=>lease,
   async takeover(nextDeployment?:string){if(nextDeployment){deployment=nextDeployment;await db.query('update fluid_private.shared_worker_slots set deployment_id=$1 where slot_id=$2',[deployment,slotId]);}await db.query("update fluid_private.shared_worker_slots set expires_at=clock_timestamp()-interval '1 second' where slot_id=$1",[slotId]);lease=sharedSlotLeaseSchema.parse(await f.asSession(role,async()=>(await db.query<{value:unknown}>('select public.claim_shared_worker_slot($1,$2,$3,120) value',[slotId,randomUUID(),deployment])).rows[0]!.value));await f.asAuth(actor,()=>db.query('select public.shared_logo_storage_session()'));await ready();return lease;}};
 }catch(error){await f.db.close();throw error;}
}
export type SharedIdentityFixture=Awaited<ReturnType<typeof createSharedIdentityFixture>>;
