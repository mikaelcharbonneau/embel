import { describe,expect,it } from "vitest";
import { identityAvailabilitySchema,identityBatchRequestCloseSchema,identityBatchStateSchema,identityGenerationCapabilitySchema,identityGenerationIntentSchema,identityGenerationJobInputSchema } from "../../src/domain/identity-jobs";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { batchState,capability,generationIntent,jobInput,ownerId,projectId } from "../worker/identity-generation-fixture";
describe("Identity generation contracts",()=>{
 it("accepts explicit uncapped v2 consent without a browser amount or provider authority",()=>{expect(identityGenerationIntentSchema.parse(generationIntent)).toEqual(generationIntent);expect(identityGenerationIntentSchema.safeParse({...generationIntent,acceptedMaxCostMicrousd:1}).success).toBe(false);});
 it("requires all four captured head observations",()=>{const {expectedIdentityRevision,...without}=generationIntent;expect(expectedIdentityRevision).toBe(0);expect(identityGenerationIntentSchema.safeParse(without).success).toBe(false);});
 it("does not equate model presence with actual available readiness",()=>{const value={version:2,spendControl:"uncapped",ownerId,projectId,status:"available",operation:"identity.image",requestedModel:IMAGE_MODEL,policyIdentity:"a".repeat(64),handlerVersion:"identity-image-v1",targetCount:3,maxReferenceImages:4,maxReferenceBytes:20_971_520};expect(identityAvailabilitySchema.parse(value)).toEqual(value);expect(identityAvailabilitySchema.safeParse({...value,maxReferenceImages:100}).success).toBe(false);});
 it("keeps capability resource limits distinct from money",()=>{expect(identityGenerationCapabilitySchema.parse(capability).maxCostMicrousd).toBe(0);expect(identityGenerationCapabilitySchema.safeParse({...capability,maxCostMicrousd:100}).success).toBe(false);});
 it("freezes three distinct SQLallocated system IDs in one exact full input",()=>{const value=jobInput();expect(identityGenerationJobInputSchema.parse(value)).toEqual(value);expect(identityGenerationJobInputSchema.safeParse({...value,systemIds:[value.systemIds[0],value.systemIds[0],value.systemIds[1]]}).success).toBe(false);});
 it("rejects progress substituted from another input revision",()=>{expect(identityBatchStateSchema.parse(batchState())).toEqual(batchState());const value=batchState();value.intent={...generationIntent,expectedReferenceRevision:2};expect(identityBatchStateSchema.safeParse(value).success).toBe(false);});
 it("does not call a zero-system job complete or terminal pending",()=>{expect(identityBatchStateSchema.safeParse({...batchState(),status:"succeeded"}).success).toBe(false);expect(identityBatchStateSchema.safeParse({...batchState(),status:"failed"}).success).toBe(false);expect(identityBatchStateSchema.parse({...batchState(),status:"failed",terminal:true,fulfillment:{targetCount:3,acceptedCount:0,status:"none"}}).fulfillment.status).toBe("none");});
 it("represents exact intent closure separately from lookup absence or provider Stop",()=>{
  const value={status:"not_admitted",ownerId,projectId,intent:generationIntent};
  expect(identityBatchRequestCloseSchema.parse(value)).toEqual(value);
  expect(identityBatchRequestCloseSchema.safeParse({status:"not_found"}).success).toBe(false);
  expect(identityBatchRequestCloseSchema.safeParse({...value,providerStopped:true}).success).toBe(false);
  const {version,spendControl,expectedIdentityRevision,...legacy}=generationIntent;
  expect([version,spendControl,expectedIdentityRevision]).toEqual([2,"uncapped",0]);
  expect(identityBatchRequestCloseSchema.safeParse({...value,intent:{...legacy,acceptedMaxCostMicrousd:0}}).success).toBe(false);
 });
 it("exposes the actual image byte bound and a distinct actionable oversized-reference reason",()=>{
  const value={ownerId,projectId,status:"unavailable",operation:"identity.image",requestedModel:IMAGE_MODEL,reason:"reference_bytes_exceeded",maxReferenceImages:4,maxReferenceBytes:20_971_520};
  expect(identityAvailabilitySchema.parse(value)).toEqual(value);
  expect(identityAvailabilitySchema.safeParse({...value,maxReferenceBytes:32_000_000}).success).toBe(false);
 });
});
