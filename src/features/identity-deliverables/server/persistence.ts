import "server-only";
import { z } from "zod";
import type { ClaimedJob } from "@/domain/jobs";
import { approvedLogoIdentitySnapshotSchema, approvedDeliverableSnapshotSchema, logoVariantSetSchema, logoDeliverablesOverviewSchema, logoExportIntentSchema, logoExportRejectionSchema, matchesLogoExportRejection, logoExportManifestSchema, identityAssetReceiptSchema, type ApprovedLogoIdentitySnapshot, type ApprovedDeliverableSnapshot, type ResolvedLogoVariantSet, type IdentityAssetReceipt, type LogoExportIntent } from "@/domain/logo-deliverables";
import { logoInputRevisionsSchema } from "@/domain/logo-vector";
import { logoDispatchReceiptSchema, logoExportPublicationReceiptSchema } from "@/domain/logo-jobs";
import { logoPageQuerySchema } from "@/domain/logo-workspace";
import type { AuthenticatedContext } from "@/server/auth/context";
import type { IdentityAssetStore } from "@/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "@/server/data/logo-jobs";
import { ApiError } from "@/server/http/errors";
import { logoDatabaseError, logoId, logoOwner, parseLogoInput, parseLogoStored } from "@/server/data/logo-transaction";
import { canonicalLogoDocumentBytes, verifyLogoVectorRevision } from "@/features/logo-vector/server/revisions";
import { validateLogoVectorDocument } from "@/features/logo-vector/model/geometry";
import { canonicalIdentityInput } from "@/features/identity-directions/model/font-check-binding";
import { assertExportJobSnapshot, type ExportPublicationDependencies } from "./publish";
import type { ExportPublicationDetails } from "./export-types";
import { LogoExportAdmissionRejectedError } from "./admission-errors";
import { computeLogoVariantRenderHash, sha256 } from "./render-policy";
const exportRejectionResultSchema=z.strictObject({kind:z.literal("logo_export_admission_rejected"),errorCode:z.literal("conflict"),rejection:logoExportRejectionSchema});
const baseSourceSchema=z.strictObject({...approvedLogoIdentitySnapshotSchema.shape,inputRevisions:logoInputRevisionsSchema}).omit({logoDocument:true});
const exportSourceSchema=z.strictObject({...approvedDeliverableSnapshotSchema.shape}).omit({logoDocument:true,resolvedVariants:true});
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
async function loadFrozen(connection:LogoWorkerConnection,job:ClaimedJob,signal?:AbortSignal) {
 active(signal);logoId(job.id);logoId(job.leaseToken);
 const response=await connection.query<{value:unknown}>("select public.load_logo_export_inputs($1,$2) value",[job.id,job.leaseToken]);active(signal);
 if(response.rows.length!==1)throw new ApiError("integration_unavailable");
 const source=parseLogoStored(exportSourceSchema,response.rows[0]!.value);scope(job.ownerId,job.projectId,source);return source;
}
/** Immutable SQL metadata never substitutes for actual owned canonical and preview bytes. */
export async function loadLogoExportInputs(connection:LogoWorkerConnection,assets:IdentityAssetStore,job:ClaimedJob,signal?:AbortSignal):Promise<ApprovedDeliverableSnapshot> {
 const source=await loadFrozen(connection,job,signal),read:ReadAsset=reference=>assets.readLeasedAsset(job,reference,signal);
 const logoDocument=await resolveLogo(source,read,signal),resolvedVariants=await resolveSet(source.variants,read,signal);
 if(!same(source,await loadFrozen(connection,job,signal)))throw new ApiError("not_found");
 return assertExportJobSnapshot(job,{...source,logoDocument,resolvedVariants});
}
export async function stageLogoExports(connection:LogoWorkerConnection,job:ClaimedJob,input:ApprovedDeliverableSnapshot,receipts:readonly IdentityAssetReceipt[],signal:AbortSignal,details:ExportPublicationDetails) {
 active(signal);assertExportJobSnapshot(job,input);
 const source=await loadFrozen(connection,job,signal);
 const metadata=exportSourceSchema.parse(Object.fromEntries(Object.entries(input).filter(([key])=>key!=="logoDocument"&&key!=="resolvedVariants")));
 if(!same(source,metadata)||receipts.length!==details.files.length)throw new ApiError("not_found");
 for(const [index,raw] of receipts.entries()){const r=identityAssetReceiptSchema.parse(raw),f=details.files[index]!;scope(job.ownerId,job.projectId,r.reference);if(r.sourceReceiptId!==job.id||r.reference.contentHash!==f.contentHash||r.verification.mimeType!==f.mimeType||r.verification.byteLength!==f.byteLength)throw new ApiError("not_found");}
 const body={sourceSnapshotHash:input.sourceSnapshotHash,...details,assetReceiptIds:receipts.map(r=>r.id)};
 const response=await connection.query<{value:unknown}>("select public.stage_logo_exports($1,$2,$3) value",[job.id,job.leaseToken,JSON.stringify(body)]);active(signal);
 const receipt=parseLogoStored(logoExportPublicationReceiptSchema,response.rows[0]?.value);
 if(receipt.jobId!==job.id||receipt.ownerId!==job.ownerId||receipt.projectId!==job.projectId||receipt.sourceSnapshotHash!==input.sourceSnapshotHash||!same(receipt.assetReceiptIds,body.assetReceiptIds))throw new ApiError("not_found");return receipt;
}
export function createExportPublicationDependencies(connection:LogoWorkerConnection,assets:IdentityAssetStore):ExportPublicationDependencies {
 return {assets,assertCurrentLease:async job=>{await loadFrozen(connection,job);},stage:(job,input,receipts,signal,details)=>stageLogoExports(connection,job,input,receipts,signal,details)};
}
export class LogoExportAdmissionUncertainError extends ApiError {
 readonly recovery:{projectId:string;input:LogoExportIntent};
 constructor(projectId:string,input:LogoExportIntent){super("integration_unavailable");this.name="LogoExportAdmissionUncertainError";this.recovery={projectId,input:structuredClone(input)};}
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
  async requestLogoExport(auth:AuthenticatedContext,projectId:string,raw:unknown,signal?:AbortSignal){projectId=logoId(projectId);const input=parseLogoInput(logoExportIntentSchema,raw);let value:unknown;try{value=await rpc(auth,"request_logo_export",{p_project_id:projectId,p_input:input},signal);}catch(error){if(error instanceof ApiError&&error.code!=="integration_unavailable")throw error;throw new LogoExportAdmissionUncertainError(projectId,input);}
   const rejected=exportRejectionResultSchema.safeParse(value);
   if(rejected.success){if(!matchesLogoExportRejection(rejected.data.rejection,logoOwner(auth),projectId,input))throw new LogoExportAdmissionUncertainError(projectId,input);throw new LogoExportAdmissionRejectedError(rejected.data.rejection);}
   try{const receipt=parseLogoStored(logoDispatchReceiptSchema,value);scope(logoOwner(auth),projectId,receipt);if(receipt.requestKey!==input.requestKey||receipt.operation!=="identity.logo_export"||receipt.jobIds.length!==1)throw new Error("Invalid export admission");return receipt;}catch{throw new LogoExportAdmissionUncertainError(projectId,input);}},
 };
}
