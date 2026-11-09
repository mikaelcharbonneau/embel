import { legacyLogoVectorProposalTextPolicySchema,uncappedLogoVectorProposalTextPolicySchema,logoVectorProposalUsageSchema,logoVectorProposalUsageCost } from "./logo-vector-proposal-jobs";
import { logoVectorProposalRequestSchema } from "./logo-vector-proposals";
import { z } from "zod";
import { moneySchema } from "./jobs";
import { IMAGE_MODEL } from "./providers";
import { subscriptionLimitsSchema, subscriptionUsageSchema } from "./strategy-jobs";
import { localRegistrationIdSchema } from "./local-chatgpt";
import { LOGO_REFERENCE_SNAPSHOT_MAX_BYTES,logoExpectedHeadsSchema,logoBriefRevisionSchema,logoReferenceSnapshotSchema,logoMutationReceiptSchema,type LogoMutationReceipt } from "./logo-workspace";
import { committedIdentityAssetReceiptSchema,logoVariantSetSchema,logoExportRejectionSchema,type LogoExportRejection,type IdentityAssetReceipt,type LogoVariantSet } from "./logo-deliverables";
import { fontRecordSchema } from "./logo-directions";
import { reviewedVisualDirectionSchema, VISUAL_DIRECTION_MAX_BYTES } from "./visual-direction";
import { LOGO_MUTATION_MAX_BYTES,LOGO_GEOMETRY_MAX_BYTES,logoUuidSchema as uuid,logoHashSchema as hash,logoStringSchema as text,logoTimestampSchema as timestamp,logoIdentifierSchema as identifier,logoScopeShape as scope,logoTypeSchema,logoRasterSourceSchema,logoRevisionSchema as revision,logoAssetReferenceSchema,logoInputRevisionsSchema,logoLocksSchema,logoTraceSettingsSchema,logoApprovalSchema,logoVectorDocumentSchema,boundedLogoJson as bounded,uniqueLogoValues as unique,sameLogoScope,logoIssue as issue } from "./logo-vector";

export const LOGO_CONCEPT_OPERATION="identity.logo_concept" as const;
// Active host inventory remains five lanes until the separate Task 6 integration.
// Disabled proposal receipts and quotes are recognized independently below.
export const logoOperationSchema=z.enum(["identity.logo_concept","identity.logo_refine","identity.logo_vectorize","identity.logo_directions","identity.logo_export"]);
export type LogoOperation=z.infer<typeof logoOperationSchema>;
export const logoBillingObservationSchema=z.discriminatedUnion("status",[z.strictObject({status:z.literal("unknown"),confirmedMicrousd:z.null()}),z.strictObject({status:z.literal("recorded"),confirmedMicrousd:moneySchema})]);
export type LogoBillingObservation=z.infer<typeof logoBillingObservationSchema>;
/** Operator-owned policy. The attestation alone never authorizes transport or credentials. */
export const logoDirectionsSubscriptionPolicySchema=z.strictObject({
 version:z.literal(1),billingMode:z.literal("chatgpt_subscription"),handlerVersion:z.literal("logo-directions-v1"),adapterVersion:z.literal("logo-directions-chatgpt-v1"),
 registrationId:localRegistrationIdSchema,model:identifier.max(150),apiCharge:z.literal("verified_zero"),
 limits:subscriptionLimitsSchema.extend({maxInputBytes:z.number().int().min(1024).max(131_072),maxOutputBytes:z.number().int().min(1024).max(262_144),maxStreamBytes:z.number().int().min(1024).max(2_097_152),deadlineMs:z.number().int().min(1000).max(240_000),maxObservedWebSearchCalls:z.literal(0)}),
});
export type LogoDirectionsSubscriptionPolicy=z.infer<typeof logoDirectionsSubscriptionPolicySchema>;
/** Future API directions are explicitly uncapped; finite resource limits are not money authority. */
export const logoDirectionsApiPolicySchema=z.strictObject({version:z.literal(1),billingMode:z.literal("openai_api"),spendControl:z.literal("uncapped"),
 handlerVersion:z.literal("logo-directions-api-v1"),adapterVersion:z.literal("logo-directions-openai-v1"),model:z.literal("gpt-6.1-sol"),pricingVersion:z.literal("2026-10-03"),serviceTier:z.literal("default"),
 maxInputTokens:z.number().int().min(1).max(32768),maxOutputTokens:z.number().int().min(1).max(4096),maxInputBytes:z.number().int().min(1024).max(131072),maxOutputBytes:z.number().int().min(1024).max(32768),
 maxStreamBytes:z.number().int().min(1024).max(2097152),deadlineMs:z.number().int().min(1000).max(240000),maxTools:z.literal(0),
 inputMicrousdPerMillionTokens:z.literal(2000000),cachedInputMicrousdPerMillionTokens:z.literal(100000),cacheWriteMicrousdPerMillionTokens:z.literal(2500000),outputMicrousdPerMillionTokens:z.literal(10000000)});
export type LogoDirectionsApiPolicy=z.infer<typeof logoDirectionsApiPolicySchema>;
/** Price guidance is informational. It neither reserves money nor authorizes a
 * second provider call; shared execution authority remains independently bound. */
