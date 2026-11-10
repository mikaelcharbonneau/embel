import "server-only";
import { z } from "zod";
import { approvedLogoIdentitySnapshotSchema, logoVariantSetSchema, logoDeliverablesOverviewSchema, matchesLogoExportRejection, logoExportManifestSchema, type ApprovedLogoIdentitySnapshot, type ResolvedLogoVariantSet, type IdentityAssetReceipt } from "@/domain/logo-deliverables";
import { logoInputRevisionsSchema } from "@/domain/logo-vector";
import { logoPageQuerySchema } from "@/domain/logo-workspace";
import type { AuthenticatedContext } from "@/server/auth/context";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
import { ApiError } from "@/server/http/errors";
import { logoDatabaseError, logoId, logoOwner, parseLogoInput, parseLogoStored } from "@/server/data/logo-transaction";
import { canonicalLogoDocumentBytes, verifyLogoVectorRevision } from "@/features/logo-vector/server/revisions";
import { validateLogoVectorDocument } from "@/features/logo-vector/model/geometry";
import { canonicalIdentityInput } from "@/features/identity-directions/model/font-check-binding";
import { computeLogoVariantRenderHash, sha256 } from "./render-policy";
const baseSourceSchema=z.strictObject({...approvedLogoIdentitySnapshotSchema.shape,inputRevisions:logoInputRevisionsSchema}).omit({logoDocument:true});
const same=(a:unknown,b:unknown)=>canonicalIdentityInput(a)===canonicalIdentityInput(b);
const active=(signal?:AbortSignal)=>{if(signal?.aborted)throw new ApiError("integration_unavailable");};
function scope(owner:string,project:string,value:{ownerId:string;projectId:string}) {if(value.ownerId!==owner||value.projectId!==project)throw new ApiError("not_found");}
type ReadAsset=(reference:IdentityAssetReceipt["reference"])=>ReturnType<IdentityAssetStore["readOwnedAsset"]>;
async function resolveSet(raw:unknown,read:ReadAsset,signal?:AbortSignal):Promise<ResolvedLogoVariantSet> {
 const set=parseLogoStored(logoVariantSetSchema,raw),items:ResolvedLogoVariantSet["items"]=[];
 for(const variant of set.items){
  active(signal);
  if(variant.applicability.status==="not_applicable"){items.push({variant,document:null});continue;}
  const stored=await read(variant.documentAsset!),preview=await read(variant.preview!.reference);active(signal);
  if(!same(stored.reference,variant.documentAsset)||stored.mimeType!=="application/json"||sha256(stored.bytes)!==variant.documentAsset!.contentHash||!same(preview.reference,variant.preview!.reference)||preview.mimeType!=="image/png"||sha256(preview.bytes)!==variant.preview!.reference.contentHash||preview.bytes.byteLength!==variant.preview!.verification.byteLength)throw new ApiError("not_found");
  const document=validateLogoVectorDocument(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(stored.bytes)));
  if(!Buffer.from(stored.bytes).equals(Buffer.from(canonicalLogoDocumentBytes(document)))||computeLogoVariantRenderHash(variant,document)!==variant.renderHash)throw new ApiError("not_found");
  items.push({variant,document});
 }
 return {set,items};
}
async function resolveLogo(source:z.infer<typeof baseSourceSchema>,read:ReadAsset,signal?:AbortSignal) {
 const document=await read(source.logo.documentAsset),svg=await read(source.logo.svgAsset);active(signal);
 return verifyLogoVectorRevision({revision:source.logo,document,svg},signal);
}
export function createLogoDeliverablesService(dependencies:{assets:IdentityAssetStore}) {
 async function rpc(auth:AuthenticatedContext,name:string,args:Record<string,unknown>,signal?:AbortSignal){logoOwner(auth);active(signal);let result:{data:unknown;error:unknown};try{const request=auth.client.rpc(name,args);result=await(signal?request.abortSignal(signal):request);}catch(error){throw logoDatabaseError(error);}if(result.error)throw logoDatabaseError(result.error);active(signal);return result.data;}
 async function readSources(auth:AuthenticatedContext,projectId:string,signal?:AbortSignal){const source=parseLogoStored(baseSourceSchema,await rpc(auth,"read_logo_deliverable_sources",{p_project_id:projectId},signal));scope(logoOwner(auth),projectId,source);return source;}
 async function getApprovedLogoIdentitySnapshot(auth:AuthenticatedContext,projectId:string,signal?:AbortSignal):Promise<ApprovedLogoIdentitySnapshot>{projectId=logoId(projectId);const source=await readSources(auth,projectId,signal),logoDocument=await resolveLogo(source,ref=>dependencies.assets.readOwnedAsset(auth,ref,signal),signal);if(!same(source,await readSources(auth,projectId,signal)))throw new ApiError("conflict");const {inputRevisions:_,...base}=source;void _;return approvedLogoIdentitySnapshotSchema.parse({...base,logoDocument});}
 async function resolveLogoVariantSet(auth:AuthenticatedContext,projectId:string,setId:string,signal?:AbortSignal){projectId=logoId(projectId);setId=logoId(setId);const set=parseLogoStored(logoVariantSetSchema,await rpc(auth,"read_logo_variant_set",{p_project_id:projectId,p_set_id:setId},signal));scope(logoOwner(auth),projectId,set);if(set.id!==setId)throw new ApiError("not_found");return resolveSet(set,ref=>dependencies.assets.readOwnedAsset(auth,ref,signal),signal);}
 return {
  readSources,getApprovedLogoIdentitySnapshot,resolveLogoVariantSet,
  async getLogoDeliverables(auth:AuthenticatedContext,projectId:string,query:{cursor?:string;requestCursor?:string;limit?:number}={},signal?:AbortSignal){projectId=logoId(projectId);const input=parseLogoInput(logoPageQuerySchema.extend({requestCursor:z.uuid().optional()}),query),value=parseLogoStored(logoDeliverablesOverviewSchema,await rpc(auth,"get_logo_deliverables",{p_project_id:projectId,p_query:input},signal));scope(logoOwner(auth),projectId,value);for(const request of value.exportRequests){if(request.state.rejection){scope(logoOwner(auth),projectId,request.state.rejection);if(!matchesLogoExportRejection(request.state.rejection,logoOwner(auth),projectId,request.input))throw new ApiError("not_found");}}return value;},
  async getLogoExport(auth:AuthenticatedContext,projectId:string,exportId:string,signal?:AbortSignal){projectId=logoId(projectId);exportId=logoId(exportId);const value=parseLogoStored(logoExportManifestSchema,await rpc(auth,"get_logo_export",{p_project_id:projectId,p_export_id:exportId},signal));scope(logoOwner(auth),projectId,value);if(value.id!==exportId)throw new ApiError("not_found");return value;},
 };
}
