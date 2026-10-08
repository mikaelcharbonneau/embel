import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClaimedJob } from "@/domain/jobs";
import type { AssetVersionReference } from "@/domain/asset-library";
import { ASSET_MAX_FILE_BYTES } from "@/domain/asset-library";
import { logoAssetReferenceSchema, logoUuidSchema } from "@/domain/logo-vector";
import { identityAssetPublicationSchema, identityUploadIntentSchema, identityAssetReceiptSchema, verifiedAssetBytesSchema, type IdentityAssetPublication, type IdentityUploadIntent, type IdentityAssetReceipt, type VerifiedAssetBytes, type VerifiedFileObservation } from "@/domain/logo-deliverables";
import { inspectIdentityRaster } from "@/features/logo-vector/server/converter";
import { validateLogoVectorSvg } from "@/features/logo-vector/model/svg";
export { inspectIdentityRaster };
import type { AuthenticatedContext } from "../auth/context";
import type { IdentityConnectionFactory } from "./identity-transaction";
import { ApiError } from "../http/errors";
import { logoOwner, logoId, parseLogoInput, parseLogoStored, logoDatabaseError } from "./logo-transaction";

export interface IdentityAssetStore {
 stageOwnedAsset(auth:AuthenticatedContext,projectId:string,publication:IdentityAssetPublication,bytes:Uint8Array,signal?:AbortSignal):Promise<IdentityAssetReceipt>;
 publishOwnedUpload(auth:AuthenticatedContext,projectId:string,intent:IdentityUploadIntent,bytes:Uint8Array,signal?:AbortSignal):Promise<IdentityAssetReceipt>;
 publishLeasedAsset(job:ClaimedJob,publication:IdentityAssetPublication,bytes:Uint8Array,signal?:AbortSignal):Promise<IdentityAssetReceipt>;
 readOwnedAsset(auth:AuthenticatedContext,reference:AssetVersionReference,signal?:AbortSignal):Promise<VerifiedAssetBytes>;
 readLeasedAsset(job:ClaimedJob,reference:AssetVersionReference,signal?:AbortSignal):Promise<VerifiedAssetBytes>;
}
export type IdentityAssetAccess = {kind:"owned";auth:AuthenticatedContext;ownerId:string;projectId:string}|{kind:"leased";job:ClaimedJob;ownerId:string;projectId:string};
export type IdentityAssetReservation = {
 id:string;requestKey:string;reference:AssetVersionReference;storagePath:string;mimeType:string;byteLength:number;
 purpose:IdentityAssetReceipt["purpose"];sourceReceiptId:string;rightsEvidenceId:string|null;publicationState:"staged"|"committed";
};
export type IdentityAssetWrite = {kind:"stage";publication:IdentityAssetPublication}|{kind:"upload";intent:IdentityUploadIntent;byteLength:number};
/** Trusted, injected persistence capability, never browser proof. Implementations
 * atomically reserve one exact request body and immutable version, independently
 * verify ownership/source rights, and revalidate the real stored lease on EVERY
 * leased call. observe commits uploads only; producer files remain staged until
 * their separate fenced source transaction commits. A lost response must replay
 * the same request, never allocate a replacement version. */
