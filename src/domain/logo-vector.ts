import { z } from "zod";
import { assetVersionReferenceSchema } from "./asset-library";

// Passive wire validation only. P3 must still inspect geometry, visible ink,
// transformed bounds, actual file bytes, shaping and all lock digests.
export const LOGO_MUTATION_MAX_BYTES = 32_768;
export const LOGO_GEOMETRY_MAX_BYTES = 8_388_608;
// Stored source records carry up to 64 complete six-digest locks plus 100 inputs.
// Their allowance does not enlarge commands or the joint vector-detail ceiling.
export const LOGO_VECTOR_REVISION_MAX_BYTES = 65_536;
export const LOGO_VECTOR_MAX_PATHS = 20_000;
export const LOGO_VECTOR_MAX_COMMANDS = 200_000;
export const LOGO_VECTOR_MAX_COMPONENTS = 64;
export const logoUuidSchema = z.uuid().refine(value => value === value.toLowerCase(), "Use a canonical lowercase UUID");
export const logoHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const logoCounterSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const logoRevisionSchema = logoCounterSchema.min(1);
export const logoTimestampSchema = z.iso.datetime({ offset: true }).max(64);
export const logoIdentifierSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const logoStringSchema = z.string().max(4000).refine(value => [...value].every(character => {
  const point = character.codePointAt(0)!;
  return point !== 0 && (point < 0xd800 || point > 0xdfff);
}), "Strings must be representable as JSONB");
export const logoScopeShape = { ownerId: logoUuidSchema, projectId: logoUuidSchema };
export const sameLogoScope = (a: {ownerId:string;projectId:string}, b: {ownerId:string;projectId:string}) => a.ownerId === b.ownerId && a.projectId === b.projectId;
export const logoIssue = (ctx: z.RefinementCtx, message: string) => ctx.addIssue({code:"custom",message});
export function uniqueLogoValues<T>(values: readonly T[]): boolean { return new Set(values).size === values.length; }

const encoder = new TextEncoder();
/** Counts PostgreSQL JSONB spacing and expanded exponents, also rejecting NUL/surrogates. */
export function logoJsonBytes(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "string") {
    for (const character of value) { const point=character.codePointAt(0)!; if(point===0 || (point>=0xd800 && point<=0xdfff)) throw new Error("Unrepresentable JSONB string"); }
    return encoder.encode(JSON.stringify(value)).byteLength;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const text=JSON.stringify(value), [mantissa,exponent]=text.split("e");
    if(exponent===undefined) return text.length;
    const unsigned=mantissa!.replace("-",""), digits=unsigned.replace(".","");
    const point=(unsigned.includes(".")?unsigned.indexOf("."):unsigned.length)+Number(exponent);
    return (text.startsWith("-")?1:0)+(point<=0?2-point+digits.length:point>=digits.length?point:digits.length+1);
  }
  if(Array.isArray(value)) return 2+Math.max(0,value.length-1)*2+value.reduce((n,child:unknown)=>n+logoJsonBytes(child),0);
  if(value && typeof value==="object" && Object.getPrototypeOf(value)===Object.prototype) {
    const entries=Object.entries(value);
    return 2+Math.max(0,entries.length-1)*2+entries.reduce((n,[key,child])=>n+logoJsonBytes(key)+2+logoJsonBytes(child),0);
  }
  throw new Error("Only JSONB values are allowed");
}
export function freezeLogoRecord<T>(value: T): T {
  if(value && typeof value==="object" && !ArrayBuffer.isView(value)) {
    for(const child of Object.values(value)) freezeLogoRecord(child);
    Object.freeze(value);
  }
  return value;
}
/** Does not authenticate a record: server readers must resolve its owned immutable sources. */
export function boundedLogoJson<T extends z.ZodType>(schema: T, maxBytes=LOGO_MUTATION_MAX_BYTES): T {
  return schema.superRefine((value,ctx)=>{
    try { if(logoJsonBytes(value)>maxBytes) logoIssue(ctx,"Serialized JSON exceeds the byte ceiling"); }
    catch { logoIssue(ctx,"Record is not representable as PostgreSQL JSONB"); }
    freezeLogoRecord(value);
  });
}
export const logoAssetReferenceSchema = assetVersionReferenceSchema.extend({ ...logoScopeShape, assetId:logoUuidSchema,versionId:logoUuidSchema });
export const logoStageSchema = z.enum(["brief_references","concepts","vector","refinements","directions","deliverables"]);
export type LogoStage = z.infer<typeof logoStageSchema>;
export const logoTypeSchema = z.enum(["wordmark","lettermark_monogram","pictorial","abstract","combination","emblem","mascot"]);
export type LogoType = z.infer<typeof logoTypeSchema>;
export const logoRevisionRefSchema = z.strictObject({stage:logoStageSchema,id:logoUuidSchema,revision:logoRevisionSchema});
export type LogoRevisionRef = z.infer<typeof logoRevisionRefSchema>;
export const logoInputRevisionsSchema = z.array(logoRevisionRefSchema).max(100).refine(values=>uniqueLogoValues(values.map(v=>v.id)),"Duplicate immutable input revision");
export const logoConceptSourceSchema = z.strictObject({kind:z.literal("concept"),batchId:logoUuidSchema,slotId:logoUuidSchema,attemptId:logoUuidSchema});
export type LogoConceptSource = z.infer<typeof logoConceptSourceSchema>;
export const logoRasterSourceSchema = z.discriminatedUnion("kind",[logoConceptSourceSchema,z.strictObject({kind:z.literal("refinement"),rasterRevisionId:logoUuidSchema})]);
export type LogoRasterSource = z.infer<typeof logoRasterSourceSchema>;

