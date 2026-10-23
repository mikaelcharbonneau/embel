import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { contextSnapshotSchema } from "../../src/domain/projects";
import { nameIdentityKey, namingStrategyBasis, namingStrategyKey } from "../../src/domain/project-naming";
import { getNamingFulfillment } from "../../src/domain/naming-jobs";
import { createBrandFromProjectName, enqueueNamingBatch, getAccountNames, getCustomProjectNames, getNamingBatch, getProjectNaming, importLocalName, saveNamingPreferences, saveNamingView, selectProjectName, setNameRetention, transformProjectNames } from "../../src/server/data/project-naming";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { asRole, asSubscriptionWorker, createTestDatabase, HASH, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "../database/local-supabase";

const at="2026-10-04T12:00:00Z";
const context=contextSnapshotSchema.parse({description:"Explicit local server Naming fixture"});
const preferences={version:1,creativeLocale:"en",notes:"",minimumGraphemes:null,maximumGraphemes:null};
const source={id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",value:"Cedar",createdAt:at,origin:"manual",history:[]};
const policy={version:1,billingMode:"chatgpt_subscription",handlerVersion:"naming-chatgpt-v1",registrationId:"server-fixture-registration",model:"fixture-model",limits:{maxInputBytes:131072,maxOutputBytes:262144,deadlineMs:240000,maxObservedWebSearchCalls:0,maxRequestsPerHour:20,maxQueuedJobs:3}};

describe("Naming DAL with real local ownership and provenance rows",()=>{
 let db:TestDatabase;let project:string;let auth:AuthenticatedContext;
 beforeAll(async()=>{db=await createTestDatabase();},30000);afterAll(async()=>{await db?.close();});
 const run=<T>(fn:()=>Promise<T>,owner=OWNER_A)=>asRole(db,"authenticated",owner,fn);
 function client(owner=OWNER_A):AuthenticatedContext{
  return {userId:owner,client:{
   rpc:async(name:string,args:Record<string,unknown>)=>{
    try{const keys=Object.keys(args);if(!/^[a-z_]+$/.test(name)||keys.some(key=>!/^p_[a-z_]+$/.test(key)))throw Error("Unexpected fixture query");
     const row=await run(()=>db.query<{result:unknown}>(`select public.${name}(${keys.map((key,i)=>`${key}=>$${i+1}`).join(",")}) result`,Object.values(args).map(value=>value&&typeof value==="object"?JSON.stringify(value):value)),owner);
     return {data:row.rows[0]!.result,error:null};}catch(error){return {data:null,error:{code:(error as {code:string}).code}};}
   },
   from:(table:string)=>{const filters:Array<[string,unknown]>=[];let after:{createdAt:string;id:string}|null=null;const fieldSql=(field:string)=>field==="origin->>kind"?"origin->>'kind'":field;const query={select:()=>query,order:()=>query,or:(value:string)=>{const match=/^created_at.gt.([^,]+),and\(created_at.eq.([^,]+),id.gt.([^)]+)\)$/.exec(value);if(!match||match[1]!==match[2])throw Error("Unexpected fixture cursor");after={createdAt:match[1]!,id:match[3]!};return query;},limit:async(count:number)=>{if(table!=="name_candidates")throw Error("Unexpected fixture table");const args=filters.map(([,value])=>value);let where=filters.map(([field],i)=>`${fieldSql(field)}=$${i+1}`).join(" and ");if(after){where+=` and (created_at,id)>($${args.length+1}::timestamptz,$${args.length+2}::uuid)`;args.push(after.createdAt,after.id);}const result=await run(()=>db.query<{result:unknown}>(`select to_jsonb(c) result from public.name_candidates c where ${where} order by created_at,id limit ${count}`,args),owner);return {data:result.rows.map(row=>row.result),error:null};},in:async(field:string,ids:string[])=>{if(table!=="name_retention"||field!=="candidate_id")throw Error("Unexpected fixture retention read");const args=filters.map(([,value])=>value);const result=await run(()=>db.query<{result:unknown}>(`select to_jsonb(r) result from public.name_retention r where ${filters.map(([key],i)=>`${key}=$${i+1}`).join(" and ")} and candidate_id=any($${args.length+1}::uuid[])`,[...args,ids]),owner);return {data:result.rows.map(row=>row.result),error:null};},eq:(field:string,value:unknown)=>{filters.push([field,value]);return query;},maybeSingle:async()=>{
    if(!["project_revisions","projects"].includes(table))throw Error("Unexpected fixture table");
    const result=await run(()=>db.query(`select ${table==="projects"?"id,owner_id":"project_id,owner_id,revision"} from public.${table} where ${filters.map(([field],i)=>`${field}=$${i+1}`).join(" and ")}`,filters.map(([,value])=>value)),owner);
    return {data:result.rows[0]??null,error:null};}};return query;},
  }} as unknown as AuthenticatedContext;
 }
 beforeEach(async()=>{await resetFixture(db);project=await run(async()=>(await db.query<{id:string}>("select * from public.create_project('naming_only','Fixture',$1::jsonb,$2)",[JSON.stringify(context),HASH])).rows[0]!.id);auth=client();});
 async function imported(value="Cedar",key="fixture-server-import-001"){
  return importLocalName(auth,project,{expectedProjectRevision:1,source:{...source,value},capturedContext:context,idempotencyKey:key});
 }
 async function generate(){
  await saveNamingPreferences(auth,project,{expectedPreferencesVersion:0,preferences});
  await asSubscriptionWorker(db,OWNER_A,()=>db.query("select public.configure_subscription_runtime($1,'naming.generate',$2::jsonb,true)",[OWNER_A,JSON.stringify(policy)]));
  await asSubscriptionWorker(db,OWNER_A,()=>db.query("select public.report_subscription_worker_ready($1,$2,'naming.generate',$3::jsonb,90)",[OWNER_A,policy.registrationId,JSON.stringify(policy)]));
  const identity=(await db.query<{value:string}>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') value",[JSON.stringify(policy)])).rows[0]!.value;
  const result=await enqueueNamingBatch(auth,project,{expectedProjectRevision:1,expectedPreferencesVersion:1,expectedBatchSequence:0,idempotencyKey:"fixture-server-enqueue-001",billingMode:"chatgpt_subscription",acceptedPolicyIdentity:identity});
  const job=await asSubscriptionWorker(db,OWNER_A,async()=>(await db.query<{id:string;lease_token:string}>("select * from public.claim_subscription_job('server-fixture',$1,$2,90)",[OWNER_A,policy.registrationId])).rows[0]!);
  const output={version:1,operation:"naming.generate",provider:"openai",billingMode:"chatgpt_subscription",model:policy.model,responseId:"fixture-response",requestId:null,generatedAt:at,usage:null,batchId:result.batch.id,sequence:1,targetCount:result.batch.targetCount,
   accepted:[{value:"Cedar",identityKey:"cedar",rationale:"Explicit local provider fixture."}],fulfillment:getNamingFulfillment(result.batch.targetCount,1,{invalid_candidate:0,empty_identity:0,below_minimum:0,above_maximum:0,duplicate_response:0,duplicate_history:0,over_target:0})};
  await asSubscriptionWorker(db,OWNER_A,()=>db.query("select public.register_job_plan($1,$2,$3::jsonb)",[job.id,job.lease_token,JSON.stringify([{key:"names",maximumCostMicrousd:0}])]));
  await asSubscriptionWorker(db,OWNER_A,()=>db.query("select public.begin_job_step($1,$2,'names','server-fixture-request',0)",[job.id,job.lease_token]));
  await asSubscriptionWorker(db,OWNER_A,()=>db.query("select public.complete_naming_job_step($1,$2,'names','succeeded',0,$3::jsonb,'fixture-response')",[job.id,job.lease_token,JSON.stringify(output)]));
  return result.batch.id;
 }
 it("reads imported candidates only after exact source replay and owner/project checks",async()=>{
  const value=await imported();const read=await getProjectNaming(auth,project);expect(read.candidates.items[0]!.candidate).toEqual(value.entry.candidate);
  await expect(getProjectNaming(client(OWNER_B),project)).rejects.toMatchObject({code:"not_found"});
  await expect(importLocalName(auth,project,{expectedProjectRevision:1,source:{...source,origin:"generated"},capturedContext:context,idempotencyKey:"fixture-forged-server-001"})).rejects.toMatchObject({code:"invalid_input"});
 });
 it("pages custom names independently and retains account ownership with generation unavailable",async()=>{
  const first=await imported();await imported("Elm","fixture-custom-import-002");
  const page=await getCustomProjectNames(auth,project,{limit:1});
  expect(page.items.map(row=>row.candidate.value)).toEqual(["Cedar"]);expect(page.nextCursor).not.toBeNull();
  const next=await getCustomProjectNames(auth,project,{limit:1,cursor:page.nextCursor});
  expect(next.items.map(row=>row.candidate.value)).toEqual(["Elm"]);expect(next.nextCursor).toBeNull();
  expect((await getProjectNaming(auth,project)).availability.status).toBe("unavailable");
  await selectProjectName(auth,project,{candidateId:first.entry.candidate.id,expectedRevision:1,acceptEarlierContext:false});
  expect((await getProjectNaming(auth,project)).currentSelection?.candidate.value).toBe("Cedar");
  await expect(getCustomProjectNames(client(OWNER_B),project)).rejects.toMatchObject({code:"not_found"});
 });
 it("rejects wrong but canonical direct-import history keys before enqueue",async()=>{
  const attack=await auth.client.rpc("import_local_name",{p_project_id:project,p_expected_revision:1,p_source:source,p_context:context,p_identity_key:"elm",p_idempotency_key:"fixture-poisoned-history01"});expect(attack.error).toBeNull();
  const call=vi.spyOn(auth.client,"rpc");
  await expect(enqueueNamingBatch(auth,project,{expectedProjectRevision:1,expectedPreferencesVersion:1,expectedBatchSequence:0,idempotencyKey:"fixture-blocked-enqueue001",billingMode:"chatgpt_subscription",acceptedPolicyIdentity:"a".repeat(64)})).rejects.toMatchObject({code:"integration_unavailable"});
  expect(call).not.toHaveBeenCalledWith("enqueue_subscription_naming_job",expect.anything());expect((await db.query("select id from public.jobs")).rows).toEqual([]);
 });
 it("replays a valid local Workshop source before sending it to storage",async()=>{
  const history=[{id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",input:{kind:"tweaks",seed:"Cedar",operations:["uppercase"]},output:"CEDAR",createdAt:at}];
  const result=await importLocalName(auth,project,{expectedProjectRevision:1,source:{...source,origin:"workshop",value:"CEDAR",history},capturedContext:context,idempotencyKey:"fixture-workshop-import01"});
  expect(result.entry.candidate.value).toBe("CEDAR");
  await expect(importLocalName(auth,project,{expectedProjectRevision:1,source:{...source,origin:"workshop",value:"FORGED",history:[{...history[0],output:"FORGED"}]},capturedContext:context,idempotencyKey:"fixture-workshop-forged01"})).rejects.toMatchObject({code:"invalid_input"});
 });
 it("binds generated origin to exact batch, step, accepted value and provider metadata",async()=>{
  const batchId=await generate();const batch=await getNamingBatch(auth,project,batchId);expect(batch.result!.fulfillment.status).toBe("partial");
  const read=await getProjectNaming(auth,project);expect(read.candidates.items[0]!.candidate.origin).toMatchObject({kind:"generated",batchId});
  const candidate=read.candidates.items[0]!.candidate;
  const original=auth.client.rpc.bind(auth.client);vi.spyOn(auth.client,"rpc").mockImplementation(((name:string,args:Record<string,unknown>)=>name==="get_project_naming"?Promise.resolve({data:{...read,candidates:{...read.candidates,items:[{...read.candidates.items[0],candidate:{...candidate,origin:{...candidate.origin,responseId:"forged-response"}}}]}},error:null}):original(name,args)) as typeof auth.client.rpc);
  await expect(getProjectNaming(auth,project)).rejects.toMatchObject({code:"integration_unavailable"});
 });
 it("binds each parent, blend-right value and immutable transform record across multiple steps",async()=>{
  const first=await imported();const second=await imported("Elm","fixture-server-import-002");
  const transformed=await transformProjectNames(auth,project,{parentCandidateId:first.entry.candidate.id,secondaryCandidateId:second.entry.candidate.id,input:{kind:"blend",left:"Cedar",right:"Elm",leftTake:2,rightDrop:0},idempotencyKey:"fixture-server-blend-0001"});
  const next=await transformProjectNames(auth,project,{parentCandidateId:transformed.entries[0]!.candidate.id,input:{kind:"tweaks",seed:"CeElm",operations:["uppercase"]},idempotencyKey:"fixture-server-tweak-0001"});
  expect(next.entries[0]!.candidate.value).toBe("CEELM");expect((await getProjectNaming(auth,project)).candidates.items).toHaveLength(4);
  await expect(transformProjectNames(auth,project,{parentCandidateId:first.entry.candidate.id,secondaryCandidateId:second.entry.candidate.id,input:{kind:"blend",left:"Cedar",right:"Forged",leftTake:2,rightDrop:0},idempotencyKey:"fixture-server-forged-001"})).rejects.toMatchObject({code:"invalid_input"});
 });
 it("does not render, select, retain or promote forged direct-RPC transform output",async()=>{
  const first=await imported();const result=await auth.client.rpc("persist_name_transform",{p_project_id:project,p_parent_candidate_id:first.entry.candidate.id,p_secondary_candidate_id:null,p_input:{kind:"tweaks",seed:"Cedar",operations:["uppercase"]},p_result:{candidates:[{value:"Forged",identityKey:"forged",explanation:"Applied Unicode uppercase mapping."}],truncated:false,notes:[]},p_idempotency_key:"fixture-direct-forged-001"});
  expect(result.error).toBeNull();const candidateId=(result.data as {entries:Array<{candidate:{id:string}}>}).entries[0]!.candidate.id;
  await expect(getProjectNaming(auth,project)).rejects.toMatchObject({code:"integration_unavailable"});
  await expect(selectProjectName(auth,project,{candidateId,expectedRevision:1,acceptEarlierContext:true})).rejects.toMatchObject({code:"integration_unavailable"});
  await expect(setNameRetention(auth,project,{candidateId,expectedRevision:0,favorite:true,saved:false})).rejects.toMatchObject({code:"integration_unavailable"});
  await expect(createBrandFromProjectName(auth,project,{sourceProjectId:project,sourceCandidateId:candidateId,expectedSourceProjectRevision:1,title:"Cannot promote",idempotencyKey:"fixture-direct-promote01"})).rejects.toMatchObject({code:"integration_unavailable"});
  expect((await db.query("select current_revision from public.projects")).rows).toEqual([{current_revision:1}]);
 });
 it("rejects a replayable output when the stored transform omits other deterministic outputs",async()=>{
  const first=await imported();const result=await auth.client.rpc("persist_name_transform",{p_project_id:project,p_parent_candidate_id:first.entry.candidate.id,p_secondary_candidate_id:null,p_input:{kind:"tweaks",seed:"Cedar",operations:["uppercase","lowercase"]},p_result:{candidates:[{value:"CEDAR",identityKey:"cedar",explanation:"Applied Unicode uppercase mapping."}],truncated:false,notes:[]},p_idempotency_key:"fixture-direct-subset-001"});
  const candidateId=(result.data as {entries:Array<{candidate:{id:string}}>}).entries[0]!.candidate.id;
  await expect(selectProjectName(auth,project,{candidateId,expectedRevision:1,acceptEarlierContext:false})).rejects.toMatchObject({code:"integration_unavailable"});
 });
 it("copies verified transitive ancestry and retains selected-only names in both library filters",async()=>{
  const first=await imported();const transformed=await transformProjectNames(auth,project,{parentCandidateId:first.entry.candidate.id,input:{kind:"tweaks",seed:"Cedar",operations:["uppercase"]},idempotencyKey:"fixture-server-transform"});
  const candidateId=transformed.entries[0]!.candidate.id;
  await selectProjectName(auth,project,{candidateId,expectedRevision:1,acceptEarlierContext:false});
  expect((await getProjectNaming(auth,project,{filter:"retained"})).candidates.items.map(row=>row.candidate.id)).toEqual([candidateId]);
  expect((await getAccountNames(auth,{filter:"retained"})).items.map(row=>row.candidate.id)).toEqual([candidateId]);
  const promoted=await createBrandFromProjectName(auth,project,{sourceProjectId:project,sourceCandidateId:candidateId,expectedSourceProjectRevision:2,title:"Copied brand",idempotencyKey:"fixture-server-promotion"});
  expect(promoted.currentSelection.candidate.origin).toMatchObject({kind:"account_copy",authorship:"user_supplied"});
  expect((await getProjectNaming(auth,promoted.project.id)).currentSelection!.candidate.value).toBe("CEDAR");
 });
 it("persists saved view and stable pagination without changing project revision",async()=>{
  const first=await imported();await imported("Elm","fixture-server-import-002");
  await setNameRetention(auth,project,{candidateId:first.entry.candidate.id,expectedRevision:0,favorite:true,saved:false});
  await saveNamingView(auth,project,{expectedViewRevision:1,viewState:{pane:"screening",conversationOpen:false,filter:"favorite",query:"",visibleBatchId:null,scrollCandidateId:first.entry.candidate.id,workshopCandidateId:null}});
  expect((await getProjectNaming(auth,project)).candidates.items.map(row=>row.candidate.id)).toEqual([first.entry.candidate.id]);
  const page=await getProjectNaming(auth,project,{filter:"all",limit:1});expect(page.candidates.nextCursor).not.toBeNull();
  const next=await getProjectNaming(auth,project,{filter:"all",limit:1,cursor:page.candidates.nextCursor});expect(next.candidates.items[0]!.candidate.value).toBe("Elm");
  expect(next.project.current_revision).toBe(1);
 });
 it("rejects a foreign response scope before private results leave the DAL",async()=>{
  const record={id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",ownerId:OWNER_B,projectId:project,value:"Cedar",identityKey:nameIdentityKey("Cedar"),rationale:"Imported local fixture.",contextRevision:1,strategyBasis:namingStrategyBasis(context),strategyKey:namingStrategyKey(context),createdAt:at,origin:{kind:"local_import",ownerId:OWNER_B,projectId:project,candidateId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",contextRevision:1,source,capturedContext:context}};
  vi.spyOn(auth.client,"rpc").mockResolvedValue({data:{entry:{candidate:record,retention:{ownerId:OWNER_B,projectId:project,candidateId:record.id,revision:0,favorite:false,saved:false,updatedAt:null}}},error:null} as never);
  await expect(selectProjectName(auth,project,{candidateId:record.id,expectedRevision:1,acceptEarlierContext:false})).rejects.toMatchObject({code:"not_found"});
 });
 it("requires promotion acknowledgement for earlier strategy while preserving the current context",async()=>{
  const first=await imported();const candidateId=first.entry.candidate.id;await setNameRetention(auth,project,{candidateId,expectedRevision:0,favorite:true,saved:false});
  const changed={...context,description:"New source project direction"};await auth.client.rpc("append_project_revision",{p_project_id:project,p_expected_revision:1,p_context:changed,p_input_hash:HASH});
  expect((await getAccountNames(auth)).items[0]!.earlierContext).toBe(true);
  const request={sourceProjectId:project,sourceCandidateId:candidateId,expectedSourceProjectRevision:2,title:"Acknowledged source",idempotencyKey:"fixture-server-stalecopy1"};
  await expect(createBrandFromProjectName(auth,project,request)).rejects.toMatchObject({code:"conflict"});
  const promoted=await createBrandFromProjectName(auth,project,{...request,acceptEarlierContext:true});
  expect(promoted.project.context.description).toBe(changed.description);expect(promoted.currentSelection.candidate.strategyBasis.description).toBe(context.description);expect(promoted.currentSelection.selection.acceptedEarlierContext).toBe(true);
 });

});