export const uncappedLogoRasterCapabilitySchema=z.strictObject({
 operation:z.enum(["identity.logo_concept","identity.logo_refine"]),policyIdentity:hash,
 handlerVersion:z.literal("logo-image-v1"),provider:z.literal("openai"),model:z.literal(IMAGE_MODEL),engine:z.null(),
 spendControl:z.literal("uncapped"),estimatedCostMicrousd:moneySchema.nullable(),
});
export type UncappedLogoRasterCapability=z.infer<typeof uncappedLogoRasterCapabilitySchema>;
const ordinal=z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(5)]);
const plannedSlot=z.strictObject({ordinal,type:logoTypeSchema,directionId:identifier});
const typeList=z.array(logoTypeSchema).max(7).refine(unique,"Duplicate logo type");
export const logoConceptPlanSchema=bounded(z.strictObject({version:z.literal(1),targetCount:z.literal(6),requestedTypes:typeList.min(1),slots:z.array(plannedSlot).length(6),coveredTypes:typeList.min(1),uncoveredTypes:typeList}).superRefine((v,ctx)=>{
 const covered=new Set(v.slots.map(s=>s.type));
 if(!unique(v.slots.map(s=>s.ordinal))||!unique(v.slots.map(s=>s.directionId))||v.slots.some(s=>!v.requestedTypes.includes(s.type)))issue(ctx,"Six planned slots require distinct ordinals/directions and requested types");
 if(v.coveredTypes.length!==covered.size||v.coveredTypes.some(t=>!covered.has(t))||v.uncoveredTypes.length!==v.requestedTypes.length-covered.size||v.requestedTypes.some(t=>covered.has(t)===v.uncoveredTypes.includes(t)))issue(ctx,"Coverage must report exactly the actually assigned requested types");
}));
export type LogoConceptPlan=z.infer<typeof logoConceptPlanSchema>;
const state=z.enum(["queued","running","succeeded","failed","cancelled","needs_reconciliation"]);
const observationShape={preview:z.lazy(()=>committedIdentityAssetReceiptSchema).nullable(),providerResponseReceiptId:uuid.nullable(),state,billing:logoBillingObservationSchema,reason:text.min(1).nullable()};
function checkObservation(v:{preview:IdentityAssetReceipt|null;providerResponseReceiptId:string|null;state:string;billing:LogoBillingObservation;reason:string|null},ctx:z.RefinementCtx){
 if(v.preview&&!v.providerResponseReceiptId)issue(ctx,"A verified preview requires retained provider evidence");
 if(v.state==="succeeded"&&(!v.preview||v.billing.status!=="recorded"))issue(ctx,"Success requires committed output and confirmed billing");
 if(v.preview&&v.billing.status==="unknown"&&(v.state!=="needs_reconciliation"||v.reason!=="billing_unknown"))issue(ctx,"Output with unknown billing remains pending reconciliation");
 if(v.state==="needs_reconciliation"&&v.reason===null)issue(ctx,"Reconciliation must preserve its reason");
}
export const logoConceptAttemptSchema=bounded(z.strictObject({id:uuid,jobId:uuid,slotId:uuid,requestKey:uuid,previousAttemptId:uuid.nullable(),attemptNumber:revision,inputHash:hash,reservedCostMicrousd:moneySchema,...observationShape}).superRefine((v,ctx)=>{
 checkObservation(v,ctx);
 if(v.previousAttemptId===v.id||(v.attemptNumber===1)!==(v.previousAttemptId===null))issue(ctx,"Attempts require exact immutable predecessor lineage");
}));
export type LogoConceptAttempt=z.infer<typeof logoConceptAttemptSchema>;
export const logoConceptSlotSchema=bounded(z.strictObject({id:uuid,...plannedSlot.shape,attempts:z.array(logoConceptAttemptSchema).max(100),acceptedPreview:z.lazy(()=>committedIdentityAssetReceiptSchema).nullable()}).superRefine((v,ctx)=>{
 if(!unique(v.attempts.map(a=>a.id))||v.attempts.some((a,i)=>a.slotId!==v.id||a.attemptNumber!==i+1||a.previousAttemptId!==(i===0?null:v.attempts[i-1]!.id)))issue(ctx,"Slot attempts must retain contiguous exact lineage");
 if(v.acceptedPreview&&!v.attempts.some(a=>a.preview&&JSON.stringify(a.preview)===JSON.stringify(v.acceptedPreview)))issue(ctx,"Accepted preview must be an actual retained attempt result");
}),131_072);
export type LogoConceptSlot=z.infer<typeof logoConceptSlotSchema>;
export const logoConceptBatchSchema=bounded(z.strictObject({version:z.literal(2),id:uuid,...scope,requestKey:uuid,briefRevisionId:uuid,referenceSnapshotId:uuid,targetCount:z.literal(6),plan:logoConceptPlanSchema,slots:z.array(logoConceptSlotSchema).length(6),createdAt:timestamp}).superRefine((v,ctx)=>{
 if(!unique(v.slots.map(s=>s.id))||!unique(v.slots.map(s=>s.ordinal)))issue(ctx,"Batch requires six stable unique slots");
 for(const s of v.slots){const planned=v.plan.slots.find(p=>p.ordinal===s.ordinal);if(!planned||s.type!==planned.type||s.directionId!==planned.directionId)issue(ctx,"Batch slots must match the immutable plan");
  if([s.acceptedPreview,...s.attempts.map(a=>a.preview)].some(p=>p&&!sameLogoScope(v,p.reference)))issue(ctx,"Batch previews must be owned");}
}),1_048_576);
export type LogoConceptBatch=z.infer<typeof logoConceptBatchSchema>;
export const logoConceptBatchSummarySchema=z.strictObject({id:uuid,requestKey:uuid,createdAt:timestamp});
export type LogoConceptBatchSummary=z.infer<typeof logoConceptBatchSummarySchema>;
/** Discovery never repeats full batches, provider receipts or private asset URLs. */
export const logoConceptBatchPageSchema=bounded(z.strictObject({...scope,items:z.array(logoConceptBatchSummarySchema).max(50),nextCursor:text.min(1).max(2048).nullable()}).refine(v=>unique(v.items.map(i=>i.id))&&unique(v.items.map(i=>i.requestKey)),"Batch summaries must retain unique immutable batch/request identities"),16_384);
export type LogoConceptBatchPage=z.infer<typeof logoConceptBatchPageSchema>;

