import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createManagedStrategyFixture,OWNER_A,OWNER_B } from "./managed-strategy-fixture";
import { strategyOperations } from "../../worker/account-enrollment/configuration";
import { ApiTextJobStore } from "../../worker/api-text-store";
import { runApiTextDelivery } from "../../worker/api-text-runtime";
import { responseFixture,transportFixture } from "../server/openai-fixtures";
import { guidedResearchResponse } from "../worker/guided-strategy-fixtures";
import { strategyJobInputSchema } from "../../src/domain/strategy-jobs";

describe("unapplied managed uncapped Strategy (restricted disposable SQL; inert Responses)",()=>{
 let f:Awaited<ReturnType<typeof createManagedStrategyFixture>>;
 beforeAll(async()=>{f=await createManagedStrategyFixture();},60_000);
 afterAll(async()=>{await f?.close();});
 beforeEach(async()=>{await f.db.exec("begin");});afterEach(async()=>{await f.db.exec("rollback; set session authorization postgres");});
 it("installs no approval, role, credit or private grants and pins reviewed predecessor metadata",async()=>{
  expect((await f.db.query("select count(*)::int n from fluid_private.managed_strategy_uncapped_jobs")).rows).toEqual([{n:0}]);
  expect((await f.db.query("select count(*)::int n from fluid_private.account_worker_profile_approvals")).rows).toEqual([{n:0}]);
  for(const role of ["anon","authenticated","service_role","fixture_production_acl_probe"]){
   expect((await f.db.query<{ok:boolean}>("select has_table_privilege($1,'fluid_private.managed_strategy_admission_context','SELECT,INSERT,UPDATE,DELETE') ok",[role])).rows[0]!.ok).toBe(false);
   expect((await f.db.query<{ok:boolean}>("select has_function_privilege($1,'fluid_private.managed_strategy_uncapped_job(uuid)','EXECUTE') ok",[role])).rows[0]!.ok).toBe(false);
  }
  expect(f.installationGuard).toContain("unexpected_managed_strategy_predecessor");
 });
 it.each(strategyOperations)("admits %s at zero allowance and executes the actual durable engine using an inert provider",async operation=>{
  const e=await f.enroll(),p=await f.project(operation),identity=e.identities[operation]!;
  await f.db.query("update public.usage_accounts set spent_microusd=100,provider_actual_microusd=200 where owner_id=$1",[OWNER_A]);
  const available=await f.owner(OWNER_A,()=>f.rpc<{operations:unknown[]}>("get_strategy_availability",[p.id],"authenticated"));
  expect(available.operations).toHaveLength(4);
  const admitted=await f.submit(p.id,identity,`synthetic-${operation}-request`,operation);
  expect((await f.db.query("select limit_microusd,spent_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows)
   .toEqual([{limit_microusd:0,spent_microusd:100,provider_actual_microusd:200}]);
  expect(admitted).toMatchObject({spendControl:"uncapped",policyIdentity:identity});
  const raw=(await f.db.query<{input:unknown;input_hash:string}>("select input,input_hash from public.jobs where id=$1",[admitted.id])).rows[0]!;
  expect(strategyJobInputSchema.parse(raw.input)).toMatchObject({version:3,spendControl:"uncapped",policyIdentity:identity});
  expect(raw.input).not.toHaveProperty("acceptedMaxCostMicrousd");
  expect((await f.db.query<{same:boolean}>("select input_hash=encode(sha256(convert_to(input::text,'UTF8')),'hex') same from public.jobs where id=$1",[admitted.id])).rows[0]!.same).toBe(true);
  const payload=operation==="strategy.audience"?{label:"Small teams",needs:["Workshops"],reason:"A relevant practical hypothesis"}
   :{profile:{sincerity:80,excitement:45,competence:90,sophistication:30,ruggedness:10},traits:["Warm","Dependable"],toneExample:"Your workshop starts here.",expression:"Friendly practical language"};
  const response=operation==="strategy.competitors"?guidedResearchResponse():responseFixture(operation==="strategy.reformulate"
   ?{kind:"question",targetStage:null,message:"Synthetic offline clarification",question:"Which detail matters?",options:[],selection:null}
   :{kind:"choices",targetStage:null,message:"Synthetic offline choices",question:"Which direction fits?",selection:null,options:[{label:"Synthetic direction",description:"A useful practical direction",recommended:true,recommendationReason:"Fits the supplied brief",payload}]});
  const transport=transportFixture(response);
  const result=await runApiTextDelivery({message:admitted.dispatch,database:e.database,configuration:{apiKey:"synthetic-inert-provider-key",policies:new Map(strategyOperations.map(op=>[op,e.policies[op]!] as const))},deploymentId:e.binding.deploymentId,transport});
  expect(result).toEqual({disposition:"ack",state:"succeeded"});
  expect(transport.createResponse).toHaveBeenCalledTimes(1);
  const request=vi.mocked(transport.createResponse).mock.calls[0]![0];
  expect(request).not.toHaveProperty("spend_control");expect(request).not.toHaveProperty("max_cost");
  expect((await f.db.query("select limit_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows).toEqual([{limit_microusd:0}]);
  expect((await f.db.query("select count(*)::int n from fluid_private.api_text_allowance_admissions")).rows).toEqual([{n:0}]);
  expect((await f.db.query("select count(*)::int n from fluid_private.managed_strategy_admission_context")).rows).toEqual([{n:0}]);
  expect((await f.submit(p.id,identity,`synthetic-${operation}-request`,operation)).id).toBe(admitted.id);
  expect(await runApiTextDelivery({message:admitted.dispatch,database:e.database,configuration:{apiKey:"synthetic-inert-provider-key",policies:new Map(strategyOperations.map(op=>[op,e.policies[op]!] as const))},deploymentId:e.binding.deploymentId,transport})).toEqual({disposition:"ack",state:"succeeded"});
  expect(transport.createResponse).toHaveBeenCalledTimes(1);
 });
 it("initializes only zero-value bookkeeping on the first qualified owner admission, never for an unqualified or foreign request",async()=>{
  const e=await f.enroll(OWNER_A,{existingLedger:false}),p=await f.project(),identity=e.identities["strategy.reformulate"]!;
  expect((await f.db.query("select count(*)::int n from public.usage_accounts")).rows).toEqual([{n:0}]);
  await f.db.query("insert into auth.users(id,email_confirmed_at) values($1,clock_timestamp())",[OWNER_B]);
  const foreign=await f.project("strategy.reformulate",OWNER_B);
  await expect(f.submit(p.id,identity,"synthetic-fresh-foreign","strategy.reformulate",OWNER_B)).rejects.toThrow("not_found");
  await expect(f.submit(foreign.id,identity,"synthetic-fresh-unqualified","strategy.reformulate",OWNER_B)).rejects.toThrow("runtime_unavailable");
  await expect(f.submit(p.id,"f".repeat(64),"synthetic-fresh-wrong-policy")).rejects.toThrow("runtime_unavailable");
  expect((await f.db.query("select count(*)::int n from public.usage_accounts")).rows).toEqual([{n:0}]);
  const admitted=await f.submit(p.id,identity,"synthetic-first-qualified");
  expect((await f.db.query("select owner_id,limit_microusd,spent_microusd,provider_actual_microusd from public.usage_accounts")).rows)
   .toEqual([{owner_id:OWNER_A,limit_microusd:0,spent_microusd:0,provider_actual_microusd:0}]);
  const transport=transportFixture(responseFixture({kind:"question",targetStage:null,message:"Synthetic offline clarification",question:"Which detail matters?",options:[],selection:null}));
  expect(await runApiTextDelivery({message:admitted.dispatch,database:e.database,configuration:{apiKey:"synthetic-inert-provider-key",policies:new Map(strategyOperations.map(op=>[op,e.policies[op]!] as const))},deploymentId:e.binding.deploymentId,transport})).toEqual({disposition:"ack",state:"succeeded"});
  expect(transport.createResponse).toHaveBeenCalledTimes(1);
  expect((await f.db.query("select limit_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows).toEqual([{limit_microusd:0}]);
  expect((await f.db.query("select count(*)::int n from fluid_private.api_text_owner_entitlements")).rows).toEqual([{n:0}]);
 });
 it.each(strategyOperations)("records %s costs above the estimate without a monetary stop, then preserves unknown outcomes",async operation=>{
  const e=await f.enroll(),p=await f.project(operation),identity=e.identities[operation]!;
  const a=await f.submit(p.id,identity,"synthetic-overestimate-request",operation),store=new ApiTextJobStore(e.database,a.dispatch,e.binding.deploymentId,operation);
  const job=(await store.claim("synthetic-worker",120))!;expect(store.hasUnmeteredExecutionAuthority(job)).toBe(true);
  expect(store.hasUnmeteredExecutionAuthority({...job})).toBe(false);
  await store.registerPlan(job,[{key:"synthetic",maximumCostMicrousd:job.reservedCostMicrousd}]);
  await store.beginStep(job,"synthetic",job.reservedCostMicrousd);
  await store.completeStep(job,"synthetic",{status:"failed",code:"synthetic_known_failure",costMicrousd:job.reservedCostMicrousd+500,providerRequestId:"resp_synthetic_known"});
  await store.finish(job,"failed");
  expect((await f.db.query("select state,actual_cost_microusd from public.jobs where id=$1",[job.id])).rows).toEqual([{state:"failed",actual_cost_microusd:job.reservedCostMicrousd+500}]);
  const next=await f.submit(p.id,identity,"synthetic-after-known-overrun",operation),nextStore=new ApiTextJobStore(e.database,next.dispatch,e.binding.deploymentId,operation);
  const j=(await nextStore.claim("synthetic-worker",120))!;
  await nextStore.registerPlan(j,[{key:"synthetic",maximumCostMicrousd:j.reservedCostMicrousd}]);await nextStore.beginStep(j,"synthetic",j.reservedCostMicrousd);
  await nextStore.completeStep(j,"synthetic",{status:"needs_reconciliation",code:"synthetic_unknown",costMicrousd:0,providerRequestId:null});
  const other=await f.project(operation);await expect(f.submit(other.id,identity,"synthetic-blocked-unknown",operation)).rejects.toThrow("runtime_unavailable");
  expect((await f.db.query("select limit_microusd,provider_actual_microusd from public.usage_accounts where owner_id=$1",[OWNER_A])).rows).toEqual([{limit_microusd:0,provider_actual_microusd:job.reservedCostMicrousd+500}]);
 });
 it("never authorizes an unmarked or client-labelled job through the ordinary bounded enqueue",async()=>{
  const e=await f.enroll(),p=await f.project(),policy=e.policies["strategy.reformulate"];
  await expect(f.session("service_role",()=>f.db.query("select public.enqueue_job($1,$2,'strategy.reformulate',1,$3,$4,'synthetic-no-private-witness',1,3)",
   [OWNER_A,p.id,"a".repeat(64),JSON.stringify({version:3,spendControl:"uncapped",policyIdentity:e.identities["strategy.reformulate"],policy})]))).rejects.toThrow("budget_exceeded");
  expect((await f.db.query("select count(*)::int n from public.jobs")).rows).toEqual([{n:0}]);
 });
 it("preserves Stop before dispatch and retains issued cost evidence after Stop",async()=>{
  const e=await f.enroll(),p=await f.project(),identity=e.identities["strategy.reformulate"]!,saved=await f.submit(p.id,identity);
  const store=new ApiTextJobStore(e.database,saved.dispatch,e.binding.deploymentId,"strategy.reformulate"),job=(await store.claim("synthetic-worker",120))!;
  await store.registerPlan(job,[{key:"synthetic",maximumCostMicrousd:job.reservedCostMicrousd}]);
  await f.owner(OWNER_A,()=>f.rpc("request_job_cancel",[job.id],"authenticated"));
  await expect(store.beginStep(job,"synthetic",job.reservedCostMicrousd)).rejects.toThrow("cancel_requested");
  await store.finish(job,"cancelled");
  const p2=await f.project(),saved2=await f.submit(p2.id,identity,"synthetic-issued-stop"),store2=new ApiTextJobStore(e.database,saved2.dispatch,e.binding.deploymentId,"strategy.reformulate"),j=(await store2.claim("synthetic-worker",120))!;
  await store2.registerPlan(j,[{key:"synthetic",maximumCostMicrousd:j.reservedCostMicrousd}]);await store2.beginStep(j,"synthetic",j.reservedCostMicrousd);
  await f.owner(OWNER_A,()=>f.rpc("request_job_cancel",[j.id],"authenticated"));
  await expect(store2.authorizeDispatch(j,"synthetic")).rejects.toThrow("Dispatch unavailable");
  await store2.completeStep(j,"synthetic",{status:"failed",code:"synthetic_issued_stopped",costMicrousd:j.reservedCostMicrousd+20,providerRequestId:"resp_synthetic_stopped"});
  await store2.finish(j,"cancelled");
  expect((await f.db.query("select state,actual_cost_microusd from public.jobs where id=$1",[j.id])).rows).toEqual([{state:"cancelled",actual_cost_microusd:j.reservedCostMicrousd+20}]);
 });
 it("fences tenants, duplicate intents, stale revisions, forged policies and stale leases",async()=>{
  const a=await f.enroll(),b=await f.enroll(OWNER_B),p=await f.project(),other=await f.project("strategy.reformulate",OWNER_B),identity=a.identities["strategy.reformulate"]!;
  await expect(f.submit(p.id,identity,"synthetic-foreign-project","strategy.reformulate",OWNER_B)).rejects.toThrow("not_found");
  await expect(f.submit(p.id,"f".repeat(64),"synthetic-wrong-policy")).rejects.toThrow("runtime_unavailable");
  await expect(f.submit(p.id,identity,"synthetic-stale-revision","strategy.reformulate",OWNER_A,2)).rejects.toThrow("revision_conflict");
  const saved=await f.submit(p.id,identity,"synthetic-canonical-request");
  await expect(f.submit(p.id,identity,"synthetic-second-intent")).rejects.toThrow("active_strategy_request");
  await expect(f.submit(other.id,identity,"synthetic-canonical-request","strategy.reformulate",OWNER_A)).rejects.toThrow("not_found");
  const foreign=new ApiTextJobStore(b.database,saved.dispatch,b.binding.deploymentId,"strategy.reformulate");expect(await foreign.claim("synthetic-foreign",60)).toBeNull();
  const store=new ApiTextJobStore(a.database,saved.dispatch,a.binding.deploymentId,"strategy.reformulate"),job=(await store.claim("synthetic-worker",120))!;
  await expect(store.registerPlan({...job,leaseToken:"11111111-1111-4111-8111-111111111111"},[{key:"synthetic",maximumCostMicrousd:1}])).rejects.toThrow("lease_lost");
  await expect(f.session(a.binding.roleName,()=>f.db.query("insert into fluid_private.managed_strategy_uncapped_jobs(job_id) values($1)",[job.id]))).rejects.toBeDefined();
 });
 it("closes paid admission after ban while preserving an already-issued actual-cost observation",async()=>{
  const e=await f.enroll(),p=await f.project(),next=await f.project(),identity=e.identities["strategy.reformulate"]!,saved=await f.submit(p.id,identity);
  const store=new ApiTextJobStore(e.database,saved.dispatch,e.binding.deploymentId,"strategy.reformulate"),job=(await store.claim("synthetic-worker",120))!;
  await store.registerPlan(job,[{key:"synthetic",maximumCostMicrousd:job.reservedCostMicrousd}]);await store.beginStep(job,"synthetic",job.reservedCostMicrousd);
  await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1",[OWNER_A]);
  await expect(store.authorizeDispatch(job,"synthetic")).rejects.toBeDefined();
  await store.completeStep(job,"synthetic",{status:"failed",code:"synthetic_known_after_ban",costMicrousd:job.reservedCostMicrousd+10,providerRequestId:"resp_synthetic_after_ban"});
  await store.finish(job,"failed");
  expect((await f.db.query("select actual_cost_microusd,state from public.jobs where id=$1",[job.id])).rows).toEqual([{actual_cost_microusd:job.reservedCostMicrousd+10,state:"failed"}]);
  expect((await f.submit(p.id,identity)).id).toBe(saved.id);
  await expect(f.submit(next.id,identity,"synthetic-new-after-ban")).rejects.toThrow("runtime_unavailable");
 });
});