export interface IdentityAssetBackend {
 prepare(access:IdentityAssetAccess,write:IdentityAssetWrite,signal?:AbortSignal):Promise<IdentityAssetReservation>;
 resolve(access:IdentityAssetAccess,reference:AssetVersionReference,signal?:AbortSignal):Promise<IdentityAssetReservation>;
 observe(access:IdentityAssetAccess,id:string,verification:VerifiedFileObservation,signal?:AbortSignal):Promise<IdentityAssetReceipt>;
}
/** Immutable private-object capability. putIfAbsent must never overwrite bytes. */
export interface IdentityAssetStorage {
 putIfAbsent(path:string,bytes:Uint8Array,mimeType:string,signal?:AbortSignal):Promise<void>;
 read(path:string,signal?:AbortSignal):Promise<{bytes:Uint8Array;mimeType:string}>;
}
export type IdentityAssetStoreDependencies={backend:IdentityAssetBackend;storage:IdentityAssetStorage;now?:()=>Date;validateBytes?:(write:IdentityAssetWrite,bytes:Uint8Array,signal?:AbortSignal)=>Promise<void>};
export class IdentityAssetUncertainPublicationError extends ApiError {
 constructor(readonly requestKey:string,readonly reservationId:string|null){super("integration_unavailable");this.name="IdentityAssetUncertainPublicationError";}
}
const reservationSchema=z.strictObject({id:logoUuidSchema,requestKey:logoUuidSchema,reference:logoAssetReferenceSchema,storagePath:z.string().min(1),mimeType:z.string().min(1).max(150),byteLength:z.number().int().min(1).max(ASSET_MAX_FILE_BYTES),purpose:z.enum(["reference_media","brand_asset","input_attachment"]),sourceReceiptId:logoUuidSchema,rightsEvidenceId:logoUuidSchema.nullable(),publicationState:z.enum(["staged","committed"])});
const active=(signal?:AbortSignal)=>{if(signal?.aborted)throw new ApiError("integration_unavailable");};
const sameReference=(a:AssetVersionReference,b:AssetVersionReference)=>a.ownerId===b.ownerId&&a.projectId===b.projectId&&a.assetId===b.assetId&&a.versionId===b.versionId&&a.contentHash===b.contentHash;
function reservation(access:IdentityAssetAccess,raw:unknown):IdentityAssetReservation {
 const row=parseLogoStored(reservationSchema,raw),ref=row.reference;
 if(ref.ownerId!==access.ownerId||ref.projectId!==access.projectId||row.storagePath!==`${ref.ownerId}/${ref.projectId}/${ref.assetId}/${ref.versionId}`)throw new ApiError("not_found");
 return row;
}
function leased(job:ClaimedJob):IdentityAssetAccess {
 logoId(job.id);logoId(job.leaseToken);
 if(!job.operation.startsWith("identity.logo_")||!["running","partial","cancel_requested"].includes(job.status))throw new ApiError("not_found");
 return {kind:"leased",job,ownerId:logoId(job.ownerId),projectId:logoId(job.projectId)};
}
function verify(bytes:Uint8Array,mimeType:string,hash:string,length:number,now:()=>Date,error:"invalid_input"|"not_found"):VerifiedFileObservation {
 if(!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>ASSET_MAX_FILE_BYTES||bytes.byteLength!==length||!mimeType||mimeType!==mimeType.toLowerCase().trim()||mimeType.includes(";")||createHash("sha256").update(bytes).digest("hex")!==hash)throw new ApiError(error);
 return {status:"verified",checkedAt:now().toISOString(),contentHash:hash,mimeType,byteLength:bytes.byteLength};
}
/** Performs byte work outside database locks. No environment/credential lookup,
 * fallback bucket or privileged client is constructed by this factory. */
