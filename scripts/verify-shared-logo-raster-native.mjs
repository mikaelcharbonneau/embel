import {randomUUID} from 'node:crypto';

/** A complete brand with its first Logo brief saved, made the way the app
 * makes it: create the project, open its Logo workspace, then save the brief.
 * Logo-only projects can no longer be started (November 9, 2026). */
export function startNativeLogoProject({quote,asVerifiedSession},session,{requestKey=randomUUID(),brief}){
 const project=asVerifiedSession(session,`to_jsonb(public.create_project('complete_brand',${quote(brief.name)},${quote(JSON.stringify({description:'Synthetic native Logo fixture'}))}::jsonb,${quote('a'.repeat(64))}))`);
 const opened=asVerifiedSession(session,`public.get_logo_workspace(${quote(project.id)})`);
 const receipt=asVerifiedSession(session,`public.initialize_existing_brand_logo(${quote(project.id)},${quote(JSON.stringify({requestKey,expected:opened.heads,brief}))}::jsonb)`);
 if(!receipt?.workspace||receipt.workspace.projectId!==project.id)throw new Error('native-logo-fixture-brief-not-saved');
 return receipt.workspace;
}

/** Called only by verify-shared-worker-native against its network-disabled,
 * disposable PG17 container. Auth, Storage metadata and provider evidence are
 * synthetic; admission, restricted LOGINs, RLS, receipts and settlement are real SQL. */
