import { createHash } from "node:crypto";
import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import type { ClaimedJob } from "@/domain/jobs";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "@/server/data/logo-jobs";
import { loadDirectionInputs } from "@/features/identity-directions/server/publication";
import { canonicalLogoDocumentBytes } from "@/features/logo-vector/server/revisions";
import { serializeLogoSvg } from "@/features/logo-vector/model/svg";
import { separatedLogoDocument } from "../logo-vector/fixtures";
import { directionFixture,id } from "./fixtures";
it("loads the exact leased documentAsset from the frozen approved vector revision",async()=>{
 const o=directionFixture(),document=separatedLogoDocument(),bytes=canonicalLogoDocumentBytes(document),svg=serializeLogoSvg(document),hash=(v:Uint8Array)=>createHash("sha256").update(v).digest("hex");
 const reference=(n:number,contentHash:string)=>({ownerId:o.ownerId,projectId:o.projectId,assetId:id(n),versionId:id(n+1),contentHash});
 const documentAsset=reference(90,hash(bytes)),svgAsset=reference(92,hash(svg));
 const snapshot={inputRevisions:[{stage:"brief_references",id:id(70),revision:1},{stage:"vector",id:id(5),revision:1}],approvedLogo:o.currentApprovedLogo!,
  logoRevision:{id:id(4),ownerId:o.ownerId,projectId:o.projectId,parentRevisionId:null,source:{kind:"refinement",rasterRevisionId:id(86)},sourcePreview:reference(94,"d".repeat(64)),documentAsset,svgAsset,documentHash:hash(bytes),proof:{version:1,documentHash:hash(bytes),svgContentHash:hash(svg),validator:{id:"fluid.logo-vector",version:"1"},viewBox:document.viewBox,pathCount:2,componentCount:2,externalFontDependencies:[]},locks:[],inputRevisions:[],reviewStatus:"review_required",createdAt:"2026-10-07T00:00:00Z"},
  brief:{version:2,id:id(70),ownerId:o.ownerId,projectId:o.projectId,stage:"brief_references",revision:1,parentRevisionId:null,inputRevisions:[],inputHash:"a".repeat(64),payload:{name:"Fluid",activity:"Design",audience:"Teams",personality:"Clear",logoTypes:["wordmark"],referenceSnapshotId:id(71),sourceProjectRevision:1},createdAt:"2026-10-07T00:00:00Z"},references:{version:2,id:id(71),ownerId:o.ownerId,projectId:o.projectId,revision:1,references:[]},permittedFonts:o.fonts,targetCount:3};
 const job:ClaimedJob={id:id(80),ownerId:o.ownerId,projectId:o.projectId,operation:"identity.logo_directions",input:{version:2,ownerId:o.ownerId,projectId:o.projectId,operation:"identity.logo_directions",requestKey:id(81),quoteId:id(82),policyIdentity:"b".repeat(64),handlerVersion:"logo-directions-v1",inputHash:"a".repeat(64),approvedLogoId:id(3),briefRevisionId:id(70),referenceSnapshotId:id(71),fontVersionIds:[id(50)],targetCount:3},inputRevision:1,leaseToken:id(83),status:"running",reservedCostMicrousd:100,actualCostMicrousd:0};
 const connection:LogoWorkerConnection={async query<Row>(){return{rows:[{value:snapshot}] as Row[]};}};
 const store={async readLeasedAsset(actualJob,ref){expect(actualJob.id).toBe(job.id);expect(ref).toEqual(documentAsset);return{reference:documentAsset,mimeType:"application/json",bytes,verification:{status:"verified",contentHash:documentAsset.contentHash,mimeType:"application/json",byteLength:bytes.length,checkedAt:"2026-10-07T00:00:00Z"}};}} as IdentityAssetStore;
 const result=await loadDirectionInputs(connection,job,store);expect(result.approvedLogo.id).toBe(id(3));expect(result.logo.components.map(c=>c.id)).toEqual(document.components.map(c=>c.id));expect(result.inputRevisions).toEqual(snapshot.inputRevisions);
});
