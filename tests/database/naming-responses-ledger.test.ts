import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { namingResponsesRequestSchema } from "../../src/domain/naming-responses";
import { createTestDatabase, asRole, type TestDatabase } from "./local-supabase";
import { brainRpc, saveBrainArtifact, seedBrainFixture, startBrainFixture } from "./naming-brain-fixture";
import { canonicalResponsesJson, hashResponsesRequest, installNamingResponsesFixture, namingResponsesAction as action, namingResponsesRequest as request, namingResponsesResponse as responseBody, seedNamingResponsesFixture, OWNER_A, OWNER_B, type NamingResponsesFixture } from "./naming-responses-fixture";

describe("dormant Responses ledger over disposable SQL", () => {
 let db: TestDatabase; let f: NamingResponsesFixture;
 beforeAll(async () => { db = await createTestDatabase(); await installNamingResponsesFixture(db); }, 30_000);
 beforeEach(async () => { f = await seedNamingResponsesFixture(db); });
 afterAll(async () => { await db?.close(); });
 it("rejects production admission before any job or reservation, including with synthetic qualification installed", async () => {
  const jobs = (await db.query("select id from public.jobs order by id")).rows, holds = (await db.query("select * from public.usage_reservations order by job_id")).rows;
  for (let i = 0; i < 2; i++) expect(await brainRpc(db, "ensure_naming_responses_run", [f.projectId, { idempotencyKey: "synthetic-admission" }])).toMatchObject({ status: "blocked", code: "provider_budget_control_unavailable" });
  expect((await db.query("select id from public.jobs order by id")).rows).toEqual(jobs);expect((await db.query("select * from public.usage_reservations order by job_id")).rows).toEqual(holds);
  await expect(brainRpc(db, "ensure_naming_responses_run", [f.projectId, {}], OWNER_B)).rejects.toMatchObject({ code: "P0002" });
 });
 it("loads without initializing, independently hashes Unicode-value JSON and reserves the exact maximum once", async () => {
  expect(await action(db,f,"load")).toEqual({ runId:f.runId, allocatedCostNanoUsd:0, maximumCostNanoUsd:5000000000, dispatches:[] });
  expect((await db.query("select count(*)::int n from fluid_private.naming_responses_runs")).rows[0]).toEqual({ n:0 });
  const r=request(f);expect(namingResponsesRequestSchema.parse(r)).toEqual(r);expect((await db.query<{ text:string }>("select fluid_private.naming_responses_canonical($1::jsonb) text",[r])).rows[0]!.text).toBe(canonicalResponsesJson(r));
  expect(await action(db,f,"reserve",r)).toMatchObject({request:r,state:"reserved",responseId:null,terminalResponse:null,observations:[]});
  await action(db,f,"reserve",r);expect(await action(db,f,"load")).toMatchObject({allocatedCostNanoUsd:234576000});
  await expect(action(db,f,"reserve",{...r,body:{...r.body,input:"tampered"}})).rejects.toMatchObject({message:"responses_request_hash_mismatch"});
  await expect(action(db,f,"reserve",hashResponsesRequest({...r,body:{...r.body,input:"different frozen request"}}))).rejects.toMatchObject({message:"immutable_responses_request"});
 });
 it("allows only one begin even after lost acknowledgement and a new lease", async () => {
  const r=request(f);await action(db,f,"reserve",r);
  expect(await action(db,f,"begin",{dispatchKey:r.dispatchKey})).toBe(true);expect(await action(db,f,"begin",{dispatchKey:r.dispatchKey})).toBe(false);
  const next=crypto.randomUUID();await db.query("update public.jobs set lease_token=$2 where id=$1",[f.jobId,next]);
  await expect(action(db,f,"load")).rejects.toMatchObject({code:"PT409"});f.leaseToken=next;
  expect(await action(db,f,"begin",{dispatchKey:r.dispatchKey})).toBe(false);expect(await action(db,f,"load")).toMatchObject({allocatedCostNanoUsd:234576000,dispatches:[{state:"dispatching",responseId:null}]});
 });
 it("rejects a second job reusing another job's run even for the same owner and project",async()=>{
  const r=request(f);await action(db,f,"reserve",r);
  const other={...f,jobId:crypto.randomUUID(),leaseToken:crypto.randomUUID()};
  await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,billing_mode,state,lease_token,lease_expires_at,worker_id) values($1,$2,$3,'naming.generate',1,$4,$5,$6,5000000,1,'openai_api','running',$7,clock_timestamp()+interval '10 minutes','fixture-worker')",[other.jobId,OWNER_A,f.projectId,"b".repeat(64),f.marker,`synthetic-binding-${other.jobId}`,other.leaseToken]);
  const holds=(await db.query("select * from public.usage_reservations order by job_id")).rows;
  const ledger=await action(db,f,"load");
  for(const [name,payload] of [["load",{}],["reserve",r],["begin",{dispatchKey:r.dispatchKey}]] as const)
   await expect(action(db,other,name,payload)).rejects.toMatchObject({message:"responses_run_binding_mismatch",code:"42501"});
  expect(await action(db,f,"load")).toEqual(ledger);
  expect((await db.query("select * from public.usage_reservations order by job_id")).rows).toEqual(holds);
 });
 it("never re-lends unknown or terminal maxima and stops allocation at US$5", async () => {
  for(let i=0;i<21;i++){const r=request(f,`creator.${i}`);await action(db,f,"reserve",r);await action(db,f,"begin",{dispatchKey:r.dispatchKey});}
  expect(await action(db,f,"load")).toMatchObject({allocatedCostNanoUsd:4926096000});
  await expect(action(db,f,"reserve",request(f,"creator.overflow"))).rejects.toMatchObject({message:"responses_budget_exhausted"});
  await action(db,f,"handle",{dispatchKey:"creator.0",responseId:"resp_synthetic_cancelled"});
  const r=request(f,"creator.0"),response=responseBody(r,"resp_synthetic_cancelled","cancelled",{usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
  await action(db,f,"observe",{dispatchKey:r.dispatchKey,response,requestId:null});
  await expect(action(db,f,"reserve",request(f,"creator.still-overflow"))).rejects.toMatchObject({message:"responses_budget_exhausted"});
  expect((await db.query("select actual_cost_nano_usd from fluid_private.naming_responses_runs")).rows).toEqual([{actual_cost_nano_usd:null}]);
 });
 it("binds one response globally, retains append-only observation and immutable terminal evidence", async () => {
  const r=request(f);await action(db,f,"reserve",r);await action(db,f,"begin",{dispatchKey:r.dispatchKey});
  await action(db,f,"handle",{dispatchKey:r.dispatchKey,responseId:"resp_synthetic_observed"});
  expect(await action(db,f,"handle",{dispatchKey:r.dispatchKey,responseId:"resp_synthetic_observed"})).toMatchObject({state:"accepted"});
  await expect(action(db,f,"handle",{dispatchKey:r.dispatchKey,responseId:"resp_rebound"})).rejects.toMatchObject({message:"responses_identity_conflict"});
  const response=responseBody(r,"resp_synthetic_observed","in_progress");
  await action(db,f,"observe",{dispatchKey:r.dispatchKey,response,requestId:null});await action(db,f,"observe",{dispatchKey:r.dispatchKey,response,requestId:null});
  const terminal={...response,status:"completed",output:[{type:"message",content:[{type:"output_text",text:"Synthetic"}]}]};
  expect(await action(db,f,"observe",{dispatchKey:r.dispatchKey,response:terminal,requestId:"req_synthetic"})).toMatchObject({state:"terminal",terminalResponse:terminal,observations:[{response},{response:terminal}]});
  expect(await action(db,f,"observe",{dispatchKey:r.dispatchKey,response:{...terminal,status:"failed"},requestId:null})).toMatchObject({terminalResponse:terminal,observations:expect.arrayContaining([expect.objectContaining({unsafeReason:"responses_terminal_conflict"})])});
  await expect(db.query("update fluid_private.naming_responses_dispatches set maximum_cost_nano_usd=1 where run_id=$1",[f.runId])).rejects.toMatchObject({message:"immutable_responses_evidence"});
 });
 it("fails unqualified research before creating a run or allocation and rejects altered exact cost/caps/tier",async()=>{
  const r=request(f,"research",true),unqualified=hashResponsesRequest({...r,quote:{...r.quote,rateCardId:"openai-gpt-6-luna-standard-20261024",qualificationId:"hosted-search-unqualified-v1",validUntil:"2026-10-25T00:00:00.000Z"}});
  await expect(action(db,f,"reserve",unqualified)).rejects.toMatchObject({message:"responses_qualification_unavailable"});
  expect(await action(db,f,"load")).toMatchObject({allocatedCostNanoUsd:0,dispatches:[]});
  for(const mutation of [{quote:{...r.quote,maximumCostNanoUsd:r.quote.maximumCostNanoUsd-1}},{body:{...r.body,max_output_tokens:32767}},{body:{...r.body,service_tier:"priority"}},{body:{...r.body,previous_response_id:"resp_unqualified"}}])await expect(action(db,f,"reserve",hashResponsesRequest({...r,...mutation}))).rejects.toBeDefined();
 });
 it("fences foreign principals, cancellation and expired leases without changing holds",async()=>{
  const r=request(f);await action(db,f,"reserve",r);
  await expect(action(db,f,"load",{},OWNER_B)).rejects.toMatchObject({code:"42501"});
  await db.query("update public.jobs set cancel_requested_at=clock_timestamp(),state='cancel_requested' where id=$1",[f.jobId]);
  expect(await action(db,f,"begin",{dispatchKey:r.dispatchKey})).toBe(false);await expect(action(db,f,"reserve",request(f,"late"))).rejects.toMatchObject({message:"responses_dispatch_stopped"});
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[f.jobId]);await expect(action(db,f,"load")).rejects.toMatchObject({code:"PT409"});
  expect((await db.query("select reserved_microusd,state,actual_microusd,captured_microusd from public.usage_reservations where job_id=$1",[f.jobId])).rows).toEqual([{reserved_microusd:5000000,state:"active",actual_microusd:0,captured_microusd:0}]);
 });
 it("excludes new jobs from generic claim/expiry and refuses generic settlement",async()=>{
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[f.jobId]);
  expect(await asRole(db,"service_role",null,()=>db.query("select public.expire_job_leases() n"))).toMatchObject({rows:[{n:0}]});
  await db.query("select fluid_private.settle_reservation($1)",[f.jobId]);
  expect((await db.query("select state from public.usage_reservations where job_id=$1",[f.jobId])).rows).toEqual([{state:"active"}]);
  await db.query("update public.jobs set state='queued',lease_token=null,lease_expires_at=null where id=$1",[f.jobId]);
  expect((await asRole(db,"service_role",null,()=>db.query("select * from public.claim_job('generic-fixture',60)"))).rows).toEqual([]);
  expect((await db.query("select fluid_private.naming_brain_is_job(j) legacy,fluid_private.naming_responses_is_job(j) responses from public.jobs j where id=$1",[f.jobId])).rows).toEqual([{legacy:false,responses:true}]);
 });
 it("accepts the exact US$5 ceiling with an explicitly synthetic cumulative bound and not one more dispatch",async()=>{
  await db.query("insert into fluid_private.naming_responses_qualifications values('synthetic-exact-five','synthetic-standard',true,true,24677120,32768,4,$1,'{\"kind\":\"synthetic arithmetic bound only, not hosted-search proof\"}')",[f.until]);
  const base=request(f,"research.exact",true),r=hashResponsesRequest({...base,quote:{...base.quote,qualificationId:"synthetic-exact-five",maximumInputTokens:24677120,maximumCostNanoUsd:5000000000}});
  expect(await action(db,f,"reserve",r)).toMatchObject({request:r,state:"reserved"});
  expect(await action(db,f,"load")).toMatchObject({allocatedCostNanoUsd:5000000000});
  await expect(action(db,f,"reserve",request(f,"one-more"))).rejects.toMatchObject({message:"responses_budget_exhausted"});
 });
 it("fails expired qualification before allocation and rechecks it before the one-shot begin",async()=>{
  const until=(await db.query<{until:string}>("select to_char((clock_timestamp()+interval '1 second') at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') until")).rows[0]!.until;
  await db.query("insert into fluid_private.naming_responses_qualifications values('synthetic-short-validity','synthetic-standard',false,true,1050000,32768,0,$1,'{\"kind\":\"synthetic expiry fixture\"}'),('synthetic-expired','synthetic-standard',false,true,1050000,32768,0,clock_timestamp()-interval '1 second','{\"kind\":\"synthetic expiry fixture\"}')",[until]);
  const base=request(f),r=hashResponsesRequest({...base,quote:{...base.quote,qualificationId:"synthetic-short-validity",validUntil:until}});
  await action(db,f,"reserve",r);await new Promise(resolve=>setTimeout(resolve,1100));
  expect(await action(db,f,"begin",{dispatchKey:r.dispatchKey})).toBe(false);
  const expired=hashResponsesRequest({...base,dispatchKey:"expired",body:{...base.body,metadata:{...base.body.metadata,embel_dispatch:"expired"}},quote:{...base.quote,qualificationId:"synthetic-expired"}});
  await expect(action(db,f,"reserve",expired)).rejects.toMatchObject({message:"responses_qualification_unavailable"});
  expect(await action(db,f,"load")).toMatchObject({allocatedCostNanoUsd:234576000,dispatches:[{state:"reserved"}]});
 });
 it("replays exact rejection evidence idempotently without releasing maxima, and protects retained attempt state",async()=>{
  const r=request(f);await action(db,f,"reserve",r);await action(db,f,"begin",{dispatchKey:r.dispatchKey});
  const rejection={dispatchKey:r.dispatchKey,requestId:"req_synthetic_rejected",code:"provider_request_rejected"};
  expect(await action(db,f,"reject",rejection)).toMatchObject({state:"rejected"});expect(await action(db,f,"reject",rejection)).toMatchObject({state:"rejected",observations:[{code:"provider_request_rejected",requestId:"req_synthetic_rejected"}]});
  await expect(action(db,f,"reject",{...rejection,requestId:"req_changed"})).rejects.toMatchObject({message:"immutable_responses_rejection"});
  await expect(db.query("update fluid_private.naming_responses_attempts set state='reserved' where run_id=$1",[f.runId])).rejects.toMatchObject({message:"immutable_responses_attempt"});
  expect(await action(db,f,"load")).toMatchObject({allocatedCostNanoUsd:234576000});
 });
 it("prevents global response rebinding and unqualified cache or image requests",async()=>{
  for(const key of ["a","b"]){await action(db,f,"reserve",request(f,key));await action(db,f,"begin",{dispatchKey:key});}
  await action(db,f,"handle",{dispatchKey:"a",responseId:"resp_global_synthetic"});
  await expect(action(db,f,"handle",{dispatchKey:"b",responseId:"resp_global_synthetic"})).rejects.toMatchObject({code:"23505"});
  const base=request(f,"forbidden");
  for(const body of [{...base.body,input:[{type:"message",role:"user",content:[{type:"input_image",image_url:"https://synthetic.invalid/image"}]}]},
   {...base.body,text:{...base.body.text,prompt_cache_breakpoint:true}}])await expect(action(db,f,"reserve",hashResponsesRequest({...base,body}))).rejects.toMatchObject({message:"unqualified_responses_body"});
 });
 it("exposes neither qualification writes nor raw ledger writes to public or worker roles",async()=>{
  const privileges=(await db.query("select has_table_privilege('fixture_naming_brain_a','fluid_private.naming_responses_qualifications','insert') worker_insert,has_table_privilege('authenticated','fluid_private.naming_responses_dispatches','insert') public_insert,has_function_privilege('authenticated','public.naming_responses_worker_action(uuid,uuid,text,jsonb)','execute') public_action")).rows;
  expect(privileges).toEqual([{worker_insert:false,public_insert:false,public_action:false}]);
  await expect(asRole(db,"authenticated",OWNER_A,()=>db.query("select * from fluid_private.naming_responses_runs"))).rejects.toMatchObject({code:"42501"});
 });
 it("leaves historical Agents request, receipt and reservation bytes unchanged on new blocked admission",async()=>{
  const project=await seedBrainFixture(db),job=await startBrainFixture(db,project);
  await saveBrainArtifact(db,job,"research",{role:"researcher",territories:[],facts:[],interpretations:[],uncertainties:[]},{readiness:"partial",sources:[]});
  const requests=(await db.query("select request from fluid_private.naming_brain_calls order by call_key")).rows,receipts=(await db.query("select receipt from fluid_private.naming_brain_receipts order by created_at,id")).rows,holds=(await db.query("select * from public.usage_reservations order by job_id")).rows;
  expect(await brainRpc(db,"ensure_naming_responses_run",[project,{}])).toMatchObject({status:"blocked"});
  expect((await db.query("select request from fluid_private.naming_brain_calls order by call_key")).rows).toEqual(requests);expect((await db.query("select receipt from fluid_private.naming_brain_receipts order by created_at,id")).rows).toEqual(receipts);expect((await db.query("select * from public.usage_reservations order by job_id")).rows).toEqual(holds);
 });
 it.each(["input","cache","cache_shape","tier","model"])("retains raw %s breach and never clears run quarantine after a clean terminal",async kind=>{
  const r=request(f,"unsafe"),pending=request(f,"already-reserved");await action(db,f,"reserve",r);await action(db,f,"reserve",pending);await action(db,f,"begin",{dispatchKey:r.dispatchKey});await action(db,f,"handle",{dispatchKey:r.dispatchKey,responseId:"resp_unsafe_synthetic"});
  const violation=responseBody(r,"resp_unsafe_synthetic","in_progress",kind==="input"?{usage:{input_tokens:r.quote.maximumInputTokens+1,output_tokens:1}}:kind==="cache"?{usage:{input_tokens:1,output_tokens:1,input_tokens_details:{cached_tokens:1}}}:kind==="cache_shape"?{usage:{input_tokens:1,output_tokens:1,input_tokens_details:{cached_tokens:"0"}}}:kind==="tier"?{service_tier:"priority"}:{model:"gpt-6-astra"});
  expect(await action(db,f,"observe",{dispatchKey:r.dispatchKey,response:violation,requestId:null})).toMatchObject({observations:[{response:violation}]});
  expect(await action(db,f,"begin",{dispatchKey:pending.dispatchKey})).toBe(false);await expect(action(db,f,"reserve",request(f,"after-unsafe"))).rejects.toMatchObject({message:"responses_observed_bound_exceeded"});
  const clean=responseBody(r,"resp_unsafe_synthetic");expect(await action(db,f,"observe",{dispatchKey:r.dispatchKey,response:clean,requestId:null})).toMatchObject({state:"terminal",terminalResponse:clean,observations:[{response:violation},{response:clean}]});
  expect(await action(db,f,"begin",{dispatchKey:pending.dispatchKey})).toBe(false);await expect(action(db,f,"reserve",request(f,"still-unsafe"))).rejects.toMatchObject({message:"responses_observed_bound_exceeded"});
  expect((await db.query("select actual_cost_nano_usd from fluid_private.naming_responses_runs where id=$1",[f.runId])).rows).toEqual([{actual_cost_nano_usd:null}]);
 });
 it("retains a bounded unsafe witness for an oversized same-identity response",async()=>{
  const r=request(f);await action(db,f,"reserve",r);await action(db,f,"begin",{dispatchKey:r.dispatchKey});await action(db,f,"handle",{dispatchKey:r.dispatchKey,responseId:"resp_oversize_synthetic"});
  const oversized=responseBody(r,"resp_oversize_synthetic","in_progress",{padding:"x".repeat(2097152)});
  expect(await action(db,f,"observe",{dispatchKey:r.dispatchKey,response:oversized,requestId:null})).toMatchObject({state:"accepted",terminalResponse:null,observations:[{kind:"oversize_response",responseId:"resp_oversize_synthetic",unsafeReason:"responses_output_limit",sha256:expect.stringMatching(/^[a-f0-9]{64}$/)}]});
  await expect(action(db,f,"reserve",request(f,"after-large"))).rejects.toMatchObject({message:"responses_observed_bound_exceeded"});
 });
});
