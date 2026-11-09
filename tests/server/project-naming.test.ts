import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { nameIdentityKey, namingStrategyBasis, namingStrategyKey } from "../../src/domain/project-naming";
import { transformNames, type NameTransformInput } from "../../src/domain/naming";
import { getCustomProjectNames, getProjectNaming, importLocalName, saveNamingView, selectProjectName, setNameRetention } from "../../src/server/data/project-naming";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { asRole, createTestDatabase, HASH, OWNER_A, OWNER_B, resetFixture, type TestDatabase } from "../database/local-supabase";
import { reviewedStrategy } from "../fixtures/reviewed-strategy";

const at="2026-10-04T12:00:00Z";
const context=reviewedStrategy({description:"Explicit local server Naming fixture"});
const source={id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",value:"Cedar",createdAt:at,origin:"manual",history:[]};

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
 beforeEach(async()=>{await resetFixture(db);project=await run(async()=>(await db.query<{id:string}>("select * from public.create_project('complete_brand','Fixture',$1::jsonb,$2)",[JSON.stringify(context),HASH])).rows[0]!.id);auth=client();});
 async function imported(value="Cedar",key="fixture-server-import-001"){
  return importLocalName(auth,project,{expectedProjectRevision:1,source:{...source,value},capturedContext:context,idempotencyKey:key});
 }
 /** Workshop transforms are no longer created by the app; existing rows keep replay verification. */
 async function transform(parentCandidateId:string,input:NameTransformInput,key:string,secondaryCandidateId:string|null=null){
  const replay=transformNames(input);
  const result=await auth.client.rpc("persist_name_transform",{p_project_id:project,p_parent_candidate_id:parentCandidateId,p_secondary_candidate_id:secondaryCandidateId,p_input:input,
   p_result:{...replay,candidates:replay.candidates.map(row=>({...row,identityKey:nameIdentityKey(row.value)}))},p_idempotency_key:key});
  expect(result.error).toBeNull();return result.data as {entries:Array<{candidate:{id:string;value:string}}>};
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
 it("replays a valid local Workshop source before sending it to storage",async()=>{
  const history=[{id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",input:{kind:"tweaks",seed:"Cedar",operations:["uppercase"]},output:"CEDAR",createdAt:at}];
  const result=await importLocalName(auth,project,{expectedProjectRevision:1,source:{...source,origin:"workshop",value:"CEDAR",history},capturedContext:context,idempotencyKey:"fixture-workshop-import01"});
  expect(result.entry.candidate.value).toBe("CEDAR");
  await expect(importLocalName(auth,project,{expectedProjectRevision:1,source:{...source,origin:"workshop",value:"FORGED",history:[{...history[0],output:"FORGED"}]},capturedContext:context,idempotencyKey:"fixture-workshop-forged01"})).rejects.toMatchObject({code:"invalid_input"});
 });
 it("binds each parent, blend-right value and immutable transform record across multiple steps",async()=>{
  const first=await imported();const second=await imported("Elm","fixture-server-import-002");
  const transformed=await transform(first.entry.candidate.id,{kind:"blend",left:"Cedar",right:"Elm",leftTake:2,rightDrop:0},"fixture-server-blend-0001",second.entry.candidate.id);
  const next=await transform(transformed.entries[0]!.candidate.id,{kind:"tweaks",seed:"CeElm",operations:["uppercase"]},"fixture-server-tweak-0001");
  expect(next.entries[0]!.candidate.value).toBe("CEELM");expect((await getProjectNaming(auth,project)).candidates.items).toHaveLength(4);
 });
 it("does not render, select or retain forged direct-RPC transform output",async()=>{
  const first=await imported();const result=await auth.client.rpc("persist_name_transform",{p_project_id:project,p_parent_candidate_id:first.entry.candidate.id,p_secondary_candidate_id:null,p_input:{kind:"tweaks",seed:"Cedar",operations:["uppercase"]},p_result:{candidates:[{value:"Forged",identityKey:"forged",explanation:"Applied Unicode uppercase mapping."}],truncated:false,notes:[]},p_idempotency_key:"fixture-direct-forged-001"});
  expect(result.error).toBeNull();const candidateId=(result.data as {entries:Array<{candidate:{id:string}}>}).entries[0]!.candidate.id;
  await expect(getProjectNaming(auth,project)).rejects.toMatchObject({code:"integration_unavailable"});
  await expect(selectProjectName(auth,project,{candidateId,expectedRevision:1,acceptEarlierContext:true})).rejects.toMatchObject({code:"integration_unavailable"});
  await expect(setNameRetention(auth,project,{candidateId,expectedRevision:0,favorite:true,saved:false})).rejects.toMatchObject({code:"integration_unavailable"});
  expect((await db.query("select current_revision from public.projects")).rows).toEqual([{current_revision:1}]);
 });
 it("rejects a replayable output when the stored transform omits other deterministic outputs",async()=>{
  const first=await imported();const result=await auth.client.rpc("persist_name_transform",{p_project_id:project,p_parent_candidate_id:first.entry.candidate.id,p_secondary_candidate_id:null,p_input:{kind:"tweaks",seed:"Cedar",operations:["uppercase","lowercase"]},p_result:{candidates:[{value:"CEDAR",identityKey:"cedar",explanation:"Applied Unicode uppercase mapping."}],truncated:false,notes:[]},p_idempotency_key:"fixture-direct-subset-001"});
  const candidateId=(result.data as {entries:Array<{candidate:{id:string}}>}).entries[0]!.candidate.id;
  await expect(selectProjectName(auth,project,{candidateId,expectedRevision:1,acceptEarlierContext:false})).rejects.toMatchObject({code:"integration_unavailable"});
 });
 it("retains a selected-only transformed name in the retained filter",async()=>{
  const first=await imported();const transformed=await transform(first.entry.candidate.id,{kind:"tweaks",seed:"Cedar",operations:["uppercase"]},"fixture-server-transform");
  const candidateId=transformed.entries[0]!.candidate.id;
  await selectProjectName(auth,project,{candidateId,expectedRevision:1,acceptEarlierContext:false});
  expect((await getProjectNaming(auth,project,{filter:"retained"})).candidates.items.map(row=>row.candidate.id)).toEqual([candidateId]);
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


});
