import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createSharedIdentityFixture, OWNER_A, OWNER_B, hash, type SharedIdentityFixture } from './shared-identity-generation-fixture';
import { syntheticPng } from '../features/logo-vector/raster-fixtures';
import { identityBatchStateSchema, logoBoardAvailabilitySchema, identityGenerationJobInputSchema, type IdentitySystemSpecification } from '../../src/domain/identity-jobs';
import { sharedExecutionSchema } from '../../worker/shared-pool/contracts';
import { parseClaimedJob } from '../../worker/postgres-store';
import { specification } from '../worker/identity-generation-fixture';
import { createIdentityTransactionService, type IdentityConnectionFactory } from '../../src/server/data/identity-transaction';
import { sharedHttpRoles } from './shared-account-fixture';
import { getProjectIdentity } from '../../src/server/data/identity';
import { identityDalAuth } from './identity-system-database';
import { logoWorkspaceV2Schema } from '../../src/domain/logo-workspace';
import { qualifySharedHttpConnection } from '../../src/server/shared-account/qualification';

describe('selected-logo boards: actual SQL admission, storage and immutable publication', () => {
 let f: SharedIdentityFixture;let historical:Awaited<ReturnType<SharedIdentityFixture['admit']>>;
 beforeAll(async () => {
  f = await createSharedIdentityFixture();
  historical=await f.admit(await f.project(OWNER_B));await f.system(historical,1);
  await f.rpc(historical.owner,'cancel_shared_identity_batch',[historical.projectId,historical.batch.batchId]);
  await f.action('finish',[historical.job.id,historical.job.leaseToken,'cancelled'],historical.execution);
  await f.db.exec('create role fixture_board_default_acl nologin;alter default privileges grant all on tables to fixture_board_default_acl;alter default privileges grant all on functions to fixture_board_default_acl');
  await f.db.exec(await readFile(new URL('../../supabase/candidates/shared_identity_selected_logo_boards.sql', import.meta.url), 'utf8'));
  await f.db.exec(await readFile(new URL('../../supabase/candidates/shared_identity_http_writer_permissions.sql', import.meta.url), 'utf8'));
  await f.db.exec('alter default privileges revoke all on tables from fixture_board_default_acl;alter default privileges revoke all on functions from fixture_board_default_acl');
 }, 60_000);
 afterAll(async () => { await f?.db.close(); });
 async function logo(p: {owner:string;projectId:string}, n = 1) {
  const owner=p.owner, project=p.projectId, id=randomUUID(), aid=randomUUID(), vid=randomUUID(), pub=randomUUID(), job=randomUUID(), provider=randomUUID(), batch=randomUUID(), slot=randomUUID(), attempt=randomUUID();
  const bytes=syntheticPng(8,8,(x,y)=>[x*20,y*20,n*30,255]), digest=hash(bytes), path=`${owner}/${project}/${aid}/${vid}`;
  const existing=logoWorkspaceV2Schema.parse(await f.rpc(owner,'get_logo_workspace',[project]));
  let briefId=existing.stages.brief_references?.id;
  if(!briefId){
   const snapshot={version:2,id,ownerId:owner,projectId:project,revision:1,references:[]};
   await f.db.query('insert into public.logo_reference_snapshots(id,project_id,owner_id,revision,snapshot) values($1,$2,$3,1,$4)',[id,project,owner,JSON.stringify(snapshot)]);
   const brief=(await f.db.query<{value:{id:string}}>("select fluid_private.logo_append_brief($1,$2,$3,$4,'[]') value",[owner,project,JSON.stringify({name:'Fixture',activity:'Synthetic company',audience:'Founders',personality:'Calm',logoTypes:['wordmark']}),id])).rows[0]!.value;
   briefId=brief.id;
  }
  const brief=(await f.db.query<{record:{id:string;revision:number;payload:{referenceSnapshotId:string}}}>('select record from public.logo_stage_revisions where id=$1',[briefId])).rows[0]!.record;
  const inputs=[{stage:'brief_references',id:brief.id,revision:brief.revision}];
  // Explicit synthetic accepted logo; subsequent authorization/publication runs real SQL.
  await f.db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd) values($1,$2,$3,'identity.logo_concept',1,$4,'{}',$5,'succeeded',0)",[job,owner,project,'a'.repeat(64),randomUUID()]);
  await f.db.query("insert into public.assets(id,owner_id,project_id,kind,purpose) values($1,$2,$3,'Synthetic selected logo','brand_asset')",[aid,owner,project]);
  await f.db.query("insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,storage_path,provenance) values($1,$2,$3,$4,1,1,$5,$6,'image/png',$7,$8)",[vid,owner,project,aid,'a'.repeat(64),digest,path,JSON.stringify({publicationId:pub})]);
  const verification={status:'verified',checkedAt:new Date().toISOString(),contentHash:digest,mimeType:'image/png',byteLength:bytes.length};
  await f.db.query("insert into public.logo_asset_publications(id,owner_id,project_id,request_key,request,asset_id,version_id,content_hash,mime_type,byte_length,purpose,source_receipt_id,source_kind,state,verification,input_revision,input_hash) values($1,$2,$3,$4,'{}',$5,$6,$7,'image/png',$8,'brand_asset',$4,'concept','committed',$9,1,$10)",[pub,owner,project,attempt,aid,vid,digest,bytes.length,JSON.stringify(verification),'a'.repeat(64)]);
  const preview=(await f.db.query<{value:unknown}>('select fluid_private.logo_asset_receipt(r) value from public.logo_asset_publications r where id=$1',[pub])).rows[0]!.value;
  await f.db.query("insert into public.logo_provider_responses(id,owner_id,project_id,job_id,lease_token,observation) values($1,$2,$3,$4,$5,'{}')",[provider,owner,project,job,randomUUID()]);
  await f.db.query('insert into public.logo_raster_results values($1,$2,$3,$4,$5)',[job,owner,project,JSON.stringify(preview),provider]);
  await f.db.query("insert into public.logo_concept_batches(id,owner_id,project_id,request_key,brief_revision_id,reference_snapshot_id,plan,input_revisions) values($1,$2,$3,$4,$5,$6,fluid_private.logo_plan('[\"wordmark\"]',0),$7)",[batch,owner,project,randomUUID(),brief.id,brief.payload.referenceSnapshotId,JSON.stringify(inputs)]);
  await f.db.query("insert into public.logo_concept_slots values($1,$2,$3,$4,0,'wordmark','open_geometry')",[slot,batch,owner,project]);
  await f.db.query("insert into public.logo_concept_attempts(id,owner_id,project_id,slot_id,job_id,request_key,attempt_number,input_hash) values($1,$2,$3,$4,$5,$6,1,$7)",[attempt,owner,project,slot,job,randomUUID(),'a'.repeat(64)]);
  const source={kind:'concept',batchId:batch,slotId:slot,attemptId:attempt};
  await f.db.query("select fluid_private.logo_append_stage($1,$2,'concepts',$3,$4)",[owner,project,JSON.stringify({batchIds:[batch],selected:source}),JSON.stringify(inputs)]);
  return{source,preview,pub};
 }
 async function ready(p: {owner:string;projectId:string}) {
  const availability=logoBoardAvailabilitySchema.parse(await f.rpc(p.owner,'get_shared_identity_availability',[p.projectId]));
  return{availability,intent:{version:3 as const,spendControl:'uncapped' as const,sourceLogo:availability.sourceLogo.source,expectedLogoRevision:availability.expectedLogoRevision,
   expectedProjectRevision:availability.expectedProjectRevision,expectedReferenceRevision:availability.expectedReferenceRevision,expectedPreferencesRevision:availability.expectedPreferencesRevision,
   expectedIdentityRevision:availability.expectedIdentityRevision,idempotencyKey:`board-${randomUUID()}`,acceptedPolicyIdentity:availability.policyIdentity}};
 }
 function boardSpecification(n:number):IdentitySystemSpecification {
  const value=specification(n);value.components.colors.swatches.push({key:'background',name:'Background',hex:'#FFFFFF'},{key:'text',name:'Text',hex:'#111111'});
  value.components.typography.styles[0]!.family=['Lora','Manrope','Fraunces'][n-1]!;
  return {...value,applicationDesign:{version:1,graphic:['rounded_shapes','fine_lines','bold_blocks'][n-1] as 'rounded_shapes'|'fine_lines'|'bold_blocks',layout:['editorial','centered','split'][n-1] as 'editorial'|'centered'|'split',paletteRoles:{primary:'primary',accent:'primary',background:'background',text:'text'},headingStyleKey:'body',bodyStyleKey:'body'}};
 }
 async function admit(p:{owner:string;projectId:string}) {
  const {availability,intent}=await ready(p),batch=identityBatchStateSchema.parse(await f.rpc(p.owner,'ensure_shared_identity_batch',[p.projectId,intent]));
  const claimed=await f.action('claim',['selected-logo-fixture',120]),execution=sharedExecutionSchema.parse(claimed.execution),job=parseClaimedJob((claimed.result as unknown[])[0]);
  return{...p,availability,intent,batch,execution,job,input:identityGenerationJobInputSchema.parse(job.input)};
 }
 async function selectSystem(p:{owner:string;projectId:string},systemVersionId:string,identityRevision=0) {
  const {availability}=await ready(p),request={systemVersionId,expectedProjectRevision:availability.expectedProjectRevision,expectedReferenceRevision:availability.expectedReferenceRevision,expectedPreferencesRevision:availability.expectedPreferencesRevision,expectedIdentityRevision:identityRevision,acceptEarlierBasis:false};
  const token=await f.issue(p.owner,'identity','identity',[p.projectId,request,false]),role=sharedHttpRoles.identity;
  const oid=(await f.db.query<{oid:number}>('select oid::int oid from pg_roles where rolname=$1',[role])).rows[0]!.oid;
  const factory:IdentityConnectionFactory={async acquire(){return{binding:{ownerId:p.owner,roleName:role,roleOid:oid},connection:{
   async query(sql,parameters=[]){
    if(sql.includes("set_config('request.jwt.claim.sub'"))return{rows:[]};
    if(sql.includes('prepare_identity_transaction'))return f.db.query('select public.prepare_shared_identity_request($1,$2,$3,$4) value',[token.token,...parameters]);
    if(sql.includes('commit_identity_transaction'))return f.db.query('select public.commit_shared_identity_request($1,$2,$3) value',[...parameters]);
    if(sql==='COMMIT')await f.db.query('select public.finish_shared_identity_request()');
    return f.db.query(sql,[...parameters]);
   },release(){},discard(){}}};}};
  return f.asSession(role,async()=>{
   // Exercise the same deployed web gate before the real selection transaction.
   // Direct transaction-only tests missed stale helper hashes after packet 15.
   await qualifySharedHttpConnection({query:(sql,args)=>f.db.query(sql,[...(args??[])]),release(){},discard(){}},'identity',
    {roleName:role,roleOid:oid,host:'inert',port:5432,tls:true,user:role,password:'inert'},'https://fricsfwqibyhemknqgyf.supabase.co');
   return createIdentityTransactionService(factory).select({userId:p.owner},p.projectId,request);
  });
 }
 it('admits the exact selected raster without a vector, fonts or supplementary references; replays its same intent',async()=>{
  const p=await f.project(OWNER_A,false);await logo(p);
  const {availability,intent}=await ready(p);expect(availability.estimatedCostMicrousd).toBeNull();
  const batch=identityBatchStateSchema.parse(await f.rpc(p.owner,'ensure_shared_identity_batch',[p.projectId,intent]));
  expect(batch).toMatchObject({sourceLogo:availability.sourceLogo,sourceLogoCurrent:true,usage:{status:'pending',knownCostMicrousd:0}});
  expect(batch.input.referenceSnapshot.selected).toHaveLength(0);
  expect(await f.rpc(p.owner,'ensure_shared_identity_batch',[p.projectId,intent])).toEqual(batch);
  await expect(f.rpc(OWNER_B,'get_shared_identity_batch',[p.projectId,batch.batchId,null])).rejects.toThrow(/project_missing/);
  await f.rpc(p.owner,'cancel_shared_identity_batch',[p.projectId,batch.batchId]);
 });
 it('rejects missing logos and changed selection heads before creating a provider job',async()=>{
  const p=await f.project(OWNER_B,false);
  expect(await f.rpc(p.owner,'get_shared_identity_availability',[p.projectId])).toMatchObject({status:'unavailable',reason:'logo_selection_required'});
  await logo(p);const {intent}=await ready(p);await logo(p,2);
  await expect(f.rpc(p.owner,'ensure_shared_identity_batch',[p.projectId,intent])).rejects.toThrow(/logo_selection_conflict/);
  expect((await f.db.query<{n:number}>("select count(*)::int n from public.jobs where project_id=$1 and operation='identity.image'",[p.projectId])).rows[0]!.n).toBe(0);
 });
 it('uses the real standalone saved brief, publishes three distinct boards, selects one, and rejects a changed logo while allowing exact restoration',async()=>{
  const workspace=await f.start(OWNER_A),p={owner:OWNER_A,projectId:workspace.projectId};
  const original=await logo(p),started=await admit(p);
  expect(started.input.input).toMatchObject({version:2,context:{description:'',selectedName:null},logoBrief:{payload:{name:'Shared test',activity:'Studio',audience:'Founders'}},basis:{version:2,name:'Shared test'}});
  expect(started.input.input.context.intake.suppliedName).toBe('');
  // The saved logo is the first leased private image; another project's publication is denied.
  expect(await f.grant(started.execution,started.availability.sourceLogo.preview,'read')).toMatchObject({member:'base'});
  const foreign=await f.project(OWNER_B,false);const other=await logo(foreign);
  await expect(f.grant(started.execution,{id:other.pub},'read')).rejects.toThrow();
  for(let n=1;n<=3;n++)await f.system(started,n,true,boardSpecification(n));
  await f.action('finish',[started.job.id,started.job.leaseToken,'succeeded'],started.execution);
  const batch=identityBatchStateSchema.parse(await f.rpc(p.owner,'get_shared_identity_batch',[p.projectId,started.batch.batchId,null]));
  expect(batch).toMatchObject({status:'succeeded',sourceLogoCurrent:true,usage:{status:'recorded',knownCostMicrousd:1410},fulfillment:{acceptedCount:3,status:'complete'}});
  expect(new Set(batch.systems.map(s=>s.board.asset.contentHash)).size).toBe(3);
  expect(batch.systems.map(s=>s.applicationDesign?.layout)).toEqual(['editorial','centered','split']);
  expect((await ready(p)).availability.estimatedCostMicrousd).toBe(1410);
  const selected=await selectSystem(p,batch.systems[0]!.id);
  expect(selected.currentSelection.freshness).toEqual({status:'current',changed:[]});
  expect(selected.currentSelection.system.applicationDesign).toEqual(boardSpecification(1).applicationDesign);
  const overview=await getProjectIdentity(identityDalAuth(f.db,p.owner),p.projectId);
  expect(overview.currentBasis).toMatchObject({status:'available',basis:{version:2,name:'Shared test'}});
  expect(overview.logoBrief).toEqual(started.availability.sourceLogo.brief);
  await logo(p,2);
  expect(await f.rpc(p.owner,'get_identity_logo_source',[p.projectId,batch.systems[0]!.id])).toMatchObject({sourceLogoCurrent:false});
  await expect(selectSystem(p,batch.systems[1]!.id,1)).rejects.toMatchObject({code:'conflict'});
  const brief=started.availability.sourceLogo.brief;
  await f.db.query("select fluid_private.logo_append_stage($1,$2,'concepts',$3,$4)",[p.owner,p.projectId,JSON.stringify({batchIds:[original.source.batchId],selected:original.source}),JSON.stringify([{stage:'brief_references',id:brief.id,revision:brief.revision}])]);
  const restored=identityBatchStateSchema.parse(await f.rpc(p.owner,'get_shared_identity_batch',[p.projectId,batch.batchId,null]));
  expect(restored.sourceLogoCurrent).toBe(true);
  expect(restored.sourceLogo?.selectionRevision).toBe(started.availability.expectedLogoRevision);
  expect((await ready(p)).availability.expectedLogoRevision).toBeGreaterThan(started.availability.expectedLogoRevision);
  expect((await selectSystem(p,batch.systems[1]!.id,1)).currentSelection.selection.identityRevision).toBe(2);
 });

 it('strips hostile default ACLs and keeps new private metadata owner-only',async()=>{
  expect((await f.db.query<{allowed:boolean}>("select has_table_privilege('fixture_board_default_acl','fluid_private.identity_system_applications','SELECT') allowed")).rows[0]!.allowed).toBe(false);
  for(const name of ['fluid_private.shared_identity_logo_source_valid(uuid,uuid,jsonb)','fluid_private.identity_current_logo_brief(uuid,uuid)','fluid_private.identity_job_logo_brief(uuid,uuid,uuid)','fluid_private.identity_board_contrast_ratio(text,text)','public.get_identity_logo_source(uuid,uuid)']){
   expect((await f.db.query<{allowed:boolean}>("select has_function_privilege('fixture_board_default_acl',$1,'EXECUTE') allowed",[name])).rows[0]!.allowed).toBe(false);
  }
  await expect(f.asAuth(OWNER_B,()=>f.db.query('select * from fluid_private.identity_system_applications'))).rejects.toThrow();
 });
 it('retains the selected logo across expansion and retitling with equal context, while real content changes still block new boards',async()=>{
  const workspace=await f.start(OWNER_A),p={owner:OWNER_A,projectId:workspace.projectId};await logo(p);
  const original=(await ready(p)).availability;
  const saved=(await f.db.query<{context:Record<string,unknown>;input_hash:string}>('select context,input_hash from public.project_revisions where owner_id=$1 and project_id=$2 and revision=1',[p.owner,p.projectId])).rows[0]!;
  const stages=(await f.db.query('select id,record from public.logo_stage_revisions where owner_id=$1 and project_id=$2 order by stage,revision',[p.owner,p.projectId])).rows;
  await f.rpc(p.owner,'expand_project_scope',[p.projectId,1]);
  const expanded=await ready(p);
  expect(expanded.availability).toMatchObject({status:'available',expectedProjectRevision:2,sourceLogo:original.sourceLogo});
  const batch=identityBatchStateSchema.parse(await f.rpc(p.owner,'ensure_shared_identity_batch',[p.projectId,expanded.intent]));
  expect(batch.input).toMatchObject({version:2,scope:'complete_brand',projectRevision:2,context:saved.context});
  expect(batch.sourceLogo).toEqual(original.sourceLogo);
  expect(batch.sourceLogo?.brief.payload.sourceProjectRevision).toBe(1);
  await f.rpc(p.owner,'cancel_shared_identity_batch',[p.projectId,batch.batchId]);
  await f.rpc(p.owner,'append_project_revision',[p.projectId,2,saved.context,saved.input_hash,'Retitled fixture']);
  expect((await ready(p)).availability).toMatchObject({status:'available',expectedProjectRevision:3,sourceLogo:original.sourceLogo});
  const changed={...saved.context,description:'The actual saved product idea changed'};
  await f.rpc(p.owner,'append_project_revision',[p.projectId,3,changed,hash(JSON.stringify(changed)),null]);
  expect(await f.rpc(p.owner,'get_shared_identity_availability',[p.projectId])).toMatchObject({status:'unavailable',reason:'logo_needs_review'});
  expect((await f.db.query('select id,record from public.logo_stage_revisions where owner_id=$1 and project_id=$2 order by stage,revision',[p.owner,p.projectId])).rows).toEqual(stages);
 });
 it('retains exact historical v2 batches and v1 inputs after the forward packet',async()=>{
  const batch=identityBatchStateSchema.parse(await f.rpc(historical.owner,'ensure_shared_identity_batch',[historical.projectId,historical.intent]));
  expect(batch.intent).toEqual(historical.intent);expect(batch.input.version).toBe(1);expect(batch.systems).toHaveLength(1);expect(batch.sourceLogo).toBeUndefined();
 });
 it('recovers the exact prepared v3 board after takeover without new paid calls, and retains its application design',async()=>{
  const p=await f.project(OWNER_B,false);await logo(p);const started=await admit(p),prepared=await f.system(started,1,false,boardSpecification(1));
  const before=(await f.db.query('select * from fluid_private.shared_identity_calls where job_id=$1 order by id',[started.job.id])).rows;
  await f.takeover('dpl_selected_logo_recovery');
  expect((await f.action('recovery',[],started.execution)).result).toMatchObject({remaining:false});
  await f.grant(started.execution,prepared.reservation,'observe');
  await f.action('observe_recovered_asset',[started.job.leaseToken,prepared.reservation.id,prepared.verification],started.execution);
  await f.action('finish_known',[],started.execution);
  const batch=identityBatchStateSchema.parse(await f.rpc(p.owner,'get_shared_identity_batch',[p.projectId,started.batch.batchId,null]));
  expect(batch.systems).toHaveLength(1);expect(batch.systems[0]!.applicationDesign).toEqual(boardSpecification(1).applicationDesign);
  expect((await f.db.query('select * from fluid_private.shared_identity_calls where job_id=$1 order by id',[started.job.id])).rows).toEqual(before);
  await f.rpc(p.owner,'cancel_shared_identity_batch',[p.projectId,batch.batchId]);await f.action('finish_known',[],started.execution);
 });
 it('preserves a completed direction and unknown usage when a later authorized call loses its outcome',async()=>{
  const p=await f.project(OWNER_A,false);await logo(p);const started=await admit(p),e=started.execution;await f.system(started,1,true,boardSpecification(1));
  const key='identity-system-v1:2',requestKey=hash('selected-uncertain-key'),requestHash=hash('selected-uncertain-body');
  await f.action('begin',[e.jobId,e.leaseToken,key,hash('selected-uncertain-step'),0],e);
  await f.action('identity_authorize',[e.jobId,e.leaseToken,key,'specifications',requestKey,requestHash],e);
  expect((await f.action('identity_authorize',[e.jobId,e.leaseToken,key,'specifications',requestKey,requestHash],e)).result).toMatchObject({disposition:'already_issued'});
  await f.action('complete',[e.jobId,e.leaseToken,key,'ambiguous',0,{error:'provider_outcome_unknown'},null],e);
  const closed=await f.rpc(p.owner,'close_shared_identity_generation_intent',[p.projectId,started.intent]);
  expect(closed).toMatchObject({status:'admitted',batch:{status:'needs_reconciliation',terminal:false,usage:{status:'unknown',knownCostMicrousd:470},fulfillment:{acceptedCount:1,status:'partial'}}});
  await expect(f.action('identity_authorize',[e.jobId,e.leaseToken,key,'specifications',requestKey,requestHash],e)).rejects.toThrow();
  expect((await f.db.query<{n:number}>('select count(*)::int n from fluid_private.shared_identity_calls where job_id=$1',[e.jobId])).rows[0]!.n).toBe(3);
 });

});
