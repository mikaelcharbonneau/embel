import {createHash,randomUUID} from "node:crypto";
import type {SharedAdvancedLogoFixture} from "../database/shared-advanced-logo-fixture";
import {OWNER_A} from "../database/shared-storage-fixture";
import {exportCapability,workerRole} from "../database/logo-production-storage-fixture";
import {seedDeliverableDirections} from "../database/logo-deliverable-direction-fixture";
import {deliverableFixture,resolvedFixture,id} from "../features/identity-deliverables/fixtures";
import type {ApprovedLogoIdentitySnapshot,IdentityAssetReceipt,IdentityAssetPublication,LogoVariantSet} from "../../src/domain/logo-deliverables";
import {logoInputRevisionsSchema} from "../../src/domain/logo-vector";
import {logoWorkspaceV2Schema} from "../../src/domain/logo-workspace";
import {logoDispatchReceiptSchema} from "../../src/domain/logo-jobs";
import {canonicalLogoDocumentBytes} from "../../src/features/logo-vector/model/canonical";
import {serializeLogoSvg} from "../../src/features/logo-vector/model/svg";
import {validateLogoVectorDocument} from "../../src/features/logo-vector/model/geometry";
import {computeLogoVariantRenderHash} from "../../src/features/identity-deliverables/server/render-policy";
import {renderProposedVariantPreview} from "../../src/features/identity-deliverables/model/variants";
import {createLogoInputService} from "../../src/server/data/logo-inputs";
import {createIdentityAssetStore,createPostgresIdentityAssetBackend} from "../../src/server/data/identity-asset-store";
import {validateLogoInputBytes} from "../../src/features/logo-inputs/server/registration";
import type {IdentityConnectionFactory} from "../../src/server/data/identity-transaction";
import type {AuthenticatedContext} from "../../src/server/auth/context";
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
/** Original synthetic approved artwork/direction metadata; actual canonical
 * JSON/SVG, real rendered PNGs and hash-verified installed Geist/OFL bytes.
 * All records are newly seeded before admission; no frozen source is rewritten.
 * This is a disposable SQL fixture, never evidence of live AI/user approval. */