const coordinate=z.number().min(-1_000_000).max(1_000_000);
const dimension=z.number().positive().max(16_384);
const scale=z.number().min(0.01).max(100);
const rotation=z.number().min(-180).max(180);
const color=z.string().regex(/^#[0-9A-F]{6}$/);
const viewBox=z.tuple([coordinate,coordinate,dimension,dimension]);
export const logoTransformSchema = z.strictObject({x:coordinate,y:coordinate,scale,rotation});
export type LogoTransform = z.infer<typeof logoTransformSchema>;

/** Canonical absolute grammar; deliberately does not parse SVG/XML or convert paths. */
function canonicalPathCommandCount(d: string): number | null {
  const arity: Record<string,number>={M:2,L:2,Q:4,C:6,Z:0};
  const token=/([MLQCZ])|([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/gy;
  let index=0,count=0,remaining=0,first=true,previousNumber=false;
  while(index<d.length) {
    while(index<d.length && /[ \t\r\n]/.test(d[index]!)) index++;
    if(index===d.length) break;
    // A comma separates two parameters of the same explicit command only.
    if(d[index]===",") {
      if(!previousNumber || !remaining)return null;
      index++;
      while(index<d.length && /[ \t\r\n]/.test(d[index]!)) index++;
      if(index===d.length || !/[+\-\d.]/.test(d[index]!))return null;
    }
    token.lastIndex=index;
    const match=token.exec(d); if(!match) return null;
    index=token.lastIndex;
    if(match[1]) { if(remaining || (first && match[1]!=="M")) return null; first=false; previousNumber=false; remaining=arity[match[1]]!; count++; if(count>LOGO_VECTOR_MAX_COMMANDS)return null; }
    else { const n=Number(match[2]); if(!remaining || !Number.isFinite(n) || Math.abs(n)>1_000_000)return null; remaining--; previousNumber=true; }
  }
  return first || remaining ? null : count;
}
export const logoVectorPathSchema = z.strictObject({
  id:logoIdentifierSchema,d:z.string().min(1).max(LOGO_GEOMETRY_MAX_BYTES).refine(d=>canonicalPathCommandCount(d)!==null,"Use bounded canonical absolute M/L/Q/C/Z geometry"),
  fill:z.strictObject({color,opacity:z.number().min(0).max(1)}).nullable(),
  stroke:z.strictObject({color,width:z.number().min(0).max(10_000),opacity:z.number().min(0).max(1),linecap:z.enum(["butt","round","square"]),linejoin:z.enum(["miter","round","bevel"]),miterLimit:z.number().min(1).max(100)}).nullable(),
  fillRule:z.enum(["nonzero","evenodd"]),
});
export type LogoVectorPath = z.infer<typeof logoVectorPathSchema>;
export const logoComponentRoleSchema = z.enum(["symbol","lettering","illustration","border","whole_artwork"]);
export type LogoComponentRole = z.infer<typeof logoComponentRoleSchema>;
const text=z.string().min(1).max(400).refine(value=>[...value].length<=200,"At most 200 Unicode code points");
const tag=z.string().regex(/^[A-Za-z0-9]{4}$/);
export const logoTextSourceSchema = boundedLogoJson(z.strictObject({
  text,contentKind:z.enum(["brand_name","approved_initials"]),font:logoAssetReferenceSchema,rightsEvidenceId:logoUuidSchema,
  faceIndex:z.number().int().min(0).max(65_535),size:dimension,
  variationAxes:z.record(tag,coordinate).refine(v=>Object.keys(v).length<=64,"Too many font axes"),
  featureTags:z.record(tag,z.boolean()).refine(v=>Object.keys(v).length<=64,"Too many font features"),
  language:z.string().min(2).max(35).regex(/^[A-Za-z0-9-]+$/),script:z.string().regex(/^[A-Za-z]{4}$/),direction:z.enum(["ltr","rtl"]),
  letterSpacing:coordinate,lineHeight:z.number().positive().max(100),shapingEngine:z.strictObject({id:logoIdentifierSchema,version:logoIdentifierSchema}),
}));
export type LogoTextSource = z.infer<typeof logoTextSourceSchema>;
const componentShape={id:logoIdentifierSchema,role:logoComponentRoleSchema,paths:z.array(logoVectorPathSchema).min(1).max(LOGO_VECTOR_MAX_PATHS),transform:logoTransformSchema};
export const logoVectorComponentSchema = z.discriminatedUnion("editingKind",[
  z.strictObject({...componentShape,editingKind:z.literal("geometry")}),
  z.strictObject({...componentShape,editingKind:z.literal("outlined_custom")}),
  z.strictObject({...componentShape,editingKind:z.literal("editable_text"),textSource:logoTextSourceSchema}),
]);
export type LogoVectorComponent = z.infer<typeof logoVectorComponentSchema>;
export const logoVectorDocumentSchema = boundedLogoJson(z.strictObject({version:z.literal(1),viewBox,components:z.array(logoVectorComponentSchema).min(1).max(LOGO_VECTOR_MAX_COMPONENTS)}).superRefine((value,ctx)=>{
  const paths=value.components.flatMap(c=>c.paths);
  if(!uniqueLogoValues(value.components.map(c=>c.id)) || !uniqueLogoValues(paths.map(p=>p.id))) logoIssue(ctx,"Component and path identifiers must be unique");
  if(paths.length>LOGO_VECTOR_MAX_PATHS || paths.reduce((n,p)=>n+(canonicalPathCommandCount(p.d)??0),0)>LOGO_VECTOR_MAX_COMMANDS) logoIssue(ctx,"Document exceeds geometry limits");
}),LOGO_GEOMETRY_MAX_BYTES);
export type LogoVectorDocument = z.infer<typeof logoVectorDocumentSchema>;
export const logoTraceSettingsSchema = z.strictObject({preset:z.enum(["bw","poster"]),simplify:z.number().min(0).max(2.5),filterSpeckle:z.number().int().min(0).max(16),maxColors:z.number().int().min(2).max(32)}).refine(v=>v.preset!=="bw" || v.maxColors===2,"B/W conversion uses exactly two colors");
export type LogoTraceSettings = z.infer<typeof logoTraceSettingsSchema>;
export const logoComponentLockSchema = z.strictObject({componentId:logoIdentifierSchema,geometryHash:logoHashSchema,appearanceHash:logoHashSchema,transformHash:logoHashSchema,textHash:logoHashSchema,zOrderHash:logoHashSchema,effectiveHash:logoHashSchema});
export type LogoComponentLock = z.infer<typeof logoComponentLockSchema>;
export const logoLocksSchema = z.array(logoComponentLockSchema).max(64).refine(v=>uniqueLogoValues(v.map(l=>l.componentId)),"Duplicate lock");
export const logoVectorProofSchema = boundedLogoJson(z.strictObject({version:z.literal(1),svgContentHash:logoHashSchema,documentHash:logoHashSchema,validator:z.strictObject({id:logoIdentifierSchema,version:logoIdentifierSchema}),viewBox,pathCount:z.number().int().min(1).max(LOGO_VECTOR_MAX_PATHS),componentCount:z.number().int().min(1).max(64),externalFontDependencies:z.tuple([])}));
export type LogoVectorProof = z.infer<typeof logoVectorProofSchema>;
export const logoVectorRevisionSchema = boundedLogoJson(z.strictObject({
  id:logoUuidSchema,...logoScopeShape,parentRevisionId:logoUuidSchema.nullable(),source:logoRasterSourceSchema,
  sourcePreview:logoAssetReferenceSchema,documentAsset:logoAssetReferenceSchema,svgAsset:logoAssetReferenceSchema,documentHash:logoHashSchema,proof:logoVectorProofSchema,
  locks:logoLocksSchema,inputRevisions:logoInputRevisionsSchema,reviewStatus:z.literal("review_required"),createdAt:logoTimestampSchema,
}).superRefine((v,ctx)=>{
  if([v.sourcePreview,v.documentAsset,v.svgAsset].some(a=>!sameLogoScope(v,a)))logoIssue(ctx,"Vector files must belong to the exact owner/project");
  if(v.parentRevisionId===v.id || v.documentHash!==v.proof.documentHash || v.documentAsset.contentHash!==v.documentHash || v.svgAsset.contentHash!==v.proof.svgContentHash)logoIssue(ctx,"Vector proof must bind its immutable document and SVG hashes");
}),LOGO_VECTOR_REVISION_MAX_BYTES);
export type LogoVectorRevision = z.infer<typeof logoVectorRevisionSchema>;
export const logoApprovalSchema = boundedLogoJson(z.strictObject({id:logoUuidSchema,...logoScopeShape,vectorRevisionId:logoUuidSchema,stageRevisionId:logoUuidSchema,approvedAt:logoTimestampSchema}));
export type LogoApproval = z.infer<typeof logoApprovalSchema>;
const componentId=logoIdentifierSchema;
export const logoManualEditSchema = boundedLogoJson(z.discriminatedUnion("kind",[
  z.strictObject({kind:z.literal("text"),componentId,text}),
  z.strictObject({kind:z.literal("font"),componentId,fontVersionId:logoUuidSchema}),
  z.strictObject({kind:z.literal("spacing"),componentId,letterSpacing:coordinate,lineHeight:z.number().positive().max(100)}),
  z.strictObject({kind:z.literal("size"),componentId,scale}),
  z.strictObject({kind:z.literal("rotation"),componentId,degrees:rotation}),
  z.strictObject({kind:z.literal("color"),componentId,fill:color.nullable(),stroke:color.nullable()}),
  z.strictObject({kind:z.literal("arrangement"),placements:z.array(z.strictObject({componentId,transform:logoTransformSchema})).min(1).max(64),order:z.array(componentId).min(1).max(64)}).refine(v=>uniqueLogoValues(v.order) && uniqueLogoValues(v.placements.map(p=>p.componentId)) && v.placements.every(p=>v.order.includes(p.componentId)),"Arrangement must name unique existing components"),
  z.strictObject({kind:z.literal("group_components"),regions:z.array(z.strictObject({id:componentId,role:logoComponentRoleSchema,bounds:viewBox})).min(1).max(64)}).refine(v=>uniqueLogoValues(v.regions.map(r=>r.id)),"Duplicate region"),
  z.strictObject({kind:z.literal("replace_outlined_lettering"),componentId,fontVersionId:logoUuidSchema,text,contentKind:z.enum(["brand_name","approved_initials"]).optional()}),
  z.strictObject({kind:z.literal("locks"),componentIds:z.array(componentId).max(64).refine(uniqueLogoValues,"Duplicate component")}),
]));
export type LogoManualEdit = z.infer<typeof logoManualEditSchema>;
