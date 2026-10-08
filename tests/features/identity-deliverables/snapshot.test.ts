import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadLogoExportInputs } from "@/features/identity-deliverables/server/persistence";
import type { LogoWorkerConnection } from "@/server/data/logo-jobs";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
import { approvedExportFixture, at, hashBytes } from "./fixtures";
import { canonicalLogoDocumentBytes } from "@/features/logo-vector/server/revisions";
import { serializeLogoSvg } from "@/features/logo-vector/model/svg";
import { renderProposedVariantPreview } from "@/features/identity-deliverables/model/variants";
import { publicationFixture } from "./publication-fixture";
import type { VerifiedAssetBytes } from "@/domain/logo-deliverables";
async function fixture() {
 const snapshot=await approvedExportFixture(),data=new Map<string,VerifiedAssetBytes>();
 function file(reference:VerifiedAssetBytes["reference"],bytes:Uint8Array,mimeType:string) {data.set(reference.versionId,{reference,mimeType,bytes:new Uint8Array(bytes),verification:{status:"verified",checkedAt:at,contentHash:hashBytes(bytes),mimeType,byteLength:bytes.byteLength}});}
 snapshot.logo.proof.validator={id:"fluid.logo-vector",version:"1"};
 snapshot.logo.proof.pathCount=snapshot.logoDocument.components.reduce((n,c)=>n+c.paths.length,0);
 file(snapshot.logo.documentAsset,canonicalLogoDocumentBytes(snapshot.logoDocument),"application/json");file(snapshot.logo.svgAsset,serializeLogoSvg(snapshot.logoDocument),"image/svg+xml");
 for(const item of snapshot.resolvedVariants.items) {
  const variant=item.variant,document=item.document!;
  file(variant.documentAsset!,canonicalLogoDocumentBytes(document),"application/json");
  const preview=await renderProposedVariantPreview({key:`${variant.role}:${variant.colorway}`,role:variant.role,colorway:variant.colorway,clearSpace:variant.clearSpace,minimumDigitalSize:variant.minimumDigitalSize,applicability:{status:"applicable"},document},new AbortController().signal);
  variant.preview!.reference.contentHash=hashBytes(preview!.png);variant.preview!.verification.contentHash=variant.preview!.reference.contentHash;variant.preview!.verification.byteLength=preview!.png.length;
  file(variant.preview!.reference,preview!.png,"image/png");
 }
 snapshot.variants.items=snapshot.resolvedVariants.items.map(i=>i.variant);
 const {logoDocument:_,resolvedVariants:__,...stored}=snapshot;void _;void __;
 const job=publicationFixture(snapshot).job;
 const reads:string[]=[];
 const store={async readLeasedAsset(_job,reference){reads.push(reference.versionId);const result=data.get(reference.versionId);if(!result)throw new Error("Synthetic asset unavailable");return structuredClone(result);}} as IdentityAssetStore;
 return {snapshot,stored,job,store,data,reads};
}
describe("immutable export source resolution",()=>{
 it("loads canonical private documents and rereads the frozen lease-bound metadata",async()=>{
  const f=await fixture(),query=vi.fn(async()=>({rows:[{value:f.stored}]}));
  const result=await loadLogoExportInputs({query} as unknown as LogoWorkerConnection,f.store,f.job,new AbortController().signal);
  expect(result.logoDocument).toEqual(f.snapshot.logoDocument);expect(result.resolvedVariants).toEqual(f.snapshot.resolvedVariants);expect(query).toHaveBeenCalledTimes(2);
  expect(f.reads).toContain(f.snapshot.logo.svgAsset.versionId);expect(f.reads).toHaveLength(8);
 });
 it.each(["changed-bytes","changed-frozen-source","foreign","noncanonical"])("rejects %s before returning an approved snapshot",async mode=>{
  const f=await fixture();let calls=0;
  if(mode==="changed-bytes")f.data.get(f.snapshot.variants.items[0]!.documentAsset!.versionId)!.bytes[0]=0;
  if(mode==="noncanonical"){const row=f.data.get(f.snapshot.logo.documentAsset.versionId)!;row.bytes=new TextEncoder().encode(JSON.stringify(f.snapshot.logoDocument));row.reference.contentHash=createHash("sha256").update(row.bytes).digest("hex");}
  const query=async()=>({rows:[{value:mode==="foreign"?{...f.stored,ownerId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}:++calls>1&&mode==="changed-frozen-source"?{...f.stored,pngLongEdge:1024}:f.stored}]});
  await expect(loadLogoExportInputs({query} as unknown as LogoWorkerConnection,f.store,f.job,new AbortController().signal)).rejects.toThrow();
 });
});
