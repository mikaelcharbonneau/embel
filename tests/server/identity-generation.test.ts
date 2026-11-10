import { beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
// The shared worker path, as with Creative directions' engine kind off (identity-engine-switch.test.ts covers it on).
vi.mock("../../src/server/engine/identity",async original=>({...await original<object>(),identityEngineEnabled:async()=>false,findIdentityDirectionsRun:async()=>null}));
import { enqueueIdentityBatch,getIdentityAvailability,getIdentityBatch,getLatestIdentityBatch,readIdentityBatchRequest,cancelIdentityBatch,closeIdentityBatchRequest,IdentityIntentClosureUncertainError,IdentityAdmissionUncertainError } from "../../src/server/data/identity-jobs";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { batchState as legacyBatchState,generationIntent as legacyGenerationIntent,selectedLogoJobInput } from "../worker/identity-generation-fixture";
import { batchId,ownerId,projectId,id } from "../worker/identity-generation-fixture";
const frozen=selectedLogoJobInput(Uint8Array.of(1,2,3));if(frozen.version!==3)throw Error('Expected selected-logo fixture');
const sourceLogo=frozen.sourceLogo;
const generationIntent={...legacyGenerationIntent,version:3 as const,sourceLogo:sourceLogo.source,expectedLogoRevision:sourceLogo.selectionRevision,expectedReferenceRevision:0};
const batchState=()=>({...legacyBatchState(),intent:generationIntent,input:frozen.input,sourceLogo,sourceLogoCurrent:true,usage:{status:'pending' as const,knownCostMicrousd:0}});
const available={version:3,sourceLogo,expectedLogoRevision:1,expectedProjectRevision:1,expectedReferenceRevision:0,expectedPreferencesRevision:0,expectedIdentityRevision:0,estimatedCostMicrousd:null,spendControl:"uncapped",ownerId,projectId,status:"available",operation:"identity.image",requestedModel:IMAGE_MODEL,policyIdentity:"a".repeat(64),handlerVersion:"identity-image-v1",targetCount:3,maxReferenceImages:4,maxReferenceBytes:20_971_520};
function fixture(){const rpc=vi.fn<(name:string,args:Record<string,unknown>)=>Promise<{data:unknown;error:unknown}>>(async(name)=>({data:name==="get_shared_identity_availability"?available:name==="get_shared_identity_batch"?null:batchState(),error:null}));const chain={select:vi.fn(()=>chain),eq:vi.fn(()=>chain),maybeSingle:vi.fn(async()=>({data:{id:projectId,owner_id:ownerId},error:null}))};
 const auth={userId:ownerId,client:{from:vi.fn(()=>chain),rpc}} as unknown as AuthenticatedContext;
 return{auth,rpc,chain};}
beforeEach(()=>{vi.stubEnv("EMBEL_SHARED_WORKERS_ENABLED","true");});
describe("Identity shared job DAL — mocked RPCs, no provider",()=>{
 it("admits only exact selected-logo v3 and returns sourcevalidated captured state",async()=>{const f=fixture();expect(await enqueueIdentityBatch(f.auth,projectId,generationIntent)).toEqual(batchState());expect(f.rpc.mock.calls.map(c=>c[0])).toEqual(["get_shared_identity_batch","get_shared_identity_availability","ensure_shared_identity_batch"]);});
 it("cannot admit through historical v1 cap consent",async()=>{const f=fixture(),{version,spendControl,expectedIdentityRevision,...v1}=legacyGenerationIntent;expect([version,spendControl,expectedIdentityRevision]).toEqual([2,"uncapped",0]);await expect(enqueueIdentityBatch(f.auth,projectId,{...v1,acceptedMaxCostMicrousd:0})).rejects.toMatchObject({code:"integration_unavailable"});expect(f.rpc).toHaveBeenCalledTimes(1);});
 it("retains exact intent on lost admission acknowledgement and recovers through GET only",async()=>{const f=fixture();f.rpc.mockImplementation(async name=>{if(name==="ensure_shared_identity_batch")throw Error("private ACK details");return{data:name==="get_shared_identity_availability"?available:name==="get_shared_identity_batch"?null:batchState(),error:null};});await expect(enqueueIdentityBatch(f.auth,projectId,generationIntent)).rejects.toBeInstanceOf(IdentityAdmissionUncertainError);f.rpc.mockResolvedValue({data:batchState(),error:null});expect(await readIdentityBatchRequest(f.auth,projectId,generationIntent.idempotencyKey)).toEqual(batchState());expect(f.rpc.mock.calls.filter(c=>c[0]==="ensure_shared_identity_batch")).toHaveLength(1);});
 it("rejects policy drift before admission",async()=>{const f=fixture();await expect(enqueueIdentityBatch(f.auth,projectId,{...generationIntent,acceptedPolicyIdentity:"b".repeat(64)})).rejects.toMatchObject({code:"conflict"});expect(f.rpc).toHaveBeenCalledTimes(2);});
 it("rejects foreign response state and invalid selectors",async()=>{const f=fixture();f.rpc.mockResolvedValue({data:{...batchState(),ownerId:id(99)},error:null});await expect(getIdentityBatch(f.auth,projectId,batchId)).rejects.toMatchObject({code:"integration_unavailable"});await expect(readIdentityBatchRequest(f.auth,projectId,"short")).rejects.toMatchObject({code:"invalid_input"});});
 it("uses owner/project verified latest and explicit cancellation RPCs",async()=>{const f=fixture();f.rpc.mockResolvedValue({data:batchState(),error:null});expect(await getLatestIdentityBatch(f.auth,projectId)).toEqual(batchState());expect(await cancelIdentityBatch(f.auth,projectId,batchId)).toEqual(batchState());expect(f.rpc.mock.calls.map(c=>c[0])).toEqual(["get_shared_identity_batch","cancel_shared_identity_batch"]);});
 it("recovers an exact accepted request despite unavailable current policy",async()=>{const f=fixture();f.rpc.mockResolvedValue({data:batchState(),error:null});expect(await enqueueIdentityBatch(f.auth,projectId,generationIntent)).toEqual(batchState());expect(f.rpc.mock.calls.map(c=>c[0])).toEqual(["get_shared_identity_batch"]);});
 it("recovers a historical v2 exact request without creating a new generation",async()=>{const f=fixture();f.rpc.mockResolvedValue({data:legacyBatchState(),error:null});expect(await enqueueIdentityBatch(f.auth,projectId,legacyGenerationIntent)).toEqual(legacyBatchState());expect(f.rpc).toHaveBeenCalledExactlyOnceWith('get_shared_identity_batch',{p_project_id:projectId,p_batch_id:null,p_request_key:legacyGenerationIntent.idempotencyKey});});
 it("rejects a changed selected-logo head before any admission call",async()=>{const f=fixture();await expect(enqueueIdentityBatch(f.auth,projectId,{...generationIntent,expectedLogoRevision:2})).rejects.toMatchObject({code:'conflict'});expect(f.rpc.mock.calls.map(c=>c[0])).toEqual(['get_shared_identity_batch','get_shared_identity_availability']);});
 it("leaves new shared RPCs unavailable by default",async()=>{const f=fixture();vi.stubEnv("EMBEL_SHARED_WORKERS_ENABLED","false");expect((await getIdentityAvailability(f.auth,projectId)).status).toBe("unavailable");expect(f.rpc).not.toHaveBeenCalled();});
});

describe("Identity intent closure — durable witness only",()=>{
 it("accepts only the exact SQL not_admitted witness without checking fresh availability",async()=>{
  const f=fixture();const witness={status:"not_admitted",ownerId,projectId,intent:structuredClone(generationIntent)};
  f.rpc.mockResolvedValue({data:witness,error:null});
  expect(await closeIdentityBatchRequest(f.auth,projectId,generationIntent)).toEqual(witness);
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith("close_shared_identity_generation_intent",{p_project_id:projectId,p_intent:generationIntent});
 });
 it("retains the actual admitted uncertain job after requesting Stop",async()=>{
  const f=fixture(),batch={...batchState(),status:"needs_reconciliation",fulfillment:{targetCount:3,acceptedCount:0,status:"none"}};
  f.rpc.mockResolvedValue({data:{status:"admitted",batch},error:null});
  expect(await closeIdentityBatchRequest(f.auth,projectId,generationIntent)).toEqual({status:"admitted",batch});
  expect(f.rpc.mock.calls.map(c=>c[0])).toEqual(["close_shared_identity_generation_intent"]);
 });
 it.each(["foreign_owner","foreign_project","changed_intent","missing_witness","invented_stopped"])("retains uncertainty for an invalid closure response: %s",async kind=>{
  const f=fixture();let data:unknown={status:"not_admitted",ownerId,projectId,intent:generationIntent};
  if(kind==="foreign_owner")data={status:"not_admitted",ownerId:id(99),projectId,intent:generationIntent};
  if(kind==="foreign_project")data={status:"not_admitted",ownerId,projectId:id(99),intent:generationIntent};
  if(kind==="changed_intent")data={status:"not_admitted",ownerId,projectId,intent:{...generationIntent,idempotencyKey:"different-original-request"}};
  if(kind==="missing_witness")data=null;
  if(kind==="invented_stopped")data={status:"not_admitted",ownerId,projectId,intent:generationIntent,providerStopped:true};
  f.rpc.mockResolvedValue({data,error:null});
  await expect(closeIdentityBatchRequest(f.auth,projectId,generationIntent)).rejects.toMatchObject({name:"IdentityIntentClosureUncertainError",recovery:{projectId,input:generationIntent}});
 });
 it("replays the identical close after a lost acknowledgement while preserving its original key",async()=>{
  const f=fixture(),witness={status:"not_admitted",ownerId,projectId,intent:generationIntent};
  f.rpc.mockRejectedValueOnce(Error("private commit acknowledgement detail")).mockResolvedValue({data:witness,error:null});
  await expect(closeIdentityBatchRequest(f.auth,projectId,generationIntent)).rejects.toBeInstanceOf(IdentityIntentClosureUncertainError);
  expect(await closeIdentityBatchRequest(f.auth,projectId,generationIntent)).toEqual(witness);
  expect(f.rpc.mock.calls.map(c=>c[1])).toEqual([{p_project_id:projectId,p_intent:generationIntent},{p_project_id:projectId,p_intent:generationIntent}]);
 });
 it("rejects the historical intent before any owned read or SQL mutation",async()=>{
  const f=fixture(),{version,spendControl,expectedIdentityRevision,...legacy}=legacyGenerationIntent;
  expect([version,spendControl,expectedIdentityRevision]).toEqual([2,"uncapped",0]);
  await expect(closeIdentityBatchRequest(f.auth,projectId,{...legacy,acceptedMaxCostMicrousd:0})).rejects.toMatchObject({code:"invalid_input"});
  expect(f.auth.client.from).not.toHaveBeenCalled();expect(f.rpc).not.toHaveBeenCalled();
 });
 it("does not allow closure through a disabled shared boundary",async()=>{
  const f=fixture();vi.stubEnv("EMBEL_SHARED_WORKERS_ENABLED","false");
  await expect(closeIdentityBatchRequest(f.auth,projectId,generationIntent)).rejects.toMatchObject({code:"integration_unavailable"});expect(f.rpc).not.toHaveBeenCalled();
 });
 it("rejects an admitted batch for a different exact intent",async()=>{
  const f=fixture();f.rpc.mockResolvedValue({data:{status:"admitted",batch:{...batchState(),intent:{...generationIntent,acceptedPolicyIdentity:"b".repeat(64)}}},error:null});
  await expect(closeIdentityBatchRequest(f.auth,projectId,generationIntent)).rejects.toBeInstanceOf(IdentityIntentClosureUncertainError);
 });
});


it.each([['茶屋', true], ['مرحبا', true], ['Studio 🦄', false]])('preflights new direction admissions for %s while preserving saved requests', async (name, supported) => {
 const f=fixture(), availability=structuredClone(available); availability.sourceLogo.brief.payload.name=name;
 f.rpc.mockImplementation(async rpc=>({data:rpc==='get_shared_identity_availability'?availability:rpc==='get_shared_identity_batch'?null:batchState(),error:null}));
 expect(await getIdentityAvailability(f.auth,projectId)).toMatchObject(supported?{status:'available'}:{status:'unavailable',reason:'unsupported_brand_text'});
 if(!supported){
  await expect(enqueueIdentityBatch(f.auth,projectId,generationIntent)).rejects.toMatchObject({code:'integration_unavailable'});
  expect(f.rpc.mock.calls.some(call=>call[0]==='ensure_shared_identity_batch')).toBe(false);
  f.rpc.mockResolvedValue({data:batchState(),error:null});
  expect(await enqueueIdentityBatch(f.auth,projectId,generationIntent)).toEqual(batchState());
 }
});