export const logoRasterRefinementSchema=bounded(z.strictObject({version:z.literal(2),id:uuid,...scope,requestKey:uuid,jobId:uuid,source:z.union([logoRasterSourceSchema,z.strictObject({kind:z.literal("vector"),vectorRevisionId:uuid})]),logoType:logoTypeSchema,...observationShape,inputRevisions:logoInputRevisionsSchema,createdAt:timestamp}).superRefine((v,ctx)=>{checkObservation(v,ctx);if(v.preview&&!sameLogoScope(v,v.preview.reference))issue(ctx,"Refinement preview must retain ownership");if(v.source.kind==="refinement"&&v.source.rasterRevisionId===v.id)issue(ctx,"A refinement cannot be its own source");}));
export type LogoRasterRefinement=z.infer<typeof logoRasterRefinementSchema>;
export const logoRasterRefinementPageSchema=bounded(z.strictObject({...scope,items:z.array(logoRasterRefinementSchema).max(50),nextCursor:text.min(1).max(2048).nullable()}).refine(v=>v.items.every(r=>sameLogoScope(v,r))&&unique(v.items.map(r=>r.id)),"Refinement page must be uniquely owned"),1_638_400);
export type LogoRasterRefinementPage=z.infer<typeof logoRasterRefinementPageSchema>;
const expected={expected:logoExpectedHeadsSchema};
export const logoQuoteRequestSchema=bounded(z.discriminatedUnion("operation",[
 logoVectorProposalRequestSchema,
 z.strictObject({...expected,operation:z.literal("concepts"),briefRevisionId:uuid,referenceSnapshotId:uuid}),
 z.strictObject({...expected,operation:z.literal("more_concepts"),briefRevisionId:uuid,referenceSnapshotId:uuid}),
 z.strictObject({...expected,operation:z.literal("retry_failed"),sourceBatchId:uuid,failedSlotIds:z.array(uuid).min(1).max(6).refine(unique,"Duplicate failed slot")}),
 z.strictObject({...expected,operation:z.literal("refine_preview"),source:logoRasterSourceSchema,instruction:text.min(1)}),
 z.strictObject({...expected,operation:z.literal("refine_vector"),baseVectorRevisionId:uuid,instruction:text.min(1),locks:logoLocksSchema,traceSettings:logoTraceSettingsSchema}),
 z.strictObject({...expected,operation:z.literal("vectorize"),source:logoRasterSourceSchema,settings:logoTraceSettingsSchema}),
 z.strictObject({...expected,operation:z.literal("directions"),approvedLogoId:uuid}),
 z.strictObject({...expected,operation:z.literal("style_note"),referenceId:uuid}),
]));
export type LogoQuoteRequest=z.infer<typeof logoQuoteRequestSchema>;
export const legacyLogoCostQuoteSchema=bounded(z.strictObject({id:uuid,...scope,request:logoQuoteRequestSchema,inputHash:hash,expected:logoExpectedHeadsSchema,policyIdentity:hash,handlerVersion:identifier,provider:identifier.nullable(),model:identifier.nullable(),engine:z.strictObject({id:identifier,version:identifier,artifactHash:hash,settingsHash:hash}).nullable(),estimatedCostMicrousd:moneySchema,maxCostMicrousd:moneySchema,externalProviderCostMicrousd:moneySchema.nullable(),expiresAt:timestamp,conceptPlan:logoConceptPlanSchema.nullable(),targetSlotIds:z.array(uuid).max(6).refine(unique,"Duplicate quote slot"),billingMode:z.literal("chatgpt_subscription").optional(),policy:logoDirectionsSubscriptionPolicySchema.optional(),textPolicy:legacyLogoVectorProposalTextPolicySchema.optional()}).superRefine((v,ctx)=>{
 if((v.request.operation==="propose_vector_edit")!==(v.textPolicy!==undefined))issue(ctx,"Only a separately priced vector proposal has its complete text policy");
 if(v.textPolicy&&(v.handlerVersion!==v.textPolicy.handlerVersion||v.provider!=="openai"||v.model!==v.textPolicy.model||v.engine!==null||v.billingMode!==undefined||v.policy!==undefined||v.conceptPlan!==null||v.targetSlotIds.length!==0||v.maxCostMicrousd!==v.textPolicy.maximumCostMicrousd||v.externalProviderCostMicrousd!==v.textPolicy.maximumCostMicrousd))issue(ctx,"Vector text quotes require exact independent policy and cost bounds");
 if((v.billingMode===undefined)!==(v.policy===undefined))issue(ctx,"Subscription quotes require the full paired policy");
 if(v.policy&&(v.request.operation!=="directions"||v.handlerVersion!==v.policy.handlerVersion||v.provider!=="openai"||v.model!==v.policy.model||v.engine!==null||v.estimatedCostMicrousd!==0||v.maxCostMicrousd!==0||v.externalProviderCostMicrousd!==0))issue(ctx,"Subscription directions quote must bind the verified zero-API policy");
 if(JSON.stringify(v.expected)!==JSON.stringify(v.request.expected)||v.estimatedCostMicrousd>v.maxCostMicrousd)issue(ctx,"Quote must freeze its exact heads and bounded estimate");
 if(v.request.operation==="vectorize"&&(v.provider!==null||v.model!==null||v.engine===null||v.externalProviderCostMicrousd!==0))issue(ctx,"Local conversion requires exact engine identity and zero external provider cost");
 if((v.provider===null)!==(v.model===null))issue(ctx,"Provider and model must be resolved together");
 if(["concepts","more_concepts"].includes(v.request.operation)&&(!v.conceptPlan||v.targetSlotIds.length!==6))issue(ctx,"A concept quote requires its frozen plan and six assigned slots");
 if(v.request.operation==="retry_failed"&&(v.targetSlotIds.length!==v.request.failedSlotIds.length||v.targetSlotIds.some(id=>v.request.operation==="retry_failed"&&!v.request.failedSlotIds.includes(id))))issue(ctx,"Retry quote must retain only explicitly failed slots");
}));
const uncappedQuoteBasis=z.strictObject({...legacyLogoCostQuoteSchema.shape}).omit({estimatedCostMicrousd:true,maxCostMicrousd:true,externalProviderCostMicrousd:true,billingMode:true,policy:true,textPolicy:true})
 .extend({version:z.literal(3),billingMode:z.literal("openai_api"),spendControl:z.literal("uncapped"),provider:z.literal("openai"),model:z.literal("gpt-6.1-sol"),engine:z.null(),conceptPlan:z.null(),targetSlotIds:z.array(uuid).length(0)});
