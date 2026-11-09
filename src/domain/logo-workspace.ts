import { z } from "zod";
import { logoApprovalSchema, logoManualEditSchema, logoAssetReferenceSchema, logoStageSchema, logoTypeSchema, logoRevisionRefSchema, logoRasterSourceSchema, logoInputRevisionsSchema, logoUuidSchema as uuid, logoRevisionSchema as revision, logoCounterSchema as counter, logoTimestampSchema as timestamp, logoHashSchema as hash, logoStringSchema as text, logoScopeShape as scope, boundedLogoJson as bounded, sameLogoScope, logoIssue as issue, uniqueLogoValues as unique, type LogoStage } from "./logo-vector";
export { logoStageSchema, logoTypeSchema, logoRevisionRefSchema, logoRasterSourceSchema, logoConceptSourceSchema, LOGO_MUTATION_MAX_BYTES } from "./logo-vector";
export type { LogoStage, LogoType, LogoRevisionRef, LogoRasterSource, LogoConceptSource } from "./logo-vector";

export const logoExpectedHeadsSchema = z.strictObject({projectRevision:revision,referenceRevision:counter,preferencesRevision:counter,workspaceRevision:counter,stageRevisions:z.record(logoStageSchema,counter)});
export type LogoExpectedHeads = z.infer<typeof logoExpectedHeadsSchema>;
export const logoBriefDraftSchema = bounded(z.strictObject({name:text.min(1).max(200).refine(v=>v.trim().length>0,"A name is required"),activity:text,audience:text,personality:text,logoTypes:z.array(logoTypeSchema).min(1).max(7).refine(unique,"Duplicate logo type")}));
export type LogoBriefDraft = z.infer<typeof logoBriefDraftSchema>;
const ids=z.array(uuid).max(1000).refine(unique,"Duplicate identifier");
export const logoStagePayloadSchemas = {
  brief_references:z.strictObject({...logoBriefDraftSchema.shape,referenceSnapshotId:uuid,sourceProjectRevision:revision}),
  concepts:z.strictObject({batchIds:ids,selected:logoRasterSourceSchema.nullable()}).refine(v=>v.selected?.kind!=="concept"||v.batchIds.includes(v.selected.batchId),"Concept selection must name a retained batch"),
  vector:z.strictObject({vectorRevisionId:uuid,approvalId:uuid.nullable()}),
  refinements:z.strictObject({rasterRevisionIds:ids,vectorRevisionId:uuid.nullable(),approvalId:uuid.nullable(),sourceRequestKey:uuid.nullable()}).refine(v=>v.approvalId===null || v.vectorRevisionId!==null,"Approval requires a vector"),
  directions:z.strictObject({directionIds:z.array(uuid).length(3).refine(unique,"Directions must be distinct"),selectionId:uuid.nullable(),approvalId:uuid.nullable()}).refine(v=>v.approvalId===null || v.selectionId!==null,"Approval requires a selection"),
  deliverables:z.strictObject({variantSetId:uuid.nullable(),exportManifestIds:ids}),
};
export type LogoStagePayloadMap = { [S in LogoStage]:z.infer<(typeof logoStagePayloadSchemas)[S]> };
export type LogoStagePayload = LogoStagePayloadMap[LogoStage];
const revisionShape={version:z.literal(2),id:uuid,...scope,revision,parentRevisionId:uuid.nullable(),inputRevisions:logoInputRevisionsSchema,inputHash:hash,createdAt:timestamp};
export const logoStageRevisionSchema = bounded(z.discriminatedUnion("stage",[
  z.strictObject({...revisionShape,stage:z.literal("brief_references"),payload:logoStagePayloadSchemas.brief_references}),
  z.strictObject({...revisionShape,stage:z.literal("concepts"),payload:logoStagePayloadSchemas.concepts}),
  z.strictObject({...revisionShape,stage:z.literal("vector"),payload:logoStagePayloadSchemas.vector}),
  z.strictObject({...revisionShape,stage:z.literal("refinements"),payload:logoStagePayloadSchemas.refinements}),
  z.strictObject({...revisionShape,stage:z.literal("directions"),payload:logoStagePayloadSchemas.directions}),
  z.strictObject({...revisionShape,stage:z.literal("deliverables"),payload:logoStagePayloadSchemas.deliverables}),
]).refine(v=>v.parentRevisionId!==v.id && (v.revision===1)===(v.parentRevisionId===null) && !v.inputRevisions.some(r=>r.id===v.id),"Revision lineage must retain a distinct predecessor"));
export type LogoStageRevision<S extends LogoStage=LogoStage> = Extract<z.infer<typeof logoStageRevisionSchema>,{stage:S}>;
export type LogoBriefRevision = LogoStageRevision<"brief_references">;
export const logoBriefRevisionSchema = logoStageRevisionSchema.refine((v):v is LogoBriefRevision=>v.stage==="brief_references");
export const logoReferenceAspectSchema = z.enum(["lettering","shape","composition","overall_feel"]);
export type LogoReferenceAspect = z.infer<typeof logoReferenceAspectSchema>;
const aspects=z.array(logoReferenceAspectSchema).min(1).max(4).refine(unique,"Duplicate reference aspect");
export const logoReferenceSelectionSchema = z.strictObject({referenceId:uuid,aspects});
export type LogoReferenceSelection = z.infer<typeof logoReferenceSelectionSchema>;
const referenceShape={referenceId:uuid,asset:logoAssetReferenceSchema,sourceKind:z.enum(["curated","upload"]),aspects,rightsEvidenceId:uuid};
// The largest fixed 100-reference projection is 51,210 JSONB-text bytes.
// Browser selections and stage pointers retain their separate 32 KiB ceiling.
export const LOGO_REFERENCE_SNAPSHOT_MAX_BYTES = 65_536;
export const logoReferenceSnapshotSchema = bounded(z.strictObject({version:z.literal(2),id:uuid,...scope,revision,references:z.array(z.strictObject(referenceShape)).max(100)}).superRefine((v,ctx)=>{
  if(!unique(v.references.map(r=>r.referenceId)) || v.references.some(r=>!sameLogoScope(v,r.asset)))issue(ctx,"Snapshot references must be unique and owned");
}),LOGO_REFERENCE_SNAPSHOT_MAX_BYTES);
export type LogoReferenceSnapshot = z.infer<typeof logoReferenceSnapshotSchema>;
export const logoCapabilitySchema = z.discriminatedUnion("status",[z.strictObject({status:z.literal("available")}),z.strictObject({status:z.literal("unavailable"),reason:text.min(1)})]);
export type LogoCapability = z.infer<typeof logoCapabilitySchema>;
export const logoWorkspaceV2Schema = bounded(z.strictObject({version:z.literal(2),...scope,heads:logoExpectedHeadsSchema,stages:z.record(logoStageSchema,logoRevisionRefSchema.nullable()),approvedLogo:logoApprovalSchema.nullable(),staleStages:z.array(z.strictObject({stage:logoStageSchema,reasons:z.array(text.min(1)).min(1).max(20).refine(unique,"Duplicate stale reason")})).max(6),capabilities:z.record(z.enum(["save","upload","generate","convert","export"]),logoCapabilitySchema)}).superRefine((v,ctx)=>{
  for(const stage of logoStageSchema.options) { const ref=v.stages[stage]; if(ref ? ref.stage!==stage || ref.revision!==v.heads.stageRevisions[stage] : v.heads.stageRevisions[stage]!==0)issue(ctx,"Stage pointers must match exact stage heads"); }
  if(v.approvedLogo && !sameLogoScope(v,v.approvedLogo))issue(ctx,"Approval must belong to workspace");
  if(!unique(v.staleStages.map(s=>s.stage)))issue(ctx,"Duplicate stale stage");
}));
export type LogoWorkspaceV2 = z.infer<typeof logoWorkspaceV2Schema>;
export const logoCurrentVectorSelectionSchema=z.strictObject({...scope,vectorRevisionId:uuid.nullable()});
export type LogoCurrentVectorSelection=z.infer<typeof logoCurrentVectorSelectionSchema>;

