import { describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createLogoDeliverableProducers } from "@/features/identity-deliverables/server/manual";
import { deliverableFixture, resolvedFixture, id, at, hashBytes } from "./fixtures";
import { computeLogoVariantRenderHash } from "@/features/identity-deliverables/server/render-policy";
import type { AuthenticatedContext } from "@/server/auth/context";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
function fixture() {
 const approved=deliverableFixture("wordmark"),{logoDocument:_,...source}=approved;void _;
 const frozen={...source,inputRevisions:[{stage:"vector" as const,id:approved.logoApproval.stageRevisionId,revision:1}]};
 const writes:{mime:string;hash:string;requestKey:string}[]=[];
 const store={async stageOwnedAsset(_auth,_project,publication,bytes){expect(hashBytes(bytes)).toBe(publication.contentHash);writes.push({mime:publication.mimeType,hash:publication.contentHash,requestKey:publication.requestKey});const n=writes.length*10;return{id:id(n+700),reference:{ownerId:approved.ownerId,projectId:approved.projectId,assetId:id(n+701),versionId:id(n+702),contentHash:publication.contentHash},verification:{status:"verified",checkedAt:at,mimeType:publication.mimeType,contentHash:publication.contentHash,byteLength:bytes.byteLength},purpose:"brand_asset",sourceReceiptId:approved.logoApproval.id,rightsEvidenceId:null,publicationState:"staged"};}} as IdentityAssetStore;
 const services={readSources:vi.fn(async()=>frozen),getApprovedLogoIdentitySnapshot:vi.fn(async()=>approved),resolveLogoVariantSet:vi.fn(async()=>resolvedFixture(approved.logoDocument,computeLogoVariantRenderHash).resolved)};
 const auth={userId:approved.ownerId} as AuthenticatedContext;
 return{approved,frozen,services,store,writes,auth};
}
describe("trusted variant preparation and review evidence",()=>{
 it("stages canonical documents and real previews with deterministic request identities",async()=>{
  const f=fixture(),producers=createLogoDeliverableProducers({assets:f.store,service:f.services});
  const command={method:"prepareLogoVariants" as const,body:{requestKey:id(901),expected:f.approved.heads,approvedLogoId:f.approved.logoApproval.id,directionApprovalId:f.approved.directionApproval.id}};
  const evidence=await producers.prepareLogoVariants(f.auth,f.approved.projectId,command) as {source:unknown;variantSet:{items:{preview:{publicationState:string}|null}[]}};
  expect(evidence.source).toEqual(f.frozen);expect(evidence.variantSet.items).toHaveLength(12);expect(f.writes).toHaveLength(6);
  expect(evidence.variantSet.items.filter(i=>i.preview).every(i=>i.preview!.publicationState==="staged")).toBe(true);
  const first=f.writes.map(w=>w.requestKey);f.writes.length=0;await producers.prepareLogoVariants(f.auth,f.approved.projectId,command);expect(f.writes.map(w=>w.requestKey)).toEqual(first);
 });
 it("never trusts an incomplete visual-review selection or a changed source",async()=>{
  const f=fixture(),producers=createLogoDeliverableProducers({assets:f.store,service:f.services}),set=(await f.services.resolveLogoVariantSet()).set;
  const command={method:"reviewLogoVariants" as const,body:{requestKey:id(902),expected:f.approved.heads,approvedLogoId:set.approvedLogoId,directionApprovalId:set.directionApprovalId,variantSetId:set.id,acceptedVariantIds:[set.items[0]!.id]}};
  await expect(producers.reviewLogoVariants(f.auth,f.approved.projectId,command)).rejects.toThrow();expect(f.writes).toHaveLength(0);
  command.body.acceptedVariantIds=set.items.map(i=>i.id);
  expect(await producers.reviewLogoVariants(f.auth,f.approved.projectId,command)).toEqual({variantSet:set,acceptedVariants:set.items.map(i=>({variantId:i.id,renderHash:i.renderHash}))});
  await expect(producers.prepareLogoVariants(f.auth,f.approved.projectId,{method:"prepareLogoVariants",body:{requestKey:id(903),expected:f.approved.heads,approvedLogoId:id(999),directionApprovalId:f.approved.directionApproval.id}})).rejects.toThrow();expect(f.writes).toHaveLength(0);
 });
});