export const uncappedLogoDirectionsQuoteSchema=uncappedQuoteBasis.extend({handlerVersion:z.literal("logo-directions-api-v1"),apiPolicy:logoDirectionsApiPolicySchema})
 .superRefine((v,ctx)=>{if(v.request.operation!=="directions"||JSON.stringify(v.expected)!==JSON.stringify(v.request.expected))issue(ctx,"Directions quote must freeze exact owned request and policy");});
export const uncappedLogoProposalQuoteSchema=uncappedQuoteBasis.extend({handlerVersion:z.literal("logo-vector-propose-v1"),textPolicy:uncappedLogoVectorProposalTextPolicySchema})
 .superRefine((v,ctx)=>{if(v.request.operation!=="propose_vector_edit"||JSON.stringify(v.expected)!==JSON.stringify(v.request.expected))issue(ctx,"Proposal quote must freeze exact owned request and policy");});
export const uncappedLogoRasterQuoteSchema=z.strictObject({...legacyLogoCostQuoteSchema.shape})
 .omit({maxCostMicrousd:true,externalProviderCostMicrousd:true,billingMode:true,policy:true,textPolicy:true})
 .extend({version:z.literal(3),billingMode:z.literal("openai_api"),spendControl:z.literal("uncapped"),
  handlerVersion:z.literal("logo-image-v1"),provider:z.literal("openai"),model:z.literal(IMAGE_MODEL),engine:z.null(),estimatedCostMicrousd:moneySchema.nullable()})
 .superRefine((v,ctx)=>{
  if(!["concepts","more_concepts","retry_failed","refine_preview"].includes(v.request.operation)
   ||JSON.stringify(v.expected)!==JSON.stringify(v.request.expected))issue(ctx,"Raster quote requires its exact owned request");
  if(["concepts","more_concepts"].includes(v.request.operation)&&(!v.conceptPlan||v.targetSlotIds.length!==6))issue(ctx,"Concept quote requires six assigned slots");
  if(v.request.operation==="retry_failed"&&(!v.conceptPlan||v.targetSlotIds.length!==v.request.failedSlotIds.length||v.targetSlotIds.some(id=>v.request.operation==="retry_failed"&&!v.request.failedSlotIds.includes(id))))issue(ctx,"Retry quote must bind only the requested failed slots");
  if(v.request.operation==="refine_preview"&&(v.conceptPlan!==null||v.targetSlotIds.length!==0))issue(ctx,"Refinement quotes cannot allocate concept slots");
 });
/** A liked upload's style note: one text request under Creative direction's exact
 * price and limits, with its own handler and adapter versions. */
export const logoStyleNoteApiPolicySchema=logoDirectionsApiPolicySchema.extend({handlerVersion:z.literal("logo-style-note-v1"),adapterVersion:z.literal("logo-style-note-openai-v1")});
export type LogoStyleNoteApiPolicy=z.infer<typeof logoStyleNoteApiPolicySchema>;
export const uncappedLogoStyleNoteQuoteSchema=uncappedQuoteBasis.extend({handlerVersion:z.literal("logo-style-note-v1"),apiPolicy:logoStyleNoteApiPolicySchema})
 .superRefine((v,ctx)=>{if(v.request.operation!=="style_note"||JSON.stringify(v.expected)!==JSON.stringify(v.request.expected))issue(ctx,"Style note quote must freeze exact owned request and policy");});
