import { createHash,randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createSharedAdvancedLogoFixture,type SharedAdvancedLogoFixture } from "./shared-advanced-logo-fixture";
import { proposalPolicy } from "../server/logo-vector-proposal-fixtures";
import { OWNER_A,OWNER_B } from "./local-supabase";
import { sharedExecutionSchema } from "../../worker/shared-pool/contracts";
import { logoCostQuoteSchema,legacyLogoCostQuoteSchema,logoGenerationIntentSchema,logoRequestStateSchema,type LogoGenerationIntent } from "../../src/domain/logo-jobs";
import { logoVectorProposalRecordSchema,logoVectorProposalUsageCost } from "../../src/domain/logo-vector-proposal-jobs";

describe("exact owned paid proposal request recovery and original intent closure (disposable SQL)",()=>{
 let f:SharedAdvancedLogoFixture;
 beforeAll(async()=>{f=await createSharedAdvancedLogoFixture();},90_000);
 afterAll(async()=>{await f?.close();});
 async function verified(name:"read_logo_vector_proposal_request"|"close_logo_vector_proposal_request",project:string,input:LogoGenerationIntent,owner=OWNER_A,overrides:Record<string,unknown>={}){
  return f.owner(owner,async()=>{
   if(Object.keys(overrides).length)await f.db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify(f.claims({sub:owner,session_id:f.customerSessions[owner],...overrides}))]);
   await f.db.exec("set session authorization postgres;set session authorization authenticator;set role authenticated");
   return(await f.db.query<{value:unknown}>(`select public.${name}($1,$2) value`,[project,input])).rows[0]!.value;
  });
 }
 async function setup(){await f.resetLease();await f.runtimeReady();const prepared=await f.prepareProposal();return{...prepared,request:logoGenerationIntentSchema.parse(prepared.request)};}
 async function freshIntent(p:Pick<Awaited<ReturnType<SharedAdvancedLogoFixture["prepareProposal"]>>,"job"|"evidence">){
  const quote=logoCostQuoteSchema.parse(await f.logoWeb(OWNER_A,"proposal_quote",p.job.project_id,p.evidence.request,p.evidence));
  return{quote,input:{requestKey:randomUUID(),quoteId:quote.id,expected:quote.expected}};
 }
 async function transaction(run:()=>Promise<void>){await f.db.exec("begin");try{await run();}finally{await f.db.exec("rollback;set session authorization postgres");}}
 it("missing lookup is not an absence proof; atomic close fences the exact late original admission and replays immutably",async()=>transaction(async()=>{
  const p=await setup(),t=await freshIntent(p);
  await expect(verified("read_logo_vector_proposal_request",p.job.project_id,t.input)).rejects.toMatchObject({code:"P0002"});
  const before=(await f.db.query("select id from public.jobs order by id")).rows;
  const closed=await verified("close_logo_vector_proposal_request",p.job.project_id,t.input);
  expect(closed).toEqual({status:"not_admitted",ownerId:OWNER_A,projectId:p.job.project_id,input:t.input});
  expect(await verified("close_logo_vector_proposal_request",p.job.project_id,t.input)).toEqual(closed);
  await expect(verified("close_logo_vector_proposal_request",p.job.project_id,{...t.input,quoteId:p.quote.id})).rejects.toMatchObject({code:"PT409"});
  const replay=await f.owner(OWNER_A,async()=>(await f.db.query<{value:unknown}>("select public.shared_logo_operation($1,'admit',$2) value",[p.job.project_id,t.input])).rows[0]!.value);
  expect(replay).toMatchObject({kind:"logo_admission_rejected",rejection:{requestKey:t.input.requestKey,quoteId:t.quote.id}});
  expect((await f.db.query("select id from public.jobs order by id")).rows).toEqual(before);
  const read=await verified("read_logo_vector_proposal_request",p.job.project_id,t.input) as {input:unknown;state:unknown;proposal:unknown};
  expect(read.input).toEqual(t.input);expect(logoRequestStateSchema.parse(read.state)).toMatchObject({status:"failed",reason:"admission_rejected"});expect(read.proposal).toBeNull();
  await expect(f.db.query("update fluid_private.shared_logo_proposal_request_closures set receipt='{}' where request_key=$1",[t.input.requestKey])).rejects.toMatchObject({code:"42501"});
 }),90_000);
 it("admission before Stop returns the original actual queued cancellation and never writes an absence witness",async()=>transaction(async()=>{
  const p=await setup();
  expect(await verified("read_logo_vector_proposal_request",p.job.project_id,p.request)).toMatchObject({ownerId:OWNER_A,input:p.request,state:{status:"admitted",receipt:p.receipt},proposal:null});
  expect(await verified("close_logo_vector_proposal_request",p.job.project_id,p.request)).toMatchObject({status:"admitted",request:{input:p.request,state:{status:"cancelled",receipt:p.receipt},proposal:null}});
  expect((await f.rawJob(p.jobId)).state).toBe("cancelled");
  expect((await f.db.query("select * from fluid_private.shared_logo_proposal_request_closures")).rows).toEqual([]);
 }),90_000);
 it("Stop preserves an already-issued unknown outcome, its evidence, original job and unsettled accounting",async()=>transaction(async()=>{
  const p=await setup(),e=sharedExecutionSchema.parse((await f.action(null,"claim",["synthetic-proposal-request-recovery",120])).execution);
  await f.action(e,"begin",[e.jobId,e.leaseToken,"propose-vector-edit",`issued:${e.jobId}`,0]);
  const observation={version:1,kind:"logo_vector_proposal_text",textPolicy:f.proposalCapability.textPolicy,provider:"openai",model:"gpt-6.1-sol",providerRequestId:`req_${e.jobId}`,responseId:`resp_${e.jobId}`,responseHash:"a".repeat(64),observedAt:new Date().toISOString(),responseComplete:true,serviceTier:"default",toolCalls:0,
   usage:{inputTokens:2,outputTokens:3,cachedInputTokens:0,cacheWriteInputTokens:0},billing:{status:"unknown",confirmedMicrousd:null}};
  await f.action(e,"receipt",[e.jobId,e.leaseToken,observation]);
  await f.action(e,"complete",[e.jobId,e.leaseToken,"propose-vector-edit","ambiguous",0,{error:"provider_outcome_unknown"},null]);
  const ledger=(await f.db.query("select * from public.usage_reservations where job_id=$1",[e.jobId])).rows;
  const steps=(await f.db.query("select * from public.job_steps where job_id=$1",[e.jobId])).rows;
  const receipts=(await f.db.query("select * from public.logo_provider_responses where job_id=$1",[e.jobId])).rows;
  expect(await verified("close_logo_vector_proposal_request",p.job.project_id,p.request)).toMatchObject({status:"admitted",request:{input:p.request,state:{status:"needs_reconciliation",receipt:p.receipt,billing:{status:"unknown"}},proposal:null}});
  expect((await f.rawJob(e.jobId))).toMatchObject({state:"needs_reconciliation",lease_token:null});
  expect((await f.db.query<{cancel_requested_at:string|null}>("select cancel_requested_at::text cancel_requested_at from public.jobs where id=$1",[e.jobId])).rows[0]!.cancel_requested_at).not.toBeNull();
  expect((await f.db.query("select * from public.usage_reservations where job_id=$1",[e.jobId])).rows).toEqual(ledger);
  expect((await f.db.query("select * from public.job_steps where job_id=$1",[e.jobId])).rows).toEqual(steps);
  expect((await f.db.query("select * from public.logo_provider_responses where job_id=$1",[e.jobId])).rows).toEqual(receipts);
 }),90_000);
 it("looks up the exact actual proposal without history search and rejects a grafted source context",async()=>transaction(async()=>{
  const p=await setup(),e=sharedExecutionSchema.parse((await f.action(null,"claim",["synthetic-proposal-request-recovery",120])).execution);
  await f.action(e,"begin",[e.jobId,e.leaseToken,"propose-vector-edit",`issued:${e.jobId}`,0]);
  const usage={inputTokens:2,outputTokens:3,cachedInputTokens:0,cacheWriteInputTokens:0},cost=logoVectorProposalUsageCost(usage);
  const observation={version:1,kind:"logo_vector_proposal_text",textPolicy:f.proposalCapability.textPolicy,provider:"openai",model:"gpt-6.1-sol",providerRequestId:`req_${e.jobId}`,responseId:`resp_${e.jobId}`,responseHash:"a".repeat(64),observedAt:new Date().toISOString(),responseComplete:true,serviceTier:"default",toolCalls:0,usage,billing:{status:"recorded",confirmedMicrousd:cost}};
  const receipt=(await f.action(e,"receipt",[e.jobId,e.leaseToken,observation])).result as {id:string};
  const payload={version:1,status:"proposed",edit:{kind:"rotation",componentId:p.context.components[0]!.id,degrees:10},explanation:"Synthetic exact-request lookup."},bytes=Buffer.from(JSON.stringify(payload));
  const staged=(await f.action(e,"stage_proposal",[e.jobId,e.leaseToken,{status:"valid",payload,reason:null,retainedOutput:{encoding:"base64",data:bytes.toString("base64"),sha256:createHash("sha256").update(bytes).digest("hex"),byteLength:bytes.length,truncated:false}},receipt.id])).result as {id:string};
  await f.action(e,"complete",[e.jobId,e.leaseToken,"propose-vector-edit","succeeded",cost,{version:1,kind:"logo_vector_proposal",preparedId:staged.id,providerResponseReceiptId:receipt.id},observation.providerRequestId]);
  await f.action(e,"finish",[e.jobId,e.leaseToken,"succeeded"]);
  const result=await verified("read_logo_vector_proposal_request",p.job.project_id,p.request) as {input:unknown;state:unknown;proposal:unknown};
  expect(result.input).toEqual(p.request);expect(logoRequestStateSchema.parse(result.state)).toMatchObject({status:"succeeded",receipt:p.receipt,billing:{status:"recorded",confirmedMicrousd:cost}});
  expect(logoVectorProposalRecordSchema.parse(result.proposal)).toMatchObject({id:staged.id,jobId:p.jobId,requestKey:p.request.requestKey,quoteId:p.request.quoteId,context:p.context});
  await f.db.exec("alter table fluid_private.shared_logo_vector_proposals disable trigger logo_vector_proposals_immutable");
  await f.db.query("update fluid_private.shared_logo_vector_proposals set record=jsonb_set(record,'{contextHash}',to_jsonb(repeat('f',64))) where id=$1",[staged.id]);
  await expect(verified("read_logo_vector_proposal_request",p.job.project_id,p.request)).rejects.toMatchObject({code:"55000"});
 }),90_000);
 it.each(["changed_expected","changed_quote","added_cost","foreign_project","foreign_session","expired_session","revoked_session","ban","missing_quote"] as const)("rejects %s without writing absence or mutating the paid request",async mode=>transaction(async()=>{
  const p=await setup(),t=await freshIntent(p);let input:LogoGenerationIntent=t.input,owner=OWNER_A,overrides:Record<string,unknown>={};
  if(mode==="changed_expected")input={...input,expected:{...input.expected,projectRevision:input.expected.projectRevision+1}};
  if(mode==="changed_quote")input={...input,quoteId:p.request.quoteId,expected:{...input.expected,projectRevision:input.expected.projectRevision+1}};
  if(mode==="added_cost")input={...input,acceptedMaxCostMicrousd:0};
  if(mode==="foreign_project")owner=OWNER_B;
  if(mode==="foreign_session")overrides={session_id:f.customerSessions[OWNER_B]};
  if(mode==="expired_session")await f.db.query("update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1",[f.customerSessions[OWNER_A]]);
  if(mode==="revoked_session")await f.db.query("delete from auth.sessions where id=$1",[f.customerSessions[OWNER_A]]);
  if(mode==="ban")await f.db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1",[OWNER_A]);
  if(mode==="missing_quote")input={...input,quoteId:randomUUID()};
  await expect(verified("close_logo_vector_proposal_request",p.job.project_id,input,owner,overrides)).rejects.toMatchObject({code:["foreign_project","missing_quote"].includes(mode)?"P0002":["foreign_session","expired_session","revoked_session","ban"].includes(mode)?"42501":"PT409"});
  expect((await f.db.query("select * from fluid_private.shared_logo_proposal_request_closures")).rows).toEqual([]);
  expect((await f.db.query("select * from public.logo_operation_rejections where request_key=$1",[t.input.requestKey])).rows).toEqual([]);
  expect((await f.rawJob(p.jobId)).state).toBe("queued");
 }),90_000);
 it("preserves historical accepted amount exactly and rejects owner-GUC-only calls/private access",async()=>transaction(async()=>{
  const p=await setup(),id=randomUUID(),policy=proposalPolicy();
  const {version:_version,billingMode:_billing,spendControl:_spend,textPolicy:_text,...base}=p.quote as Record<string,unknown>;void _version;void _billing;void _spend;void _text;
  const record=legacyLogoCostQuoteSchema.parse({...base,id,maxCostMicrousd:policy.maximumCostMicrousd,estimatedCostMicrousd:policy.maximumCostMicrousd,externalProviderCostMicrousd:policy.maximumCostMicrousd,textPolicy:policy});
  await f.db.query("insert into public.logo_cost_quotes(id,owner_id,project_id,operation,record,input_revisions,source_inputs,expires_at) select $1,owner_id,project_id,operation,$2,input_revisions,source_inputs,expires_at from public.logo_cost_quotes where id=$3",[id,record,p.quote.id]);
  const input={requestKey:randomUUID(),quoteId:id,expected:p.quote.expected,acceptedMaxCostMicrousd:policy.maximumCostMicrousd+1};
  expect(await verified("close_logo_vector_proposal_request",p.job.project_id,input)).toEqual({status:"not_admitted",ownerId:OWNER_A,projectId:p.job.project_id,input});
  const replay=await f.owner(OWNER_A,async()=>(await f.db.query<{value:unknown}>("select public.shared_logo_operation($1,'admit',$2) value",[p.job.project_id,input])).rows[0]!.value);
  expect(replay).toMatchObject({kind:"logo_admission_rejected",rejection:{requestKey:input.requestKey}});
  await expect(f.owner(OWNER_A,()=>f.db.query("select public.read_logo_vector_proposal_request($1,$2)",[p.job.project_id,input]))).rejects.toMatchObject({code:"42501"});
  expect((await f.db.query("select has_function_privilege('authenticated','fluid_private.shared_logo_read_proposal_request(uuid,uuid,jsonb,public.logo_cost_quotes)','EXECUTE') helper,has_table_privilege('authenticated','fluid_private.shared_logo_proposal_request_closures','SELECT') witness")).rows).toEqual([{helper:false,witness:false}]);
 }),90_000);
});
