import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {createTestDatabase,OWNER_A,type TestDatabase} from "./local-supabase";
import {beginBrainStage,brainAction,brainRpc,brainWorker,claimBrain,installBrainFixture,planBrainCall,prepareBrainFixture,saveBrainArtifact,seedBrainFixture,startBrainFixture} from "./naming-brain-fixture";
describe("Bounded Naming observation and resumed execution",()=>{
 let db:TestDatabase;let project:string;
 beforeAll(async()=>{db=await createTestDatabase();await installBrainFixture(db);},30000);afterAll(async()=>{await db?.close();});beforeEach(async()=>{project=await seedBrainFixture(db);});
 const expire=async(job:{id:string})=>{await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[job.id]);await brainWorker(db,()=>db.query("select public.expire_naming_brain_leases('fixture-worker','fixture-deployment')"));};
 async function knownCall(){const job=await startBrainFixture(db,project);await beginBrainStage(db,job,"research");const {request,allocation,snapshot}=await planBrainCall(db,job,"research");await brainWorker(db,()=>db.query("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(request)]));
  const receipt={version:1,provider:"openai",billingMode:"openai_api",runId:job.input.runId,stageKey:"research",role:"researcher",snapshotHash:snapshot.snapshotHash,protocol:"openai_agents",providerCallKey:allocation.providerCallKey,assignmentKey:null,requestKey:allocation.requestKey,requestHash:allocation.requestHash,sessionLimitCents:75,dispatchState:"dispatched",requestId:null,callIds:[],observedModel:"synthetic-fixture-model",toolCalls:[],artifactItemIds:[],usageObservations:[],estimatedCostMicrousd:null,providerCostCounters:[],accountingStatus:"provisional",confirmedActualCostMicrousd:null,recordedAt:"2026-10-16T12:00:00Z",sessionId:"fixture-known-session",turnId:null as string|null,agentId:null,responseId:null};
  await brainWorker(db,()=>db.query("select public.record_naming_brain_provider_receipt($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(receipt)]));return{job,request,receipt};}
 it("retains ambiguous history and real terminal observations after Stop/policy withdrawal, without releasing liability",async()=>{
  const {job,request,receipt}=await knownCall();await brainRpc(db,"request_job_cancel",[job.id]);
  const unresolved={artifactIds:[],errorCode:"fixture_unknown_turn"};await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'research','ambiguous',$3::jsonb)",[job.id,job.lease_token,JSON.stringify(unresolved)]));
  await db.query("update fluid_private.naming_brain_pilots set enabled=false,ready_until=null where owner_id=$1",[OWNER_A]);
  const observed=await claimBrain(db);expect(observed.mode).toBe("observe_only");job.lease_token=observed.job.lease_token;
  receipt.turnId="fixture-observed-turn";await brainWorker(db,()=>db.query("select public.record_naming_brain_provider_receipt($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(receipt)]));
  const turn={id:receipt.turnId,session_id:receipt.sessionId,agent_id:"fixture-agent",subagent_id:null,object:"agent.session.turn",status:"cancelled",created_at:1,started_at:1,completed_at:2,error:null,usage:null};
  const payload={providerCallKey:receipt.providerCallKey,sessionId:receipt.sessionId,turnId:receipt.turnId,turn};
  for(const forged of [{...payload,providerCallKey:"foreign-call"},{...payload,sessionId:"foreign-session"},{...payload,turn:{...turn,status:"in_progress"}},{...payload,turn:{...turn,id:"foreign-turn"}},{...payload,turn:{...turn,subagent_id:"invented-child"}}])await expect(brainAction(db,job,"provider_turn",forged)).rejects.toMatchObject({code:"22023"});
  await brainAction(db,job,"provider_turn",payload);await brainAction(db,job,"provider_turn",{...payload,turn:{...turn,usage:{input_tokens:4,output_tokens:2}}});
  await expect(brainAction(db,job,"provider_turn",{...payload,turn:{...turn,status:"completed"}})).rejects.toMatchObject({code:"55000"});
  expect((await brainAction(db,job,"stage",{stageKey:"research"}) as {providerTurns:unknown[]}).providerTurns).toHaveLength(2);
  await expect(brainAction(db,job,"tool_result",{providerCallKey:receipt.providerCallKey,sessionId:receipt.sessionId,turnId:receipt.turnId,callId:"fixture-new-tool",requestHash:request.requestHash,result:{},sourceEvidence:null})).rejects.toMatchObject({code:"55000"});
  await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'research','failed','{\"artifactIds\":[],\"errorCode\":\"provider_cancelled\"}')",[job.id,job.lease_token]));await brainAction(db,job,"finish",{state:"cancelled",errorCode:null});
  const history=(await db.query<{output:unknown}>("select output from fluid_private.naming_brain_stage_results where run_id=$1 order by created_at,id",[job.input.runId])).rows;expect(history).toHaveLength(2);expect(history[0]!.output).toEqual(unresolved);
  expect(await brainRpc(db,"get_naming_brain_job_accounting",[job.id])).toEqual({status:"held_unsettled",heldAllowanceMicrousd:5000000,confirmedActualCostMicrousd:null});
 });
 it.each(["failed","malformed_json","schema_invalid","later_schema_invalid","paused_failed"])("handles known terminal gap %s only through the real registered prepare stage",async(mode)=>{
  const preparing=prepareBrainFixture(db,project,1,undefined,async(job)=>{
   const snapshot=(await db.query<{snapshot:Record<string,unknown>}>("select snapshot from fluid_private.naming_brain_runs where id=$1",[job.input.runId])).rows[0]!.snapshot;
   const later=mode==="later_schema_invalid";
   const base=(await db.query<{receipt:Record<string,unknown>}>("select receipt from fluid_private.naming_brain_receipts where run_id=$1 and stage_key='research' limit 1",[job.input.runId])).rows[0]!.receipt;
   if(later){
    const first={providerCallKey:"fixture-valid-gap-director",assignmentKey:null,requestKey:"fixture-valid-gap-director-request",requestHash:"d".repeat(64),sessionLimitCents:10,maxWebSearchCalls:0,role:"director"};
    await brainAction(db,job,"call_plan",{stageKey:"gap",phase:"direction",calls:[first]});
    const firstRequest={...first,runId:job.input.runId,stageKey:"gap",snapshotHash:snapshot.snapshotHash,input:{role:"director",snapshot},dependencyArtifactIds:[],policy:{model:"synthetic-fixture-model",protocol:"openai_agents",nativeDelegation:false,maximumCostMicrousd:100000,sessionLimitCents:10,maxWebSearchCalls:0}};
    await brainWorker(db,()=>db.query("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(firstRequest)]));
    const firstReceipt={...base,...first,stageKey:"gap",sessionId:"fixture-valid-gap-session",turnId:"fixture-valid-gap-turn",artifactItemIds:["fixture-valid-gap-item"]};
    delete (firstReceipt as Partial<typeof first>).maxWebSearchCalls;
    await brainWorker(db,()=>db.query("select public.record_naming_brain_provider_receipt($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(firstReceipt)]));
    const output={role:"director",round:"gap",assignments:[{assignmentKey:"gap-real",primaryApproach:"real_words",additionalApproaches:[],territoryId:"nature",constructionKey:"whole_word",direction:"Synthetic bounded gap.",targetCount:50,sourceKeys:[],avoidPatterns:[],freshTerritory:true}],feedbackHypotheses:[]};
    await brainAction(db,job,"provider_item",{providerCallKey:first.providerCallKey,sessionId:firstReceipt.sessionId,turnId:firstReceipt.turnId,itemId:"fixture-valid-gap-item",item:{id:"fixture-valid-gap-item",turn_id:firstReceipt.turnId,type:"message",role:"assistant",phase:"final_answer",status:"completed",content:[{type:"output_text",text:JSON.stringify(output)}]}});
    await brainAction(db,job,"provider_turn",{providerCallKey:first.providerCallKey,sessionId:firstReceipt.sessionId,turnId:firstReceipt.turnId,turn:{id:firstReceipt.turnId,session_id:firstReceipt.sessionId,agent_id:"fixture-agent",subagent_id:null,object:"agent.session.turn",status:"completed",created_at:1,started_at:1,completed_at:2,error:null,usage:null}});
    await brainAction(db,job,"artifact",{artifact:{artifactId:crypto.randomUUID(),runId:job.input.runId,stageKey:"gap",snapshotHash:snapshot.snapshotHash,schemaVersion:1,promptVersion:"naming-brain-v1",providerReceipt:firstReceipt,output}});
   }
   const allocation={providerCallKey:"fixture-gap-terminal-role",assignmentKey:later?"gap-real":null,requestKey:"fixture-gap-terminal-request",requestHash:"c".repeat(64),sessionLimitCents:later?40:10,maxWebSearchCalls:0,role:later?"creator":"director"};
   await brainAction(db,job,"call_plan",{stageKey:"gap",phase:later?"creation":"direction",calls:[allocation]});
   const request={...allocation,runId:job.input.runId,stageKey:"gap",snapshotHash:snapshot.snapshotHash,input:{role:allocation.role,snapshot},dependencyArtifactIds:[],policy:{model:"synthetic-fixture-model",protocol:"openai_agents",nativeDelegation:false,maximumCostMicrousd:allocation.sessionLimitCents*10000,sessionLimitCents:allocation.sessionLimitCents,maxWebSearchCalls:0}};
   await brainWorker(db,()=>db.query("select public.authorize_naming_brain_dispatch($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(request)]));

   const receipt={...base,...allocation,stageKey:"gap",sessionId:"fixture-gap-failed-session",turnId:"fixture-gap-failed-turn",artifactItemIds:mode.includes("failed")?[]:["fixture-invalid-final"]};
   delete (receipt as Partial<typeof allocation>).maxWebSearchCalls;
   await brainWorker(db,()=>db.query("select public.record_naming_brain_provider_receipt($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify(receipt)]));
   await expire(job);const recovered=await claimBrain(db);expect(recovered.mode).toBe("observe_only");job.lease_token=recovered.job.lease_token;
   await expect(beginBrainStage(db,job,"prepare")).rejects.toMatchObject({code:"55000"});
   await db.query("update fluid_private.naming_brain_pilots set enabled=false where owner_id=$1",[OWNER_A]);
   if(!mode.includes("failed"))await brainAction(db,job,"provider_item",{providerCallKey:allocation.providerCallKey,sessionId:receipt.sessionId,turnId:receipt.turnId,itemId:"fixture-invalid-final",item:{id:"fixture-invalid-final",type:"message",role:"assistant",phase:"final_answer",status:"completed",turn_id:receipt.turnId,content:[{type:"output_text",text:mode==="malformed_json"?"not json":JSON.stringify({role:"director",assignments:"invalid"})}]}});
   await brainAction(db,job,"provider_turn",{providerCallKey:allocation.providerCallKey,sessionId:receipt.sessionId,turnId:receipt.turnId,turn:{id:receipt.turnId,session_id:receipt.sessionId,subagent_id:null,agent_id:"fixture-agent",object:"agent.session.turn",status:mode.includes("failed")?"failed":"completed",created_at:1,started_at:1,completed_at:2,error:mode.includes("failed")?{code:"fixture_failed"}:null,usage:null}});
   expect(await brainAction(db,job,"resume_execution",{stageKey:"gap"})).toEqual({recoveryMode:"observe_only",resumed:false});
   if(mode==="paused_failed")await brainRpc(db,"stop_naming_feed",[project,{version:1,expectedDemandSequence:0,pendingEnsureIdempotencyKey:null,idempotencyKey:"fixture-before-prepare-stop"}]);
   if(mode.includes("failed"))return "gap_incomplete";
   const outcome={providerCallKey:allocation.providerCallKey,status:"failed",code:"provider_output_invalid",receipt};
   const rejected=await brainWorker(db,()=>db.query<{step:{state:string}}>("select public.complete_naming_brain_stage($1,$2,'gap','succeeded',$3::jsonb) step",[job.id,job.lease_token,JSON.stringify({artifactIds:[],errorCode:"gap_incomplete",partialArtifacts:[{...outcome,receipt:{...receipt,sessionId:"forged-session"}}]})]));expect(rejected.rows[0]!.step.state).toBe("ambiguous");
   await db.query("update fluid_private.naming_brain_runs set next_observation_at=clock_timestamp()-interval '1 second' where id=$1",[job.input.runId]);const retry=await claimBrain(db);expect(retry.mode).toBe("observe_only");job.lease_token=retry.job.lease_token;
   return {errorCode:"gap_incomplete",partialArtifacts:[outcome]};
  });
  if(mode==="paused_failed"){await expect(preparing).rejects.toMatchObject({code:"55000"});expect((await db.query<{n:number}>("select count(*)::integer n from fluid_private.naming_brain_prepared_sets")).rows[0]!.n).toBe(0);return;}
  const result=await preparing;
  expect(result.preparedSet.candidateIds).toHaveLength(1);
  const gap=await brainAction(db,result.job,"stage",{stageKey:"gap"}) as {state:string;artifacts:unknown[];providerTurns:unknown[]};expect(gap.state).toBe("succeeded");expect(gap.artifacts).toHaveLength(mode==="later_schema_invalid"?1:0);expect(gap.providerTurns).toHaveLength(mode==="later_schema_invalid"?2:1);
  expect((await db.query<{state:string}>("select state from public.job_steps where job_id=$1 and step_key='prepare'",[result.job.id])).rows[0]!.state).toBe("in_flight");
  await brainRpc(db,"stop_naming_feed",[project,{version:1,expectedDemandSequence:0,pendingEnsureIdempotencyKey:null,idempotencyKey:"fixture-post-gap-stop"}]);
  await expect(brainRpc(db,"append_prepared_naming_set",[project,result.preparedSetId])).rejects.toMatchObject({code:"PT409"});
 });
 it("never newly exposes a prepared set after an observed overrun",async()=>{
  const result=await prepareBrainFixture(db,project,1);await db.query("update fluid_private.naming_brain_runs set observed_overrun=true where id=$1",[result.job.input.runId]);
  await expect(brainRpc(db,"append_prepared_naming_set",[project,result.preparedSetId])).rejects.toMatchObject({code:"PT409"});
  expect((await db.query<{n:number}>("select count(*)::integer n from fluid_private.naming_brain_feed_entries")).rows[0]!.n).toBe(0);
 });
 it("backs off read-only claims and enforces separate attempt and absolute observation limits",async()=>{
  const {job}=await knownCall();await expire(job);const first=await claimBrain(db);expect(first.mode).toBe("observe_only");job.lease_token=first.job.lease_token;
  await expire(job);expect(await claimBrain(db)).toBeNull();
  const limits=(await db.query<{attempts:number;delay:number;window_seconds:number}>("select observation_attempts attempts,extract(epoch from next_observation_at-clock_timestamp())::float8 delay,extract(epoch from observation_deadline_at-clock_timestamp())::float8 window_seconds from fluid_private.naming_brain_runs where id=$1",[job.input.runId])).rows[0]!;expect(limits.attempts).toBe(1);expect(limits.delay).toBeGreaterThan(20);expect(limits.window_seconds).toBeLessThanOrEqual(3600);
  await db.query("update fluid_private.naming_brain_runs set observation_attempts=11,next_observation_at=clock_timestamp()-interval '1 second' where id=$1",[job.input.runId]);const last=await claimBrain(db);expect(last.mode).toBe("observe_only");await expire(last.job);expect(await claimBrain(db)).toBeNull();
  expect((await db.query<{state:string}>("select state from public.jobs where id=$1",[job.id])).rows[0]!.state).toBe("needs_reconciliation");
 });
 it("finalizes stopped completed-stage-only recovery from saved proof while keeping its full hold",async()=>{
  const job=await startBrainFixture(db,project);await saveBrainArtifact(db,job,"research",{role:"researcher",territories:[],facts:[],interpretations:[],uncertainties:[]},{readiness:"partial",sources:[]});
  await expire(job);await brainRpc(db,"request_job_cancel",[job.id]);expect(await claimBrain(db)).toBeNull();
  expect((await db.query<{state:string}>("select state from public.jobs where id=$1",[job.id])).rows[0]!.state).toBe("cancelled");
  expect(await brainRpc(db,"get_naming_brain_job_accounting",[job.id])).toEqual({status:"held_unsettled",heldAllowanceMicrousd:5000000,confirmedActualCostMicrousd:null});
 });
 it("caps observer heartbeat at the original one-hour window",async()=>{
  const {job}=await knownCall();await expire(job);const claimed=await claimBrain(db);job.lease_token=claimed.job.lease_token;
  await db.query("update fluid_private.naming_brain_runs set observation_deadline_at=clock_timestamp()+interval '10 seconds' where id=$1",[job.input.runId]);
  await brainAction(db,job,"heartbeat",{leaseSeconds:300});expect((await db.query<{capped:boolean}>("select j.lease_expires_at<=r.observation_deadline_at capped from public.jobs j join fluid_private.naming_brain_runs r on r.job_id=j.id where j.id=$1",[job.id])).rows[0]!.capped).toBe(true);
  await db.query("update fluid_private.naming_brain_runs set observation_deadline_at=clock_timestamp()-interval '1 second',next_observation_at=clock_timestamp()-interval '1 second' where id=$1",[job.input.runId]);await expire(job);expect(await claimBrain(db)).toBeNull();
 });
 it.each(["disabled","paused","overrun","deadline"])("never resumes paid execution when %s even with a complete saved call",async(condition)=>{
  const job=await startBrainFixture(db,project);await saveBrainArtifact(db,job,"research",{role:"researcher",territories:[],facts:[],interpretations:[],uncertainties:[]},{readiness:"partial",sources:[]},false);await expire(job);const claimed=await claimBrain(db);job.lease_token=claimed.job.lease_token;
  if(condition==="disabled")await db.query("update fluid_private.naming_brain_pilots set enabled=false where owner_id=$1",[OWNER_A]);
  if(condition==="paused")await brainRpc(db,"stop_naming_feed",[project,{version:1,expectedDemandSequence:0,pendingEnsureIdempotencyKey:null,idempotencyKey:"fixture-observer-stop"}]);
  if(condition==="overrun")await db.query("update fluid_private.naming_brain_runs set observed_overrun=true where id=$1",[job.input.runId]);
  if(condition==="deadline")await db.query("update public.job_steps set created_at=clock_timestamp()-interval '241 seconds' where job_id=$1",[job.id]);
  expect(await brainAction(db,job,"resume_execution",{stageKey:"research"})).toEqual({recoveryMode:"observe_only",resumed:false});
 });
});