export const logoCostQuoteSchema=bounded(z.union([legacyLogoCostQuoteSchema,uncappedLogoDirectionsQuoteSchema,uncappedLogoProposalQuoteSchema,uncappedLogoRasterQuoteSchema,uncappedLogoStyleNoteQuoteSchema]));
export type LogoCostQuote=z.infer<typeof logoCostQuoteSchema>;
export const logoGenerationIntentSchema=bounded(z.union([z.strictObject({requestKey:uuid,quoteId:uuid,acceptedMaxCostMicrousd:moneySchema,expected:logoExpectedHeadsSchema}),
 z.strictObject({requestKey:uuid,quoteId:uuid,expected:logoExpectedHeadsSchema})]));
export type LogoGenerationIntent=z.infer<typeof logoGenerationIntentSchema>;
export const logoDispatchReceiptSchema=bounded(z.strictObject({...scope,requestKey:uuid,operation:z.union([logoOperationSchema,z.literal("identity.logo_vector_propose"),z.literal("identity.logo_style_note")]),batchId:uuid.nullable(),jobIds:z.array(uuid).min(1).max(6).refine(unique,"Duplicate admitted job"),inputHash:hash}).refine(v=>(v.operation==="identity.logo_concept")===(v.batchId!==null),"Only concept operations have a batch").refine(v=>!["identity.logo_vector_propose","identity.logo_style_note"].includes(v.operation)||v.jobIds.length===1,"A vector proposal or style note must bind exactly one durable job"));
export type LogoDispatchReceipt=z.infer<typeof logoDispatchReceiptSchema>;
export type LogoRequestState={status:"not_found"}|{status:"admitted"|"running"|"partial"|"succeeded"|"failed"|"cancelled"|"needs_reconciliation";requestKey:string;receipt:LogoDispatchReceipt|LogoMutationReceipt|LogoVariantSet|null;outputs:IdentityAssetReceipt[];billing:LogoBillingObservation;reason:string|null;rejection?:LogoExportRejection};
export const logoRequestStateSchema:z.ZodType<LogoRequestState>=bounded(z.discriminatedUnion("status",[
 z.strictObject({status:z.literal("not_found")}),
 z.strictObject({status:z.enum(["admitted","running","partial","succeeded","failed","cancelled","needs_reconciliation"]),requestKey:uuid,receipt:z.union([logoDispatchReceiptSchema,logoMutationReceiptSchema,z.lazy(()=>logoVariantSetSchema)]).nullable(),outputs:z.array(z.lazy(()=>committedIdentityAssetReceiptSchema)).max(100),billing:logoBillingObservationSchema,reason:text.min(1).nullable(),rejection:z.lazy(()=>logoExportRejectionSchema).optional()}).superRefine((v,ctx)=>{
  if(v.rejection&&(v.status!=="failed"||v.reason!=="admission_rejected"||v.receipt!==null||v.outputs.length!==0||v.billing.status!=="recorded"||v.billing.confirmedMicrousd!==0||v.rejection.requestKey!==v.requestKey))issue(ctx,"Export rejection requires exact failed empty zero-cost state");
  if(v.status==="succeeded"&&v.receipt===null)issue(ctx,"Successful recovery requires its durable receipt");
  if(v.receipt&&"requestKey" in v.receipt&&v.receipt.requestKey!==v.requestKey)issue(ctx,"Recovery receipt must bind the original request key");
  if(v.receipt&&v.outputs.some(o=>!sameLogoScope(v.receipt!,o.reference)))issue(ctx,"Recovered outputs must belong to the receipt owner/project");
  if(v.status==="needs_reconciliation"&&v.reason===null)issue(ctx,"Uncertain requests retain their reason");
  if(v.outputs.length&&v.billing.status==="unknown"&&(v.status!=="needs_reconciliation"||v.reason!=="billing_unknown"))issue(ctx,"Verified output does not settle unknown billing");
 }),
]),262_144);
const jobBasis={version:z.literal(2),...scope,requestKey:uuid,quoteId:uuid,policyIdentity:hash,handlerVersion:identifier,inputHash:hash};
export const logoJobBasisSchema=bounded(z.strictObject(jobBasis));
export type LogoJobBasis=z.infer<typeof logoJobBasisSchema>;
const logoConceptInputFields=z.strictObject({...jobBasis,operation:z.literal("identity.logo_concept"),batchId:uuid,slotId:uuid,attemptId:uuid,attemptNumber:revision,previousAttemptId:uuid.nullable(),directionId:identifier,plan:logoConceptPlanSchema,ordinal,briefRevisionId:uuid,referenceSnapshotId:uuid,references:z.array(logoAssetReferenceSchema).max(100)});
const checkConceptInput=(v:z.infer<typeof logoConceptInputFields> | (Omit<z.infer<typeof logoConceptInputFields>,"version"> & {version:3}),ctx:z.RefinementCtx)=>{
 if(v.references.some(r=>!sameLogoScope(v,r))||!v.plan.slots.some(s=>s.ordinal===v.ordinal&&s.directionId===v.directionId)||(v.attemptNumber===1)!==(v.previousAttemptId===null)||v.attemptId===v.previousAttemptId)issue(ctx,"Concept job must bind the owned plan, references and lineage");
};
export const logoConceptJobInputSchema=bounded(z.union([logoConceptInputFields.superRefine(checkConceptInput),logoConceptInputFields.extend({version:z.literal(3),billingMode:z.literal("openai_api"),spendControl:z.literal("uncapped")}).superRefine(checkConceptInput)]));
export type LogoConceptJobInput=z.infer<typeof logoConceptJobInputSchema>;
const legacyLogoRefinementJobInputSchema=z.strictObject({...jobBasis,operation:z.literal("identity.logo_refine"),rasterRevisionId:uuid,instruction:text.min(1),briefRevisionId:uuid,referenceSnapshotId:uuid,source:z.discriminatedUnion("kind",[
 z.strictObject({kind:z.literal("preview"),raster:logoRasterSourceSchema}),
 z.strictObject({kind:z.literal("vector"),vectorRevisionId:uuid,documentHash:hash,logoType:logoTypeSchema,locks:logoLocksSchema,traceSettings:logoTraceSettingsSchema}),
])});
export const logoRefinementJobInputSchema=bounded(z.union([legacyLogoRefinementJobInputSchema,legacyLogoRefinementJobInputSchema.extend({version:z.literal(3),billingMode:z.literal("openai_api"),spendControl:z.literal("uncapped"),source:z.strictObject({kind:z.literal("preview"),raster:logoRasterSourceSchema})})]));
export type LogoRefinementJobInput=z.infer<typeof logoRefinementJobInputSchema>;
export const logoVectorizeJobInputSchema=bounded(z.strictObject({...jobBasis,operation:z.literal("identity.logo_vectorize"),source:logoRasterSourceSchema,settings:logoTraceSettingsSchema,engine:z.strictObject({id:identifier,version:identifier,artifactHash:hash})}));
export type LogoVectorizeJobInput=z.infer<typeof logoVectorizeJobInputSchema>;
const legacyLogoDirectionsJobInputSchema=z.strictObject({...jobBasis,operation:z.literal("identity.logo_directions"),approvedLogoId:uuid,briefRevisionId:uuid,referenceSnapshotId:uuid,fontVersionIds:z.array(uuid).max(100).refine(unique,"Duplicate font"),targetCount:z.literal(3),billingMode:z.literal("chatgpt_subscription").optional(),policy:logoDirectionsSubscriptionPolicySchema.optional()}).superRefine((v,ctx)=>{
 if((v.billingMode===undefined)!==(v.policy===undefined)||v.policy&&v.handlerVersion!==v.policy.handlerVersion)issue(ctx,"Subscription jobs require their exact paired frozen directions policy");
});
export const logoDirectionsApiJobInputSchema=bounded(z.strictObject({...jobBasis,version:z.literal(3),operation:z.literal("identity.logo_directions"),handlerVersion:z.literal("logo-directions-api-v1"),
 approvedLogoId:uuid,briefRevisionId:uuid,referenceSnapshotId:uuid,fontVersionIds:z.array(uuid).min(1).max(100).refine(unique,"Duplicate font"),targetCount:z.literal(3),
 billingMode:z.literal("openai_api"),spendControl:z.literal("uncapped"),apiPolicy:logoDirectionsApiPolicySchema,policy:z.never().optional()}));
