import {ASSET_MAX_FILE_BYTES} from "../../src/domain/asset-library";
import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual,MIMEType } from "node:util";
import { decodeJwt } from "jose";
import { z } from "zod";
import { sharedExecutionSchema,sharedSlotLeaseSchema,type SharedExecution,type SharedSlotLease } from "../shared-pool/contracts";
import { type SharedLogoObservationScope } from "../shared-storage/authorization";
import { slotSessionSchema,storageFetch,storageOrigin,storagePublicKey,storageUnavailable,type SharedStorageSession } from "../shared-storage/protocol";
import { qualifySharedLogoCapability,type SharedLogoCapability } from "./logo-capability";
import { logoDirectionsApiJobInputSchema,logoVectorizeJobInputSchema,logoExportJobInputSchema } from "../../src/domain/logo-jobs";
import { identityGenerationJobInputSchema } from "../../src/domain/identity-jobs";
import { identityAssetPublicationSchema,type IdentityAssetPublication } from "../../src/domain/logo-deliverables";
import { logoAssetReferenceSchema } from "../../src/domain/logo-vector";
import { createIdentityAssetStore,createPostgresIdentityAssetBackend,type IdentityAssetStore,type IdentityAssetReservation } from "../../src/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import {jobStatusSchema,type ClaimedJob } from "../../src/domain/jobs";
import { inspectIdentityRaster } from "../../src/features/logo-vector/server/converter";
import { validateLogoVectorDocument } from "../../src/features/logo-vector/model/geometry";
import { canonicalLogoDocumentBytes } from "../../src/features/logo-vector/model/canonical";
import { validateLogoVectorSvg } from "../../src/features/logo-vector/model/svg";
import { inspectFontBytes } from "../../src/features/identity-directions/server/font-inspection";
import { validateLogoExportAssetBytes } from "../../src/features/identity-deliverables/server/validate-assets";
type Read=Readonly<{read(signal?:AbortSignal):Promise<{bytes:Uint8Array;mimeType:string}>}>;
type Write=Read&Readonly<{putIfAbsent(bytes:Uint8Array,mimeType:string,signal?:AbortSignal):Promise<void>}>;
type Scope={job:ClaimedJob;reservation:Readonly<IdentityAssetReservation>};
export type SharedAdvancedLogoStorageAuthorization={
 readonly ownerId:string;readonly capability:SharedLogoCapability;
 assertAvailable(job:ClaimedJob):Promise<void>;authorizeRead(scope:Scope,signal?:AbortSignal):Promise<Read>;
 authorizeReadback(scope:Scope,signal?:AbortSignal):Promise<Read>;
 authorizeWrite(scope:Scope&{publication:IdentityAssetPublication},signal?:AbortSignal):Promise<Write>;
 authorizeObservedOutput(scope:SharedLogoObservationScope,signal?:AbortSignal):Promise<Read>;close():void;
};
const reservationSchema=z.strictObject({id:z.uuid(),requestKey:z.uuid(),reference:logoAssetReferenceSchema,storagePath:z.string().max(147),mimeType:z.string().min(1).max(150),
 byteLength:z.number().int().min(1).max(ASSET_MAX_FILE_BYTES),purpose:z.enum(["reference_media","brand_asset","input_attachment"]),sourceReceiptId:z.uuid(),rightsEvidenceId:z.uuid().nullable(),publicationState:z.enum(["staged","committed"])});
const grantSchema=slotSessionSchema.extend({execution:sharedExecutionSchema,ownerId:z.uuid(),projectId:z.uuid(),jobId:z.uuid(),leaseToken:z.uuid(),inputRevision:z.number().int().positive(),jobInput:z.unknown(),
 capability:z.unknown(),mode:z.enum(["probe","read","write","observe"]),member:z.enum(["reference","base","source","font","logo-document","output"]).nullable(),reservation:reservationSchema.nullable(),publication:identityAssetPublicationSchema.nullable()});
