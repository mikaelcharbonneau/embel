import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSharedWorkerFixture, type SharedWorkerFixture, type SharedFixtureSlot } from './shared-worker-fixture';
import { brainPolicy, brainPreferences, brainReadinessFingerprint, brainRpc, initialIntent } from './naming-brain-fixture';
import { asRole, OWNER_A, OWNER_B } from './local-supabase';
vi.mock('server-only',()=>({}));
import { createBrandFromProjectNameResponseSchema, projectNameCandidateSchema, nameIdentityKey } from '../../src/domain/project-naming';
import { namingFeedSchema, namingFeedEnsureResultSchema, namingBrainRunSchema } from '../../src/domain/naming-brain';
import { transformNames } from '../../src/domain/naming';
import { normalizeNamingBrain, verifyBrainstormNamingSource } from '../../src/server/data/naming-brain-provenance';
import type { AuthenticatedContext } from '../../src/server/auth/context';

/** Synthetic Auth and provider observations in disposable PostgreSQL. No paid calls. */
describe('future-only Naming brainstorm SQL capability', () => {
 let f:SharedWorkerFixture, slot:SharedFixtureSlot, lease:Record<string,unknown>, execution:Record<string,unknown>, project:string, runId:string, callId:string;
 const policy={...brainPolicy,model:'gpt-6-luna'};
 const action=async(name:string,args:unknown={},e:Record<string,unknown>|null=execution)=>{
  if(name==='brainstorm_begin'){
   const history=(await f.db.query<{id:string;value:string}>('select id,value from public.name_candidates where project_id=$1',[project])).rows;
   const epoch=(await f.db.query<{writer_epoch:number}>('select writer_epoch from fluid_private.naming_brain_heads where project_id=$1',[project])).rows[0]!.writer_epoch;
   args={...args as object,expectedHistoryEpoch:Number(epoch),historyIdentities:history.map(x=>({candidateId:x.id,value:x.value,identityKey:x.value.toLowerCase().replace(/[\p{P}\s]/gu,'').normalize('NFC')}))};
  }
  return f.asSlot(slot,async()=>(await f.db.query<{v:{result:Record<string,unknown>;execution:Record<string,unknown>}}> ('select public.shared_naming_worker_action($1,$2,$3,$4) v',[lease,e,name,JSON.stringify(args)])).rows[0]!.v);};
 const request=(index=1)=>({model:'gpt-6-luna',store:true,stream:true,reasoning:{effort:'low'},max_output_tokens:16000,input:'Synthetic source fixture only',text:{verbosity:'low',format:{type:'json_schema',name:'naming_brainstorm_v1',strict:true,schema:{type:'object'}}},metadata:{embel_generation_profile:'brainstorm_v1',embel_job_id:execution.jobId,embel_run_id:runId,embel_call_index:String(index)}});
 beforeAll(async()=>{
  f=await createSharedWorkerFixture({probe:false});await f.seedUser(OWNER_A);await f.seedUser(OWNER_B);
  await f.db.exec(await readFile(new URL('../../supabase/candidates/shared_worker_naming.sql',import.meta.url),'utf8'));
  // A pre-existing unrelated grantee models hostile owner default ACLs. It is
  // disposable fixture metadata, never an installation-created capability.
  await f.db.exec(`create role fixture_brainstorm_acl_probe nologin;
   grant usage on schema fluid_private to fixture_brainstorm_acl_probe;
   alter default privileges for role postgres in schema fluid_private grant all on tables to fixture_brainstorm_acl_probe;
   alter default privileges for role postgres in schema fluid_private grant all on functions to fixture_brainstorm_acl_probe;`);
  await f.db.exec(await readFile(new URL('../../supabase/candidates/shared_naming_brainstorm.sql',import.meta.url),'utf8'));
  const identity=(await f.db.query<{h:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') h",[JSON.stringify(policy)])).rows[0]!.h;
  slot=await f.seedSlot({lane:'naming',policies:[{operation:'naming.generate',policyIdentity:identity,policy}]});
  await f.db.exec(`grant execute on function public.shared_naming_worker_action(jsonb,jsonb,text,jsonb) to ${slot.roleName}`);
  await f.db.query('insert into fluid_private.shared_naming_slot_configuration(slot_id,readiness_fingerprint) values($1,$2)',[slot.slotId,JSON.stringify(brainReadinessFingerprint)]);
  lease=await f.lease(slot);await action('qualify',[policy,brainReadinessFingerprint],null);
  project=(await brainRpc<{id:string}>(f.db,'create_project',['naming_only','Synthetic brainstorm',{description:'Synthetic naming brief'},'a'.repeat(64)])).id;
  await brainRpc(f.db,'save_naming_preferences',[project,0,brainPreferences]);
  expect(await brainRpc(f.db,'ensure_shared_naming_brainstorm_run',[project,initialIntent('brainstorm-initial')])).toMatchObject({code:'preferences_validation_pending'});
  const work=(await action('preference_work',[20],null)).result as unknown as {projectId:string;preferencesVersion:number;preferencesHash:string}[];
  const row=work.find(x=>x.projectId===project)!;
  await action('attest_preferences',[project,row.preferencesVersion,row.preferencesHash,brainReadinessFingerprint,{ready:true,missing:[]}],null);
  expect(await brainRpc(f.db,'ensure_shared_naming_brainstorm_run',[project,initialIntent('brainstorm-initial')])).toMatchObject({status:'pending'});
  const claim=await action('claim',['fixture-brainstorm-worker',slot.deploymentId,120],null);execution=claim.execution;
  runId=((claim.result as {job:{input:{runId:string}}}).job.input.runId);
 },60_000);
 afterAll(async()=>{await f?.close();});
 const startNext=async(key:string,owner=OWNER_A,preferences=brainPreferences)=>{
  project=(await brainRpc<{id:string}>(f.db,'create_project',['naming_only','Synthetic follow-up',{description:'Synthetic naming brief'},'b'.repeat(64)],owner)).id;
  await brainRpc(f.db,'save_naming_preferences',[project,0,preferences],owner);
  await brainRpc(f.db,'ensure_shared_naming_brainstorm_run',[project,initialIntent(key)],owner);
  const work=(await action('preference_work',[20],null)).result as unknown as {projectId:string;preferencesVersion:number;preferencesHash:string}[];
  const row=work.find(x=>x.projectId===project)!;
  await action('attest_preferences',[project,row.preferencesVersion,row.preferencesHash,brainReadinessFingerprint,{ready:true,missing:[]}],null);
  await brainRpc(f.db,'ensure_shared_naming_brainstorm_run',[project,initialIntent(key)],owner);
  const claim=await action('claim',['fixture-brainstorm-worker',slot.deploymentId,120],null);execution=claim.execution;
  runId=(claim.result as {job:{input:{runId:string}}}).job.input.runId;
 };
 it('freezes new profile before enqueue and preserves exact replay/owner/oldwire',async()=>{
  const input=(await f.db.query<{input:Record<string,unknown>}>('select input from public.jobs where id=$1',[execution.jobId])).rows[0]!.input;
  expect(input).toMatchObject({generationProfile:'brainstorm_v1',executionAuthority:'hosted_owner_v1',providerBudgetVersion:2,localTimingVersion:2,localPipelineVersion:2});
  expect(await brainRpc(f.db,'ensure_shared_naming_brainstorm_run',[project,initialIntent('brainstorm-initial')])).toMatchObject({status:'pending',reused:true,run:{generationProfile:'brainstorm_v1'}});
  await expect(brainRpc(f.db,'ensure_shared_naming_brainstorm_run',[project,initialIntent('foreign-brainstorm')],OWNER_B)).rejects.toThrow(/account_required/);
  await expect(action('authorize',[execution.jobId,execution.leaseToken,'{}'])).rejects.toThrow(/profile_action_required/);
  await expect(f.asSlot(slot,()=>f.db.query('select * from fluid_private.naming_brainstorm_calls'))).rejects.toThrow(/permission denied/);
 });
 it('strips every hostile default grantee while exposing only the existing worker gateway and two owner RPCs',async()=>{
  const grants=await f.db.query<{name:string;role:string;allowed:boolean}>(`select c.relname name,r.rolname role,has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed
   from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r
   where n.nspname='fluid_private' and c.relname in('naming_brainstorm_calls','naming_brainstorm_events','naming_brainstorm_publications','naming_brainstorm_completions')
   and r.rolname=any($1::text[])`,[[slot.roleName,'fixture_brainstorm_acl_probe','anon','authenticated','service_role']]);
  expect(grants.rows).toHaveLength(20);expect(grants.rows.every(row=>!row.allowed)).toBe(true);
  expect((await f.db.query<{n:number}>(`select count(*)::integer n from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
   lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
   where n.nspname='fluid_private' and (p.proname like 'naming_brainstorm_%' or p.proname='shared_naming_brainstorm_ensure_core') and acl.grantee<>p.proowner`)).rows).toEqual([{n:0}]);
  for(const table of ['naming_brainstorm_calls','naming_brainstorm_events','naming_brainstorm_publications','naming_brainstorm_completions']){
   await expect(f.asSlot(slot,()=>f.db.query(`select * from fluid_private.${table}`))).rejects.toThrow(/permission denied/);
  }
  await expect(f.asSlot(slot,()=>f.db.query('select public.ensure_shared_naming_brainstorm_run($1,$2)',[project,initialIntent('slot-admission-denied')]))).rejects.toThrow(/permission denied/);
  await expect(asRole(f.db,'service_role',OWNER_A,()=>f.db.query('select public.get_naming_brainstorm_sources($1,$2)',[project,[]]))).rejects.toThrow(/permission denied/);
  await expect(asRole(f.db,'anon',null,()=>f.db.query('select public.ensure_shared_naming_brainstorm_run($1,$2)',[project,initialIntent('anon-admission-denied')]))).rejects.toThrow(/permission denied/);
 });
 it('one exact first120 request is durable before dispatch and never replays a create',async()=>{
  const created=await action('brainstorm_begin',{callIndex:1,candidateTarget:120,request:request()});callId=String(created.result.callId);expect(created.result).toMatchObject({dispatch:'create',responseId:null});
  expect((await action('brainstorm_begin',{callIndex:1,candidateTarget:120,request:request()})).result).toMatchObject({dispatch:'quarantined',callId});
  await expect(action('brainstorm_begin',{callIndex:1,candidateTarget:120,request:{...request(),input:'changed'}})).rejects.toThrow(/immutable/);
  await expect(action('brainstorm_begin',{callIndex:2,candidateTarget:120,request:request(2)})).rejects.toThrow(/not_admissible/);
  expect((await f.db.query('select fluid_private.naming_brain_no_dispatch($1) value',[execution.jobId])).rows).toEqual([{value:false}]);
 });
 it('records actual response, publishes only source-bound constraints and dedups owned history',async()=>{
  const candidates=Array.from({length:100},(_,i)=>({value:`Cedar${i}`,rationale:'Synthetic creative association.',primaryApproach:'real_words',identityKey:`cedar${i}`,graphemeCount:`Cedar${i}`.length,caution:'Unchecked brainstorm. Research and screening are needed before use.'}));
  await action('brainstorm_event',{callId,kind:'created',responseId:'resp_fixture',requestId:'req_fixture',observedAt:'2026-10-29T12:00:00Z'});
  expect((await action('brainstorm_begin',{callIndex:1,candidateTarget:120,request:request()})).result).toMatchObject({dispatch:'retrieve',responseId:'resp_fixture'});
  const response={id:'resp_fixture',status:'completed',model:'gpt-6-luna',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({candidates:candidates.map(({value,rationale,primaryApproach})=>({value,rationale,primaryApproach}))})}]}]};
  const event={callId,kind:'completed',responseId:'resp_fixture',requestId:'req_fixture',model:'gpt-6-luna',observedAt:'2026-10-29T12:01:00Z',response,usage:{input_tokens:5,output_tokens:6,total_tokens:11},candidates};
  await expect(action('brainstorm_event',{...event,candidates:[{...candidates[0],value:'Forged'}]})).rejects.toThrow(/source_mismatch/);
  await action('brainstorm_event',event);
  expect((await action('brainstorm_publish',{callId})).result).toEqual({publishedCount:100,insertedCount:100});
  expect((await action('brainstorm_publish',{callId})).result).toEqual({publishedCount:100,insertedCount:0});
  const candidateIds=(await f.db.query<{id:string}>('select id from public.name_candidates where project_id=$1',[project])).rows.map(x=>x.id);
  const sources=await asRole(f.db,'authenticated',OWNER_A,async()=>(await f.db.query<{v:unknown[]}>('select public.get_naming_brainstorm_sources($1,$2) v',[project,candidateIds])).rows[0]!.v);
  expect(sources).toHaveLength(100);expect(sources[0]).toMatchObject({profile:'brainstorm_v1',callId,responseId:'resp_fixture',runId});
  expect((await f.db.query('select count(*)::integer n from fluid_private.naming_brain_artifacts where run_id=$1',[runId])).rows).toEqual([{n:0}]);
  await expect(action('brainstorm_begin',{callIndex:2,candidateTarget:20,request:request(2)})).rejects.toThrow(/not_admissible/);
 });
 it('derives exact100 completion with a genuine witness and unknown monetary actual',async()=>{
  expect((await action('brainstorm_finish')).result).toEqual({state:'succeeded',publishedCount:100});
  const feed=await brainRpc<{activeRun:Record<string,unknown>}>(f.db,'get_naming_feed',[project,{}]);
  expect(()=>namingFeedSchema.parse(normalizeNamingBrain(feed,OWNER_A))).not.toThrow();
  expect(feed.activeRun).toMatchObject({state:'succeeded',generationProfile:'brainstorm_v1',fulfillment:{status:'complete',acceptedCount:100}});
  expect(feed.activeRun.brainstormCompletionId).toBeTypeOf('string');expect(feed.activeRun).not.toHaveProperty('progressiveCompletionId');
  expect((await f.db.query('select actual_cost_microusd from fluid_private.naming_brain_runs where id=$1',[runId])).rows).toEqual([{actual_cost_microusd:null}]);
  expect((await f.db.query('select count(*)::integer n from fluid_private.naming_brain_progressive_results where run_id=$1',[runId])).rows).toEqual([{n:0}]);
 });
 it('validates actual source proofs and preserves generated authorship only for an untransformed brainstorm copy',async()=>{
  const feed=namingFeedSchema.parse(normalizeNamingBrain(await brainRpc(f.db,'get_naming_feed',[project,{}]),OWNER_A));
  const source=feed.entries[0]!.entry.candidate;
  const proofAuth={userId:OWNER_A,client:{rpc:vi.fn(async(name:string,args:{p_project_id:string;p_candidate_ids:string[]})=>{
   expect(name).toBe('get_naming_brainstorm_sources');
   const data=await asRole(f.db,'authenticated',OWNER_A,async()=>(await f.db.query<{v:unknown}>('select public.get_naming_brainstorm_sources($1,$2) v',[args.p_project_id,args.p_candidate_ids])).rows[0]!.v);
   return {data,error:null};
  })}} as unknown as AuthenticatedContext;
  await expect(verifyBrainstormNamingSource(proofAuth,source)).resolves.toMatchObject({candidateId:source.id,profile:'brainstorm_v1',responseId:'resp_fixture'});
  const promoted=createBrandFromProjectNameResponseSchema.parse(normalizeNamingBrain(await brainRpc(f.db,'create_brand_from_project_name',[project,source.id,1,'Brainstorm brand',false,'brainstorm-copy-direct-001']),OWNER_A));
  expect(promoted.currentSelection.candidate.origin).toMatchObject({kind:'account_copy',authorship:'generated',root:source.origin,history:[]});
  const input={kind:'affixes' as const,seed:source.value,prefixes:['New'],suffixes:[],separator:' ' as const};
  const outputs=transformNames(input);
  const transformed=await brainRpc<{entries:{candidate:unknown}[]}>(f.db,'persist_name_transform',[project,source.id,null,input,{...outputs,candidates:outputs.candidates.map(row=>({...row,identityKey:nameIdentityKey(row.value)}))},'brainstorm-transform-001']);
  const derived=projectNameCandidateSchema.parse(normalizeNamingBrain(transformed.entries[0]!.candidate,OWNER_A));
  expect(derived.origin).toMatchObject({kind:'transform',authorship:'user_supplied',root:source.origin});
  const derivedCopy=createBrandFromProjectNameResponseSchema.parse(normalizeNamingBrain(await brainRpc(f.db,'create_brand_from_project_name',[project,derived.id,1,'Transformed brainstorm brand',false,'brainstorm-copy-derived-001']),OWNER_A));
  expect(derivedCopy.currentSelection.candidate.origin).toMatchObject({kind:'account_copy',authorship:'user_supplied',root:source.origin});
  const replay=namingFeedEnsureResultSchema.parse(normalizeNamingBrain(await brainRpc(f.db,'ensure_shared_naming_brainstorm_run',[project,initialIntent('brainstorm-initial')]),OWNER_A));
  expect(replay.status).toBe('appended');
 });
 it('keeps the genuine full completion row private when the rendered run is cancelled or superseded',async()=>{
  // Disposable state perturbations exercise actual read projections; rollback
  // retains the original completed fixture and performs no provider operation.
  for(const state of ['cancelled','superseded']){
   await f.db.exec('begin');
   try{
    if(state==='superseded')await f.db.query('update fluid_private.naming_brain_runs set superseded=true where id=$1',[runId]);
    else await f.db.query("update public.jobs set state='cancelled'where id=$1",[execution.jobId]);
    const run=namingBrainRunSchema.parse(normalizeNamingBrain(await brainRpc(f.db,'get_naming_brain_run',[project,runId]),OWNER_A));
    expect(run.state).toBe(state);expect(run).not.toHaveProperty('brainstormCompletionId');
    const rawFeed=await brainRpc(f.db,'get_naming_feed',[project,{}]);
    expect(()=>namingFeedSchema.parse(normalizeNamingBrain(rawFeed,OWNER_A))).not.toThrow();
    expect((await f.db.query('select count(*)::integer n from fluid_private.naming_brainstorm_completions where run_id=$1',[runId])).rows).toEqual([{n:1}]);
   }finally{await f.db.exec('rollback');}
  }
 });
 it('allows only two bounded topups when short and reports genuine shortfall',async()=>{
  await startNext('brainstorm-short',OWNER_B);
  for(let index=1;index<=3;index++){
   const begun=(await action('brainstorm_begin',{callIndex:index,candidateTarget:index===1?120:60,request:request(index)})).result;
   const raw={value:`ShortCedar${index}`,rationale:'Synthetic creative association.',primaryApproach:'real_words'};
   const response={id:`resp_short_${index}`,model:'gpt-6-luna',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({candidates:[raw]})}]}]};
   await action('brainstorm_event',{callId:begun.callId,kind:'completed',responseId:response.id,observedAt:'2026-10-29T12:05:00Z',response,candidates:[{...raw,identityKey:raw.value.toLowerCase(),graphemeCount:raw.value.length,caution:'Unchecked brainstorm. Research and screening are needed before use.'}]});
   expect((await action('brainstorm_publish',{callId:begun.callId})).result).toMatchObject({publishedCount:index,insertedCount:1});
   if(index<3)await expect(action('brainstorm_finish')).rejects.toThrow(/topups_remaining/);
  }
  await expect(action('brainstorm_begin',{callIndex:4,candidateTarget:60,request:request(4)})).rejects.toThrow(/invalid_brainstorm_request/);
  expect((await action('brainstorm_finish')).result).toEqual({state:'partial',publishedCount:3});
  const feed=await brainRpc<{activeRun:Record<string,unknown>}>(f.db,'get_naming_feed',[project,{}],OWNER_B);
  expect(()=>namingFeedSchema.parse(normalizeNamingBrain(feed,OWNER_B))).not.toThrow();
  expect(feed.activeRun).toMatchObject({state:'partial',canResume:false,fulfillment:{status:'partial',acceptedCount:3,missingCount:97}});
 });
 it('reports actual uneven approach coverage after 100 names without authorizing coverage-only topups',async()=>{
  await startNext('brainstorm-uneven-coverage',OWNER_A,{...brainPreferences,approaches:['real_words','invented']});
  const begun=(await action('brainstorm_begin',{callIndex:1,candidateTarget:120,request:request()})).result;
  const raw=Array.from({length:100},(_,index)=>({value:`CoverageCedar${index}`,rationale:'Synthetic creative construction.',primaryApproach:'real_words'}));
  const response={id:'resp_uneven_coverage',model:'gpt-6-luna',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({candidates:raw})}]}]};
  await action('brainstorm_event',{callId:begun.callId,kind:'completed',responseId:response.id,requestId:null,observedAt:'2026-10-29T12:09:00Z',response,candidates:raw.map(value=>({...value,identityKey:nameIdentityKey(value.value),graphemeCount:value.value.length,caution:'Unchecked brainstorm. Research and screening are needed before use.'}))});
  expect((await action('brainstorm_publish',{callId:begun.callId})).result).toEqual({publishedCount:100,insertedCount:100});
  expect((await action('brainstorm_finish')).result).toEqual({state:'succeeded',publishedCount:100});
  const feed=namingFeedSchema.parse(normalizeNamingBrain(await brainRpc(f.db,'get_naming_feed',[project,{}]),OWNER_A));
  expect(feed.activeRun).toMatchObject({state:'succeeded',fulfillment:{status:'partial',acceptedCount:100,missingCount:0,coverageSatisfied:false}});
  expect(feed.activeRun!.brainstormCompletionId).toBeTypeOf('string');
  expect(feed.activeRun!.fulfillment!.message).toContain('fewer than five');
  expect((await f.db.query('select count(*)::integer n from fluid_private.naming_brainstorm_calls where run_id=$1',[runId])).rows).toEqual([{n:1}]);
  const replay=namingFeedEnsureResultSchema.parse(normalizeNamingBrain(await brainRpc(f.db,'ensure_shared_naming_brainstorm_run',[project,initialIntent('brainstorm-uneven-coverage')]),OWNER_A));
  expect(replay.status).toBe('appended');
 });
 it('replays an actual historical shared run through the new facade without changing its profile, job, input or predecessor bodies',async()=>{
  // Normal committed RPC boundaries preserve the worker's attestation scope.
  // Cancel only this unused fixture job afterward so final fencing stays isolated.
  let historicalJobId:string|undefined;
  try{
   const historicalProject=(await brainRpc<{id:string}>(f.db,'create_project',['naming_only','Historical shared Naming fixture',{description:'Synthetic historical shared brief'},'c'.repeat(64)])).id;
   const intent=initialIntent('historical-shared-replay-after-brainstorm-install');
   await brainRpc(f.db,'save_naming_preferences',[historicalProject,0,brainPreferences]);
   expect(await brainRpc(f.db,'ensure_shared_naming_brain_run',[historicalProject,intent])).toMatchObject({code:'preferences_validation_pending'});
   const work=(await action('preference_work',[20],null)).result as unknown as {projectId:string;preferencesVersion:number;preferencesHash:string}[];
   const row=work.find(value=>value.projectId===historicalProject)!;
   await action('attest_preferences',[historicalProject,row.preferencesVersion,row.preferencesHash,brainReadinessFingerprint,{ready:true,missing:[]}],null);
   const admitted=namingFeedEnsureResultSchema.parse(normalizeNamingBrain(await brainRpc(f.db,'ensure_shared_naming_brain_run',[historicalProject,intent]),OWNER_A));
   expect(admitted.status).toBe('pending');
   const historicalRun=admitted.feed.activeRun!;historicalJobId=historicalRun.jobId;
   expect(historicalRun).toMatchObject({localPipelineVersion:2,state:'queued'});
   const originalSummary=(await f.db.query<{v:unknown}>('select fluid_private.naming_brainstorm_previous_summary(r) v from fluid_private.naming_brain_runs r where id=$1',[historicalRun.runId])).rows[0]!.v;
   expect(historicalRun).toEqual(normalizeNamingBrain(originalSummary,OWNER_A));
   expect(historicalRun).not.toHaveProperty('generationProfile');expect(historicalRun).not.toHaveProperty('brainstormCompletionId');
   const before=(await f.db.query<{job:Record<string,unknown>}>('select to_jsonb(j) job from public.jobs j where id=$1',[historicalRun.jobId])).rows[0]!.job;
   expect(before.input).toMatchObject({executionAuthority:'hosted_owner_v1',providerBudgetVersion:2,localPipelineVersion:2,localTimingVersion:2});
   expect(before.input).not.toHaveProperty('generationProfile');
   const feed=namingFeedSchema.parse(normalizeNamingBrain(await brainRpc(f.db,'get_naming_feed',[historicalProject,{}]),OWNER_A));
   expect(feed.activeRun).toEqual(historicalRun);
   const replay=namingFeedEnsureResultSchema.parse(normalizeNamingBrain(await brainRpc(f.db,'ensure_shared_naming_brainstorm_run',[historicalProject,intent]),OWNER_A));
   expect(replay.status).toBe('pending');expect(replay.feed.activeRun).toEqual(historicalRun);
   if(replay.status==='pending')expect(replay.reused).toBe(true);
   expect((await f.db.query('select to_jsonb(j) job from public.jobs j where id=$1',[historicalRun.jobId])).rows).toEqual([{job:before}]);
   expect((await f.db.query('select count(*)::integer n from public.jobs where project_id=$1',[historicalProject])).rows).toEqual([{n:1}]);
   const originals=[
    ['fluid_private.naming_brainstorm_previous_worker_action(jsonb,jsonb,text,jsonb)','d7a168d06f92d965d9859fe5f1612dfa'],
    ['fluid_private.naming_brainstorm_previous_summary(fluid_private.naming_brain_runs)','0781ee058a051531e2e81f019fd371d9'],
    ['fluid_private.naming_brainstorm_previous_no_dispatch(uuid)','cd07080fab51d8389aaf441d12a35c39'],
    ['fluid_private.naming_brainstorm_previous_ensure_response(fluid_private.naming_brain_runs,boolean)','5e271baffb34697edb1ca8cd976dc5ac'],
   ];
   for(const [signature,md5]of originals){
    expect((await f.db.query<{h:string}>('select md5(prosrc) h from pg_proc where oid=to_regprocedure($1)',[signature])).rows).toEqual([{h:md5}]);
   }
  }finally{if(historicalJobId)await brainRpc(f.db,'request_job_cancel',[historicalJobId]);}
 });
 it('retains unknown outcomes and permits exact observations after cancellation and fencing',async()=>{
  await startNext('brainstorm-unknown');
  const begun=(await action('brainstorm_begin',{callIndex:1,candidateTarget:120,request:request()})).result;
  await brainRpc(f.db,'request_job_cancel',[execution.jobId]);
  await f.asSlot(slot,()=>f.db.query('select public.fence_shared_worker_slot($1)',[lease]));
  await action('brainstorm_event',{callId:begun.callId,kind:'unknown',responseId:null,requestId:null,observedAt:'2026-10-29T12:06:00Z'});
  expect((await action('brainstorm_finish')).result).toEqual({state:'needs_reconciliation',publishedCount:0});
  await expect(action('brainstorm_begin',{callIndex:2,candidateTarget:60,request:request(2)})).rejects.toThrow(/fenced|closed/);
  await action('brainstorm_event',{callId:begun.callId,kind:'created',responseId:'resp_late_fixture',requestId:null,observedAt:'2026-10-29T12:07:00Z'});
  const response={id:'resp_late_fixture',model:'gpt-6-luna',status:'cancelled',output:[]};
  await action('brainstorm_event',{callId:begun.callId,kind:'completed',responseId:response.id,requestId:null,observedAt:'2026-10-29T12:08:00Z',response,candidates:[]});
  expect((await action('brainstorm_finish')).result).toEqual({state:'cancelled',publishedCount:0});
  expect((await f.db.query('select actual_cost_microusd from fluid_private.naming_brain_runs where id=$1',[runId])).rows).toEqual([{actual_cost_microusd:null}]);
 });

});


