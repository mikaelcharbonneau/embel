import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createSharedAdvancedLogoFixture,type SharedAdvancedLogoFixture } from "./shared-advanced-logo-fixture";
import { OWNER_A,OWNER_B } from "./local-supabase";
import { logoCostQuoteSchema,logoRequestStateSchema,type LogoGenerationIntent } from "../../src/domain/logo-jobs";
import { sharedExecutionSchema } from "../../worker/shared-pool/contracts";
type Item={ownerId:string;projectId:string;input:LogoGenerationIntent;state:{status:string;receipt:{jobIds:string[]}};proposal:unknown};
type Page={ownerId:string;projectId:string;items:Item[];nextCursor:string|null};
/** Synthetic provider/source fixtures; real verified-session, ownership,
 * immutable admissions, pending discovery and normal cancellation SQL. */
describe("cold reload pending proposal discovery (actual disposable SQL)",()=>{
 let f:SharedAdvancedLogoFixture;
 beforeAll(async()=>{f=await createSharedAdvancedLogoFixture();},90_000);
 afterAll(async()=>{await f?.close();});
 async function list(project:string,cursor:string|null=null,limit:number|null=10,owner=OWNER_A):Promise<Page>{
  return f.owner(owner,async()=>{
   await f.db.exec("set session authorization postgres;set session authorization authenticator;set role authenticated");
   return(await f.db.query<{value:Page}>("select public.list_pending_logo_vector_proposal_requests($1,$2,$3) value",[project,cursor,limit])).rows[0]!.value;
  });
 }
 async function setup(owner=OWNER_A){await f.resetLease();await f.runtimeReady();return f.prepareProposal(owner);}
 async function another(p:Awaited<ReturnType<SharedAdvancedLogoFixture["prepareProposal"]>>,owner=OWNER_A){
  const quote=logoCostQuoteSchema.parse(await f.logoWeb(owner,"proposal_quote",p.job.project_id,p.evidence.request,p.evidence));return f.admitAdvanced(p.job.project_id,quote,owner);
 }
 async function transaction(run:()=>Promise<void>){await f.db.exec("begin");try{await run();}finally{await f.db.exec("rollback;set session authorization postgres");}}
 it("recovers every original stored intent after losing local memory, across multiple queued requests and two owners",async()=>transaction(async()=>{
  const a=await setup(),second=await another(a),third=await another(a),b=await f.prepareProposal(OWNER_B);
  const snapshots=(await f.db.query("select id,state,input from public.jobs order by id")).rows;
  const page=await list(a.job.project_id);
  expect(page).toMatchObject({ownerId:OWNER_A,projectId:a.job.project_id,nextCursor:null});
  expect(page.items.map(item=>item.input)).toEqual([third.request,second.request,a.request]);
  for(const item of page.items){expect(item.ownerId).toBe(OWNER_A);expect(item.projectId).toBe(a.job.project_id);expect(item.proposal).toBeNull();expect(logoRequestStateSchema.parse(item.state)).toMatchObject({status:"admitted",requestKey:item.input.requestKey});expect(item.input).not.toHaveProperty("acceptedMaxCostMicrousd");}
  expect((await list(b.job.project_id,null,10,OWNER_B)).items.map(item=>item.input)).toEqual([b.request]);
  await expect(list(a.job.project_id,null,10,OWNER_B)).rejects.toMatchObject({code:"P0002"});
  expect((await f.db.query("select id,state,input from public.jobs order by id")).rows).toEqual(snapshots);
  expect((await f.db.query("select * from fluid_private.shared_logo_proposal_request_closures")).rows).toEqual([]);
 }),90_000);
 it("bounds a page to ten and anchors continuation to the actual owned request even after it becomes terminal",async()=>transaction(async()=>{
  const p=await setup(),all=[p];for(let i=0;i<10;i++)all.push({...p,...await another(p)});
  const first=await list(p.job.project_id);expect(first.items).toHaveLength(10);expect(first.nextCursor).toBe(first.items[9]!.input.requestKey);
  const anchor=all.find(item=>item.request.requestKey===first.nextCursor)!;
  await f.owner(OWNER_A,()=>f.db.query("select public.request_job_cancel($1)",[anchor.jobId]));
  const next=await list(p.job.project_id,first.nextCursor);expect(next.items).toHaveLength(1);expect(next.nextCursor).toBeNull();
  expect(next.items[0]!.input).toEqual(p.request);
  expect(new Set([...first.items,...next.items].map(item=>item.input.requestKey)).size).toBe(11);
  const foreign=await f.prepareProposal(OWNER_B);
  await expect(list(p.job.project_id,foreign.request.requestKey)).rejects.toMatchObject({code:"P0002"});
  await expect(list(p.job.project_id,"00000000-0000-4000-8000-000000000001")).rejects.toMatchObject({code:"P0002"});
 }),90_000);
 it("discovers running and unresolved requests while excluding terminal requests without unresolved steps",async()=>transaction(async()=>{
  const p=await setup();
  const e=sharedExecutionSchema.parse((await f.action(null,"claim",["synthetic-pending-discovery",120])).execution);
  expect((await list(p.job.project_id)).items[0]!.state.status).toBe("running");
  await f.action(e,"begin",[e.jobId,e.leaseToken,"propose-vector-edit",`synthetic:${e.jobId}`,0]);
  await f.action(e,"complete",[e.jobId,e.leaseToken,"propose-vector-edit","ambiguous",0,{error:"provider_outcome_unknown"},null]);
  expect((await list(p.job.project_id)).items[0]!.state.status).toBe("needs_reconciliation");
  // A historical terminal row with an unresolved step must still be exposed;
  // this does not alter its immutable input, receipts or provider evidence.
  await f.db.query("update public.jobs set state='failed' where id=$1",[e.jobId]);
  expect((await list(p.job.project_id)).items.map(item=>item.input)).toEqual([p.request]);
  await f.db.query("update public.job_steps set state='failed' where job_id=$1",[e.jobId]);
  expect((await list(p.job.project_id))).toMatchObject({items:[],nextCursor:null});
 }),90_000);
 it.each(["missing","mismatched"] as const)("fails closed for %s immutable request binding instead of reporting an empty safe page",async mode=>transaction(async()=>{
  const p=await setup();
  await f.db.exec("alter table public.logo_operation_requests disable trigger logo_operation_requests_immutable");
  if(mode==="missing")await f.db.query("delete from public.logo_operation_requests where request_key=$1",[p.request.requestKey]);
  else await f.db.query("update public.logo_operation_requests set receipt=jsonb_set(receipt,'{jobIds}','[]'::jsonb) where request_key=$1",[p.request.requestKey]);
  await expect(list(p.job.project_id)).rejects.toMatchObject({code:"55000"});
  expect((await f.rawJob(p.jobId)).state).toBe("queued");
 }),90_000);
 it("excludes a normally cancelled queued request and never treats invalid page/session arguments as success",async()=>transaction(async()=>{
  const p=await setup();await f.owner(OWNER_A,()=>f.db.query("select public.request_job_cancel($1)",[p.jobId]));
  expect((await list(p.job.project_id))).toMatchObject({items:[],nextCursor:null});
  for(const limit of [0,11,null])await expect(list(p.job.project_id,null,limit)).rejects.toMatchObject({code:"22023"});
  await f.db.query("delete from auth.sessions where id=$1",[f.customerSessions[OWNER_A]]);
  await expect(list(p.job.project_id)).rejects.toMatchObject({code:"42501"});
 }),90_000);
});