export function verifySharedLogoRaster({sql,rpc,quote,assert,checkDenied,asVerifiedSession,asVerifiedStatement,sessions,origin}){
 const role='embel_shared_logo_native_raster',slotId=randomUUID(),actor=randomUUID(),session={owner:actor,id:randomUUID()},deployment='native-uncapped-raster-fixture';
 const capability={operation:'identity.logo_concept',policyIdentity:'a5'.repeat(32),handlerVersion:'logo-image-v1',provider:'openai',model:'gpt-image-2.5-sunburst-2026-09-08',engine:null,spendControl:'uncapped',estimatedCostMicrousd:1};
 const policies=[capability,{...capability,operation:'identity.logo_refine',policyIdentity:'b5'.repeat(32)}];
 sql(`create role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4;
  grant usage on schema public to ${role};grant execute on function public.claim_shared_worker_slot(uuid,uuid,text,integer),public.shared_logo_worker_action(jsonb,jsonb,text,jsonb) to ${role};
  insert into fluid_private.shared_worker_slots(slot_id,lane,slot_index,role_name,role_oid,deployment_id,enabled) select ${quote(slotId)},'logo',2,rolname,oid,${quote(deployment)},true from pg_roles where rolname=${quote(role)};
  insert into fluid_private.shared_service_actors values(${quote(actor)},'logo_storage');
  insert into auth.users(id,email_confirmed_at) values(${quote(actor)},clock_timestamp());insert into auth.sessions(id,user_id) values(${quote(session.id)},${quote(actor)});
  insert into fluid_private.shared_storage_target values(true,${quote(origin)});
  insert into fluid_private.shared_storage_actors(auth_user_id,slot_id,enabled) values(${quote(actor)},${quote(slotId)},true);`);
 for(const policy of policies)sql(`insert into fluid_private.shared_worker_policies values(${quote(slotId)},${quote(policy.operation)},${quote(policy.policyIdentity)},${quote(JSON.stringify(policy))});`);
 const lease=rpc('claim_shared_worker_slot',[slotId,randomUUID(),deployment,120],role);
 asVerifiedSession(session,'public.shared_logo_storage_session()');
 const action=(execution,name,args)=>rpc('shared_logo_worker_action',[lease,execution,name,args],role);
 assert(action(null,'runtime_ready',[policies]).result===true,'native-raster-advertises-the-exact-uncapped-policy');
 const owner=sessions[1],other=sessions[0];
 const workspace=startNativeLogoProject({quote,asVerifiedSession},owner,{brief:{name:'Native uncapped Logo',activity:'Synthetic SQL proof',audience:'Testers',personality:'Calm',logoTypes:['wordmark']}});
 const snapshot=sql(`select reference_snapshot_id from public.logo_stage_revisions where id=${quote(workspace.stages.brief_references.id)};`);
 const quoteRequest={operation:'concepts',expected:workspace.heads,briefRevisionId:workspace.stages.brief_references.id,referenceSnapshotId:snapshot};
 const operation=(kind,input,who=owner)=>asVerifiedSession(who,`public.shared_logo_operation(${quote(workspace.projectId)},${quote(kind)},${quote(JSON.stringify(input))})`);
 const q=operation('quote',quoteRequest),request={requestKey:randomUUID(),quoteId:q.id,expected:q.expected},receipt=operation('admit',request);
 assert(q.version===3&&q.spendControl==='uncapped'&&q.estimatedCostMicrousd===6&&!('maxCostMicrousd'in q)&&receipt.jobIds.length===6,'native-zero-allowance-admission-has-an-estimate-and-no-money-ceiling');
 assert(JSON.stringify(operation('admit',request))===JSON.stringify(receipt),'native-raster-original-admission-replays-once');
 let denied=false;try{operation('admit',request,other);}catch{denied=true;}assert(denied,'native-raster-foreign-owner-cannot-replay-or-admit');
 const complete=(admitted,kind)=>{
  const claimed=action(null,'claim',['native-uncapped-raster',120]),job=claimed.result[0],execution=claimed.execution,input=job.input;
  assert(admitted.jobIds.includes(job.id)&&job.reserved_cost_microusd===0,'native-'+kind+'-claim-does-not-reserve-fictional-money');
  for(const id of admitted.jobIds.filter(id=>id!==job.id))asVerifiedSession(owner,`public.request_job_cancel(${quote(id)})`);
  const key=kind==='concept'?`logo-preview-v1:${input.slotId}:${input.attemptId}`:'generate-refinement';
  const sourceId=kind==='concept'?input.attemptId:input.rasterRevisionId;
  assert(action(execution,'begin',[job.id,job.lease_token,key,'native:'+job.id,0]).result==='started','native-'+kind+'-dispatch-is-issued-once');
  checkDenied(`select public.shared_logo_worker_action(${quote(JSON.stringify(lease))},${quote(JSON.stringify({...execution,ownerId:other.owner}))},'read',${quote(JSON.stringify([job.id,job.lease_token,'input_revisions',null]))});`,role,'native-'+kind+'-execution-cannot-cross-owners');
  const revisions=action(execution,'read',[job.id,job.lease_token,'input_revisions',null]).result,cost=25_000_000;
  const hash=(kind==='concept'?'c':'d').repeat(64),pixel=(kind==='concept'?'e':'f').repeat(64),providerId='synthetic-native-'+job.id;
  const observation={provider:'openai',model:capability.model,providerRequestId:providerId,responseHash:'a'.repeat(64),observedAt:new Date().toISOString(),billing:{status:'recorded',confirmedMicrousd:cost},artifactHash:hash,normalizedPixelHash:pixel};
  const provider=action(execution,'receipt',[job.id,job.lease_token,observation]).result;
  assert(JSON.stringify(action(execution,'receipt',[job.id,job.lease_token,observation]).result)===JSON.stringify(provider),'native-'+kind+'-provider-receipt-replay-keeps-the-original-charge');
  const publication={requestKey:sourceId,source:{kind:'concept',sourceId},inputRevisions:revisions,mimeType:'image/png',contentHash:hash,byteLength:100};
  const reservation=action(execution,'prepare_asset',[job.project_id,{kind:'stage',publication},job.id,job.lease_token]).result;
  asVerifiedSession(session,`public.authorize_shared_logo_storage(${[execution.executionId,execution.executionToken,job.id,job.lease_token,reservation.id,'write'].map(quote).join(',')})`);
  asVerifiedStatement(session,`insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',${quote(reservation.storagePath)},${quote(actor)});select 'null'::jsonb`,{},'object.upload');
  assert(asVerifiedSession(other,`(select count(*) from storage.objects where name=${quote(reservation.storagePath)})`,{},'object.get_authenticated')===0,'native-'+kind+'-private-image-hidden-from-other-owner');
  action(execution,'observe_asset',[reservation.id,{status:'verified',checkedAt:new Date().toISOString(),contentHash:hash,mimeType:'image/png',byteLength:100},job.id,job.lease_token]);
  const output=kind==='concept'?{version:2,kind:'logo_concept',batchId:input.batchId,slotId:input.slotId,attemptId:input.attemptId,publicationId:reservation.id,providerResponseReceiptId:provider.id}
   :{version:2,kind:'logo_refinement_raster',rasterRevisionId:input.rasterRevisionId,publicationId:reservation.id,providerResponseReceiptId:provider.id};
  action(execution,'complete',[job.id,job.lease_token,key,'succeeded',cost,output,providerId]);action(execution,'finish',[job.id,job.lease_token,'succeeded']);
  assert(sql(`select j.state='succeeded' and j.actual_cost_microusd=${cost} and r.reserved_microusd=0 and r.captured_microusd=0 and r.actual_microusd=${cost} and r.state='settled' and p.state='committed' from public.jobs j join public.usage_reservations r on r.job_id=j.id join public.logo_asset_publications p on p.job_id=j.id where j.id=${quote(job.id)};`)==='t','native-'+kind+'-above-estimate-success-commits-image-and-exact-expense');
  return input;
 };
 const concept=complete(receipt,'concept');
 const current=asVerifiedSession(owner,`public.get_logo_workspace(${quote(workspace.projectId)})`);
 const refinementQuote=operation('quote',{operation:'refine_preview',expected:current.heads,source:{kind:'concept',batchId:concept.batchId,slotId:concept.slotId,attemptId:concept.attemptId},instruction:'Round the symbol'});
 complete(operation('admit',{requestKey:randomUUID(),quoteId:refinementQuote.id,expected:refinementQuote.expected}),'refinement');
 assert(sql(`select limit_microusd=0 and provider_actual_microusd=50000000 and reserved_microusd=0 and spent_microusd=0 from public.usage_accounts where owner_id=${quote(owner.owner)};`)==='t','native-raster-usage-is-truthful-without-budget-or-fake-capture');
 assert(sql('select count(*) from fluid_private.shared_worker_gateway_context;')==='0','native-raster-calls-clear-private-owner-context');
 checkDenied(`select fluid_private.shared_logo_create_raster_jobs(null,null,null);`,role,'native-worker-cannot-call-private-admission-helper');
}