export const logoMutationReceiptSchema = bounded(z.strictObject({...scope,workspace:logoWorkspaceV2Schema,revision:logoStageRevisionSchema,requestKey:uuid}).superRefine((v,ctx)=>{
  const head=v.workspace.stages[v.revision.stage];
  if(!sameLogoScope(v,v.workspace)||!sameLogoScope(v,v.revision)||!head||head.id!==v.revision.id||head.revision!==v.revision.revision)issue(ctx,"Mutation receipt must bind its exact owned workspace revision");
}),65_536);
export type LogoMutationReceipt = z.infer<typeof logoMutationReceiptSchema>;
const command={requestKey:uuid,expected:logoExpectedHeadsSchema};
export const saveLogoBriefInputSchema=bounded(z.strictObject({...command,brief:logoBriefDraftSchema}));
export const saveLogoReferencesInputSchema=bounded(z.strictObject({...command,selections:z.array(logoReferenceSelectionSchema).max(100).refine(v=>unique(v.map(r=>r.referenceId)),"Duplicate reference")}));
export const selectLogoConceptInputSchema=bounded(z.strictObject({...command,batchId:uuid,slotId:uuid,attemptId:uuid}));
export const selectLogoRasterInputSchema=bounded(z.strictObject({...command,source:logoRasterSourceSchema}));
export const saveLogoEditInputSchema=bounded(z.strictObject({...command,baseVectorRevisionId:uuid,edit:logoManualEditSchema}));
export const acceptLogoVectorInputSchema=bounded(z.strictObject({...command,vectorRevisionId:uuid,acceptEarlierBasis:z.boolean()}));
export const restoreLogoStageInputSchema=bounded(z.strictObject({...command,stage:logoStageSchema,revisionId:uuid,acceptEarlierBasis:z.boolean()}));
export const selectIdentityDirectionComponentsInputSchema=bounded(z.strictObject({...command,approvedLogoId:uuid,paletteVersionId:uuid,typographyVersionId:uuid,graphicsVersionId:uuid}));
export const approveIdentityDirectionInputSchema=bounded(z.strictObject({...command,directionSelectionId:uuid,consistencyHash:hash}));
export const prepareLogoVariantsInputSchema=bounded(z.strictObject({...command,approvedLogoId:uuid,directionApprovalId:uuid}));
export const reviewLogoVariantsInputSchema=bounded(z.strictObject({...command,approvedLogoId:uuid,directionApprovalId:uuid,variantSetId:uuid,acceptedVariantIds:z.array(uuid).min(1).max(12).refine(unique,"Duplicate variant")}));
export const logoManualCommandSchema=bounded(z.discriminatedUnion("method",[
 z.strictObject({method:z.literal("saveLogoBrief"),body:saveLogoBriefInputSchema}),z.strictObject({method:z.literal("saveLogoReferences"),body:saveLogoReferencesInputSchema}),
 z.strictObject({method:z.literal("selectLogoConcept"),body:selectLogoConceptInputSchema}),z.strictObject({method:z.literal("selectLogoRaster"),body:selectLogoRasterInputSchema}),
 z.strictObject({method:z.literal("saveLogoEdit"),body:saveLogoEditInputSchema}),z.strictObject({method:z.literal("acceptLogoVector"),body:acceptLogoVectorInputSchema}),
 z.strictObject({method:z.literal("restoreLogoStage"),body:restoreLogoStageInputSchema}),z.strictObject({method:z.literal("selectIdentityDirectionComponents"),body:selectIdentityDirectionComponentsInputSchema}),
 z.strictObject({method:z.literal("approveIdentityDirection"),body:approveIdentityDirectionInputSchema}),z.strictObject({method:z.literal("prepareLogoVariants"),body:prepareLogoVariantsInputSchema}),
 z.strictObject({method:z.literal("reviewLogoVariants"),body:reviewLogoVariantsInputSchema}),
]));
export type LogoManualCommand=z.infer<typeof logoManualCommandSchema>;
export const logoPageQuerySchema=z.strictObject({cursor:z.string().min(1).max(2048).optional(),limit:z.number().int().min(1).max(50).default(20)});
export const logoHistoryCursorSchema=z.strictObject({stage:logoStageSchema,createdAt:timestamp,id:uuid});
export type LogoHistoryCursor=z.infer<typeof logoHistoryCursorSchema>;
export const logoHistoryPageSchema=bounded(z.strictObject({...scope,items:z.array(logoStageRevisionSchema).max(50),nextCursor:logoHistoryCursorSchema.nullable()}).refine(v=>v.items.every(i=>sameLogoScope(v,i))&&unique(v.items.map(i=>i.id)),"History must be uniquely owned"),1_638_400);
export type LogoHistoryPage=z.infer<typeof logoHistoryPageSchema>;
export const logoReferenceRegistrationSchema=bounded(z.strictObject({...referenceShape,workspace:logoWorkspaceV2Schema}).refine(v=>sameLogoScope(v.asset,v.workspace),"Registration must belong to its workspace"),65_536);
export type LogoReferenceRegistration=z.infer<typeof logoReferenceRegistrationSchema>;
export const logoReferencePageSchema=bounded(z.strictObject({...scope,items:z.array(logoReferenceRegistrationSchema).max(50),nextCursor:z.string().min(1).max(2048).nullable()}).refine(v=>v.items.every(r=>sameLogoScope(v,r.asset))&&unique(v.items.map(r=>r.referenceId)),"Reference page must be uniquely owned"),3_276_800);
export type LogoReferencePage=z.infer<typeof logoReferencePageSchema>;
export const uploadLogoReferenceInputSchema=bounded(z.strictObject({...command,aspects,rightsDeclaration:text.min(1).max(2000)}));
export const importCuratedLogoReferenceInputSchema=bounded(z.strictObject({...command,curatedReferenceId:uuid,aspects}));
