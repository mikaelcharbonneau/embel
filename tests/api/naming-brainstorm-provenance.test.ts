import { describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { projectNameCandidateSchema } from "../../src/domain/project-naming";
import { namingBrainRunSummarySchema,namingFeedEntrySchema } from "../../src/domain/naming-brain";
import { NAMING_BRAINSTORM_CAUTION } from "../../src/domain/naming-brainstorm";
import { loadManagedNamingSources,verifyBrainstormNamingSource } from "../../src/server/data/naming-brain-provenance";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { at,id,snapshot,hash } from "../domain/naming-brain-fixtures";
function fixture(){
 const brief=snapshot(),origin={kind:"brainstorm" as const,version:1 as const,profile:"brainstorm_v1" as const,ownerId:id(1),projectId:id(2),candidateId:id(7),contextRevision:1,value:"Mossline",batchId:id(5),jobId:id(4),runId:id(3),callId:id(8),responseId:"resp_fixture",requestId:"req_fixture",model:"synthetic-model",generatedAt:at};
 const candidate=projectNameCandidateSchema.parse({id:id(7),ownerId:id(1),projectId:id(2),value:"Mossline",identityKey:"mossline",rationale:"A creative garden-planning direction.",caution:NAMING_BRAINSTORM_CAUTION,verificationNotes:[],contextRevision:1,strategyBasis:brief.strategyBasis,strategyKey:brief.strategyKey,origin,createdAt:at});
 const proof={ownerId:id(1),projectId:id(2),candidateId:id(7),runId:id(3),jobId:id(4),batchId:id(5),callId:id(8),responseId:"resp_fixture",requestId:"req_fixture",model:"synthetic-model",generatedAt:at,value:candidate.value,identityKey:candidate.identityKey,rationale:candidate.rationale,snapshot:brief,profile:"brainstorm_v1"};
 const rpc=vi.fn(async(name:string,args:unknown)=>{void name;void args;return {data:[proof],error:null};});const auth={userId:id(1),client:{rpc}}as unknown as AuthenticatedContext;
 return{candidate,proof,rpc,auth};
}
describe("future brainstorm public provenance boundary",()=>{
 it("verifies persisted response membership without requiring or manufacturing researched artifacts",async()=>{
  const f=fixture(),proofs=await loadManagedNamingSources(f.auth,id(2),[f.candidate]);
  expect(await verifyBrainstormNamingSource(f.auth,f.candidate,proofs.get(f.candidate.id))).toMatchObject({callId:id(8),profile:"brainstorm_v1"});
  expect(f.rpc).toHaveBeenCalledOnce();expect(f.rpc).toHaveBeenCalledWith("get_naming_brainstorm_sources",{p_project_id:id(2),p_candidate_ids:[id(7)]});
 });
 it.each([
  ["http://127.0.0.1:54321", "55000", "invalid_brainstorm_source", true],
  ["https://example.invalid", "55000", "invalid_brainstorm_source", false],
  ["http://127.0.0.1:54321", "P0002", "not_found", false],
  ["http://127.0.0.1:54321", "55000", "different_state", false],
 ] as const)("limits supplemental reads to local missing membership (%s, %s, %s)", async (url, code, message, allowed) => {
  vi.stubEnv("EMBEL_DEVELOPMENT_ENABLED", "true"); vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3105");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
  try {
   const f=fixture();
   f.rpc.mockResolvedValueOnce({data:null,error:{code,message}} as never);
   if (allowed) {
    const proofs=await loadManagedNamingSources(f.auth,id(2),[f.candidate]);
    await expect(verifyBrainstormNamingSource(f.auth,f.candidate,proofs.get(f.candidate.id))).resolves.toMatchObject({candidateId:id(7)});
    expect(f.rpc.mock.calls.map(([name])=>name)).toEqual(["get_naming_brainstorm_sources","get_naming_brainstorm_sources_v2"]);
   } else {
    await expect(loadManagedNamingSources(f.auth,id(2),[f.candidate])).rejects.toBeTruthy();
    expect(f.rpc).toHaveBeenCalledOnce();
   }
  } finally { vi.unstubAllEnvs(); }
 });
 it("fails closed on another account's proof and never uses the historical curator path",async()=>{
  const f=fixture();f.proof.ownerId=id(99);
  await expect(loadManagedNamingSources(f.auth,id(2),[f.candidate])).rejects.toMatchObject({code:"not_found"});
  expect(f.rpc.mock.calls.every(c=>c[0]==="get_naming_brainstorm_sources")).toBe(true);
 });
 it.each(["callId","responseId","model","rationale","value","identityKey"])("rejects mismatched persisted %s",async key=>{
  const f=fixture(),proof={...f.proof,[key]:key==="callId"?id(99):"mismatch"};
  await expect(verifyBrainstormNamingSource(f.auth,f.candidate,proof)).rejects.toMatchObject({code:"integration_unavailable"});
 });
 it("refuses researched claims and old artifact fields on the new root contract",()=>{
  const f=fixture();expect(projectNameCandidateSchema.safeParse({...f.candidate,origin:{...f.candidate.origin,sourceArtifactId:id(9)}}).success).toBe(false);
  expect(projectNameCandidateSchema.safeParse({...f.candidate,verificationNotes:[{claimKey:"claim",originalStatement:"Purported origin",status:"supported",explanation:"invented"}]}).success).toBe(false);
 });
 it("requires the real new run in feed membership and preserves zero published claims",()=>{
  const f=fixture(),entry={entryId:id(10),position:1,runId:id(3),steeringRevision:0,entry:{candidate:f.candidate,retention:{ownerId:id(1),projectId:id(2),candidateId:id(7),favorite:false,saved:false,revision:0,updatedAt:null}},primaryApproach:"real_words",additionalApproaches:[],publishedClaims:[]};
  expect(namingFeedEntrySchema.safeParse(entry).success).toBe(true);
  expect(namingFeedEntrySchema.safeParse({...entry,runId:id(99)}).success).toBe(false);
 });
 it("uses a distinct completion witness and does not accept a relabeled historical one",()=>{
  const summary={version:1,ownerId:id(1),projectId:id(2),runId:id(3),jobId:id(4),batchId:id(5),revision:1,resumedFromRunId:null,canResume:false,localPipelineVersion:2,executionAuthority:"hosted_owner_v1",providerBudgetVersion:2,generationProfile:"brainstorm_v1",brainstormCompletionId:id(11),state:"succeeded",projectRevision:1,preferencesVersion:1,feedbackRevision:0,steeringRevision:0,demandSequence:0,snapshotHash:hash,acceptedPolicyIdentity:hash,progress:100,preparedSetId:null,fulfillment:{status:"complete",targetCount:100,acceptedCount:100,missingCount:0,coverageSatisfied:true,message:null},accounting:{status:"held_unsettled",heldAllowanceMicrousd:5000000,confirmedActualCostMicrousd:null},createdAt:at,updatedAt:at};
  expect(namingBrainRunSummarySchema.safeParse(summary).success).toBe(true);
  expect(namingBrainRunSummarySchema.safeParse({...summary,generationProfile:undefined}).success).toBe(false);
  expect(namingBrainRunSummarySchema.safeParse({...summary,progressiveCompletionId:id(12)}).success).toBe(false);
 });
});
