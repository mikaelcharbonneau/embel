import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {createTestDatabase,OWNER_A,type TestDatabase} from "./local-supabase";
import {attestBrainPreferences,brainGapEnvelope,brainManifest,beginBrainStage,brainAction,brainPreferences,brainRpc,brainWorker,claimBrain,initialIntent,installBrainFixture,planBrainCall,prepareBrainFixture,seedBrainFixture,startBrainFixture} from "./naming-brain-fixture";
import {getNamingPreferencesReadiness} from "../../src/domain/naming-brain-preferences";
type Run={runId:string;jobId:string;revision:number;canResume:boolean;demandSequence:number};
type Result={status:string;code?:string;run:Run;feed:{demandSequence:number;activeRun:Run};appendedEntryIds:string[]};
const stop=(sequence:number,key="fixture-review-stop-key",pending:string|null=null)=>({version:1,expectedDemandSequence:sequence,pendingEnsureIdempotencyKey:pending,idempotencyKey:key});
describe("Naming persistence review regressions",()=>{
 let db:TestDatabase;let project:string;
 beforeAll(async()=>{db=await createTestDatabase();await installBrainFixture(db);},30000);afterAll(async()=>{await db?.close();});beforeEach(async()=>{project=await seedBrainFixture(db);});
 const ensure=(intent:unknown)=>brainRpc<Result>(db,"ensure_naming_brain_run",[project,intent]);
 const read=(id:string)=>brainRpc<Run>(db,"get_naming_brain_run",[project,id]);
 const finishPrepared=async(job:Awaited<ReturnType<typeof startBrainFixture>>)=>{await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'prepare','succeeded','{\"artifactIds\":[]}')",[job.id,job.lease_token]));await brainAction(db,job,"finish",{state:"succeeded",errorCode:null});};
 async function ledger(){return (await db.query<{runs:number;batches:number;receipts:number;reserved:number;heads:unknown}>("select (select count(*) from fluid_private.naming_brain_runs)::integer runs,(select count(*) from public.naming_batches)::integer batches,(select count(*) from fluid_private.naming_brain_intents)::integer receipts,(select coalesce(sum(reserved_microusd),0) from public.usage_accounts)::integer reserved,(select coalesce(jsonb_agg(to_jsonb(h)),'[]') from fluid_private.naming_brain_heads h) heads")).rows[0];}
 it.each(["stop","ambiguous","disabled","superseded"])("R1 observes known sessions after %s without new inference",async(reason)=>{
  const job=await startBrainFixture(db,project);await beginBrainStage(db,job,"research");const {request,allocation,snapshot}=await planBrainCall(db,job,"research");
  await brainWorker(db,()=>db.query("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(request)]));
  const receipt={version:1,provider:"openai",billingMode:"openai_api",runId:job.input.runId,stageKey:"research",role:"researcher",snapshotHash:snapshot.snapshotHash,protocol:"openai_agents",providerCallKey:allocation.providerCallKey,assignmentKey:null,requestKey:allocation.requestKey,requestHash:allocation.requestHash,sessionLimitCents:75,dispatchState:"dispatched",requestId:null,callIds:[],observedModel:"synthetic-fixture-model",toolCalls:[],artifactItemIds:[],usageObservations:[],estimatedCostMicrousd:null,providerCostCounters:[],accountingStatus:"provisional",confirmedActualCostMicrousd:null,recordedAt:"2026-10-16T12:00:00Z",sessionId:"fixture-known-session",turnId:null,agentId:null,responseId:null};
  await brainWorker(db,()=>db.query("select public.record_naming_brain_provider_receipt($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(receipt)]));
  if(reason==="stop")await brainRpc(db,"stop_naming_feed",[project,stop(0)]);
  if(reason==="disabled")await db.query("update fluid_private.naming_brain_pilots set enabled=false,ready_until=null where owner_id=$1",[OWNER_A]);
  if(reason==="superseded")await db.query("update fluid_private.naming_brain_runs set superseded=true where id=$1",[job.input.runId]);
  if(reason==="ambiguous")await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'research','ambiguous','{\"artifactIds\":[],\"errorCode\":\"fixture_unknown_turn\"}')",[job.id,job.lease_token]));
  else{await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[job.id]);await brainWorker(db,()=>db.query("select public.expire_naming_brain_leases('fixture-worker','fixture-deployment')"));}
  const claimed=await claimBrain(db);expect(claimed).not.toBeNull();expect(claimed.mode).toBe("observe_only");
  expect(await beginBrainStage(db,claimed.job,"research")).toMatchObject({disposition:"resume_observation"});
  expect(await brainAction(db,claimed.job,"heartbeat",{leaseSeconds:120})).toMatchObject({recoveryMode:"observe_only"});
  expect((await brainWorker(db,()=>db.query<{ok:boolean}>("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb) ok",[claimed.job.id,claimed.job.lease_token,JSON.stringify(request)]))).rows[0]!.ok).toBe(false);
  expect(await brainAction(db,claimed.job,"resume_execution",{stageKey:"research"})).toMatchObject({recoveryMode:"observe_only",resumed:false});
  expect((await read(job.input.runId)).canResume).toBe(false);
 });
 it.each([true,false])("R2 exposed partial uses paid Resume; admission available=%s",async(available)=>{
  const {job,preparedSetId}=await prepareBrainFixture(db,project,1);await finishPrepared(job);await brainRpc(db,"append_prepared_naming_set",[project,preparedSetId]);await brainRpc(db,"stop_naming_feed",[project,stop(0)]);
  if(!available)await db.query("update fluid_private.naming_brain_pilots set enabled=false where owner_id=$1",[OWNER_A]);
  const source=await read(job.input.runId);expect(source.canResume).toBe(available);const intent={...initialIntent("fixture-review-partial-resume"),reason:"resume",expectedDemandSequence:1,resumeOfRunId:source.runId,expectedRunRevision:source.revision};
  if(available){const result=await ensure(intent);expect(result.status).toBe("pending");expect(result.run.runId).not.toBe(source.runId);expect(await ledger()).toMatchObject({runs:2,reserved:10000000});}
  else{const before=await ledger();await expect(ensure(intent)).rejects.toMatchObject({code:"PT409"});expect(await ledger()).toEqual(before);}
 });
 it("R2 consumes eligible unexposed partial membership without paid readiness",async()=>{
  const {job}=await prepareBrainFixture(db,project,1);await finishPrepared(job);await brainRpc(db,"stop_naming_feed",[project,stop(0)]);await db.query("update fluid_private.naming_brain_pilots set enabled=false where owner_id=$1",[OWNER_A]);
  const source=await read(job.input.runId);expect(source.canResume).toBe(true);
  const result=await ensure({...initialIntent("fixture-unexposed-free-resume"),reason:"resume",expectedDemandSequence:1,resumeOfRunId:source.runId,expectedRunRevision:source.revision});expect(result.status).toBe("appended");expect(result.appendedEntryIds).toHaveLength(1);expect(await ledger()).toMatchObject({runs:1,reserved:5000000});
 });
 it("R4 does not rebase a delayed paid Resume receipt onto a later free continuation",async()=>{
  const first=await ensure(initialIntent());await brainRpc(db,"request_job_cancel",[first.run.jobId]);const source=await read(first.run.runId);
  const intent={...initialIntent("fixture-original-paid-resume"),reason:"resume",resumeOfRunId:source.runId,expectedRunRevision:source.revision};const child=await ensure(intent);
  const claimed=await claimBrain(db);await brainAction(db,claimed.job,"plan",{manifest:brainManifest,gapEnvelope:brainGapEnvelope});
  const {job}=await prepareBrainFixture(db,project,100,claimed.job);await finishPrepared(job);await brainRpc(db,"stop_naming_feed",[project,stop(1)]);
  const complete=await read(child.run.runId);await ensure({...initialIntent("fixture-later-free-resume"),reason:"resume",expectedDemandSequence:2,resumeOfRunId:complete.runId,expectedRunRevision:complete.revision});
  const delayedKey="fixture-delayed-paid-duplicate";const before=await ledger();await expect(ensure({...intent,idempotencyKey:delayedKey})).rejects.toMatchObject({code:"PT409"});
  await expect(brainRpc(db,"stop_naming_feed",[project,stop(0,"fixture-delayed-duplicate-stop",delayedKey)])).rejects.toMatchObject({code:"PT409"});expect(await ledger()).toEqual(before);
  expect((await db.query<{sequence:number}>("select (response->>'committedDemandSequence')::integer sequence from fluid_private.naming_brain_intents where request_key=$1",[intent.idempotencyKey])).rows[0]!.sequence).toBe(1);
 });
 it("R3 rejects malformed direct intents atomically, including null Resume revision",async()=>{
  const {job,preparedSet}=await prepareBrainFixture(db,project,1);await finishPrepared(job);
  const steering={expectedProjectRevision:1,expectedPreferencesVersion:1,expectedSteeringRevision:0,candidateIds:[preparedSet.candidateIds[0]],instruction:null,idempotencyKey:"fixture-review-steer-key"};
  const invalid=[{...steering,expectedProjectRevision:null},{...steering,expectedSteeringRevision:null},{...steering,expectedPreferencesVersion:"1"},{...steering,instruction:"x".repeat(3000)},{...steering,instruction:2},{...steering,instruction:"\u200b"},{...steering,instruction:"hi\nthere"},{...steering,extra:true},{...steering,candidateIds:[2]}];
  for(const value of invalid){const before=await ledger();await expect(brainRpc(db,"steer_naming_feed",[project,value])).rejects.toMatchObject({code:"22023"});expect(await ledger()).toEqual(before);}
  const source=await read(job.input.runId);for(const value of [null,"1",0,-1,1.5,9007199254740992]){const before=await ledger();await expect(ensure({...initialIntent("fixture-review-invalid-resume"),reason:"resume",resumeOfRunId:source.runId,expectedRunRevision:value})).rejects.toMatchObject({code:"22023"});expect(await ledger()).toEqual(before);}
  for(const value of [null,{...initialIntent(),reason:null},{...initialIntent(),expectedProjectRevision:0},{...initialIntent(),consumedThrough:{entryId:crypto.randomUUID(),position:1,extra:1}}]){const before=await ledger();await expect(ensure(value)).rejects.toMatchObject({code:"22023"});expect(await ledger()).toEqual(before);}
  for(const value of [null,{...stop(0),expectedDemandSequence:null},{...stop(0),pendingEnsureIdempotencyKey:123},{...stop(0),idempotencyKey:1234567890123456}]){const before=await ledger();await expect(brainRpc(db,"stop_naming_feed",[project,value])).rejects.toMatchObject({code:"22023"});expect(await ledger()).toEqual(before);}
 });
 it.each([{requiredText:["cedar"],excludedText:["cedar"]},{requiredText:["cedar"],maximumGraphemes:3}])("R5 blocks unusable saved drafts before any reservation: %j",async(patch)=>{
  const preferences={...brainPreferences,...patch};expect(getNamingPreferencesReadiness(preferences as Parameters<typeof getNamingPreferencesReadiness>[0]).ready).toBe(false);
  await brainRpc(db,"save_naming_preferences",[project,1,preferences]);await attestBrainPreferences(db);const before=await ledger();expect(await ensure({...initialIntent(),expectedPreferencesVersion:2})).toMatchObject({status:"blocked",code:"preferences_incomplete"});expect(await ledger()).toMatchObject({runs:before!.runs,batches:before!.batches,receipts:before!.receipts,reserved:before!.reserved});
 });
});