type StorageJob=SharedLogoObservationScope["job"];
/** One frozen advanced operation; no general owner reader or arbitrary upload.
 * The exact SQL grant establishes source/font membership and every readback. */
export function createSharedAdvancedLogoStorageAuthorization(input:{targetOrigin:string;publishableKey:string;slot:()=>SharedSlotLease|null;execution:SharedExecution;capability:SharedLogoCapability;
 session:Pick<SharedStorageSession,"authUserId"|"sessionId"|"tokenProvider">},dependencies:{fetch?:typeof fetch;now?:()=>number}={}):SharedAdvancedLogoStorageAuthorization{
 try{
 const origin=storageOrigin(input.targetOrigin),key=storagePublicKey(input.publishableKey,origin),execution=sharedExecutionSchema.parse(input.execution),first=sharedSlotLeaseSchema.parse(input.slot());
 const capability=qualifySharedLogoCapability(input.capability),authUserId=z.uuid().parse(input.session.authUserId),sessionId=z.uuid().parse(input.session.sessionId);
 if(!capability||!["identity.image","identity.logo_vectorize","identity.logo_export","identity.logo_directions"].includes(capability.operation)||capability.operation!==execution.operation
  ||capability.policyIdentity!==execution.policyIdentity||first.lane!=="logo"||execution.lane!=="logo"||first.slotId!==execution.slotId
  ||first.generation<execution.generation||first.generation===execution.generation&&first.instanceId!==execution.instanceId||authUserId===execution.ownerId)throw storageUnavailable();
 const lifetime=new AbortController(),now=dependencies.now??Date.now,transport=dependencies.fetch??globalThis.fetch;
 const signal=(caller?:AbortSignal)=>AbortSignal.any([lifetime.signal,...caller?[caller]:[],AbortSignal.timeout(10_000)]);
 function current(active:boolean){const slot=sharedSlotLeaseSchema.parse(input.slot());
  if(lifetime.signal.aborted||slot.slotId!==first.slotId||slot.roleName!==first.roleName||slot.roleOid!==first.roleOid
   ||active&&(slot.generation!==execution.generation||slot.instanceId!==execution.instanceId||slot.leaseToken!==first.leaseToken||Date.parse(slot.expiresAt)<=now()))throw storageUnavailable();}
 async function request(path:string,init:RequestInit,s:AbortSignal,max:number,active:boolean){
  current(active);s.throwIfAborted();const token=await input.session.tokenProvider(s),claims=decodeJwt(z.string().max(16384).parse(token));
  if(claims.sub!==authUserId||claims.session_id!==sessionId||claims.role!=="authenticated"||claims.aud!=="authenticated"||claims.iss!==origin+"/auth/v1"||claims.is_anonymous!==false
   ||!Number.isSafeInteger(claims.exp)||claims.exp!*1000<=now()||claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf*1000>now()))throw storageUnavailable();
  current(active);s.throwIfAborted();const headers=new Headers(init.headers);if(headers.has("authorization")||headers.has("apikey"))throw storageUnavailable();
  headers.set("authorization","Bearer "+token);headers.set("apikey",key);
  const result=await storageFetch(transport,origin+path,{...init,headers,signal:s},max);current(active);s.throwIfAborted();return result;
 }
 async function verify(s:AbortSignal,active:boolean){const response=await request("/auth/v1/user",{method:"GET"},s,16384,active);
  if(response.status!==200)throw storageUnavailable();z.object({id:z.literal(authUserId),is_anonymous:z.literal(false),email_confirmed_at:z.string().min(1)}).parse(await response.json());}
 function snapshot(raw:StorageJob,observe=false,lease?:string){
  const job=structuredClone(raw);jobStatusSchema.parse(job.status);const frozen=execution.operation==="identity.image"?identityGenerationJobInputSchema.parse(job.input)
   :execution.operation==="identity.logo_vectorize"?logoVectorizeJobInputSchema.parse(job.input):execution.operation==="identity.logo_export"?logoExportJobInputSchema.parse(job.input):logoDirectionsApiJobInputSchema.parse(job.input);
  if(job.id!==execution.jobId||job.operation!==execution.operation||job.ownerId!==execution.ownerId||job.projectId!==execution.projectId||frozen.ownerId!==job.ownerId||frozen.projectId!==job.projectId
   ||frozen.policyIdentity!==execution.policyIdentity||frozen.handlerVersion!==capability!.handlerVersion
   ||(observe?lease!==execution.leaseToken||job.leaseToken!==null&&job.leaseToken!==lease||job.status==="queued":job.leaseToken!==execution.leaseToken||job.status!=="running"))throw storageUnavailable();
  if(frozen.operation==="identity.image"&&(!("textPolicy" in capability!)||!isDeepStrictEqual(frozen.textPolicy,capability!.textPolicy))
   ||frozen.operation==="identity.logo_directions"&&(!("apiPolicy" in capability!)||!isDeepStrictEqual(frozen.apiPolicy,capability!.apiPolicy))
   ||frozen.operation==="identity.logo_vectorize"&&!isDeepStrictEqual(frozen.engine,capability!.engine))throw storageUnavailable();
  job.input=frozen;return job;
 }
 function publication(job:StorageJob,row:IdentityAssetReservation,raw:unknown){
  const p=identityAssetPublicationSchema.parse(raw);
  if(row.publicationState!=="staged"||row.purpose!=="brand_asset"||row.rightsEvidenceId!==null||p.requestKey!==row.requestKey||p.source.sourceId!==row.sourceReceiptId
   ||p.contentHash!==row.reference.contentHash||p.byteLength!==row.byteLength||p.mimeType!==row.mimeType)throw storageUnavailable();
  if(job.operation==="identity.image"){const frozen=identityGenerationJobInputSchema.parse(job.input);
   if(p.source.kind!=="identity_system"||!frozen.systemIds.includes(p.source.sourceId)||p.requestKey!==p.source.sourceId||p.mimeType!=="image/png"||p.inputRevisions.length!==0)throw storageUnavailable();
  }else if(p.source.sourceId!==job.id||p.source.kind!==(job.operation==="identity.logo_vectorize"?"vector":"export")
   ||!(job.operation==="identity.logo_vectorize"?["application/json","image/svg+xml"]:job.operation==="identity.logo_export"?["image/png","image/svg+xml","application/pdf","application/zip"]:[]).includes(p.mimeType))throw storageUnavailable();
  return p;
 }
 async function grant(job:StorageJob,row:IdentityAssetReservation|null,mode:"probe"|"read"|"write"|"observe",s:AbortSignal,p?:IdentityAssetPublication|null){
  const response=await request("/rest/v1/rpc/authorize_shared_logo_storage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({p_execution:execution.executionId,
   p_execution_token:execution.executionToken,p_job:execution.jobId,p_lease:execution.leaseToken,p_reservation:row?.id??null,p_mode:mode})},s,2_097_152,mode!=="observe");
  if(response.status!==200)throw storageUnavailable();const result=grantSchema.parse(await response.json());
  if(result.slotId!==execution.slotId||result.instanceId!==execution.instanceId||result.generation!==execution.generation||result.roleName!==first.roleName||result.roleOid!==first.roleOid
   ||result.authUserId!==authUserId||result.sessionId!==sessionId||!isDeepStrictEqual(result.execution,execution)||result.ownerId!==execution.ownerId||result.projectId!==execution.projectId
   ||result.jobId!==execution.jobId||result.leaseToken!==execution.leaseToken||result.inputRevision!==job.inputRevision||!isDeepStrictEqual(result.jobInput,job.input)
   ||!isDeepStrictEqual(result.capability,capability)||result.mode!==mode||!isDeepStrictEqual(result.reservation,row)||p!==undefined&&!isDeepStrictEqual(result.publication,p))throw storageUnavailable();
  if(mode==="probe"){if(result.member!==null||result.publication!==null)throw storageUnavailable();}
  else if(mode==="read"){if(!row||row.publicationState!=="committed"||result.member===null||result.member==="output"||result.publication!==null)throw storageUnavailable();
   if(result.member==="font"&&(!["font/ttf","font/otf"].includes(row.mimeType)||row.rightsEvidenceId===null))throw storageUnavailable();
  }else if(!row||result.member!=="output"||!result.publication)throw storageUnavailable();
  return result.publication;
 }
 async function validate(row:IdentityAssetReservation,bytes:Uint8Array,mime:string,s:AbortSignal,p:IdentityAssetPublication|null){
  s.throwIfAborted();if(bytes.byteLength!==row.byteLength||mime!==row.mimeType||createHash("sha256").update(bytes).digest("hex")!==row.reference.contentHash)throw storageUnavailable();
  if(["image/png","image/jpeg","image/webp"].includes(mime))await inspectIdentityRaster(bytes,mime,s);
  else if(mime==="application/json"){const doc=validateLogoVectorDocument(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));if(!Buffer.from(canonicalLogoDocumentBytes(doc)).equals(Buffer.from(bytes)))throw storageUnavailable();}
  else if(mime==="image/svg+xml")validateLogoVectorSvg(bytes);
  else if(mime==="font/ttf"||mime==="font/otf")await inspectFontBytes(bytes,mime,s);
  else if((mime==="application/pdf"||mime==="application/zip")&&p)await validateLogoExportAssetBytes({kind:"stage",publication:p},bytes,s);
  else throw storageUnavailable();s.throwIfAborted();
 }
 async function authorize(scope:Scope|SharedLogoObservationScope,mode:"read"|"write"|"observe",caller?:AbortSignal,raw?:IdentityAssetPublication){
  const s=signal(caller),observed="observationLeaseToken" in scope,job=snapshot(scope.job,observed,observed?scope.observationLeaseToken:undefined),row=reservationSchema.parse(scope.reservation),ref=row.reference;
  if(ref.ownerId!==execution.ownerId||ref.projectId!==execution.projectId||row.storagePath!==ref.ownerId+"/"+ref.projectId+"/"+ref.assetId+"/"+ref.versionId)throw storageUnavailable();
  let p=raw?publication(job,row,raw):undefined;
  await verify(s,mode!=="observe");const returned=await grant(job,row,mode,s,p??(mode==="read"?null:undefined));
  if(mode!=="read"){p=publication(job,row,returned);if(raw&&!isDeepStrictEqual(p,raw))throw storageUnavailable();}
  const read=async(currentSignal?:AbortSignal)=>{const current=signal(AbortSignal.any([s,...currentSignal?[currentSignal]:[]])),readMode=p?"observe":"read";
   await grant(job,row,readMode,current,p??null);const response=await request("/storage/v1/object/fluid-assets/"+row.storagePath,{method:"GET",headers:{"accept-encoding":"identity"}},current,row.byteLength,!p);
   if(response.status!==200)throw storageUnavailable();const mime=new MIMEType(response.headers.get("content-type")??"").essence,bytes=new Uint8Array(await response.arrayBuffer());
   await validate(row,bytes,mime,current,p??null);await grant(job,row,readMode,current,p??null);return{bytes,mimeType:mime};};
  if(mode!=="write")return Object.freeze({read});
  return Object.freeze({read,async putIfAbsent(bytes:Uint8Array,mime:string,callerSignal?:AbortSignal){
   const current=signal(AbortSignal.any([s,...callerSignal?[callerSignal]:[]]));await validate(row,bytes,mime,current,p!);await grant(job,row,"write",current,p!);
   const response=await request("/storage/v1/object/fluid-assets/"+row.storagePath,{method:"POST",headers:{"content-type":mime,"content-length":String(bytes.byteLength),"x-upsert":"false","accept-encoding":"identity"},body:new Uint8Array(bytes)},current,16384,true);
   if(![200,400,409].includes(response.status))throw storageUnavailable();const ack=z.record(z.string(),z.unknown()).parse(await response.json());
   const duplicate=["ResourceAlreadyExists","KeyAlreadyExists","already_exists"].includes(String(ack.code))&&(response.status===409||response.status===400&&String(ack.statusCode)==="409");
   if(!duplicate&&(response.status!==200||!z.uuid().safeParse(ack.Id).success||ack.Key!=="fluid-assets/"+row.storagePath))throw storageUnavailable();
   await grant(job,row,"observe",current,p!);
  }});
 }
 const guarded=<T>(run:()=>Promise<T>)=>run().catch(()=>{throw storageUnavailable();});
 return Object.freeze({ownerId:execution.ownerId,capability,close(){lifetime.abort();},
  assertAvailable:(raw:ClaimedJob)=>guarded(async()=>{const job=snapshot(raw),s=signal();await verify(s,true);await grant(job,null,"probe",s,null);}),
  authorizeRead:(scope:Scope,s?:AbortSignal)=>guarded(()=>authorize(scope,"read",s)) as Promise<Read>,
  authorizeReadback:(scope:Scope,s?:AbortSignal)=>guarded(()=>authorize(scope,"observe",s)) as Promise<Read>,
  authorizeWrite:(scope:Scope&{publication:IdentityAssetPublication},s?:AbortSignal)=>guarded(()=>authorize(scope,"write",s,scope.publication)) as Promise<Write>,
  authorizeObservedOutput:(scope:SharedLogoObservationScope,s?:AbortSignal)=>guarded(()=>authorize(scope,"observe",s,scope.publication)) as Promise<Read>});
 }catch{throw storageUnavailable();}
}
/** Real leased metadata and immutable object protocol. No owned/customer API. */
export function createSharedAdvancedLogoAssetStore(connection:LogoWorkerConnection,authorization:SharedAdvancedLogoStorageAuthorization):IdentityAssetStore{
 const backend=createPostgresIdentityAssetBackend({owned:null,worker:connection}),denied=async():Promise<never>=>{throw storageUnavailable();};
 return Object.freeze({stageOwnedAsset:denied,publishOwnedUpload:denied,readOwnedAsset:denied,
  async readLeasedAsset(job:ClaimedJob,reference:z.infer<typeof logoAssetReferenceSchema>,signal?:AbortSignal){let row:IdentityAssetReservation|undefined,reader:Read|undefined;
   const store=createIdentityAssetStore({backend:{...backend,async resolve(access,ref,current){await authorization.assertAvailable(job);return row=await backend.resolve(access,ref,current);}},
    storage:{putIfAbsent:denied,async read(path,current){if(!row||row.storagePath!==path)throw storageUnavailable();reader??=await(row.publicationState==="committed"?authorization.authorizeRead({job,reservation:row},signal):authorization.authorizeReadback({job,reservation:row},signal));return reader.read(current);}}});
   return store.readLeasedAsset(job,reference,signal);
  },
  async publishLeasedAsset(job:ClaimedJob,publication:IdentityAssetPublication,bytes:Uint8Array,signal?:AbortSignal){let row:IdentityAssetReservation|undefined,writer:Write|undefined;
   const exact=async(path:string)=>{if(!row||row.storagePath!==path)throw storageUnavailable();return writer??=await authorization.authorizeWrite({job,reservation:row,publication},signal);};
   const store=createIdentityAssetStore({backend:{...backend,async prepare(access,write,current){await authorization.assertAvailable(job);return row=await backend.prepare(access,write,current);}},
    storage:{async putIfAbsent(path,value,mime,current){await(await exact(path)).putIfAbsent(value,mime,current);},async read(path,current){return(await exact(path)).read(current);}},
    async validateBytes(write,value,current){if(write.kind!=="stage")throw storageUnavailable();if(["application/pdf","application/zip"].includes(write.publication.mimeType))await validateLogoExportAssetBytes(write,value,current);}});
   return store.publishLeasedAsset(job,publication,bytes,signal);
  }});
}
