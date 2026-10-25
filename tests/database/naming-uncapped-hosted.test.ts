import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBrainJobInputSchema, namingBrainRunSchema, namingBrainRunSummarySchema, namingProviderReceiptSchema } from "../../src/domain/naming-brain";
import { createProgressiveNamingAssignment } from "../../src/server/ai/naming-brain/progressive-assignments";
import { buildNamingManagedRequest } from "../../src/server/ai/naming-brain/prompts";
import { normalizeNamingStoredJson } from "../../worker/naming-brain-store";
import { receipt } from "../domain/naming-brain-fixtures";
import { createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "./local-supabase";
import { brainRpc, brainWorker, installBrainFixture } from "./naming-brain-fixture";
import { seedHostedNamingFixture } from "./hosted-naming-fixture";
import { progressiveRequest } from "./naming-brain-progressive-fixture";

const migration = "20261025232300_naming_uncapped_hosted_execution.sql";
type HostedFixture = Awaited<ReturnType<typeof seedHostedNamingFixture>>;
const creatorRequest = (f: HostedFixture, index: number) => progressiveRequest(f, `part${String(index).padStart(3,"0")}.creation`, {
 role:"creator",snapshot:f.input.snapshot,assignment:createProgressiveNamingAssignment({runId:f.input.runId,snapshot:f.input.snapshot,partIndex:index,approach:"real_words",targetCount:4}),
});
async function accounting(db: TestDatabase, f: HostedFixture) {
 return {
  reservations:(await db.query("select * from public.usage_reservations where job_id=$1",[f.job.id])).rows,
  account:(await db.query("select limit_microusd,reserved_microusd,spent_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows,
  run:(await db.query("select actual_cost_microusd,settlement_evidence from fluid_private.naming_brain_runs where id=$1",[f.input.runId])).rows,
 };
}

describe("future hosted uncapped native Naming (disposable SQL only)",()=>{
 let db:TestDatabase,f:HostedFixture;
 beforeAll(async()=>{db=await createTestDatabase();await installBrainFixture(db);},60_000);
 beforeEach(async()=>{f=await seedHostedNamingFixture(db);});
 afterAll(async()=>{await db?.close();});

 it("admits the new owned execution witness and retains idempotent bookkeeping without a provider cap",async()=>{
  expect(f.input).toMatchObject({providerBudgetVersion:2,executionAuthority:"hosted_owner_v1",localPipelineVersion:2,localTimingVersion:2});
  const request=creatorRequest(f,0),wire=buildNamingManagedRequest(request);
  expect(request.policy).toMatchObject({budgetControl:"local_unlimited_v1",localPipelineVersion:2,progressiveContractVersion:3});
  expect(request.policy.providerSpendCapCents).toBeUndefined();expect(wire).not.toHaveProperty("spend_control");
  const before=await accounting(db,f),input=(await db.query("select input,input_hash from public.jobs where id=$1",[f.job.id])).rows;
  expect(await brainRpc(db,"ensure_hosted_naming_brain_run",[f.project,f.intent])).toMatchObject({status:"pending",reused:true,run:{runId:f.input.runId,providerBudgetVersion:2}});
  expect((await db.query("select count(*)::int count from public.jobs where project_id=$1",[f.project])).rows).toEqual([{count:1}]);
  expect((await db.query("select input,input_hash from public.jobs where id=$1",[f.job.id])).rows).toEqual(input);
  expect(await accounting(db,f)).toEqual(before);expect(before.run).toEqual([{actual_cost_microusd:null,settlement_evidence:null}]);
  const run=namingBrainRunSchema.parse(normalizeNamingStoredJson(await brainRpc(db,"get_naming_brain_run",[f.project,f.input.runId])));
  expect(run.providerBudgetVersion).toBe(2);
  const summary=Object.fromEntries(Object.entries(run).filter(([key])=>key!=="snapshot"&&key!=="stages"));
  expect(namingBrainRunSummarySchema.parse(summary).providerBudgetVersion).toBe(2);
  expect(namingBrainRunSummarySchema.safeParse({...summary,executionAuthority:undefined}).success).toBe(false);
  expect(namingBrainRunSchema.safeParse({...run,executionAuthority:undefined}).success).toBe(false);
  for(const patch of [{executionAuthority:undefined},{localPipelineVersion:undefined},{localTimingVersion:undefined},{providerBudgetVersion:3}])
   expect(namingBrainJobInputSchema.safeParse({...f.input,...patch}).success).toBe(false);
 });

 it("plans and authorizes more than 500 nominal cents without a monetary gate or invented expense",async()=>{
  const before=await accounting(db,f);
  for(let index=0;index<6;index++){
   const request=creatorRequest(f,index),phase=`part${String(index).padStart(3,"0")}.creation` as const;
   await brainWorker(db,()=>f.store.saveProgressiveCallPlan(f.job,phase,[request]));
   await brainWorker(db,()=>f.store.authorizeDispatch(f.job,request));
  }
  expect((await db.query("select sum((request#>>'{policy,sessionLimitCents}')::int)::int nominal,count(*)::int calls from fluid_private.naming_brain_calls where run_id=$1",[f.input.runId])).rows).toEqual([{nominal:900,calls:6}]);
  expect((await db.query("select sum(fluid_private.naming_progressive_provider_cap($2::jsonb,request))::int allocated from fluid_private.naming_brain_calls where run_id=$1",[f.input.runId,JSON.stringify(f.input)])).rows).toEqual([{allocated:0}]);
  expect(await accounting(db,f)).toEqual(before);
 });

 it("refuses a smuggled provider cap and incomplete uncapped witnesses",async()=>{
  const request=creatorRequest(f,0),capped={...request,policy:{...request.policy,providerSpendCapCents:request.policy.sessionLimitCents}};
  await expect(brainWorker(db,()=>f.store.saveProgressiveCallPlan(f.job,"part000.creation",[capped]))).rejects.toThrow("invalid_uncapped_provider_budget");
  for(const [input,raw] of [
   [{...f.input,executionAuthority:undefined},request],
   [{...f.input,localTimingVersion:undefined},request],
   [f.input,{...request,policy:{...request.policy,budgetControl:undefined}}],
   [f.input,{...request,policy:{...request.policy,localPipelineVersion:undefined}}],
  ])await expect(db.query("select fluid_private.naming_progressive_provider_cap($1::jsonb,$2::jsonb)",[JSON.stringify(input),JSON.stringify(raw)])).rejects.toThrow("invalid_uncapped_provider_budget");
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_progressive_plans where run_id=$1",[f.input.runId])).rows).toEqual([{count:0}]);
 });

 it("retains high observed usage without pausing uncapped dispatch or treating usage as final billing",async()=>{
  const before=await accounting(db,f),request=progressiveRequest(f,"context.research",{role:"researcher",snapshot:f.input.snapshot});
  await brainWorker(db,()=>f.store.saveProgressiveCallPlan(f.job,"context.research",[request]));
  await brainWorker(db,()=>f.store.authorizeDispatch(f.job,request));
  const value=namingProviderReceiptSchema.parse({...receipt("creation","researcher"),budgetControl:"local_unlimited_v1",localPipelineVersion:2,
   sessionLimitCents:request.policy.sessionLimitCents,runId:f.input.runId,snapshotHash:request.snapshotHash,requestKey:request.requestKey,requestHash:request.requestHash,
   providerCallKey:request.providerCallKey,assignmentKey:null,observedModel:request.policy.model,
   providerCostCounters:[{scope:"session",scopeId:"synthetic-high-observation",kind:"consumed_usd_cents",value:10_000,observedAt:new Date().toISOString()}]});
  await brainWorker(db,()=>f.store.recordReceipt(f.job,value));
  expect((await db.query("select observed_overrun,actual_cost_microusd,fluid_private.local_naming_progressive_current(r) current from fluid_private.naming_brain_runs r where id=$1",[f.input.runId])).rows).toEqual([{observed_overrun:false,actual_cost_microusd:null,current:true}]);
  const next=creatorRequest(f,0);await brainWorker(db,()=>f.store.saveProgressiveCallPlan(f.job,"part000.creation",[next]));
  await brainWorker(db,()=>f.store.authorizeDispatch(f.job,next));
  expect((await db.query("select receipt from fluid_private.naming_brain_receipts where run_id=$1",[f.input.runId])).rows).toEqual([{receipt:value}]);
  expect(await accounting(db,f)).toEqual(before);
 });

 it("retains tenant, exact-request and Stop fences after removing monetary limits",async()=>{
  const first=creatorRequest(f,0),pending=creatorRequest(f,1);
  await brainWorker(db,()=>f.store.saveProgressiveCallPlan(f.job,"part000.creation",[first]));
  await brainWorker(db,()=>f.store.saveProgressiveCallPlan(f.job,"part001.creation",[pending]));
  await brainWorker(db,()=>f.store.authorizeDispatch(f.job,first));
  await expect(brainWorker(db,()=>f.store.authorizeDispatch(f.job,first))).rejects.toThrow();
  await expect(brainRpc(db,"ensure_hosted_naming_brain_run",[f.project,f.intent],OWNER_B)).rejects.toMatchObject({code:"P0002"});
  await expect(brainWorker(db,()=>f.store.loadProgressiveState(f.job),OWNER_B)).rejects.toMatchObject({code:"42501"});
  const before=await accounting(db,f),stop={version:1,expectedDemandSequence:0,pendingEnsureIdempotencyKey:null,idempotencyKey:"synthetic-uncapped-stop"};
  const stopped=await brainRpc(db,"stop_naming_feed",[f.project,stop]);
  expect(await brainRpc(db,"stop_naming_feed",[f.project,stop])).toEqual(stopped);
  await expect(brainWorker(db,()=>f.store.authorizeDispatch(f.job,pending))).rejects.toThrow();
  expect((await db.query("select count(*)::int count from fluid_private.naming_brain_calls where run_id=$1",[f.input.runId])).rows).toEqual([{count:1}]);
  expect(await accounting(db,f)).toEqual(before);
 });
});

it("upgrades historical capped admissions without changing their evidence or grants",async()=>{
 const db=await createTestDatabase({before:migration});
 try{
  await installBrainFixture(db);const f=await seedHostedNamingFixture(db),request=creatorRequest(f,0);
  expect(f.input.providerBudgetVersion).toBe(1);expect(request.policy.providerSpendCapCents).toBe(10);
  await brainWorker(db,()=>f.store.saveProgressiveCallPlan(f.job,"part000.creation",[request]));
  const snapshot=async()=>({
   jobs:(await db.query("select to_jsonb(j) row from public.jobs j")).rows,
   plans:(await db.query("select to_jsonb(p) row from fluid_private.naming_brain_progressive_plans p")).rows,
   accounting:await accounting(db,f),
   acl:(await db.query("select oid,proowner,proacl,prosecdef,proconfig from pg_proc where oid in('public.ensure_naming_brain_run(uuid,jsonb)'::regprocedure,'fluid_private.naming_progressive_provider_cap(jsonb,jsonb)'::regprocedure,'fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)'::regprocedure) order by oid")).rows,
  });
  const before=await snapshot();await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`,import.meta.url),"utf8"));
  expect(await snapshot()).toEqual(before);
  await brainWorker(db,()=>f.store.authorizeDispatch(f.job,request));
  expect((await db.query("select fluid_private.naming_progressive_provider_cap($1::jsonb,$2::jsonb) cap",[JSON.stringify(f.input),JSON.stringify(request)])).rows).toEqual([{cap:10}]);
  await expect(db.query("select fluid_private.naming_progressive_provider_cap($1::jsonb,$2::jsonb)",[JSON.stringify(f.input),JSON.stringify({...request,policy:{...request.policy,providerSpendCapCents:undefined}})])).rejects.toThrow("provider_budget_required");
  expect((await db.query("select request from fluid_private.naming_brain_calls where run_id=$1",[f.input.runId])).rows).toEqual([{request}]);
 }finally{await db.close();}
},60_000);

it.each([true,false])("retains capped create evidence and permits only a proven terminal's explicit new uncapped Resume (known rejection=%s)",async knownRejection=>{
 const db=await createTestDatabase({before:migration});
 try{
  await installBrainFixture(db);const f=await seedHostedNamingFixture(db),request=progressiveRequest(f,"context.research",{role:"researcher",snapshot:f.input.snapshot});
  await brainWorker(db,()=>f.store.saveProgressiveCallPlan(f.job,"context.research",[request]));
  await brainWorker(db,()=>f.store.authorizeDispatch(f.job,request));
  const value=namingProviderReceiptSchema.parse({...receipt("creation","researcher"),budgetControl:"local_unlimited_v1",localPipelineVersion:2,providerSpendCapCents:25,
   sessionLimitCents:25,runId:f.input.runId,snapshotHash:request.snapshotHash,requestKey:request.requestKey,requestHash:request.requestHash,
   providerCallKey:request.providerCallKey,assignmentKey:null,observedModel:request.policy.model,dispatchState:knownRejection?"not_dispatched":"unknown",
   requestId:knownRejection?"req_synthetic_capped_http400":null,sessionId:null,turnId:null,agentId:null,responseId:null,
   callIds:[],toolCalls:[],artifactItemIds:[],usageObservations:[],providerCostCounters:[]});
  await brainWorker(db,()=>f.store.recordReceipt(f.job,value));
  await brainWorker(db,()=>f.store.completeStep(f.job,"creation",{
   status:knownRejection?"failed":"needs_reconciliation",code:knownRejection?"provider_request_rejected":"provider_outcome_unknown",costMicrousd:0,providerRequestId:value.requestId,
   result:{artifactIds:[],errorCode:knownRejection?"provider_request_rejected":"provider_outcome_unknown",...(knownRejection?{partialArtifacts:[{type:"provider_failure",code:"provider_configuration_rejected",retryable:false}]}:{})},
  }));
  if(knownRejection)await brainWorker(db,()=>f.store.finish(f.job,"failed"));
  const oldEvidence=async()=>({
   job:(await db.query("select to_jsonb(j) row from public.jobs j where id=$1",[f.job.id])).rows,
   request:(await db.query("select request from fluid_private.naming_brain_calls where run_id=$1",[f.input.runId])).rows,
   receipts:(await db.query("select receipt from fluid_private.naming_brain_receipts where run_id=$1",[f.input.runId])).rows,
   holds:(await db.query("select * from public.usage_reservations where job_id=$1",[f.job.id])).rows,
   actual:(await db.query("select actual_cost_microusd,settlement_evidence from fluid_private.naming_brain_runs where id=$1",[f.input.runId])).rows,
  });
  const before=await oldEvidence();await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`,import.meta.url),"utf8"));
  const initial=await brainRpc(db,"ensure_hosted_naming_brain_run",[f.project,{...f.intent,idempotencyKey:"synthetic-uncapped-new-initial"}]);
  if(knownRejection)expect(initial).toMatchObject({run:{runId:f.input.runId}});
  else expect(initial).toMatchObject({status:"blocked",code:"dispatch_unresolved"});
  const run=namingBrainRunSchema.parse(normalizeNamingStoredJson(await brainRpc(db,"get_naming_brain_run",[f.project,f.input.runId])));
  const intent={...f.intent,idempotencyKey:"synthetic-uncapped-resume",reason:"resume",resumeOfRunId:f.input.runId,expectedRunRevision:run.revision};
  if(knownRejection){
   const next=await brainRpc(db,"ensure_hosted_naming_brain_run",[f.project,intent]);
   expect(next).toMatchObject({status:"pending",reused:false,run:{providerBudgetVersion:2,resumedFromRunId:f.input.runId}});
   expect((await db.query("select count(*)::int count from public.jobs where project_id=$1",[f.project])).rows).toEqual([{count:2}]);
   expect(await brainRpc(db,"ensure_hosted_naming_brain_run",[f.project,intent])).toMatchObject({status:"pending",reused:true});
  }else{
   await expect(brainRpc(db,"ensure_hosted_naming_brain_run",[f.project,intent])).rejects.toThrow("resume_conflict");
   expect((await db.query("select count(*)::int count from public.jobs where project_id=$1",[f.project])).rows).toEqual([{count:1}]);
  }
  expect(await oldEvidence()).toEqual(before);expect(before.actual).toEqual([{actual_cost_microusd:null,settlement_evidence:null}]);
 }finally{await db.close();}
},60_000);