describe('Naming brainstorm incremental install predecessors (disposable SQL)',()=>{
 let f:SharedWorkerFixture;let candidate:string;
 const signatures=[
  'public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)',
  'public.ensure_shared_naming_brain_run(uuid,jsonb)',
  'fluid_private.shared_naming_ensure_core(uuid,jsonb)',
  'fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)',
  'fluid_private.naming_brain_ensure_response(fluid_private.naming_brain_runs,boolean)',
  'fluid_private.naming_brain_no_dispatch(uuid)',
  'public.persist_name_transform(uuid,uuid,uuid,jsonb,jsonb,text)',
  'public.create_brand_from_project_name(uuid,uuid,integer,text,boolean,text)',
 ];
 beforeAll(async()=>{
  f=await createSharedWorkerFixture({probe:false});
  await f.db.exec(await readFile(new URL('../../supabase/candidates/shared_worker_naming.sql',import.meta.url),'utf8'));
  candidate=await readFile(new URL('../../supabase/candidates/shared_naming_brainstorm.sql',import.meta.url),'utf8');
 },60_000);
 afterAll(async()=>{await f?.close();});
 it('rejects drift in each exact changed or cloned predecessor before any table or root change',async()=>{
  for(const signature of signatures){
   await f.db.exec('begin');
   try{
    await f.db.exec(`alter function ${signature} set search_path=public`);
    await expect(f.db.exec(candidate)).rejects.toThrow(/brainstorm_predecessor_mismatch/);
   }finally{await f.db.exec('rollback');}
   expect((await f.db.query<{v:string|null}>("select to_regclass('fluid_private.naming_brainstorm_calls')::text v")).rows[0]!.v).toBeNull();
  }
  const definition=(await f.db.query<{v:string}>("select pg_get_functiondef('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)'::regprocedure) v")).rows[0]!.v;
  await f.db.exec('begin');
  try{
   await f.db.exec(definition.replace('AS $function$','AS $function$\n-- synthetic fixture body drift'));
   await expect(f.db.exec(candidate)).rejects.toThrow(/brainstorm_predecessor_mismatch/);
  }finally{await f.db.exec('rollback');}
 });
});
