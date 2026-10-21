import {readFile} from "node:fs/promises";
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {asApiTextWorker,asRole,createTestDatabase,installApiTextWorkerFixture,OWNER_A,OWNER_B,type TestDatabase} from "./local-supabase";
import {createMultiAccountFixture,resetMultiAccountFixture,enableSyntheticCohort,admit} from "./api-text-multi-account-fixture";
import {repairApiTextDispatches} from "../../worker/hosting/publication";
import {runBackgroundApiTextDelivery} from "../../worker/api-text-background-runtime";
import {apiTextDispatchDatabase} from "../../worker/api-text-multi-account";
import {strategyPolicy} from "../../src/server/ai/config";
import {responseFixture} from "../server/openai-fixtures";
describe.each(["historical", "current"] as const)("%s schema background recovery",schema=>{
let db:TestDatabase,projects:{a:string;b:string};
beforeAll(async()=>{
 if(schema==='historical')db=await createMultiAccountFixture();
 else {
  db=await createTestDatabase({before:"20261021190000_api_text_background_recovery.sql"});await installApiTextWorkerFixture(db);
  await db.exec("alter table auth.users add column created_at timestamptz default clock_timestamp(),add column email_confirmed_at timestamptz; grant execute on function public.api_text_dispatch_action(jsonb,text,jsonb),public.list_api_text_dispatches_v2(integer),public.api_text_multi_account_readiness(jsonb,text) to fixture_api_text_a,fixture_api_text_b");
 }
 await db.exec(await readFile(new URL('../../supabase/candidates/api_text_background_journal.sql',import.meta.url),'utf8'));
},300000);
beforeEach(async()=>{projects=await resetMultiAccountFixture(db);await db.exec('update fluid_private.api_text_background_rollout set enabled=false');},30000);
afterAll(async()=>{await db?.close();});
async function call(d:unknown,action:string,args:unknown[]=[]){return asApiTextWorker(db,OWNER_A,async()=>(await db.query<{result:unknown}>('select public.api_text_dispatch_action($1,$2,$3) result',[d,action,args])).rows[0]!.result);}
// Disposable-fixture clock setup only. Restore the production immutability
// trigger before any gateway call or assertion exercises the redrive.
async function ageGeneration(jobId:string){
 await db.exec('alter table fluid_private.api_text_dispatches disable trigger api_text_dispatch_immutable');
 try { await db.query("update fluid_private.api_text_dispatches set generation_started_at=clock_timestamp()-interval '31 seconds' where job_id=$1",[jobId]); }
 finally { await db.exec('alter table fluid_private.api_text_dispatches enable trigger api_text_dispatch_immutable'); }
}
async function prepare(enabled=true){
 await enableSyntheticCohort(db);if(enabled)await db.exec("update fluid_private.api_text_background_rollout set enabled=true,deployment_id='dpl_multi_account_fixture'");
 const admitted=await admit(db,OWNER_B,projects.b);
 const claim=await call(admitted.dispatch,'claim',['fixture-worker',300]) as {job:{lease_token:string}};
 const lease=claim.job.lease_token;
 await call(admitted.dispatch,'plan',[lease,[{key:'respond',maximumCostMicrousd:122880}]]);
 await call(admitted.dispatch,'begin',[lease,'respond','fixture-request-key',122880]);
 return {admitted,lease,act:(action:string,value:unknown=null)=>call(admitted.dispatch,'background',[lease,'respond',action,value])};
}
it('does not adopt historical or unmarked jobs when rollout is later enabled',async()=>{
 const f=await prepare(false);await db.exec("update fluid_private.api_text_background_rollout set enabled=true,deployment_id='dpl_multi_account_fixture'");
 await expect(f.act('load')).rejects.toThrow('background_profile_missing');
});
it('freezes one create and original deadlines through repeat reads and lost acknowledgements',async()=>{
 const f=await prepare();const initial=await f.act('load');
 expect(await f.act('begin')).toMatchObject({value:true});expect(await f.act('begin')).toMatchObject({value:false});
 await f.act('handle','resp_fixture');await f.act('handle','resp_fixture');
 const later=await f.act('load') as {value:{executionDeadlineAt:number;observationDeadlineAt:number}};
 expect(later.value).toMatchObject({executionDeadlineAt:(initial as typeof later).value.executionDeadlineAt,observationDeadlineAt:(initial as typeof later).value.observationDeadlineAt,dispatchState:'accepted',responseId:'resp_fixture'});
 await expect(f.act('handle','resp_other')).rejects.toThrow('background_identity_conflict');
});
it('retains the first terminal body and refuses conflicting output',async()=>{
 const f=await prepare();await f.act('load');await f.act('begin');await f.act('handle','resp_fixture');
 const value={body:{id:'resp_fixture',status:'completed',output:[]},requestId:'req_fixture'};
 await f.act('terminal',value);await f.act('terminal',{...value,requestId:'req_second_observation'});
 expect(await f.act('load')).toMatchObject({value:{terminalResponse:value}});
 await expect(f.act('terminal',{...value,body:{...value.body,output:['changed']}})).rejects.toThrow('background_terminal_conflict');
});
it('rejects a pending or missing terminal status',async()=>{
 const f=await prepare();await f.act('load');await f.act('begin');await f.act('handle','resp_fixture');
 await expect(f.act('terminal',{body:{id:'resp_fixture',status:'in_progress'},requestId:null})).rejects.toThrow('invalid_background_terminal');
 await expect(f.act('terminal',{body:{id:'resp_fixture'},requestId:null})).rejects.toThrow('invalid_background_terminal');
});
it('preserves explicit no-dispatch rejection without allowing another create',async()=>{
 const f=await prepare();await f.act('load');await f.act('begin');await f.act('reject',{reason:'observer_stopped',requestId:null});
 expect(await f.act('begin')).toMatchObject({value:false});
 await expect(f.act('handle','resp_fixture')).rejects.toThrow('background_identity_conflict');
});
it('rejects wrong leases and direct user access',async()=>{
 const f=await prepare();await f.act('load');
 await expect(call(f.admitted.dispatch,'background',[crypto.randomUUID(),'respond','load',null])).rejects.toThrow('lease_lost');
 await expect(asRole(db,'authenticated',OWNER_B,()=>db.query('select * from fluid_private.api_text_background_responses'))).rejects.toThrow();
});
it('hands off an expired observer lease without new attempts or changing the saved response',async()=>{
 const f=await prepare();await f.act('load');await f.act('begin');await f.act('handle','resp_fixture');
 const before=(await db.query('select attempts,actual_cost_microusd from public.jobs where id=$1',[f.admitted.id])).rows;
 await call(f.admitted.dispatch,'background_control',['yield',f.lease]);
 const claimed=await call(f.admitted.dispatch,'background_control',['claim','replacement-observer']) as {job:{lease_token:string},disposition:string};
 expect(claimed.disposition).toBe('claimed');expect(claimed.job.lease_token).not.toBe(f.lease);
 await expect(f.act('load')).rejects.toThrow('lease_lost');
 expect(await call(f.admitted.dispatch,'background',[claimed.job.lease_token,'respond','load',null])).toMatchObject({value:{dispatchState:'accepted',responseId:'resp_fixture'}});
 expect((await db.query('select attempts,actual_cost_microusd from public.jobs where id=$1',[f.admitted.id])).rows).toEqual(before);
});
it('does not steal an active lease or retry a terminal unknown outcome',async()=>{
 const f=await prepare();await f.act('load');
 expect(await call(f.admitted.dispatch,'background_control',['claim','other-observer'])).toMatchObject({disposition:'busy'});
 await call(f.admitted.dispatch,'complete',[f.lease,'respond','ambiguous',0,{},null]);
 expect(await call(f.admitted.dispatch,'background_control',['claim','other-observer'])).toMatchObject({disposition:'terminal',state:'needs_reconciliation'});
});

async function deliveryFixture(){
 await enableSyntheticCohort(db);await db.exec("update fluid_private.api_text_background_rollout set enabled=true,deployment_id='dpl_multi_account_fixture'");
 const admitted=await admit(db,OWNER_B,projects.b);
 const provider={countInputTokens:vi.fn().mockResolvedValue(100),createResponse:vi.fn().mockResolvedValue({body:{id:'resp_synthetic_fixture',status:'queued'},requestId:'req_fixture'}),retrieveResponse:vi.fn().mockResolvedValue({body:responseFixture(),requestId:'req_observe'}),cancelResponse:vi.fn()};
 const run=()=>asApiTextWorker(db,OWNER_A,()=>runBackgroundApiTextDelivery({database:db,scopedDatabase:apiTextDispatchDatabase(db,admitted.dispatch),message:admitted.dispatch,configuration:{apiKey:'synthetic',policies:new Map([['strategy.reformulate',strategyPolicy('strategy.reformulate')]])},transport:provider,signal:new AbortController().signal}));
 return {admitted,provider,run};
}
it('resumes after an observation disconnect and captures spend exactly once',async()=>{
 const f=await deliveryFixture();f.provider.retrieveResponse.mockRejectedValueOnce(new Error('synthetic_disconnect'));
 expect(await f.run()).toEqual({disposition:'retry',state:'background_observing'});
 expect((await db.query('select state,actual_cost_microusd from public.jobs where id=$1',[f.admitted.id])).rows).toEqual([{state:'running',actual_cost_microusd:0}]);
 expect(await f.run()).toEqual({disposition:'ack',state:'succeeded'});
 expect(await f.run()).toEqual({disposition:'ack',state:'succeeded'});
 expect(f.provider.createResponse).toHaveBeenCalledOnce();expect(f.provider.countInputTokens).toHaveBeenCalledOnce();
 expect((await db.query('select actual_cost_microusd from public.jobs where id=$1',[f.admitted.id])).rows).toEqual([{actual_cost_microusd:691}]);
},30000);
it('never retries an accepted create whose identity was not received',async()=>{
 const f=await deliveryFixture();f.provider.createResponse.mockRejectedValueOnce(new Error('synthetic_lost_create_ack'));
 expect(await f.run()).toMatchObject({disposition:'ack',state:'needs_reconciliation'});
 expect(await f.run()).toMatchObject({disposition:'ack',state:'needs_reconciliation'});
 expect(f.provider.createResponse).toHaveBeenCalledOnce();
 expect((await db.query('select state from public.usage_reservations where job_id=$1',[f.admitted.id])).rows).toEqual([{state:'active'}]);
},30000);

it('generic expiry preserves a known recoverable response and its reservation',async()=>{
 const f=await prepare();await f.act('load');await f.act('begin');await f.act('handle','resp_fixture');
 await call(f.admitted.dispatch,'background_control',['yield',f.lease]);
 const before=(await db.query('select to_jsonb(j) snapshot from public.jobs j where id=$1',[f.admitted.id])).rows;
 expect(await call(f.admitted.dispatch,'expire')).toMatchObject({disposition:'available',state:'running'});
 expect((await db.query('select to_jsonb(j) snapshot from public.jobs j where id=$1',[f.admitted.id])).rows).toEqual(before);
 expect((await db.query('select state from public.usage_reservations where job_id=$1',[f.admitted.id])).rows).toEqual([{state:'active'}]);
});
it('generic expiry retains its conservative behavior for an unknown create',async()=>{
 const f=await prepare();await f.act('load');await f.act('begin');
 await call(f.admitted.dispatch,'background_control',['yield',f.lease]);
 expect(await call(f.admitted.dispatch,'expire')).toMatchObject({disposition:'terminal',state:'needs_reconciliation'});
 expect((await db.query('select state from public.usage_reservations where job_id=$1',[f.admitted.id])).rows).toEqual([{state:'active'}]);
});
it('generic expiry cannot recover unmarked historical work',async()=>{
 const f=await prepare(false);
 await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[f.admitted.id]);
 expect(await call(f.admitted.dispatch,'expire')).toMatchObject({disposition:'terminal',state:'needs_reconciliation'});
});

it('fences observation redrive without recreating inference or changing job accounting',async()=>{
 const f=await prepare();await f.act('load');await f.act('begin');await f.act('handle','resp_fixture');
 await call(f.admitted.dispatch,'background_control',['yield',f.lease]);
 await ageGeneration(f.admitted.id);
 const before=(await db.query('select to_jsonb(j) snapshot from public.jobs j where id=$1',[f.admitted.id])).rows;
 const next=await call(f.admitted.dispatch,'background_control',['redrive',0]);
 expect(next).toMatchObject({jobId:f.admitted.id,state:'running',publicationGeneration:1,retryable:true,publishedMessageId:null});
 expect(await call(f.admitted.dispatch,'background_control',['redrive',0])).toBeNull();
 expect(await call(f.admitted.dispatch,'background_control',['redrive',1])).toBeNull();
 expect(await call(f.admitted.dispatch,'published',[0,'stale-receipt'])).toBe(false);
 expect((await db.query('select to_jsonb(j) snapshot from public.jobs j where id=$1',[f.admitted.id])).rows).toEqual(before);
});
it('refuses observation redrive while a lease is active or create identity is unknown',async()=>{
 const f=await prepare();await f.act('load');await f.act('begin');
 await ageGeneration(f.admitted.id);
 expect(await call(f.admitted.dispatch,'background_control',['redrive',0])).toBeNull();
 await call(f.admitted.dispatch,'background_control',['yield',f.lease]);
 expect(await call(f.admitted.dispatch,'background_control',['redrive',0])).toBeNull();
});

it('publishes a generation-fenced observation repair through the actual outbox adapter',async()=>{
 const f=await prepare();await f.act('load');await f.act('begin');await f.act('handle','resp_fixture');
 await call(f.admitted.dispatch,'background_control',['yield',f.lease]);
 await ageGeneration(f.admitted.id);
 const send=vi.fn().mockResolvedValue({messageId:'synthetic-observation-message'});
 const options={database:db,send,deploymentId:f.admitted.dispatch.deploymentId,signal:new AbortController().signal,multiAccount:true,backgroundRecovery:true};
 const result=await asApiTextWorker(db,OWNER_A,()=>repairApiTextDispatches(options));
 expect(result).toMatchObject({published:1,errors:0});expect(send).toHaveBeenCalledOnce();
 expect(send.mock.calls[0]?.[1]).toEqual(f.admitted.dispatch);
 expect(send.mock.calls[0]?.[2]).toMatchObject({idempotencyKey:`api-text:${f.admitted.dispatch.dispatchIdentity}:1`});
 const again=await asApiTextWorker(db,OWNER_A,()=>repairApiTextDispatches(options));
 expect(again).toMatchObject({published:0,errors:0});expect(send).toHaveBeenCalledOnce();
});
it('does not extend an expired observation window but retains a saved terminal response',async()=>{
 const f=await prepare();await f.act('load');await f.act('begin');await f.act('handle','resp_fixture');
 await f.act('terminal',{body:{id:'resp_fixture',status:'completed',output:[]},requestId:null});
 await call(f.admitted.dispatch,'background_control',['yield',f.lease]);
 await db.query("update fluid_private.api_text_background_responses set created_at=created_at-interval '11 minutes',execution_deadline_at=execution_deadline_at-interval '11 minutes',observation_deadline_at=observation_deadline_at-interval '11 minutes' where job_id=$1",[f.admitted.id]);
 expect(await call(f.admitted.dispatch,'expire')).toMatchObject({disposition:'available',state:'running'});
});

it('never marks jobs admitted for another deployment',async()=>{
 await enableSyntheticCohort(db);
 await db.exec("update fluid_private.api_text_background_rollout set enabled=true,deployment_id='dpl_other_deployment'");
 const admitted=await admit(db,OWNER_B,projects.b);
 expect(await call(admitted.dispatch,'background_control',['profile',null])).toBe(false);
});

it('stops expired observation without releasing uncertain spend',async()=>{
 const f=await prepare();await f.act('load');await f.act('begin');await f.act('handle','resp_fixture');
 await call(f.admitted.dispatch,'background_control',['yield',f.lease]);await ageGeneration(f.admitted.id);
 await db.query("update fluid_private.api_text_background_responses set created_at=created_at-interval '11 minutes',execution_deadline_at=execution_deadline_at-interval '11 minutes',observation_deadline_at=observation_deadline_at-interval '11 minutes' where job_id=$1",[f.admitted.id]);
 expect(await call(f.admitted.dispatch,'background_control',['redrive',0])).toBeNull();
 expect(await call(f.admitted.dispatch,'expire')).toMatchObject({disposition:'terminal',state:'needs_reconciliation'});
 expect((await db.query('select state from public.usage_reservations where job_id=$1',[f.admitted.id])).rows).toEqual([{state:'active'}]);
});

it('settles explicit cancellation of a known text response exactly once',async()=>{
 const f=await deliveryFixture();f.provider.retrieveResponse.mockRejectedValueOnce(new Error('synthetic_disconnect'));
 expect(await f.run()).toMatchObject({disposition:'retry'});
 await asRole(db,'authenticated',OWNER_B,()=>db.query('select public.request_job_cancel($1)',[f.admitted.id]));
 f.provider.cancelResponse.mockResolvedValue({body:{...responseFixture(),status:'cancelled'},requestId:'req_cancel'});
 expect(await f.run()).toEqual({disposition:'ack',state:'cancelled'});
 expect(await f.run()).toEqual({disposition:'ack',state:'cancelled'});
 expect(f.provider.createResponse).toHaveBeenCalledOnce();expect(f.provider.cancelResponse).toHaveBeenCalledOnce();
 expect((await db.query('select actual_cost_microusd from public.jobs where id=$1',[f.admitted.id])).rows).toEqual([{actual_cost_microusd:691}]);
 expect((await db.query('select state from public.usage_reservations where job_id=$1',[f.admitted.id])).rows).not.toEqual([{state:'active'}]);
});
it('finishes observation after database admission policy is disabled',async()=>{
 const f=await deliveryFixture();f.provider.retrieveResponse.mockRejectedValueOnce(new Error('synthetic_disconnect'));
 expect(await f.run()).toMatchObject({disposition:'retry'});
 await db.exec("update fluid_private.strategy_runtime_policy set enabled=false; update fluid_private.api_text_background_rollout set enabled=false");
 expect(await f.run()).toEqual({disposition:'ack',state:'succeeded'});
 expect(f.provider.createResponse).toHaveBeenCalledOnce();
});

it('cancels before the first step without a provider request or spend',async()=>{
 const f=await deliveryFixture();
 const claim=await call(f.admitted.dispatch,'claim',['synthetic-initial-worker',60]) as {job:{lease_token:string}};
 await asRole(db,'authenticated',OWNER_B,()=>db.query('select public.request_job_cancel($1)',[f.admitted.id]));
 await call(f.admitted.dispatch,'background_control',['yield',claim.job.lease_token]);
 expect(await f.run()).toEqual({disposition:'ack',state:'cancelled'});
 expect(f.provider.createResponse).not.toHaveBeenCalled();
 expect((await db.query('select actual_cost_microusd from public.jobs where id=$1',[f.admitted.id])).rows).toEqual([{actual_cost_microusd:0}]);
});

});