export const logoDirectionsJobInputSchema=bounded(z.union([legacyLogoDirectionsJobInputSchema.safeExtend({apiPolicy:z.never().optional(),spendControl:z.never().optional()}),logoDirectionsApiJobInputSchema]));
export type LogoDirectionsJobInput=z.infer<typeof logoDirectionsJobInputSchema>;
export const logoExportJobInputSchema=bounded(z.strictObject({...z.strictObject(jobBasis).omit({quoteId:true}).shape,operation:z.literal("identity.logo_export"),approvedLogoId:uuid,directionApprovalId:uuid,variantSetId:uuid,variantReviewId:uuid,sourceSnapshotHash:hash}));
export type LogoExportJobInput=z.infer<typeof logoExportJobInputSchema>;
// Server-resolved inputs compose independently bounded immutable records and exact publication lineage.
// Wrappers have no free text; 128 bytes covers their JSONB keys/separators.
export const LOGO_RESOLVED_CONCEPT_INPUT_MAX_BYTES=3*LOGO_MUTATION_MAX_BYTES+LOGO_REFERENCE_SNAPSHOT_MAX_BYTES+128;
// The additional fixed asset reference and its wrapper fit within 512 bytes.
export const LOGO_RESOLVED_REFINEMENT_INPUT_MAX_BYTES=LOGO_RESOLVED_CONCEPT_INPUT_MAX_BYTES+512;
// Geometry, approval, brief, frozen inputs, 100 bounded font records, references and wrappers.
export const LOGO_RESOLVED_DIRECTION_INPUT_MAX_BYTES=LOGO_GEOMETRY_MAX_BYTES+103*LOGO_MUTATION_MAX_BYTES+LOGO_REFERENCE_SNAPSHOT_MAX_BYTES+VISUAL_DIRECTION_MAX_BYTES+1024;
export const logoResolvedConceptInputSchema=bounded(z.strictObject({inputRevisions:logoInputRevisionsSchema,input:logoConceptJobInputSchema,brief:logoBriefRevisionSchema,referenceSnapshot:logoReferenceSnapshotSchema}).refine(v=>sameLogoScope(v.input,v.brief)&&sameLogoScope(v.input,v.referenceSnapshot)&&v.input.briefRevisionId===v.brief.id&&v.input.referenceSnapshotId===v.referenceSnapshot.id&&v.brief.payload.referenceSnapshotId===v.referenceSnapshot.id&&v.inputRevisions.length===1&&v.inputRevisions[0]!.stage==="brief_references"&&v.inputRevisions[0]!.id===v.brief.id&&v.inputRevisions[0]!.revision===v.brief.revision&&JSON.stringify(v.input.references)===JSON.stringify(v.referenceSnapshot.references.map(s=>s.asset)),"Resolved concept sources must match exact owned input IDs"),LOGO_RESOLVED_CONCEPT_INPUT_MAX_BYTES);
export type LogoResolvedConceptInput=z.infer<typeof logoResolvedConceptInputSchema>;
export const logoResolvedRefinementInputSchema=bounded(z.strictObject({inputRevisions:logoInputRevisionsSchema,input:logoRefinementJobInputSchema,brief:logoBriefRevisionSchema,referenceSnapshot:logoReferenceSnapshotSchema,basePreview:logoAssetReferenceSchema}).refine(v=>[v.brief,v.referenceSnapshot,v.basePreview].every(r=>sameLogoScope(v.input,r))&&v.input.briefRevisionId===v.brief.id&&v.input.referenceSnapshotId===v.referenceSnapshot.id&&v.brief.payload.referenceSnapshotId===v.referenceSnapshot.id&&v.inputRevisions.some(r=>r.stage==="brief_references"&&r.id===v.brief.id&&r.revision===v.brief.revision),"Resolved refinement sources must match exact owned input IDs"),LOGO_RESOLVED_REFINEMENT_INPUT_MAX_BYTES);
export type LogoResolvedRefinementInput=z.infer<typeof logoResolvedRefinementInputSchema>;
export const logoConceptStepOutputSchema=bounded(z.strictObject({version:z.literal(2),kind:z.literal("logo_concept"),batchId:uuid,slotId:uuid,attemptId:uuid,publicationId:uuid,providerResponseReceiptId:uuid}));
export type LogoConceptStepOutput=z.infer<typeof logoConceptStepOutputSchema>;
export const logoRefinementStepOutputSchema=bounded(z.discriminatedUnion("kind",[z.strictObject({version:z.literal(2),kind:z.literal("logo_refinement_raster"),rasterRevisionId:uuid,publicationId:uuid,providerResponseReceiptId:uuid}),z.strictObject({version:z.literal(2),kind:z.literal("logo_refinement_vector"),publicationId:uuid,sourceStepKey:z.literal("generate-refinement")})]));
export type LogoRefinementStepOutput=z.infer<typeof logoRefinementStepOutputSchema>;
export const logoVectorStepOutputSchema=bounded(z.strictObject({version:z.literal(2),kind:z.literal("logo_vector"),publicationId:uuid}));
export type LogoVectorStepOutput=z.infer<typeof logoVectorStepOutputSchema>;
export const logoDirectionStepOutputSchema=bounded(z.strictObject({version:z.literal(2),kind:z.literal("logo_directions"),publicationId:uuid,providerResponseReceiptId:uuid}));
export type LogoDirectionStepOutput=z.infer<typeof logoDirectionStepOutputSchema>;
export const logoExportStepOutputSchema=bounded(z.strictObject({version:z.literal(2),kind:z.literal("logo_export"),publicationId:uuid}));
export type LogoExportStepOutput=z.infer<typeof logoExportStepOutputSchema>;
/** Verified files retained after a known local render/pack failure. Never a ready pack. */
export const logoExportPartialStepOutputSchema=bounded(z.strictObject({version:z.literal(2),kind:z.literal("logo_export_partial"),publicationId:uuid}));
export type LogoExportPartialStepOutput=z.infer<typeof logoExportPartialStepOutputSchema>;
const legacyProviderObservationShape={provider:identifier,model:identifier,providerRequestId:text.min(1).max(200).nullable(),responseHash:hash.nullable(),observedAt:timestamp,billing:logoBillingObservationSchema,artifactHash:hash.nullable(),normalizedPixelHash:hash.optional()};
const legacyProviderObservationSchema=z.strictObject(legacyProviderObservationShape);
const subscriptionProviderObservationShape={provider:z.literal("openai"),model:identifier.max(150),providerRequestId:text.min(1).max(200).nullable(),responseHash:hash.nullable(),observedAt:timestamp,billing:z.discriminatedUnion("status",[z.strictObject({status:z.literal("unknown"),confirmedMicrousd:z.null()}),z.strictObject({status:z.literal("recorded"),confirmedMicrousd:z.literal(0)})]),artifactHash:z.null(),version:z.literal(2),billingMode:z.literal("chatgpt_subscription"),registrationId:localRegistrationIdSchema,responseId:z.string().regex(/^resp_[a-zA-Z0-9_-]+$/).max(200).nullable(),usage:subscriptionUsageSchema.nullable()};
const apiDirectionsObservationShape={...legacyProviderObservationShape,provider:z.literal("openai"),artifactHash:z.null(),normalizedPixelHash:z.never().optional(),version:z.literal(3),kind:z.literal("logo_directions_text"),
 billingMode:z.literal("openai_api"),spendControl:z.literal("uncapped"),apiPolicy:logoDirectionsApiPolicySchema,responseId:z.string().regex(/^resp_[a-zA-Z0-9_-]+$/).max(200).nullable(),
 usage:logoVectorProposalUsageSchema.nullable(),serviceTier:z.string().min(1).max(100).nullable(),toolCalls:moneySchema.nullable(),responseComplete:z.boolean()};