export async function prepareRealSharedExportSource(f:SharedAdvancedLogoFixture){
 const {db}=f,workspace=await f.project(),projectId=workspace.projectId;
 const snapshot=JSON.parse(JSON.stringify(deliverableFixture("wordmark")).replaceAll(id(1),OWNER_A).replaceAll(id(2),projectId)) as ApprovedLogoIdentitySnapshot;
 snapshot.logoDocument=validateLogoVectorDocument(snapshot.logoDocument);
 const sourceInputs=[{stage:"brief_references" as const,id:workspace.stages.brief_references!.id,revision:1}];
 const sourceBytes=new Map<string,{bytes:Uint8Array;mimeType:string}>();
 async function writer<T>(run:()=>Promise<T>):Promise<T>{await db.exec("savepoint real_export_source_write");
  try{return await f.legacy.writer(async()=>{try{return await run();}catch(error){await db.exec("rollback to savepoint real_export_source_write");throw error;}});}
  finally{await db.exec("release savepoint real_export_source_write");}}

 async function file(bytes:Uint8Array,mimeType:string,sourceId:string,sourceKind="vector",rightsEvidenceId:string|null=null,inputRevisions:IdentityAssetPublication["inputRevisions"]=sourceInputs):Promise<IdentityAssetReceipt>{
  const contentHash=hash(bytes),requestKey=randomUUID(),row=(await db.query<{id:string}>(
   "insert into public.logo_asset_publications(owner_id,project_id,request_key,request,content_hash,mime_type,byte_length,purpose,source_receipt_id,rights_evidence_id,source_kind,state,verification,input_revision,input_hash) values($1,$2,$3,$4,$5,$6,$7,'brand_asset',$8,$9,$10,'staged',$11,1,$5) returning id",
   [OWNER_A,projectId,requestKey,{kind:"stage",publication:{requestKey,inputRevisions,mimeType,contentHash,byteLength:bytes.length,source:{kind:sourceKind,sourceId}}},contentHash,mimeType,bytes.length,sourceId,rightsEvidenceId,sourceKind,
    {status:"verified",checkedAt:new Date().toISOString(),contentHash,mimeType,byteLength:bytes.length}])).rows[0]!;
  const receipt=(await db.query<{value:IdentityAssetReceipt}>("select fluid_private."+(sourceKind==="variant"?"logo_asset_receipt":"logo_commit_asset")+"(a) value from public.logo_asset_publications a where id=$1",[row.id])).rows[0]!.value;
  const path=OWNER_A+"/"+projectId+"/"+receipt.reference.assetId+"/"+receipt.reference.versionId;sourceBytes.set(path,{bytes:Uint8Array.from(bytes),mimeType});
  await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)",[path,OWNER_A]);return receipt;
 }
 const documentBytes=canonicalLogoDocumentBytes(snapshot.logoDocument),svgBytes=serializeLogoSvg(snapshot.logoDocument);
 const originalPreview=await renderProposedVariantPreview({key:"original-synthetic-source",role:"primary",colorway:"color",clearSpace:0,minimumDigitalSize:null,applicability:{status:"applicable"},document:snapshot.logoDocument},new AbortController().signal);
 if(!originalPreview)throw Error("Actual source raster unavailable");
 snapshot.logo.sourcePreview=(await file(originalPreview.png,"image/png",snapshot.logo.id)).reference;

 snapshot.logo.documentAsset=(await file(documentBytes,"application/json",snapshot.logo.id)).reference;
 snapshot.logo.svgAsset=(await file(svgBytes,"image/svg+xml",snapshot.logo.id)).reference;
 snapshot.logo.proof={...snapshot.logo.proof,validator:{id:"fluid.logo-vector",version:"1"},documentHash:hash(documentBytes),svgContentHash:hash(svgBytes),
  pathCount:snapshot.logoDocument.components.reduce((n,component)=>n+component.paths.length,0),componentCount:snapshot.logoDocument.components.length};
 snapshot.logo.documentHash=hash(documentBytes);snapshot.logo.inputRevisions=sourceInputs;
 await db.query("insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)",[snapshot.logo.id,OWNER_A,projectId,snapshot.logo]);
 const vector=(await db.query<{value:{id:string;revision:number}}>("select fluid_private.logo_append_stage($1,$2,'vector',$3,$4) value",[OWNER_A,projectId,{vectorRevisionId:snapshot.logo.id,approvalId:snapshot.logoApproval.id},sourceInputs])).rows[0]!.value;
 snapshot.logoApproval.stageRevisionId=vector.id;
 await db.query("insert into public.logo_approvals(id,owner_id,project_id,vector_revision_id,stage_revision_id,record) values($1,$2,$3,$4,$5,$6)",[snapshot.logoApproval.id,OWNER_A,projectId,snapshot.logo.id,vector.id,snapshot.logoApproval]);
 // Synthetic trusted source-Storage transport seeds pre-cutover object rows;
 // it does not claim customer HTTP/RLS upload proof. The worker later uses real RLS.
 // Use the real catalog registration protocol: exact source/license bytes,
 // owned upload/readback and immutable registry receipts, not font flags alone.
 await db.exec("grant execute on function fluid_private.prepare_logo_input(uuid,jsonb),fluid_private.commit_logo_input(uuid,jsonb,jsonb,jsonb) to "+workerRole);
 const roleOid=Number((await db.query<{oid:number}>("select oid::bigint oid from pg_roles where rolname=$1",[workerRole])).rows[0]!.oid);
 const connections:IdentityConnectionFactory={async acquire(owner){if(owner!==OWNER_A)throw Error("Foreign fixture owner");return{binding:{ownerId:OWNER_A,roleName:workerRole,roleOid},connection:{
  query:(sql,args=[])=>writer(()=>db.query(sql,[...args])),release(){},discard(){}}};}};
 const assets=createIdentityAssetStore({backend:createPostgresIdentityAssetBackend({owned:connections,worker:null}),validateBytes:validateLogoInputBytes,
  storage:{async putIfAbsent(path,bytes,mimeType){sourceBytes.set(path,{bytes:Uint8Array.from(bytes),mimeType});await db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2) on conflict do nothing",[path,OWNER_A]);},
   async read(path){const exists=await db.query("select name from storage.objects where name=$1",[path]);if(exists.rows.length!==1||!sourceBytes.has(path))throw Error("Missing actual ownedfontbytes");return sourceBytes.get(path)!;}}});
 const beforeFont=await f.owner(OWNER_A,async()=>logoWorkspaceV2Schema.parse((await db.query<{value:unknown}>("select public.get_logo_workspace($1) value",[projectId])).rows[0]!.value));
 const font=await createLogoInputService({assets,connections}).importCatalogLogoFont({userId:OWNER_A} as AuthenticatedContext,projectId,{requestKey:randomUUID(),expected:beforeFont.heads,catalogFontId:"geist-sans-variable"});
 snapshot.fonts=[font];snapshot.typography.styles=snapshot.typography.styles.map(style=>({...style,fontVersionId:font.id}));
 const inputs=[...sourceInputs,{stage:"vector" as const,id:vector.id,revision:vector.revision}],directionIds=await seedDeliverableDirections(db,snapshot,inputs);
 for(const[kind,record]of[["palette",snapshot.palette],["typography",snapshot.typography],["graphics",snapshot.graphics],["selection",snapshot.directionSelection],["approval",snapshot.directionApproval]] as const)
  await db.query("insert into public.logo_direction_records(id,owner_id,project_id,kind,approved_logo_id,record) values($1,$2,$3,$4,$5,$6)",[record.id,OWNER_A,projectId,kind,snapshot.logoApproval.id,record]);
 await db.query("select fluid_private.logo_append_stage($1,$2,'directions',$3,$4)",[OWNER_A,projectId,{directionIds,selectionId:snapshot.directionSelection.id,approvalId:snapshot.directionApproval.id},inputs]);
 const ownerRpc=async(name:string,args:unknown[])=>f.owner(OWNER_A,async()=>(await db.query<{value:unknown}>("select public."+name+"("+args.map((_,i)=>"$"+(i+1)).join(",")+") value",args)).rows[0]!.value);
 const source=await ownerRpc("read_logo_deliverable_sources",[projectId]) as {inputRevisions:unknown};
 const local=resolvedFixture(snapshot.logoDocument,computeLogoVariantRenderHash),variantInputs=logoInputRevisionsSchema.parse(source.inputRevisions);
 const items:LogoVariantSet["items"]=[];
 for(const entry of local.resolved.items){
  const variant={...entry.variant,id:randomUUID()},document=entry.document!,preview=await renderProposedVariantPreview({key:variant.role+":"+variant.colorway,role:variant.role,colorway:variant.colorway,
   clearSpace:variant.clearSpace,minimumDigitalSize:variant.minimumDigitalSize,applicability:{status:"applicable"},document},new AbortController().signal);
  if(!preview)throw Error("Actual native preview unavailable");
  variant.documentAsset=(await file(canonicalLogoDocumentBytes(document),"application/json",snapshot.logoApproval.id,"variant",null,variantInputs)).reference;
  variant.preview=await file(preview.png,"image/png",snapshot.logoApproval.id,"variant",null,variantInputs);items.push(variant);
 }
 for(const role of["horizontal","stacked","symbol_only"] as const)for(const colorway of["black","white","color"] as const)
  items.push({id:randomUUID(),role,colorway,documentAsset:null,renderHash:null,preview:null,clearSpace:0,minimumDigitalSize:null,applicability:{status:"not_applicable",reason:role==="symbol_only"?"no_symbol":"inseparable_artwork"},reviewStatus:"review_required"});
 const before=logoWorkspaceV2Schema.parse(await ownerRpc("get_logo_workspace",[projectId])),variantSet={...local.resolved.set,id:randomUUID(),ownerId:OWNER_A,projectId,items};
 const set=await writer(async()=>(await db.query<{value:LogoVariantSet}>("select fluid_private.apply_logo_trusted_command($1,$2,$3) value",[projectId,
  {method:"prepareLogoVariants",body:{requestKey:randomUUID(),expected:before.heads,approvedLogoId:snapshot.logoApproval.id,directionApprovalId:snapshot.directionApproval.id}},{source,variantSet}])).rows[0]!.value);
 const review=logoWorkspaceV2Schema.parse(await ownerRpc("get_logo_workspace",[projectId])),accepted=set.items.filter(item=>item.applicability.status==="applicable");
 await writer(()=>db.query("select fluid_private.apply_logo_trusted_command($1,$2,$3)",[projectId,
  {method:"reviewLogoVariants",body:{requestKey:randomUUID(),expected:review.heads,approvedLogoId:set.approvedLogoId,directionApprovalId:set.directionApprovalId,variantSetId:set.id,acceptedVariantIds:accepted.map(item=>item.id)}},
  {variantSet:set,acceptedVariants:accepted.map(item=>({variantId:item.id,renderHash:item.renderHash}))}]));
 const current=logoWorkspaceV2Schema.parse(await ownerRpc("get_logo_workspace",[projectId]));
 const request={requestKey:randomUUID(),expected:current.heads,approvedLogoId:set.approvedLogoId,directionApprovalId:set.directionApprovalId,variantSetId:set.id,pngLongEdge:512,socialSelections:[]};
 const receipt=await f.owner(OWNER_A,async()=>logoDispatchReceiptSchema.parse((await db.query<{value:unknown}>("select public.shared_logo_operation($1,'export',$2) value",[projectId,request])).rows[0]!.value));
 const jobId=receipt.jobIds[0]!,job=await f.rawJob(jobId);
 return{jobId,job,capability:exportCapability,sourceBytes,request,receipt,snapshot};
}
