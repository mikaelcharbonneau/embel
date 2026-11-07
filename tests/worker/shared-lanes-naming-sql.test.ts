import {readFile} from 'node:fs/promises';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {createSharedWorkerFixture,type SharedWorkerFixture,type SharedFixtureSlot} from '../database/shared-worker-fixture';
import {brainPolicy,brainPreferences,brainRpc,initialIntent,brainReadinessFingerprint} from '../database/naming-brain-fixture';
import {NAMING_GAP_ENVELOPE} from '../../src/server/ai/naming-brain/policy';
import {NamingBrainJobStore} from '../../worker/naming-brain-store';
import {createNamingBrainHandlers} from '../../worker/handlers/naming-brain';
import {OWNER_A,OWNER_B} from '../database/local-supabase';
import {sharedSlotLeaseSchema, type SharedSlotLease,type SharedExecution} from '../../worker/shared-pool/contracts';
import {createSharedNamingLaneEngine} from '../../worker/shared-lanes/naming';
import {randomUUID} from 'node:crypto';

describe('shared Naming real restricted SQL gateway, synthetic Auth and no provider calls',()=>{
 let f:SharedWorkerFixture,slot:SharedFixtureSlot,lease:SharedSlotLease;
 const policy={...brainPolicy,model:'gpt-6-luna'};
 const hash=async()=>String((await f.db.query<{h:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h",[policy])).rows[0]!.h);
 const call=async(action:string,args:unknown[],execution:SharedExecution|null=null)=>f.asSlot(slot,async()=>(await f.db.query<{envelope:{execution:SharedExecution|null;result:unknown}}>('select public.shared_naming_worker_action($1,$2,$3,$4) envelope',[lease,execution,action,args])).rows[0]!.envelope);
 beforeAll(async()=>{
  f=await createSharedWorkerFixture({probe:false});await f.seedUser(OWNER_A);await f.seedUser(OWNER_B);
  // The released Naming chain the engine requires (its lease expiry needs delivery recovery).
  for(const file of ['shared_worker_naming.sql','shared_naming_brainstorm.sql','shared_naming_brainstorm_delivery_recovery.sql','shared_naming_lease_expiry.sql'])
   await f.db.exec(await readFile(new URL(`../../supabase/candidates/${file}`,import.meta.url),'utf8'));
  slot=await f.seedSlot({lane:'naming',policies:[{operation:'naming.generate',policyIdentity:await hash(),policy}]});
  await f.db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
  await f.db.query('insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)',[slot.slotId,brainReadinessFingerprint]);
  lease=sharedSlotLeaseSchema.parse(await f.lease(slot));
 },60_000);
 afterAll(async()=>{await f?.close();});
 it('requires exact operator-approved policy and runtime fingerprint, never environment presence',async()=>{
  // The reviewed base gateway, retained exactly beneath the later packets' entry point.
  const metadata=(await f.db.query<{hash:string;owner:string;prosecdef:boolean;provolatile:string;proleakproof:boolean}>("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') hash,pg_get_userbyid(proowner) owner,prosecdef,provolatile,proleakproof from pg_proc where oid='fluid_private.naming_brainstorm_previous_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure")).rows[0]!;
  expect(metadata).toEqual({hash:'2d509fd4d973126b2b454ac3507e7979f9837e03026e4826636e2762411e8bab',owner:'postgres',prosecdef:true,provolatile:'v',proleakproof:false});
  await expect(call('qualify',[{...policy,model:'wrong'},brainReadinessFingerprint])).rejects.toThrow(/runtime_mismatch/);
  await expect(call('qualify',[policy,{...brainReadinessFingerprint,nodeVersion:'false'}])).rejects.toThrow(/runtime_mismatch/);
  expect((await call('qualify',[policy,brainReadinessFingerprint])).result).toBe(true);
 });
 it('runs the actual idle engine against the restricted gateway without provider calls',async()=>{
  const engine=createSharedNamingLaneEngine({database:{query:(sql,values)=>f.asSlot(slot,()=>f.db.query(sql,values))},slot:()=>lease,
   deploymentId:slot.deploymentId,workerId:'shared-naming-fixture',provider:{apiKey:'synthetic-not-a-provider-secret',model:policy.model,modelVerificationReceipt:'synthetic-model-proof'},policy});
  try{expect(await engine.run()).toEqual({disposition:'ack',state:'idle'});}finally{await engine.close();}
 });
 it('creates fresh-owner metadata/admission with no roles, then claims SQL-derived shared authority',async()=>{
  const roles=(await f.db.query('select oid from pg_roles order by oid')).rows;
  for(const owner of [OWNER_A,OWNER_B]){
   const project=(await brainRpc<{id:string}>(f.db,'create_project',['naming_only','Shared synthetic',{description:'Synthetic isolated brief'},'a'.repeat(64)],owner)).id;
   await brainRpc(f.db,'save_naming_preferences',[project,0,brainPreferences],owner);
   const pending=await brainRpc<Record<string,unknown>>(f.db,'ensure_shared_naming_brain_run',[project,initialIntent(`shared-${owner}-request`)],owner);
   expect(pending.code).toBe('preferences_validation_pending');
  }
  const work=(await call('preference_work',[20])).result as {projectId:string;preferencesVersion:number;preferencesHash:string}[];
  expect(work).toHaveLength(2);
  for(const row of work)await call('attest_preferences',[row.projectId,row.preferencesVersion,row.preferencesHash,brainReadinessFingerprint,{ready:true,missing:[]}]);
  for(const owner of [OWNER_A,OWNER_B]){
   const project=String((await f.db.query<{id:string}>('select id from public.projects where owner_id=$1',[owner])).rows[0]!.id);
   const admitted=await brainRpc<Record<string,unknown>>(f.db,'ensure_shared_naming_brain_run',[project,initialIntent(`shared-${owner}-request`)],owner);
   expect(admitted,JSON.stringify(admitted)).toMatchObject({status:'pending'});
  }
  const claimed=await call('claim',['shared-naming-fixture',slot.deploymentId,120]);
  expect(claimed.execution?.ownerId).toBe(OWNER_A);
  expect((claimed.result as {executionAuthority:string}).executionAuthority).toBe('shared_slot_v1');
  expect((await f.db.query('select oid from pg_roles order by oid')).rows).toEqual(roles);
  expect((await f.db.query('select * from fluid_private.shared_worker_gateway_context')).rows).toEqual([]);
  if(!claimed.execution)throw Error('missing fixture claim');
  await expect(call('action',[claimed.execution.jobId,claimed.execution.leaseToken,'stage','{}'],{...claimed.execution,ownerId:OWNER_B})).rejects.toThrow(/shared_execution_denied/);
  await expect(f.asSlot(slot,()=>f.db.query('select * from public.jobs'))).rejects.toThrow(/permission denied/);
  const e=claimed.execution;
  // Parse/cache the already committed actual SQL claim through the real store.
  const store=new NamingBrainJobStore({query:async()=>({rows:[{result:claimed.result}]})},slot.deploymentId);
  const job=await store.claim('shared-naming-fixture',120);if(!job)throw Error('missing parsed SQL claim');
  const handlers=createNamingBrainHandlers({store,assertReady:async()=>{}});
  const manifest=handlers.get('naming.generate')!.steps(job).map(({key,maximumCostMicrousd})=>({key,maximumCostMicrousd}));
  await call('action',[e.jobId,e.leaseToken,'plan',JSON.stringify({manifest,gapEnvelope:NAMING_GAP_ENVELOPE})],e);
  expect((await call('action',[e.jobId,e.leaseToken,'begin',JSON.stringify({stageKey:'creation',requestKey:'shared-fixture-creation-request',maximumCostMicrousd:1500000})],e)).result).toMatchObject({disposition:'started'});
  const account=(await f.db.query<{limit_microusd:number}>('select limit_microusd from public.usage_accounts where owner_id=$1',[e.ownerId])).rows[0]!;
  expect(Number(account.limit_microusd)).toBe(0);
 });
 it('a second fixed slot can attest/admit existing shared owners without retargeting historical pilots',async()=>{
  const first=slot,oldLease=lease;
  const old=(await f.asSlot(first,()=>f.db.query<{pending:{execution:SharedExecution}}>('select public.read_shared_worker_executions($1) pending',[oldLease]))).rows[0]!.pending.execution;
  const expiry=(await f.db.query('select lease_expires_at from public.jobs where id=$1',[old.jobId])).rows[0];
  await f.db.query("update fluid_private.shared_worker_slots set expires_at=clock_timestamp()-interval '1 second' where slot_id=$1",[first.slotId]);
  const second=await f.seedSlot({lane:'naming',index:2,policies:[{operation:'naming.generate',policyIdentity:await hash(),policy}]});
  await f.db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${second.roleName}`);
  await f.db.query('insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)',[second.slotId,brainReadinessFingerprint]);
  slot=second;lease=sharedSlotLeaseSchema.parse(await f.lease(second));await call('qualify',[policy,brainReadinessFingerprint]);
  const project=(await brainRpc<{id:string}>(f.db,'create_project',['naming_only','Failover synthetic',{description:'Synthetic isolated brief'},'b'.repeat(64)],OWNER_A)).id;
  await brainRpc(f.db,'save_naming_preferences',[project,0,brainPreferences],OWNER_A);
  expect(await brainRpc(f.db,'get_shared_naming_availability',[project],OWNER_A)).toMatchObject({status:'available'});
  expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[project,initialIntent('shared-failover-request')],OWNER_A)).toMatchObject({code:'preferences_validation_pending'});
  const work=(await call('preference_work',[20])).result as {projectId:string;preferencesVersion:number;preferencesHash:string}[];
  const row=work.find(r=>r.projectId===project);if(!row)throw Error('failover preference unavailable');
  await call('attest_preferences',[row.projectId,row.preferencesVersion,row.preferencesHash,brainReadinessFingerprint,{ready:true,missing:[]}]);
  expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[project,initialIntent('shared-failover-request')],OWNER_A)).toMatchObject({status:'pending'});
  expect((await f.db.query<{role_name:string}>('select role_name from fluid_private.naming_brain_pilots where owner_id=$1',[OWNER_A])).rows[0]!.role_name).toBe(first.roleName);
  const claim=await call('claim',['shared-naming-fixture-2',second.deploymentId,120]);expect(claim.execution?.ownerId).toBe(OWNER_B);
  // A historical slot can deliver real stored Stop/status without extending a
  // job lease or regaining begin/authorize authority after expiration.
  const observed=await f.asSlot(first,async()=>(await f.db.query<{envelope:{result:{recoveryMode:string}}}>('select public.shared_naming_worker_action($1,$2,$3,$4) envelope',
   [oldLease,old,'action',[old.jobId,old.leaseToken,'heartbeat',JSON.stringify({leaseSeconds:120})]])).rows[0]!.envelope);
  expect(observed.result.recoveryMode).toBe('observe_only');
  expect((await f.db.query('select lease_expires_at from public.jobs where id=$1',[old.jobId])).rows[0]).toEqual(expiry);
  await expect(f.asSlot(first,()=>f.db.query('select public.shared_naming_worker_action($1,$2,$3,$4)',[oldLease,old,'authorize',[old.jobId,old.leaseToken,'{}']]))).rejects.toThrow(/shared_slot_fenced|shared_dispatch_closed/);
  await expect(f.asSlot(second,()=>f.db.query("select public.claim_naming_brain_job('foreign','foreign',120)"))).rejects.toThrow(/permission denied/);
  await expect(call('action',[randomUUID(),claim.execution!.leaseToken,'stage','{}'],claim.execution!)).rejects.toThrow(/scope_mismatch/);
  expect((await f.db.query('select * from fluid_private.shared_worker_gateway_context')).rows).toEqual([]);
 });
 it('explicit Resume uses fresh pool readiness after cancellation and rejects unknown or foreign histories',async()=>{
  const current=(await f.db.query<{execution:SharedExecution}>("select fluid_private.shared_worker_execution_json(e) execution from fluid_private.shared_worker_executions e where owner_id=$1 and state='active'",[OWNER_B])).rows[0]!.execution;
  await brainRpc(f.db,'request_job_cancel',[current.jobId],OWNER_B);
  const heartbeat=(await call('action',[current.jobId,current.leaseToken,'heartbeat',JSON.stringify({leaseSeconds:120})],current)).result;
  expect(heartbeat).toMatchObject({state:'cancel_requested',recoveryMode:'observe_only'});
  await call('action',[current.jobId,current.leaseToken,'finish',JSON.stringify({state:'cancelled',errorCode:null})],current);
  const source=(await f.db.query<{id:string;revision:number}>('select id,revision from fluid_private.naming_brain_runs where job_id=$1',[current.jobId])).rows[0]!;
  const feed=await brainRpc<{demandSequence:number;activeRun:{canResume:boolean}}>(f.db,'get_naming_feed',[current.projectId],OWNER_B);
  expect(feed.activeRun.canResume).toBe(true);
  const intent={...initialIntent('shared-explicit-resume'),reason:'resume',resumeOfRunId:source.id,expectedRunRevision:source.revision,expectedDemandSequence:feed.demandSequence};
  await expect(brainRpc(f.db,'ensure_shared_naming_brain_run',[current.projectId,intent],OWNER_A)).rejects.toThrow(/account_required/);
  await expect(brainRpc(f.db,'ensure_shared_naming_brain_run',[current.projectId,{...intent,expectedRunRevision:source.revision+1}],OWNER_B)).rejects.toThrow(/resume_conflict/);
  expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[current.projectId,intent],OWNER_B)).toMatchObject({status:'pending'});
  expect((await f.db.query('select state from public.jobs where id=$1',[current.jobId])).rows).toEqual([{state:'cancelled'}]);
  const unknown=(await f.db.query<{id:string;project_id:string;revision:number}>("select r.id,r.project_id,r.revision from fluid_private.naming_brain_runs r join public.jobs j on j.id=r.job_id where r.owner_id=$1 and j.state='running'",[OWNER_A])).rows[0]!;
  const unknownFeed=await brainRpc<{demandSequence:number;activeRun:{canResume:boolean}}>(f.db,'get_naming_feed',[unknown.project_id],OWNER_A);
  expect(unknownFeed.activeRun.canResume).toBe(false);
  await expect(brainRpc(f.db,'ensure_shared_naming_brain_run',[unknown.project_id,{...initialIntent('shared-unknown-no-repeat'),reason:'resume',resumeOfRunId:unknown.id,expectedRunRevision:unknown.revision,expectedDemandSequence:unknownFeed.demandSequence}],OWNER_A)).rejects.toThrow(/resume_conflict/);
 });
});
