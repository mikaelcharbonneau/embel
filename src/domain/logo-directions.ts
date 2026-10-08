import { z } from "zod";
import { logoUuidSchema as uuid,logoHashSchema as hash,logoStringSchema as text,logoTimestampSchema as timestamp,logoIdentifierSchema as key,logoScopeShape as scope,logoAssetReferenceSchema,logoInputRevisionsSchema,logoApprovalSchema,boundedLogoJson as bounded,uniqueLogoValues as unique,sameLogoScope,logoIssue as issue } from "./logo-vector";

export const fontPurposeSchema=z.enum(["render","outline","embed","modify","redistribute"]);
export type FontPurpose=z.infer<typeof fontPurposeSchema>;
export const fontPermissionSchema=z.enum(["allowed","denied","unknown"]);
export type FontPermission=z.infer<typeof fontPermissionSchema>;
const sourceUrl=z.string().max(2048).refine(v=>{try{const u=new URL(v);return ["https:","http:"].includes(u.protocol)&&!!u.hostname&&!u.username&&!u.password;}catch{return false;}},"Use a credential-free source URL");
export const fontRightsEvidenceSchema=bounded(z.strictObject({id:uuid,fontContentHash:hash,sourceKind:z.enum(["reviewed_license","user_declaration"]),sourceUrl:sourceUrl.nullable(),licenseTextHash:hash,permissions:z.record(fontPurposeSchema,fontPermissionSchema),commercialUse:fontPermissionSchema,reviewedAt:timestamp.nullable()}).refine(v=>v.sourceKind==="reviewed_license"?v.sourceUrl!==null&&v.reviewedAt!==null:v.reviewedAt===null,"Reviewed licenses require a source and review; declarations stay declarations"));
export type FontRightsEvidence=z.infer<typeof fontRightsEvidenceSchema>;
export const fontRecordSchema=bounded(z.strictObject({id:uuid,asset:logoAssetReferenceSchema,family:text.min(1).max(200),source:z.enum(["free_catalog","user_upload"]),rights:fontRightsEvidenceSchema}).refine(v=>v.asset.contentHash===v.rights.fontContentHash&&(v.source!=="free_catalog"||(v.rights.sourceKind==="reviewed_license"&&v.rights.commercialUse==="allowed")),"Font rights must bind exact bytes and catalog permission"));
export type FontRecord=z.infer<typeof fontRecordSchema>;
/** Server-resolved bytes, never a browser proof or a persisted JSON record. */
export type PermittedFont={record:FontRecord;bytes:Uint8Array;contentHash:string;purpose:FontPurpose};
export const colorSpecificationSchema=bounded(z.strictObject({
 hex:z.string().regex(/^#[0-9A-F]{6}$/),rgb:z.tuple([z.number().int().min(0).max(255),z.number().int().min(0).max(255),z.number().int().min(0).max(255)]),
 cmyk:z.discriminatedUnion("status",[
  z.strictObject({status:z.literal("unavailable"),reason:z.literal("profile_unavailable")}),
  z.strictObject({status:z.literal("converted"),channels:z.tuple([z.number().min(0).max(100),z.number().min(0).max(100),z.number().min(0).max(100),z.number().min(0).max(100)]),profileId:key,profileHash:hash,conversionVersion:key,limitations:z.array(text.min(1)).min(1).max(20)}),
 ]),
 pantone:z.discriminatedUnion("status",[
  z.strictObject({status:z.literal("unavailable"),reason:z.literal("licensed_source_unavailable")}),
  z.strictObject({status:z.literal("approximate"),reference:text.min(1).max(200),sourceId:key,sourceHash:hash,limitations:z.array(text.min(1)).min(1).max(20)}),
 ]),
}).refine(v=>v.hex==="#"+v.rgb.map(n=>n.toString(16).padStart(2,"0").toUpperCase()).join(""),"RGB and HEX must describe the same color"));
export type ColorSpecification=z.infer<typeof colorSpecificationSchema>;
export const identityDirectionBasisSchema=z.strictObject({id:uuid,...scope,approvedLogoId:uuid,inputRevisions:logoInputRevisionsSchema});
export type IdentityDirectionBasis=z.infer<typeof identityDirectionBasisSchema>;
const basis=identityDirectionBasisSchema.shape;
const role=z.enum(["heading","body","accent"]);
export const identityPaletteVersionSchema=bounded(z.strictObject({...basis,swatches:z.array(z.strictObject({key,name:text.min(1).max(200),color:colorSpecificationSchema})).min(1).max(32),pairings:z.array(z.strictObject({foregroundKey:key,backgroundKey:key,role})).max(100)}).refine(v=>unique(v.swatches.map(s=>s.key))&&v.pairings.every(p=>v.swatches.some(s=>s.key===p.foregroundKey)&&v.swatches.some(s=>s.key===p.backgroundKey)),"Palette pairs must name unique declared swatches"));
export type IdentityPaletteVersion=z.infer<typeof identityPaletteVersionSchema>;
export const identityTypographyVersionSchema=bounded(z.strictObject({...basis,styles:z.array(z.strictObject({key,role,sampleText:text.min(1).max(2000),fontVersionId:uuid,weight:z.number().int().min(1).max(1000),style:z.enum(["normal","italic"]),sizePx:z.number().positive().max(16_384),lineHeight:z.number().positive().max(100)})).min(1).max(32)}).refine(v=>unique(v.styles.map(s=>s.key)),"Typography style keys must be unique"));
export type IdentityTypographyVersion=z.infer<typeof identityTypographyVersionSchema>;
const positive=z.number().positive().max(16_384),coordinate=z.number().min(-1_000_000).max(1_000_000);
export const identityGraphicSpecSchema=z.discriminatedUnion("kind",[
 z.strictObject({kind:z.literal("dots"),paletteKey:key,radius:positive,spacing:positive}),
 z.strictObject({kind:z.literal("stripes"),paletteKey:key,width:positive,spacing:positive,rotation:z.number().min(-180).max(180)}),
 z.strictObject({kind:z.literal("shape"),shape:z.enum(["circle","rectangle","triangle"]),paletteKey:key,x:coordinate,y:coordinate,width:positive,height:positive}),
]);
export type IdentityGraphicSpec=z.infer<typeof identityGraphicSpecSchema>;
export const identityGraphicsVersionSchema=bounded(z.strictObject({...basis,elements:z.array(identityGraphicSpecSchema).max(100)}));
export type IdentityGraphicsVersion=z.infer<typeof identityGraphicsVersionSchema>;
export const identityDirectionVersionSchema=bounded(z.strictObject({...basis,name:text.min(1).max(200),paletteVersionId:uuid,typographyVersionId:uuid,graphicsVersionId:uuid}));
export type IdentityDirectionVersion=z.infer<typeof identityDirectionVersionSchema>;
export const identityDirectionProductionResultSchema=bounded(z.strictObject({
 directions:z.tuple([identityDirectionVersionSchema,identityDirectionVersionSchema,identityDirectionVersionSchema]),
 palettes:z.tuple([identityPaletteVersionSchema,identityPaletteVersionSchema,identityPaletteVersionSchema]),
 typography:z.tuple([identityTypographyVersionSchema,identityTypographyVersionSchema,identityTypographyVersionSchema]),
 graphics:z.tuple([identityGraphicsVersionSchema,identityGraphicsVersionSchema,identityGraphicsVersionSchema]),
}).superRefine((v,ctx)=>{
 const all=[...v.directions,...v.palettes,...v.typography,...v.graphics],first=v.directions[0];
 if(!unique(all.map(i=>i.id))||all.some(i=>!sameLogoScope(first,i)||i.approvedLogoId!==first.approvedLogoId||JSON.stringify(i.inputRevisions)!==JSON.stringify(first.inputRevisions)))issue(ctx,"All direction components require unique IDs and one owned approved-logo basis");
 for(const d of v.directions){
  const palette=v.palettes.find(p=>p.id===d.paletteVersionId),typography=v.typography.find(p=>p.id===d.typographyVersionId),graphics=v.graphics.find(p=>p.id===d.graphicsVersionId);
  if(!palette||!typography||!graphics||graphics.elements.some(e=>!palette.swatches.some(s=>s.key===e.paletteKey)))issue(ctx,"Each direction must resolve complete declared components and palette roles");
 }
 for(const field of ["paletteVersionId","typographyVersionId","graphicsVersionId"] as const)if(!unique(v.directions.map(d=>d[field])))issue(ctx,"Initial directions require three distinct complete component sets");
}),393_216);
export type IdentityDirectionProductionResult=z.infer<typeof identityDirectionProductionResultSchema>;
/** Task 2 inventory alias: identical wire shape, no separate persisted batch DTO. */
export const logoDirectionBatchSchema=identityDirectionProductionResultSchema;
export const identityConsistencyResultSchema=bounded(z.strictObject({hash,status:z.enum(["pass","warning","blocked"]),checks:z.array(z.strictObject({id:key,code:z.enum(["text_contrast","missing_glyphs","font_permission","unknown_palette_role","foreign_logo_basis","unsupported_graphic","font_check_unavailable"]),role:text.max(200).nullable(),status:z.enum(["pass","warning","blocked"]),message:text.min(1)})).max(100),warnings:z.array(text.min(1)).max(100),blockingReasons:z.array(text.min(1)).max(100)}).refine(v=>unique(v.checks.map(c=>c.id)),"Consistency check IDs must be unique").refine(v=>v.status===(v.blockingReasons.length||v.checks.some(c=>c.status==="blocked")?"blocked":v.warnings.length||v.checks.some(c=>c.status==="warning")?"warning":"pass"),"Consistency status must reflect all retained checks and reasons"));
export type IdentityConsistencyResult=z.infer<typeof identityConsistencyResultSchema>;
export const identityDirectionSelectionSchema=bounded(z.strictObject({...basis,paletteVersionId:uuid,typographyVersionId:uuid,graphicsVersionId:uuid,sourceDirectionIds:z.array(uuid).min(1).max(3).refine(unique,"Duplicate source direction"),consistency:identityConsistencyResultSchema}),65_536);
export type IdentityDirectionSelection=z.infer<typeof identityDirectionSelectionSchema>;
export const identityDirectionApprovalSchema=bounded(z.strictObject({id:uuid,...scope,directionSelectionId:uuid,approvedLogoId:uuid,consistencyHash:hash,approvedAt:timestamp}));
export type IdentityDirectionApproval=z.infer<typeof identityDirectionApprovalSchema>;
export const fontTextCheckSchema=bounded(z.strictObject({typographyVersionId:uuid,styleKey:key,sampleHash:hash,styleHash:hash,role:text.min(1).max(200),fontVersionId:uuid,fontContentHash:hash,missingCodePoints:z.array(z.number().int().min(0).max(0x10ffff).refine(v=>v<0xd800||v>0xdfff,"Use Unicode scalar values")).max(200).refine(unique,"Duplicate missing code point"),styleSupported:z.boolean()}));
export type FontTextCheck=z.infer<typeof fontTextCheckSchema>;
export const identityDirectionsOverviewSchema=bounded(z.strictObject({...scope,currentApprovedLogo:logoApprovalSchema.nullable(),directions:z.array(identityDirectionVersionSchema).max(50),palettes:z.array(identityPaletteVersionSchema).max(50),typography:z.array(identityTypographyVersionSchema).max(50),graphics:z.array(identityGraphicsVersionSchema).max(50),fonts:z.array(fontRecordSchema).max(100),fontChecks:z.array(fontTextCheckSchema).max(100),selection:identityDirectionSelectionSchema.nullable(),approval:identityDirectionApprovalSchema.nullable(),stale:z.boolean(),nextCursor:z.string().min(1).max(2048).nullable()}).superRefine((v,ctx)=>{
 const rows=[...v.directions,...v.palettes,...v.typography,...v.graphics,...(v.currentApprovedLogo?[v.currentApprovedLogo]:[]),...(v.selection?[v.selection]:[]),...(v.approval?[v.approval]:[])];
 if(rows.some(r=>!sameLogoScope(v,r))||v.fonts.some(f=>!sameLogoScope(v,f.asset)))issue(ctx,"Direction overview must contain owned records");
 if(v.approval&&(!v.selection||v.approval.directionSelectionId!==v.selection.id||v.approval.consistencyHash!==v.selection.consistency.hash||v.approval.approvedLogoId!==v.selection.approvedLogoId))issue(ctx,"Approval must bind exact selection and consistency");
}),8_388_608);
export type IdentityDirectionsOverview=z.infer<typeof identityDirectionsOverviewSchema>;