export const logoDirectionsApiObservationSchema=z.strictObject(apiDirectionsObservationShape).superRefine((o,ctx)=>{
 if(o.billing.status==="recorded"&&(!o.usage||o.toolCalls!==0||o.model!==o.apiPolicy.model||o.serviceTier!==o.apiPolicy.serviceTier||o.billing.confirmedMicrousd!==logoVectorProposalUsageCost(o.usage)))issue(ctx,"Recorded API directions usage requires exact model, tier, tools and calculated price");
});
export const logoProviderObservationSchema=bounded(z.union([legacyProviderObservationSchema,z.strictObject(subscriptionProviderObservationShape),logoDirectionsApiObservationSchema]));
export type LogoProviderObservation=z.infer<typeof logoProviderObservationSchema>;
const providerReceiptShape={id:uuid,...scope,jobId:uuid,leaseToken:uuid};
export const logoProviderResponseReceiptSchema=bounded(z.union([z.strictObject({...legacyProviderObservationShape,...providerReceiptShape}),z.strictObject({...subscriptionProviderObservationShape,...providerReceiptShape}),logoDirectionsApiObservationSchema.safeExtend(providerReceiptShape)]));
export type LogoProviderResponseReceipt=z.infer<typeof logoProviderResponseReceiptSchema>;
/** One liked upload's style-note job, frozen at admission. */
export const logoStyleNoteJobInputSchema=bounded(z.strictObject({...jobBasis,version:z.literal(3),operation:z.literal("identity.logo_style_note"),handlerVersion:z.literal("logo-style-note-v1"),
 referenceId:uuid,asset:logoAssetReferenceSchema,noteVersion:z.literal("logo-style-note-v1"),billingMode:z.literal("openai_api"),spendControl:z.literal("uncapped"),apiPolicy:logoStyleNoteApiPolicySchema}));
