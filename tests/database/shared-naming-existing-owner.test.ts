import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {createSharedWorkerFixture,type SharedWorkerFixture,type SharedFixtureSlot} from './shared-worker-fixture';
import {brainPolicy,brainGapEnvelope,brainPreferences,brainRpc,brainWorker,brainReadinessFingerprint,initialIntent,installBrainFixture} from './naming-brain-fixture';
import {seedHostedNamingFixture} from './hosted-naming-fixture';
import {progressiveRequest} from './naming-brain-progressive-fixture';
import {createNamingRoleRequest} from '../../src/server/ai/naming-brain/prompts';
import {createProgressiveNamingRolePolicy} from '../../src/server/ai/naming-brain/policy';
import {normalizeNamingStoredJson} from '../../worker/naming-brain-store';
import {namingBrainJobInputSchema,namingProviderReceiptSchema} from '../../src/domain/naming-brain';
import {receipt} from '../domain/naming-brain-fixtures';
import {OWNER_A,OWNER_B} from './local-supabase';
import {sharedSlotLeaseSchema,type SharedSlotLease,type SharedExecution} from '../../worker/shared-pool/contracts';

describe('explicit existing Naming-owner future binding (restricted disposable SQL; no provider)',()=>{
 let f:SharedWorkerFixture,old:Awaited<ReturnType<typeof seedHostedNamingFixture>>,slot:SharedFixtureSlot,lease:SharedSlotLease;
 let successorExecution:SharedExecution,successorSlot:SharedFixtureSlot,successorLease:SharedSlotLease,freshExecution:SharedExecution;
 let futureExecution:SharedExecution,futureRequest:ReturnType<typeof createNamingRoleRequest>;
 let approval:string,oldRequest:ReturnType<typeof createNamingRoleRequest>,oldPilot:unknown,project:string;
 const policy={...brainPolicy,model:'gpt-6-luna'};
 const fingerprint={...brainReadinessFingerprint,nodeVersion:'fixture-future-node'};
 const call=async(action:string,args:unknown[],execution:SharedExecution|null=null)=>f.asSlot(slot,async()=>(await f.db.query<{envelope:{execution:SharedExecution|null;result:unknown}}>('select public.shared_naming_worker_action($1,$2,$3,$4) envelope',[lease,execution,action,args])).rows[0]!.envelope);
 const pilot=async()=>(await f.db.query('select to_jsonb(p) row from fluid_private.naming_brain_pilots p where owner_id=$1',[OWNER_A])).rows;
 const authority=async(owner=OWNER_A)=>(await f.db.query<{hash:string}>('select fluid_private.shared_naming_pilot_authority(p) hash from fluid_private.naming_brain_pilots p where owner_id=$1',[owner])).rows[0]!.hash;
 const approve=async(overrides:Record<string,unknown>={})=>{
  const id=randomUUID();
  const current=(await f.db.query<{binding_id:string;binding_revision:number}>('select binding_id,binding_revision from fluid_private.shared_naming_owners where owner_id=$1',[overrides.owner??OWNER_A])).rows[0];
  await f.db.query(`insert into fluid_private.shared_naming_adoption_approvals(approval_id,owner_id,pilot_id,legacy_authority_sha256,slot_id,role_name,role_oid,deployment_id,policy_identity,policy,readiness_fingerprint,approval_receipt,expires_at,expected_prior_binding,expected_prior_revision)
   select $1,$2,p.id,$3,s.slot_id,s.role_name,s.role_oid,$4,$5,$6,$7,'synthetic-owner-reviewed-authority',clock_timestamp()+interval '10 minutes',$10,$11
   from fluid_private.naming_brain_pilots p cross join fluid_private.shared_worker_slots s where p.owner_id=$9 and s.slot_id=$8`,
  [id,overrides.owner??OWNER_A,overrides.digest??await authority(String(overrides.owner??OWNER_A)),overrides.deployment??slot.deploymentId,
   overrides.identity??(await f.db.query<{h:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h",[policy])).rows[0]!.h,
   overrides.policy??policy,overrides.fingerprint??fingerprint,slot.slotId,overrides.pilotOwner??overrides.owner??OWNER_A,overrides.priorBinding??current?.binding_id??null,overrides.priorRevision??current?.binding_revision??0]);
  return id;
 };
 beforeAll(async()=>{
  f=await createSharedWorkerFixture({probe:false});await installBrainFixture(f.db);
  old=await seedHostedNamingFixture(f.db);
  expect(old.job.leaseToken).toMatch(/^[a-f0-9-]{36}$/);
  expect((await f.db.query<{lease_token:string}>('select lease_token from public.jobs where id=$1',[old.job.id])).rows[0]!.lease_token).toBe(old.job.leaseToken);
  await f.db.exec('update auth.users set email_confirmed_at=clock_timestamp(),is_anonymous=false');
  // A genuine frozen v4 request goes through legacy plan+authorization BEFORE
  // the additive packet. Its remote outcome is deliberately not invented.
  const prior=progressiveRequest(old,'context.research',{role:'researcher',snapshot:old.input.snapshot});
  oldRequest=createNamingRoleRequest({...prior,policy:{...prior.policy,progressiveContractVersion:4}});
  await brainWorker(f.db,()=>old.store.saveProgressiveCallPlan(old.job,'context.research',[oldRequest]));
  await brainWorker(f.db,()=>old.store.authorizeDispatch(old.job,oldRequest));
  oldPilot=await pilot();
  await f.db.exec(await readFile(new URL('../../supabase/candidates/shared_worker_naming.sql',import.meta.url),'utf8'));
  const identity=(await f.db.query<{h:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h",[policy])).rows[0]!.h;
  slot=await f.seedSlot({lane:'naming',policies:[{operation:'naming.generate',policyIdentity:String(identity),policy}]});
  await f.db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
  await f.db.query('insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)',[slot.slotId,fingerprint]);
  lease=sharedSlotLeaseSchema.parse(await f.lease(slot));await call('qualify',[policy,fingerprint]);
  project=(await brainRpc<{id:string}>(f.db,'create_project',['naming_only','Existing owner, new future project',{description:'Synthetic isolated brief'},'b'.repeat(64)],OWNER_A)).id;
  await brainRpc(f.db,'save_naming_preferences',[project,0,brainPreferences],OWNER_A);
 },60_000);
 afterAll(async()=>{await f?.close();});
 it('fails closed until explicit approved metadata exists, without touching the pilot or old evidence',async()=>{
  expect(await brainRpc(f.db,'get_shared_naming_availability',[project],OWNER_A)).toMatchObject({status:'unavailable'});
  await expect(brainRpc(f.db,'ensure_shared_naming_brain_run',[project,initialIntent('adoption-future-initial')],OWNER_A)).rejects.toThrow(/requires_cutover/);
  expect(await pilot()).toEqual(oldPilot);
  expect((await f.db.query('select request from fluid_private.naming_brain_calls where run_id=$1',[old.input.runId])).rows).toEqual([{request:oldRequest}]);
  expect((await call('preference_work',[20])).result).toEqual([]);
 });
 it('denies runtime activation, cross-owner approval, forged authority and mismatched future policy',async()=>{
  approval=await approve();
  await expect(f.asSlot(slot,()=>f.db.query('select fluid_private.shared_naming_adopt_existing($1)',[approval]))).rejects.toThrow(/permission denied/);
  await expect(brainRpc(f.db,'ensure_shared_naming_brain_run',[project,initialIntent('foreign-adoption')],OWNER_B)).rejects.toThrow(/account_required/);
  const foreign=await approve({owner:OWNER_B,pilotOwner:OWNER_A,digest:await authority()});
  await expect(f.db.query('select fluid_private.shared_naming_adopt_existing($1)',[foreign])).rejects.toThrow(/no rows/);
  for(const overrides of [{digest:'f'.repeat(64)},{deployment:'wrong-deployment'},{policy:{...policy,model:'wrong-model'}},{fingerprint:brainReadinessFingerprint}]){
   const bad=await approve(overrides);
   await expect(f.db.query('select fluid_private.shared_naming_adopt_existing($1)',[bad])).rejects.toThrow(/proof_mismatch/);
  }
  expect((await f.db.query('select * from fluid_private.shared_naming_owners')).rows).toEqual([]);
  expect(await pilot()).toEqual(oldPilot);
 });
 it('atomically installs only future admission, preserving historical replay and immutable original principal',async()=>{
  const roles=(await f.db.query('select oid from pg_roles order by oid')).rows;
  expect((await f.db.query('select fluid_private.shared_naming_adopt_existing($1) ok',[approval])).rows).toEqual([{ok:true}]);
  expect((await f.db.query('select fluid_private.shared_naming_adopt_existing($1) ok',[approval])).rows).toEqual([{ok:true}]);
  await expect(f.db.query('update fluid_private.shared_naming_adoption_approvals set expires_at=clock_timestamp() where approval_id=$1',[approval])).rejects.toThrow(/immutable/);
  await expect(brainRpc(f.db,'ensure_naming_brain_run',[project,initialIntent('legacy-new-denied')],OWNER_A)).rejects.toThrow(/future_admission_required/);
  expect(await brainRpc(f.db,'ensure_naming_brain_run',[old.project,old.intent],OWNER_A)).toMatchObject({reused:true});
  expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[old.project,old.intent],OWNER_A)).toMatchObject({reused:true});
  expect((await f.db.query('select oid from pg_roles order by oid')).rows).toEqual(roles);
  expect(await pilot()).toEqual(oldPilot);
 });
 it('uses separate future fingerprint/policy for a new project while old unknown work and v4 bytes remain',async()=>{
  expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[project,initialIntent('adoption-future-initial')],OWNER_A)).toMatchObject({code:'preferences_validation_pending'});
  const work=(await call('preference_work',[20])).result as {projectId:string;preferencesVersion:number;preferencesHash:string}[];
  const row=work.find(r=>r.projectId===project);expect(row).toBeDefined();
  await call('attest_preferences',[project,row!.preferencesVersion,row!.preferencesHash,fingerprint,{ready:true,missing:[]}]);
  expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[project,initialIntent('adoption-future-initial')],OWNER_A)).toMatchObject({status:'pending'});
  expect(await brainWorker(f.db,async()=>(await f.db.query<{result:unknown}>("select public.claim_naming_brain_job('fixture-worker','fixture-deployment',120) result")).rows[0]!.result)).toBeNull();
  const claim=await call('claim',['synthetic-future-worker',slot.deploymentId,120]);
  expect(claim.execution).toMatchObject({ownerId:OWNER_A,projectId:project});
  futureExecution=claim.execution!;
  const job=(claim.result as {job:{input:{policy:typeof policy;providerBudgetVersion:number}}}).job;
  expect(job.input).toMatchObject({policy,providerBudgetVersion:2});
  // Future v5 request construction is explicit; no historical request conversion.
  const next=createProgressiveNamingRolePolicy(policy,'researcher',undefined,undefined,true,5);
  expect(next).toMatchObject({progressiveContractVersion:5,model:'gpt-6-luna'});
  expect(next).not.toHaveProperty('providerSpendCapCents');
  const input=namingBrainJobInputSchema.parse(normalizeNamingStoredJson(job.input)),e=claim.execution!;
  const request=createNamingRoleRequest({runId:input.runId,stageKey:'creation',providerCallKey:'context.research.researcher',
   input:{role:'researcher',snapshot:input.snapshot},dependencyArtifactIds:[],policy:next});
  futureRequest=request;
  await call('action',[e.jobId,e.leaseToken,'plan',JSON.stringify({manifest:[{key:'creation',maximumCostMicrousd:1500000},{key:'prepare',maximumCostMicrousd:0}],gapEnvelope:brainGapEnvelope})],e);
  await call('action',[e.jobId,e.leaseToken,'begin',JSON.stringify({stageKey:'creation',requestKey:'synthetic-future-creation',maximumCostMicrousd:1500000})],e);
  await call('action',[e.jobId,e.leaseToken,'progressive_call_plan',JSON.stringify({phase:'context.research',requests:[request]})],e);
  expect((await call('authorize',[e.jobId,e.leaseToken,JSON.stringify(request)],e)).result).toBe(true);
  expect((await f.db.query('select request from fluid_private.naming_brain_calls where run_id=$1',[input.runId])).rows).toEqual([{request}]);
  expect((await f.db.query('select request from fluid_private.naming_brain_calls where run_id=$1',[old.input.runId])).rows).toEqual([{request:oldRequest}]);
  expect(await pilot()).toEqual(oldPilot);
  await expect(call('action',[old.job.id,old.job.leaseToken,'stage','{}'],claim.execution!)).rejects.toThrow(/scope_mismatch/);
 });
 it('retains the real legacy observation/heartbeat path and old fingerprint without hash churn or recreated calls',async()=>{
  const digest=await authority();
  expect(old.job.leaseToken).toMatch(/^[a-f0-9-]{36}$/);
  expect((await f.db.query<{lease_token:string}>('select lease_token from public.jobs where id=$1',[old.job.id])).rows[0]!.lease_token).toBe(old.job.leaseToken);
  await brainWorker(f.db,()=>old.store.heartbeat(old.job,120));
  expect(await authority()).toBe(digest);
  expect(await brainWorker(f.db,()=>old.store.loadProgressiveState(old.job))).toMatchObject({plannedRequests:[oldRequest]});
  const value=namingProviderReceiptSchema.parse({...receipt('creation','researcher'),budgetControl:'local_unlimited_v1',localPipelineVersion:2,
   sessionLimitCents:oldRequest.policy.sessionLimitCents,runId:old.input.runId,snapshotHash:oldRequest.snapshotHash,
   requestKey:oldRequest.requestKey,requestHash:oldRequest.requestHash,providerCallKey:oldRequest.providerCallKey,assignmentKey:null,
   observedModel:oldRequest.policy.model,dispatchState:'unknown',requestId:null,sessionId:'synthetic-pre-cutover-issued-handle',turnId:null,agentId:null,responseId:null,
   callIds:[],toolCalls:[],artifactItemIds:[],usageObservations:[],providerCostCounters:[]});
  await brainWorker(f.db,()=>old.store.recordReceipt(old.job,value));
  await brainWorker(f.db,()=>old.store.recordReceipt(old.job,value));
  await brainWorker(f.db,()=>old.store.completeStep(old.job,'creation',{status:'needs_reconciliation',code:'provider_outcome_unknown',costMicrousd:0,providerRequestId:null,result:{artifactIds:[],errorCode:'provider_outcome_unknown'}}));
  expect((await f.db.query('select receipt from fluid_private.naming_brain_receipts where run_id=$1',[old.input.runId])).rows).toEqual([{receipt:value}]);
  expect((await f.db.query('select request from fluid_private.naming_brain_calls where run_id=$1',[old.input.runId])).rows).toEqual([{request:oldRequest}]);
  expect(await authority()).toBe(digest);
  await expect(brainWorker(f.db,()=>old.store.authorizeDispatch(old.job,oldRequest))).rejects.toThrow();
  const replay=await brainRpc(f.db,'ensure_shared_naming_brain_run',[old.project,{...old.intent,idempotencyKey:'existing-unknown-no-repeat'}],OWNER_A);
  expect(replay).toMatchObject({status:'blocked',code:'dispatch_unresolved',feed:{activeRun:{runId:old.input.runId,canResume:false}}});
  expect((await f.db.query('select count(*)::int n from public.jobs where project_id=$1',[old.project])).rows).toEqual([{n:1}]);
  // Independent old attestation still selects the original fingerprint.
  const oldWork=await brainWorker(f.db,async()=>(await f.db.query<{work:{expectedFingerprint:unknown}[]}>('select public.get_naming_brain_preference_work(20) work')).rows[0]!.work);
  expect(oldWork.length).toBeGreaterThan(0);
  for(const row of oldWork)expect(row.expectedFingerprint).toEqual(brainReadinessFingerprint);
 });
 it('appends a CAS-approved deployment successor while the old shared issued execution remains observation-only',async()=>{
  const oldSlot=slot,oldLease=lease;
  const before=(await f.db.query<{row:Record<string,unknown>}>('select to_jsonb(b) row from fluid_private.shared_naming_owner_bindings b where owner_id=$1 order by binding_revision',[OWNER_A])).rows;
  const oldAdmissions=(await f.db.query('select to_jsonb(a) row from fluid_private.shared_job_admissions a where job_id=$1',[futureExecution.jobId])).rows;
  expect(await f.asSlot(oldSlot,async()=>(await f.db.query<{ok:boolean}>('select public.fence_shared_worker_slot($1) ok',[oldLease])).rows[0]!.ok)).toBe(true);
  slot=await f.seedSlot({lane:'naming',index:2,policies:[{operation:'naming.generate',policyIdentity:futureExecution.policyIdentity,policy}]});
  slot.deploymentId='fixture-successor-deployment';
  await f.db.query('update fluid_private.shared_worker_slots set deployment_id=$1 where slot_id=$2',[slot.deploymentId,slot.slotId]);
  await f.db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
  fingerprint.nodeVersion='fixture-successor-node';
  await f.db.query('insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)',[slot.slotId,fingerprint]);
  lease=sharedSlotLeaseSchema.parse(await f.lease(slot));await call('qualify',[policy,fingerprint]);
  const nextApproval=await approve(),stale=await approve();
  const wrongFingerprint=await approve({fingerprint:brainReadinessFingerprint});
  await expect(f.db.query('select fluid_private.shared_naming_adopt_existing($1)',[wrongFingerprint])).rejects.toThrow(/proof_mismatch/);
  await expect(f.asSlot(slot,()=>f.db.query('select fluid_private.shared_naming_adopt_existing($1)',[nextApproval]))).rejects.toThrow(/permission denied/);
  expect(await brainRpc(f.db,'get_shared_naming_availability',[project],OWNER_A)).toMatchObject({status:'unavailable'});
  expect((await f.db.query('select fluid_private.shared_naming_adopt_existing($1) ok',[nextApproval])).rows).toEqual([{ok:true}]);
  await expect(f.db.query('select fluid_private.shared_naming_adopt_existing($1)',[stale])).rejects.toThrow(/adoption_conflict/);
  const history=(await f.db.query<{row:Record<string,unknown>}>('select to_jsonb(b) row from fluid_private.shared_naming_owner_bindings b where owner_id=$1 order by binding_revision',[OWNER_A])).rows;
  expect(history).toHaveLength(2);expect(history[0]).toEqual(before[0]);
  expect((await f.db.query('select binding_revision,deployment_id from fluid_private.shared_naming_owners where owner_id=$1',[OWNER_A])).rows).toEqual([{binding_revision:2,deployment_id:slot.deploymentId}]);
  expect((await f.db.query('select to_jsonb(a) row from fluid_private.shared_job_admissions a where job_id=$1',[futureExecution.jobId])).rows).toEqual(oldAdmissions);
  const observe=await f.asSlot(oldSlot,async()=>(await f.db.query<{envelope:{result:{plannedRequests:unknown[]}}}>('select public.shared_naming_worker_action($1,$2,$3,$4) envelope',[oldLease,futureExecution,'action',[futureExecution.jobId,futureExecution.leaseToken,'progressive_state','{}']])).rows[0]!.envelope.result);
  expect(observe.plannedRequests).toEqual([futureRequest]);
  await expect(f.asSlot(oldSlot,()=>f.db.query('select public.shared_naming_worker_action($1,$2,$3,$4)',[oldLease,futureExecution,'authorize',[futureExecution.jobId,futureExecution.leaseToken,JSON.stringify(futureRequest)]]))).rejects.toThrow(/shared_slot_fenced|shared_dispatch_closed/);
  const nextProject=(await brainRpc<{id:string}>(f.db,'create_project',['naming_only','New deployment, existing customer',{description:'Synthetic isolated successor brief'},'c'.repeat(64)],OWNER_A)).id;
  await brainRpc(f.db,'save_naming_preferences',[nextProject,0,brainPreferences],OWNER_A);
  expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[nextProject,initialIntent('successor-new-project')],OWNER_A)).toMatchObject({code:'preferences_validation_pending'});
  const row=((await call('preference_work',[20])).result as {projectId:string;preferencesVersion:number;preferencesHash:string}[]).find(r=>r.projectId===nextProject)!;
  await call('attest_preferences',[nextProject,row.preferencesVersion,row.preferencesHash,fingerprint,{ready:true,missing:[]}]);
  expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[nextProject,initialIntent('successor-new-project')],OWNER_A)).toMatchObject({status:'pending'});
  successorExecution=(await call('claim',['synthetic-successor-worker',slot.deploymentId,120])).execution!;
  expect(successorExecution).toMatchObject({ownerId:OWNER_A,projectId:nextProject,deploymentId:slot.deploymentId});
  successorSlot=slot;successorLease=lease;
  expect((await f.db.query('select count(*)::int n from fluid_private.naming_brain_calls c join fluid_private.naming_brain_runs r on r.id=c.run_id where r.job_id=$1',[futureExecution.jobId])).rows).toEqual([{n:1}]);
  expect(await pilot()).toEqual(oldPilot);
 });
 it('advances an automatically enrolled fresh customer from its original NULL-digest binding without retargeting its pilot',async()=>{
  const fresh=(await brainRpc<{id:string}>(f.db,'create_project',['naming_only','Fresh shared customer',{description:'Synthetic fresh customer brief'},'d'.repeat(64)],OWNER_B)).id;
  await brainRpc(f.db,'save_naming_preferences',[fresh,0,brainPreferences],OWNER_B);
  expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[fresh,initialIntent('fresh-shared-first')],OWNER_B)).toMatchObject({code:'preferences_validation_pending'});
  const predecessor=(await f.db.query<{row:Record<string,unknown>}>('select to_jsonb(b) row from fluid_private.shared_naming_owner_bindings b where owner_id=$1',[OWNER_B])).rows;
  expect(predecessor[0]!.row).toMatchObject({binding_revision:1,legacy_authority_sha256:null,approval_id:null});
  const original=(await f.db.query('select to_jsonb(p) row from fluid_private.naming_brain_pilots p where owner_id=$1',[OWNER_B])).rows;
  slot=await f.seedSlot({lane:'naming',index:3,policies:[{operation:'naming.generate',policyIdentity:futureExecution.policyIdentity,policy}]});
  slot.deploymentId='fixture-fresh-next-deployment';
  await f.db.query('update fluid_private.shared_worker_slots set deployment_id=$1 where slot_id=$2',[slot.deploymentId,slot.slotId]);
  await f.db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
  await f.db.query('insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)',[slot.slotId,fingerprint]);
  lease=sharedSlotLeaseSchema.parse(await f.lease(slot));await call('qualify',[policy,fingerprint]);
  const next=await approve({owner:OWNER_B});
  expect((await f.db.query('select fluid_private.shared_naming_adopt_existing($1) ok',[next])).rows).toEqual([{ok:true}]);
  const history=(await f.db.query<{row:Record<string,unknown>}>('select to_jsonb(b) row from fluid_private.shared_naming_owner_bindings b where owner_id=$1 order by binding_revision',[OWNER_B])).rows;
  expect(history).toHaveLength(2);expect(history[0]).toEqual(predecessor[0]);
  expect(history[1]!.row).toMatchObject({binding_revision:2,legacy_authority_sha256:await authority(OWNER_B),deployment_id:slot.deploymentId});
  expect((await f.db.query('select to_jsonb(p) row from fluid_private.naming_brain_pilots p where owner_id=$1',[OWNER_B])).rows).toEqual(original);
  const row=((await call('preference_work',[20])).result as {projectId:string;preferencesVersion:number;preferencesHash:string}[]).find(r=>r.projectId===fresh)!;
  await call('attest_preferences',[fresh,row.preferencesVersion,row.preferencesHash,fingerprint,{ready:true,missing:[]}]);
  expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[fresh,initialIntent('fresh-shared-first')],OWNER_B)).toMatchObject({status:'pending'});
  freshExecution=(await call('claim',['fresh-successor-worker',slot.deploymentId,120])).execution!;
  expect(freshExecution).toMatchObject({ownerId:OWNER_B,projectId:fresh,deploymentId:slot.deploymentId});
 });
 it('ignores operational pilot updates but fails future authority closed on true configuration drift',async()=>{
  const digest=await authority();
  await f.db.query("update fluid_private.naming_brain_pilots set enabled=false,worker_id='synthetic-operational-heartbeat',ready_until=clock_timestamp() where owner_id=$1",[OWNER_A]);
  expect(await authority()).toBe(digest);
  expect(await brainRpc(f.db,'get_shared_naming_availability',[project],OWNER_A)).toMatchObject({status:'available'});
  await f.db.query("update fluid_private.naming_brain_pilots set deployment_id='unapproved-authority-drift' where owner_id=$1",[OWNER_A]);
  expect(await brainRpc(f.db,'get_shared_naming_availability',[project],OWNER_A)).toMatchObject({status:'unavailable'});
  await expect(call('attest_preferences',[project,1,'a'.repeat(64),fingerprint,{ready:true,missing:[]}])).rejects.toThrow(/scope_denied/);
  expect((await f.db.query('select * from fluid_private.shared_naming_request_context')).rows).toEqual([]);
 });
 it('approves a third future version after its original anchor is drained and retired NOLOGIN/passwordless',async()=>{
  // These two exact executions never issued provider calls. Cancel/finish both
  // through their real observation gateways before retiring the old slot role.
  await brainRpc(f.db,'request_job_cancel',[successorExecution.jobId],OWNER_A);
  await f.asSlot(successorSlot,()=>f.db.query('select public.shared_naming_worker_action($1,$2,$3,$4)',[successorLease,successorExecution,'action',[successorExecution.jobId,successorExecution.leaseToken,'finish',JSON.stringify({state:'cancelled',errorCode:null})]]));
  await brainRpc(f.db,'request_job_cancel',[freshExecution.jobId],OWNER_B);
  await call('action',[freshExecution.jobId,freshExecution.leaseToken,'finish',JSON.stringify({state:'cancelled',errorCode:null})],freshExecution);
  const original=(await f.db.query<{row:Record<string,unknown>}>('select to_jsonb(p) row from fluid_private.naming_brain_pilots p where owner_id=$1',[OWNER_B])).rows;
  const history=(await f.db.query<{row:Record<string,unknown>}>('select to_jsonb(b) row from fluid_private.shared_naming_owner_bindings b where owner_id=$1 order by binding_revision',[OWNER_B])).rows;
  expect((await f.db.query<{n:number}>("select count(*)::int n from fluid_private.naming_brain_runs r join public.jobs j on j.id=r.job_id where r.admitted_role_name=$1 and j.state not in('succeeded','failed','cancelled','partial')",[successorSlot.roleName])).rows).toEqual([{n:0}]);
  await f.db.exec(`alter role ${successorSlot.roleName} nologin password null`);
  const retired=async()=>(await f.db.query<{rolcanlogin:boolean;password_absent:boolean}>('select rolcanlogin,rolpassword is null password_absent from pg_authid where rolname=$1',[successorSlot.roleName])).rows;
  expect(await retired()).toEqual([{rolcanlogin:false,password_absent:true}]);
  await f.asSlot(slot,()=>f.db.query('select public.fence_shared_worker_slot($1)',[lease]));
  slot.deploymentId='fixture-fresh-third-deployment';
  await f.db.query('update fluid_private.shared_worker_slots set deployment_id=$1 where slot_id=$2',[slot.deploymentId,slot.slotId]);
  lease=sharedSlotLeaseSchema.parse(await f.lease(slot));await call('qualify',[policy,fingerprint]);
  const approved=await approve({owner:OWNER_B});
  await f.db.exec(`alter role ${successorSlot.roleName} inherit`);
  await expect(f.db.query('select fluid_private.shared_naming_adopt_existing($1)',[approved])).rejects.toThrow(/proof_mismatch/);
  await f.db.exec(`alter role ${successorSlot.roleName} noinherit`);
  expect((await f.db.query<{ok:boolean}>('select fluid_private.shared_naming_adopt_existing($1) ok',[approved])).rows).toEqual([{ok:true}]);
  const after=(await f.db.query<{row:Record<string,unknown>}>('select to_jsonb(b) row from fluid_private.shared_naming_owner_bindings b where owner_id=$1 order by binding_revision',[OWNER_B])).rows;
  expect(after).toHaveLength(3);expect(after.slice(0,2)).toEqual(history);
  expect(after[2]!.row).toMatchObject({binding_revision:3,deployment_id:slot.deploymentId});
  expect((await f.db.query<{row:Record<string,unknown>}>('select to_jsonb(p) row from fluid_private.naming_brain_pilots p where owner_id=$1',[OWNER_B])).rows).toEqual(original);
  expect(await retired()).toEqual([{rolcanlogin:false,password_absent:true}]);
  expect((await f.db.query<{rolcanlogin:boolean}>('select rolcanlogin from pg_roles where rolname=$1',[slot.roleName])).rows).toEqual([{rolcanlogin:true}]);
  const p=(await brainRpc<{id:string}>(f.db,'create_project',['naming_only','Retired anchor future project',{description:'Synthetic next-deployment brief'},'e'.repeat(64)],OWNER_B)).id;
  await brainRpc(f.db,'save_naming_preferences',[p,0,brainPreferences],OWNER_B);
  expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[p,initialIntent('third-future-admission')],OWNER_B)).toMatchObject({code:'preferences_validation_pending'});
  const row=((await call('preference_work',[20])).result as {projectId:string;preferencesVersion:number;preferencesHash:string}[]).find(r=>r.projectId===p)!;
  await call('attest_preferences',[p,row.preferencesVersion,row.preferencesHash,fingerprint,{ready:true,missing:[]}]);
  expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[p,initialIntent('third-future-admission')],OWNER_B)).toMatchObject({status:'pending'});
  expect((await call('claim',['third-future-worker',slot.deploymentId,120])).execution).toMatchObject({ownerId:OWNER_B,projectId:p,deploymentId:slot.deploymentId});
  expect(await retired()).toEqual([{rolcanlogin:false,password_absent:true}]);
 });

});
