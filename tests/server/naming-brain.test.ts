import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { cancelNamingBrainRun, ensureNextNamingRun, getNamingBrainRun, getNamingFeed, stopNamingFeed } from "../../src/server/data/naming-brain";
import { getProjectNaming, getNamingBatch, getAccountNames, selectProjectName, transformProjectNames, createBrandFromProjectName } from "../../src/server/data/project-naming";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { asRole, createTestDatabase, OWNER_A, OWNER_B, type TestDatabase } from "../database/local-supabase";
import { initialIntent, installBrainFixture, seedBrainFixture, prepareBrainFixture, brainAction, brainWorker } from "../database/naming-brain-fixture";

export function namingSqlAuth(db:TestDatabase,owner=OWNER_A):AuthenticatedContext {
 return {userId:owner,client:{rpc:async(name:string,args:Record<string,unknown>)=>{
  const keys=Object.keys(args);if(!/^[a-z_]+$/.test(name)||keys.some(key=>!/^p_[a-z_]+$/.test(key)))throw Error("Unexpected fixture SQL");
  try { const result=await asRole(db,"authenticated",owner,()=>db.query<{result:unknown}>(`select to_jsonb(public.${name}(${keys.map((key,i)=>`${key}=>$${i+1}`).join(",")})) result`,Object.values(args).map(value=>value&&typeof value==="object"?JSON.stringify(value):value)));return {data:result.rows[0]!.result,error:null}; }
  catch(error){const e=error as {code:string;message:string};return {data:null,error:{code:e.code,message:e.message}};}
 },from:(table:string)=>{
  const filters:Array<[string,unknown]>=[];
  const q={select:()=>q,eq:(field:string,value:unknown)=>{if(!["project_id","owner_id","revision"].includes(field))throw Error("Unexpected fixture filter");filters.push([field,value]);return q;},maybeSingle:async()=>{
   if(table!=="project_revisions")throw Error("Unexpected fixture table");
   const result=await asRole(db,"authenticated",owner,()=>db.query(`select project_id,owner_id,revision from public.project_revisions where ${filters.map(([key],i)=>`${key}=$${i+1}`).join(" and ")}`,filters.map(([,value])=>value)));
   return {data:result.rows[0]??null,error:null};}};return q;
 }}} as unknown as AuthenticatedContext;
}

describe("Naming Brain DAL over actual local SQL ownership",()=>{
 let db:TestDatabase;let project:string;let auth:AuthenticatedContext;
 beforeAll(async()=>{db=await createTestDatabase();await installBrainFixture(db);},30_000);afterAll(async()=>{await db?.close();});
 beforeEach(async()=>{project=await seedBrainFixture(db);auth=namingSqlAuth(db);});
 it("parses saved admission, frozen snapshots, managed availability and truthful zero-dispatch cancellation",async()=>{
  const feed=await getNamingFeed(auth,project);expect(feed.entries).toEqual([]);expect(feed.availability.status).toBe("available");
  const admitted=await ensureNextNamingRun(auth,project,initialIntent());expect(admitted.status).toBe("pending");if(admitted.status!=="pending")throw Error("Expected admitted fixture");
  const run=await getNamingBrainRun(auth,project,admitted.run.runId);expect(run.snapshot.projectId).toBe(project);expect(run.stages).toHaveLength(7);expect(run.accounting.confirmedActualCostMicrousd).toBeNull();
  const cancelled=await cancelNamingBrainRun(auth,project,run.runId);expect(cancelled.state).toBe("cancelled");expect(cancelled.accounting).toEqual({status:"settled",heldAllowanceMicrousd:0,confirmedActualCostMicrousd:0});
 });
 it("keeps V2 batches readable in the original overview without leaking seven raw stages",async()=>{
  await ensureNextNamingRun(auth,project,initialIntent());const overview=await getProjectNaming(auth,project);
  expect(overview.batches.items).toHaveLength(1);expect(overview.batches.items[0]!.batch).toMatchObject({version:2,targetCount:100});expect(overview.jobs).toEqual([]);
 });
 it("retains complete stopped preparation and consumes it without another paid run through strict public DTOs",async()=>{
  const {job}=await prepareBrainFixture(db,project);
  await stopNamingFeed(auth,project,{version:1,expectedDemandSequence:0,pendingEnsureIdempotencyKey:null,idempotencyKey:"fixture-server-durable-stop"});
  await brainWorker(db,()=>db.query("select public.complete_naming_brain_stage($1,$2,'prepare','succeeded','{\"artifactIds\":[]}')",[job.id,job.lease_token]));
  await brainAction(db,job,"finish",{state:"cancelled",errorCode:null});
  const run=await getNamingBrainRun(auth,project,job.input.runId);expect(run).toMatchObject({state:"succeeded",canResume:true});
  const result=await ensureNextNamingRun(auth,project,{...initialIntent("fixture-server-free-continue"),reason:"resume",expectedDemandSequence:1,resumeOfRunId:run.runId,expectedRunRevision:run.revision});expect(result.status).toBe("appended");
  const loaded=await getNamingFeed(auth,project);expect(loaded.entries).toHaveLength(100);expect(loaded.activeRun?.runId).toBe(run.runId);
  const candidate=loaded.entries[0]!.entry.candidate;
  const detail=await getNamingBatch(auth,project,run.batchId);expect(detail.batch).toMatchObject({version:2});expect(detail.job.results).toHaveLength(1);
  const transformed=await transformProjectNames(auth,project,{parentCandidateId:candidate.id,input:{kind:"tweaks",seed:candidate.value,operations:["uppercase"]},idempotencyKey:"fixture-managed-workshop"});
  const transformedId=transformed.entries[0]!.candidate.id;
  await selectProjectName(auth,project,{candidateId:transformedId,expectedRevision:1,acceptEarlierContext:false});
  expect((await getAccountNames(auth,{filter:"retained"})).items.map(item=>item.candidate.id)).toContain(transformedId);
  const promoted=await createBrandFromProjectName(auth,project,{sourceProjectId:project,sourceCandidateId:transformedId,expectedSourceProjectRevision:2,title:"Synthetic managed promotion",idempotencyKey:"fixture-managed-promotion"});
  expect(promoted.currentSelection.candidate.origin.kind).toBe("account_copy");
  expect((await getProjectNaming(auth,promoted.project.id)).currentSelection?.candidate.value).toBe(candidate.value.toUpperCase());
 });
 it("rejects foreign reads and request owner/policy injection before admission",async()=>{
  await expect(getNamingFeed(namingSqlAuth(db,OWNER_B),project)).rejects.toMatchObject({code:"not_found"});
  await expect(ensureNextNamingRun(auth,project,{...initialIntent(),ownerId:OWNER_B})).rejects.toMatchObject({code:"invalid_input"});
  await expect(ensureNextNamingRun(auth,project,{...initialIntent(),policy:{maximumCostMicrousd:1}})).rejects.toMatchObject({code:"invalid_input"});
 });
});
