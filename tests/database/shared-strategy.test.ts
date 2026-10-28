import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { randomUUID } from "node:crypto";
import { createSharedStrategyFixture,OWNER_A,OWNER_B } from "./shared-strategy-fixture";
import { strategyOperations } from "../../worker/account-enrollment/configuration";

let f:Awaited<ReturnType<typeof createSharedStrategyFixture>>;
beforeEach(async()=>{f=await createSharedStrategyFixture();},30_000);
afterEach(async()=>{await f?.close();});
describe("actual fixed-slot Strategy SQL, no provider transport",()=>{
 it.each(strategyOperations)("admits %s with frozen uncapped authority and preserves existing balances",async operation=>{
  const p=await f.project(operation);
  await f.db.query("insert into public.usage_accounts(owner_id,limit_microusd,spent_microusd,provider_actual_microusd) values($1,0,100,200)",[OWNER_A]);
  const admitted=await f.submit(p.id,operation);
  expect(admitted.spendControl).toBe("uncapped");
  const claim=await f.claim(admitted.dispatch);
  expect(claim.result.executionAuthority).toMatchObject({contract:"hosted_strategy_shared_uncapped_v1",jobId:admitted.id,ownerId:OWNER_A,slotId:f.slot.slotId});
  expect((await f.db.query("select limit_microusd,spent_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows)
   .toEqual([{limit_microusd:0,spent_microusd:100,provider_actual_microusd:200}]);
  expect((await f.db.query("select count(*)::int n from fluid_private.api_text_allowance_admissions")).rows).toEqual([{n:0}]);
  expect((await f.db.query("select count(*)::int n from fluid_private.shared_worker_gateway_context")).rows).toEqual([{n:0}]);
 });
 it("reuses one fixed login for two owners, denies forged message/execution scope and clears context",async()=>{
  const a=await f.submit((await f.project()).id),b=await f.submit((await f.project("strategy.reformulate",OWNER_B)).id,"strategy.reformulate",OWNER_B);
  const claim=await f.claim(a.dispatch);
  await expect(f.action({...b.dispatch,dispatchIdentity:a.dispatch.dispatchIdentity},"descriptor")).rejects.toThrow("shared_dispatch_denied");
  await expect(f.action(b.dispatch,"step",[OWNER_B,claim.execution.projectId,"synthetic"],claim.execution)).rejects.toThrow("shared_dispatch_denied");
  await expect(f.action(a.dispatch,"step",[OWNER_B,claim.execution.projectId,"synthetic"],claim.execution)).rejects.toThrow("shared_owner_denied");
  await expect(f.action(a.dispatch,"step",[OWNER_A,claim.execution.projectId,"synthetic"],{...claim.execution,executionToken:randomUUID()})).rejects.toThrow();
  expect((await f.db.query("select count(*)::int n from fluid_private.shared_worker_gateway_context")).rows).toEqual([{n:0}]);
  await f.action(a.dispatch,"finish",[claim.result.job.lease_token,"failed","synthetic_predispatch_failure"],claim.execution);
  expect((await f.claim(b.dispatch)).result.executionAuthority).toMatchObject({ownerId:OWNER_B,slotId:f.slot.slotId});
 });
 it("enforces database capacity and keeps historical unknown work separate from new unrelated projects",async()=>{
  const project=await f.project(),a=await f.submit(project.id),claim=await f.claim(a.dispatch),lease=claim.result.job.lease_token,maximum=claim.result.job.reserved_cost_microusd;
  await f.action(a.dispatch,"plan",[lease,[{key:"synthetic",maximumCostMicrousd:maximum}]],claim.execution);
  await f.action(a.dispatch,"begin",[lease,"synthetic",claim.requestKey,maximum],claim.execution);
  expect((await f.action<boolean>(a.dispatch,"authorize",[lease,"synthetic"],claim.execution)).result).toBe(true);
  await f.db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[a.id]);
  expect((await f.action(a.dispatch,"expire")).result).toEqual({disposition:"terminal",state:"needs_reconciliation"});
  await f.db.query("update fluid_private.shared_worker_slots set expires_at=clock_timestamp()-interval '1 second' where slot_id=$1",[f.slot.slotId]);
  f.setLease(await f.leaseSlot());
  await expect(f.action(a.dispatch,"authorize",[lease,"synthetic"],claim.execution)).rejects.toThrow();
  await expect(f.submit(project.id)).rejects.toThrow("active_strategy_request");
  const other=await f.submit((await f.project()).id);
  expect((await f.claim(other.dispatch)).result.executionAuthority).toMatchObject({ownerId:OWNER_A,jobId:other.id});
  expect((await f.action(a.dispatch,"step",[OWNER_A,project.id,"synthetic"],claim.execution)).result).toMatchObject([{state:"in_flight"}]);
  expect((await f.db.query("select count(*)::int n from fluid_private.shared_worker_gateway_context")).rows).toEqual([{n:0}]);
 });
 it("retries only a proven predispatch expiry and never resets attempts or frozen inputs",async()=>{
  const a=await f.submit((await f.project()).id),claim=await f.claim(a.dispatch);
  const before=(await f.db.query("select input_hash,input,attempts from public.jobs where id=$1",[a.id])).rows[0]!;
  await f.db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[a.id]);
  expect((await f.action(a.dispatch,"expire")).result).toEqual({disposition:"available",state:"queued"});
  const next=await f.claim(a.dispatch);
  expect(next.result.job.lease_token).not.toBe(claim.result.job.lease_token);
  const after=(await f.db.query("select input_hash,input,attempts from public.jobs where id=$1",[a.id])).rows[0]!;
  expect(after).toEqual({...before,attempts:2});
  await expect(f.action(a.dispatch,"begin",[claim.result.job.lease_token,"synthetic",claim.requestKey,1],claim.execution)).rejects.toThrow();
 });
 it("retains the durable outbox on uncertain publication and records only actual message IDs",async()=>{
  const a=await f.submit((await f.project()).id);
  const list=()=>f.asSlot(f.slot,()=>f.db.query<{dispatch:{jobId:string}}>("select public.list_shared_strategy_dispatches($1,25) dispatch",[JSON.stringify(f.lease)]));
  expect((await list()).rows.map(r=>r.dispatch.jobId)).toEqual([a.id]);
  await expect(f.action(a.dispatch,"published",[0,null])).rejects.toThrow("invalid_message_id");
  expect((await list()).rows).toHaveLength(1);
  expect((await f.action(a.dispatch,"published",[0,"synthetic-actual-message"])).result).toBe(true);
  expect((await f.action(a.dispatch,"published",[0,"synthetic-actual-message"])).result).toBe(true);
  expect((await list()).rows).toHaveLength(0);
 });
 it("retains late observed outcomes and known response retrieval without rewriting ambiguity or billing twice",async()=>{
  const a=await f.submit((await f.project()).id),claim=await f.claim(a.dispatch),lease=claim.result.job.lease_token,maximum=claim.result.job.reserved_cost_microusd;
  await f.action(a.dispatch,"plan",[lease,[{key:"synthetic",maximumCostMicrousd:maximum}]],claim.execution);
  await f.action(a.dispatch,"begin",[lease,"synthetic",claim.requestKey,maximum],claim.execution);
  await f.action(a.dispatch,"complete",[lease,"synthetic","ambiguous",0,{errorCode:"synthetic_unknown"},null],claim.execution);
  const outcome={status:"succeeded",result:{fixture:true},costMicrousd:17,providerRequestId:"resp_synthetic_known"};
  expect((await f.action(a.dispatch,"observe_outcome",[lease,"synthetic",outcome],claim.execution)).result).toBe(true);
  expect((await f.action(a.dispatch,"observe_outcome",[lease,"synthetic",outcome],claim.execution)).result).toBe(true);
  await expect(f.action(a.dispatch,"observe_outcome",[lease,"synthetic",{...outcome,costMicrousd:18}],claim.execution)).rejects.toThrow("shared_observed_outcome_immutable");
  expect((await f.action(null,"recovery",[],claim.execution)).result).toEqual([{stepKey:"synthetic",responseId:"resp_synthetic_known"}]);
  await expect(f.action(null,"observe_response",[lease,"synthetic","resp_forged",{body:{id:"resp_forged",status:"completed"},requestId:null}],claim.execution)).rejects.toThrow("shared_response_identity_unproven");
  const response={body:{id:"resp_synthetic_known",status:"completed",output:[]},requestId:"req_actual_first_fixture"};
  expect((await f.action(null,"observe_response",[lease,"synthetic","resp_synthetic_known",response],claim.execution)).result).toBe(true);
  expect((await f.action(null,"observe_response",[lease,"synthetic","resp_synthetic_known",{...response,requestId:"req_actual_second_fixture"}],claim.execution)).result).toBe(true);
  expect((await f.action(null,"recovery",[],claim.execution)).result).toEqual([]);
  expect((await f.db.query("select state,actual_cost_microusd from public.job_steps where job_id=$1",[a.id])).rows).toEqual([{state:"ambiguous",actual_cost_microusd:0}]);
  expect((await f.db.query("select state,actual_cost_microusd from public.jobs where id=$1",[a.id])).rows).toEqual([{state:"needs_reconciliation",actual_cost_microusd:0}]);
  expect((await f.db.query("select count(*)::int n from fluid_private.shared_strategy_observed_outcomes")).rows).toEqual([{n:1}]);
  expect((await f.db.query("select count(*)::int n from fluid_private.shared_strategy_observed_responses")).rows).toEqual([{n:1}]);
 });
 it("records actual cost above the estimate without creating an allowance or a monetary stop",async()=>{
  const a=await f.submit((await f.project()).id),claim=await f.claim(a.dispatch),lease=claim.result.job.lease_token,maximum=claim.result.job.reserved_cost_microusd;
  await f.action(a.dispatch,"plan",[lease,[{key:"synthetic",maximumCostMicrousd:maximum}]],claim.execution);
  await f.action(a.dispatch,"begin",[lease,"synthetic",claim.requestKey,maximum],claim.execution);
  await f.action(a.dispatch,"complete",[lease,"synthetic","failed",maximum+500,{errorCode:"synthetic_known_failure"},"req_known_fixture"],claim.execution);
  await f.action(a.dispatch,"finish",[lease,"failed","synthetic_known_failure"],claim.execution);
  expect((await f.db.query("select state,actual_cost_microusd from public.jobs where id=$1",[a.id])).rows).toEqual([{state:"failed",actual_cost_microusd:maximum+500}]);
  expect((await f.db.query("select limit_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows).toEqual([{limit_microusd:0,provider_actual_microusd:maximum+500}]);
 });
});
