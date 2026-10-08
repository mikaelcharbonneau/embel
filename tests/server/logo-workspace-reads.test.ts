import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { createLogoWorkspaceService } from "../../src/server/data/logo-workspace";
import type { AuthenticatedContext } from "../../src/server/auth/context";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import type { LogoVectorDocument } from "../../src/domain/logo-vector";
const ownerId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",projectId=randomUUID(),hash="a".repeat(64),at="2026-10-06T12:00:00Z";
const ref=()=>({ownerId,projectId,assetId:randomUUID(),versionId:randomUUID(),contentHash:hash});
const document:LogoVectorDocument={version:1,viewBox:[0,0,10,10],components:[{id:"art",role:"symbol",editingKind:"geometry",paths:[{id:"p",d:"M 0 0 L 10 0 L 10 10 Z",fill:{color:"#000000",opacity:1},stroke:null,fillRule:"nonzero"}],transform:{x:0,y:0,scale:1,rotation:0}}]};
function fixture(){
 const preview=ref(),json=ref(),svg=ref();
 const revision={id:randomUUID(),ownerId,projectId,parentRevisionId:null,source:{kind:"concept",batchId:randomUUID(),slotId:randomUUID(),attemptId:randomUUID()},sourcePreview:preview,documentAsset:json,svgAsset:svg,documentHash:hash,proof:{version:1,svgContentHash:hash,documentHash:hash,validator:{id:"test",version:"1"},viewBox:[0,0,10,10],pathCount:1,componentCount:1,externalFontDependencies:[]},locks:[],inputRevisions:[],reviewStatus:"review_required",createdAt:at};
 const receipt={id:randomUUID(),reference:preview,verification:{status:"verified",checkedAt:at,contentHash:hash,mimeType:"image/png",byteLength:10},purpose:"brand_asset",sourceReceiptId:randomUUID(),rightsEvidenceId:null,publicationState:"committed"};
 const rpc=vi.fn((_name:string,args:Record<string,unknown>)=>{
  let signal:AbortSignal|undefined;
  type Response={data:typeof revision|typeof receipt|null;error:DOMException|null};
  const request:PromiseLike<Response>&{abortSignal(value:AbortSignal):typeof request}={
   abortSignal(value){signal=value;return request;},
   then(resolve,reject){return Promise.resolve().then(()=>signal?.aborted?{data:null,error:new DOMException("Synthetic read cancelled","AbortError")}:{data:args.p_kind==="vector"?revision:receipt,error:null}).then(resolve,reject);},
  };
  return request;
 });
 const auth={userId:ownerId,client:{rpc}} as unknown as AuthenticatedContext;
 const bytes=new TextEncoder().encode(JSON.stringify(document));
 const read=vi.fn(async (_auth:AuthenticatedContext,r:ReturnType<typeof ref>)=>({reference:r,mimeType:r.versionId===json.versionId?"application/json":r.versionId===svg.versionId?"image/svg+xml":"image/png",bytes,verification:{status:"verified" as const,checkedAt:at,contentHash:r.contentHash,mimeType:r.versionId===json.versionId?"application/json":r.versionId===svg.versionId?"image/svg+xml":"image/png",byteLength:bytes.length}}));
 const verify=vi.fn(async()=>document);
 const store={readOwnedAsset:read} as unknown as IdentityAssetStore;
 return {revision,receipt,rpc,auth,read,verify,service:createLogoWorkspaceService({assetStore:store,verifyVectorRevision:verify})};
}
describe("owned immutable vector detail reads",()=>{
 it("unapproved_vector_detail_verifies_actual_document_before_accept",async()=>{
  const f=fixture(),detail=await f.service.readLogoVectorDetail(f.auth,projectId,f.revision.id);
  expect(detail.document).toEqual(document);expect(detail.revision.reviewStatus).toBe("review_required");expect(f.read).toHaveBeenCalledTimes(3);expect(f.verify).toHaveBeenCalledOnce();
 });
 it("rejects corrupt document and does not fabricate a preview or approval",async()=>{
  const f=fixture();f.verify.mockRejectedValue(Error("hash mismatch"));await expect(f.service.readLogoVectorDetail(f.auth,projectId,f.revision.id)).rejects.toMatchObject({code:"integration_unavailable"});
 });
 it("rejects a foreign immutable revision before reading its bytes",async()=>{
  const f=fixture();f.revision.ownerId=randomUUID();await expect(f.service.readLogoVectorDetail(f.auth,projectId,f.revision.id)).rejects.toMatchObject({code:"not_found"});expect(f.read).not.toHaveBeenCalled();
 });
 it("fences cancellation after verification before exposing private output",async()=>{
  const f=fixture(),c=new AbortController();f.verify.mockImplementation(async()=>{c.abort();return document;});await expect(f.service.readLogoVectorDetail(f.auth,projectId,f.revision.id,c.signal)).rejects.toMatchObject({code:"integration_unavailable"});expect(f.verify).toHaveBeenCalledOnce();expect(f.read).toHaveBeenCalledTimes(3);expect(c.signal.aborted).toBe(true);
 });
});