export type LogoStyleNoteJobInput=z.infer<typeof logoStyleNoteJobInputSchema>;
export const logoStyleNoteObservationSchema=z.strictObject({...apiDirectionsObservationShape,kind:z.literal("logo_style_note_text"),apiPolicy:logoStyleNoteApiPolicySchema}).superRefine((o,ctx)=>{
 if(o.billing.status==="recorded"&&(!o.usage||o.toolCalls!==0||o.model!==o.apiPolicy.model||o.serviceTier!==o.apiPolicy.serviceTier||o.billing.confirmedMicrousd!==logoVectorProposalUsageCost(o.usage)))issue(ctx,"Recorded style note usage requires exact model, tier, tools and calculated price");
});
export type LogoStyleNoteObservation=z.infer<typeof logoStyleNoteObservationSchema>;
export const logoStyleNoteResponseReceiptSchema=bounded(logoStyleNoteObservationSchema.safeExtend(providerReceiptShape));
export const logoStyleNoteStagedSchema=bounded(z.strictObject({version:z.literal(1),kind:z.literal("logo_style_note_staged"),noteId:uuid,providerResponseReceiptId:uuid}));
export const logoStyleNoteStepOutputSchema=bounded(z.strictObject({version:z.literal(1),kind:z.literal("logo_style_note"),noteId:uuid,providerResponseReceiptId:uuid}));
/** Subscription completion can use the actual response ID without fabricating an HTTP header ID. */
export function logoProviderHasResponseIdentity(observation:LogoProviderObservation):boolean{return observation.responseHash!==null&&("version" in observation ? observation.responseId!==null : observation.providerRequestId!==null);}
export const logoDirectionPublicationReceiptSchema=bounded(z.strictObject({id:uuid,...scope,jobId:uuid,inputHash:hash,directionIds:z.tuple([uuid,uuid,uuid]).refine(unique,"Directions must be unique"),publicationState:z.literal("staged")}));
export type LogoDirectionPublicationReceipt=z.infer<typeof logoDirectionPublicationReceiptSchema>;
export const logoExportPublicationReceiptSchema=bounded(z.strictObject({id:uuid,...scope,jobId:uuid,sourceSnapshotHash:hash,assetReceiptIds:z.array(uuid).min(1).max(100).refine(unique,"Duplicate staged asset"),publicationState:z.literal("staged")}));
export type LogoExportPublicationReceipt=z.infer<typeof logoExportPublicationReceiptSchema>;
export const logoResolvedDirectionInputSchema=bounded(z.strictObject({inputRevisions:logoInputRevisionsSchema,approvedLogo:logoApprovalSchema,logo:logoVectorDocumentSchema,brief:logoBriefRevisionSchema,references:logoReferenceSnapshotSchema,permittedFonts:z.array(fontRecordSchema).max(100),targetCount:z.literal(3),reviewedVisualDirection:reviewedVisualDirectionSchema.optional()}).refine(v=>sameLogoScope(v.approvedLogo,v.brief)&&sameLogoScope(v.approvedLogo,v.references)&&v.permittedFonts.every(f=>sameLogoScope(v.approvedLogo,f.asset))&&(!v.reviewedVisualDirection||sameLogoScope(v.approvedLogo,v.reviewedVisualDirection)),"Direction inputs must be owned"),LOGO_RESOLVED_DIRECTION_INPUT_MAX_BYTES);
export type LogoResolvedDirectionInput=z.infer<typeof logoResolvedDirectionInputSchema>;