export function createIdentityAssetStore(dependencies:IdentityAssetStoreDependencies|null):IdentityAssetStore {
 const now=dependencies?.now??(()=>new Date());
 function configured(){if(!dependencies)throw new ApiError("integration_unavailable");return dependencies;}
 async function publish(access:IdentityAssetAccess,write:IdentityAssetWrite,input:Uint8Array,signal?:AbortSignal):Promise<IdentityAssetReceipt>{
  active(signal);const d=configured(),body=write.kind==="stage"?write.publication:write.intent;
  // Freeze caller bytes before awaiting capabilities or storage.
  if(!(input instanceof Uint8Array)||input.byteLength<1||input.byteLength>ASSET_MAX_FILE_BYTES)throw new ApiError("invalid_input");
  const bytes=new Uint8Array(input),length=write.kind==="stage"?write.publication.byteLength:write.byteLength;
  verify(bytes,body.mimeType,body.contentHash,length,now,"invalid_input");
  if(["image/png","image/jpeg","image/webp"].includes(body.mimeType))await inspectIdentityRaster(bytes,body.mimeType,signal);
  else if(body.mimeType==="image/svg+xml")validateLogoVectorSvg(bytes);
  else if(body.mimeType==="application/json"){try{JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{throw new ApiError("invalid_input");}}
  else if(!d.validateBytes)throw new ApiError("integration_unavailable");
  if(d.validateBytes)await d.validateBytes(write,bytes,signal);
  active(signal);
  let row:IdentityAssetReservation;
  try{row=reservation(access,await d.backend.prepare(access,write,signal));}catch(error){if(error instanceof ApiError)throw error;throw new IdentityAssetUncertainPublicationError(body.requestKey,null);}
  if(row.requestKey!==body.requestKey||row.reference.contentHash!==body.contentHash||row.mimeType!==body.mimeType||row.byteLength!==length)throw new ApiError("conflict");
  const purpose=write.kind==="stage"?"brand_asset":write.intent.usage==="logo_reference"?"reference_media":write.intent.usage==="project_attachment"?"input_attachment":"brand_asset";
  if(row.purpose!==purpose||(write.kind==="stage"&&row.sourceReceiptId!==write.publication.source.sourceId))throw new ApiError("not_found");
  try{
   active(signal);await d.storage.putIfAbsent(row.storagePath,bytes,row.mimeType,signal);active(signal);
   const stored=await d.storage.read(row.storagePath,signal);active(signal);
   if(stored.mimeType!==row.mimeType)throw new ApiError("not_found");
   const observed=verify(stored.bytes,stored.mimeType,row.reference.contentHash,row.byteLength,now,"not_found");
   const receipt=parseLogoStored(identityAssetReceiptSchema,await d.backend.observe(access,row.id,observed,signal));active(signal);
   if(receipt.id!==row.id||!sameReference(receipt.reference,row.reference)||receipt.purpose!==row.purpose||receipt.sourceReceiptId!==row.sourceReceiptId||receipt.rightsEvidenceId!==row.rightsEvidenceId||receipt.verification.contentHash!==observed.contentHash||receipt.verification.mimeType!==observed.mimeType||receipt.verification.byteLength!==observed.byteLength||receipt.publicationState!==(write.kind==="upload"?"committed":row.publicationState))throw new Error("Invalid publication acknowledgement");
   return receipt;
  }catch{throw new IdentityAssetUncertainPublicationError(body.requestKey,row.id);}
 }
 async function read(access:IdentityAssetAccess,reference:AssetVersionReference,signal?:AbortSignal):Promise<VerifiedAssetBytes>{
  active(signal);const d=configured();reference=parseLogoInput(logoAssetReferenceSchema,reference);
  if(reference.ownerId!==access.ownerId||reference.projectId!==access.projectId)throw new ApiError("not_found");
  const row=reservation(access,await d.backend.resolve(access,reference,signal));active(signal);
  if(!sameReference(reference,row.reference)||(access.kind==="owned"&&row.publicationState!=="committed"))throw new ApiError("not_found");
  const stored=await d.storage.read(row.storagePath,signal);active(signal);
  if(stored.mimeType!==row.mimeType)throw new ApiError("not_found");
  if(!(stored.bytes instanceof Uint8Array)||stored.bytes.byteLength<1||stored.bytes.byteLength>ASSET_MAX_FILE_BYTES)throw new ApiError("not_found");
  const bytes=new Uint8Array(stored.bytes),verification=verify(bytes,row.mimeType,reference.contentHash,row.byteLength,now,"not_found");
  // Recheck ownership/lease after byte I/O so late results cannot escape.
  const current=reservation(access,await d.backend.resolve(access,reference,signal));active(signal);
  if(!sameReference(current.reference,row.reference)||current.id!==row.id||current.storagePath!==row.storagePath||current.mimeType!==row.mimeType||current.byteLength!==row.byteLength)throw new ApiError("not_found");
  return parseLogoStored(verifiedAssetBytesSchema,{reference,mimeType:row.mimeType,bytes,verification});
 }
 return {
  stageOwnedAsset:(auth,projectId,publication,bytes,signal)=>publish({kind:"owned",auth,ownerId:logoOwner(auth),projectId:logoId(projectId)},{kind:"stage",publication:parseLogoInput(identityAssetPublicationSchema,publication)},bytes,signal),
  publishOwnedUpload:(auth,projectId,intent,bytes,signal)=>publish({kind:"owned",auth,ownerId:logoOwner(auth),projectId:logoId(projectId)},{kind:"upload",intent:parseLogoInput(identityUploadIntentSchema,intent),byteLength:bytes instanceof Uint8Array?bytes.byteLength:0},bytes,signal),
  publishLeasedAsset:(job,publication,bytes,signal)=>publish(leased(job),{kind:"stage",publication:parseLogoInput(identityAssetPublicationSchema,publication)},bytes,signal),
  readOwnedAsset:(auth,reference,signal)=>read({kind:"owned",auth,ownerId:logoOwner(auth),projectId:logoId(reference.projectId)},reference,signal),
  readLeasedAsset:(job,reference,signal)=>read(leased(job),reference,signal),
 };
}
export const productionIdentityAssetStore=createIdentityAssetStore(null);

/** Concrete metadata adapter. Every fixed SQL entrypoint independently binds the
 * actual session_user/OID and current lease. No owner GUC or admin fallback. */
export function createPostgresIdentityAssetBackend(dependencies:{owned:IdentityConnectionFactory|null;worker:{query(sql:string,parameters?:unknown[]):Promise<{rows:unknown[]}>}|null}):IdentityAssetBackend {
 async function call(access:IdentityAssetAccess,sql:string,parameters:unknown[],signal?:AbortSignal):Promise<unknown>{
  active(signal);
  if(access.kind==="leased"){
   if(!dependencies.worker)throw new ApiError("integration_unavailable");
   try{const result=await dependencies.worker.query(sql,parameters);active(signal);return parseLogoStored(z.strictObject({value:z.unknown()}),result.rows[0]).value;}catch(error){throw logoDatabaseError(error);}
  }
  if(!dependencies.owned)throw new ApiError("integration_unavailable");
  const acquired=await dependencies.owned.acquire(access.ownerId,signal);let discard=false;
  try{
   if(acquired.binding.ownerId!==access.ownerId)throw new ApiError("not_found");active(signal);
   const principal=await acquired.connection.query("SELECT session_user::text AS role_name, pg_catalog.to_regrole(session_user)::oid::bigint AS role_oid");
   const login=parseLogoStored(z.strictObject({role_name:z.string(),role_oid:z.coerce.number().int().positive()}),principal.rows[0]);
   if(login.role_name!==acquired.binding.roleName||login.role_oid!==acquired.binding.roleOid)throw new ApiError("integration_unavailable");
   const result=await acquired.connection.query(sql,parameters);active(signal);return parseLogoStored(z.strictObject({value:z.unknown()}),result.rows[0]).value;
  }catch(error){discard=true;throw logoDatabaseError(error);}finally{try{await acquired.connection.release(discard);}catch{await acquired.connection.discard();throw new ApiError("integration_unavailable");}}
 }
 const lease=(access:IdentityAssetAccess)=>access.kind==="leased"?[access.job.id,access.job.leaseToken]:[null,null];
 return {
  async prepare(access,write,signal){return parseLogoStored(reservationSchema,await call(access,"SELECT fluid_private.prepare_logo_asset($1::uuid,$2::jsonb,$3::uuid,$4::uuid) AS value",[access.projectId,JSON.stringify(write),...lease(access)],signal));},
  async resolve(access,reference,signal){
   if(access.kind==="owned"){
    active(signal);const request=access.auth.client.rpc("read_logo_asset",{p_reference:reference});
    const response=await (signal?request.abortSignal(signal):request);active(signal);
    if(response.error)throw logoDatabaseError(response.error);return parseLogoStored(reservationSchema,response.data);
   }
   return parseLogoStored(reservationSchema,await call(access,"SELECT fluid_private.read_logo_asset_publication($1::uuid,$2::jsonb,$3::uuid,$4::uuid) AS value",[access.projectId,JSON.stringify(reference),...lease(access)],signal));
  },
  async observe(access,id,verification,signal){return parseLogoStored(identityAssetReceiptSchema,await call(access,"SELECT fluid_private.observe_logo_asset($1::uuid,$2::jsonb,$3::uuid,$4::uuid) AS value",[id,JSON.stringify(verification),...lease(access)],signal));},
 };
}
