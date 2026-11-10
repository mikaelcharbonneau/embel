import { z } from "zod";
import { jobStatusSchema, moneySchema } from "./jobs";
import { sharedImageModelSchema } from "./providers";
import { identityLogoSourceSchema } from "./identity-logo-source";
import { brandBoardApplicationDesignSchema } from "./brand-board-design";
import { logoRasterSourceSchema } from "./logo-workspace";
import { logoVectorProposalUsageSchema } from "./logo-vector-proposal-jobs";
import {
  identityComponentsSchema, identityInputSnapshotSchema, identitySystemAssetSchema, identitySystemVersionSchema, validIdentityApplicationDesign,
  type IdentitySystemAsset, type IdentitySystemVersion,
} from "./project-identity";

export const IDENTITY_JOB_MUTATION_MAX_BYTES = 4096;
export const IDENTITY_BATCH_TARGET = 3 as const;

/** A client may acknowledge a server policy; this is never permission to spend. */
const legacyIdentityGenerationIntentSchema = z.strictObject({
  expectedProjectRevision: z.number().int().positive(),
  expectedReferenceRevision: z.number().int().nonnegative(),
  expectedPreferencesRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  acceptedPolicyIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  acceptedMaxCostMicrousd: moneySchema,
});
const uncappedIdentityGenerationIntentSchema = z.strictObject({
  version: z.literal(2), spendControl: z.literal("uncapped"),
  expectedProjectRevision: z.number().int().positive(), expectedReferenceRevision: z.number().int().nonnegative(),
  expectedPreferencesRevision: z.number().int().nonnegative(), idempotencyKey: legacyIdentityGenerationIntentSchema.shape.idempotencyKey,
  expectedIdentityRevision: z.number().int().nonnegative(),
  acceptedPolicyIdentity: legacyIdentityGenerationIntentSchema.shape.acceptedPolicyIdentity,
});
export const logoBoardGenerationIntentSchema = uncappedIdentityGenerationIntentSchema.extend({
  version: z.literal(3), sourceLogo: logoRasterSourceSchema,
  expectedLogoRevision: z.number().int().positive(),
});
export const identityGenerationIntentSchema = z.union([legacyIdentityGenerationIntentSchema, uncappedIdentityGenerationIntentSchema, logoBoardGenerationIntentSchema]);
export type IdentityGenerationIntent = z.infer<typeof identityGenerationIntentSchema>;

const unavailableIdentitySchema = z.strictObject({
  ownerId: z.uuid(), projectId: z.uuid(), status: z.literal("unavailable"),
  operation: z.literal("identity.image"), requestedModel: sharedImageModelSchema,
  reason: z.enum(["pipeline_not_implemented", "runtime_unavailable", "policy_unavailable", "inputs_not_ready", "references_unavailable", "reference_limit_exceeded", "reference_bytes_exceeded", "logo_selection_required", "logo_needs_review", "unsupported_brand_text"]),
  maxReferenceImages: z.literal(4).optional(),
  maxReferenceBytes: z.literal(20_971_520).optional(),
});
/** Availability is loaded from actual SQL policy/slot/Storage readiness, never inferred from a model name. */
const legacyAvailableIdentitySchema = z.strictObject({
  version: z.literal(2), spendControl: z.literal("uncapped"), ownerId: z.uuid(), projectId: z.uuid(), status: z.literal("available"),
  operation: z.literal("identity.image"), requestedModel: sharedImageModelSchema, policyIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  handlerVersion: z.literal("identity-image-v1"), targetCount: z.literal(IDENTITY_BATCH_TARGET), maxReferenceImages:z.literal(4), maxReferenceBytes:z.literal(20_971_520),
});
export const logoBoardAvailabilitySchema = legacyAvailableIdentitySchema.extend({
  version: z.literal(3), sourceLogo: identityLogoSourceSchema,
  expectedProjectRevision: z.number().int().positive(), expectedReferenceRevision: z.number().int().nonnegative(),
  expectedPreferencesRevision: z.number().int().nonnegative(), expectedIdentityRevision: z.number().int().nonnegative(),
  expectedLogoRevision: z.number().int().positive(), estimatedCostMicrousd: moneySchema.nullable(),
}).refine(v => v.sourceLogo.brief.ownerId === v.ownerId && v.sourceLogo.brief.projectId === v.projectId
  && v.sourceLogo.selectionRevision === v.expectedLogoRevision, "Availability must bind the current owned logo selection");
export const identityAvailabilitySchema = z.union([unavailableIdentitySchema, legacyAvailableIdentitySchema, logoBoardAvailabilitySchema]);
export type IdentityAvailability = z.infer<typeof identityAvailabilitySchema>;

/** Matches public.job_steps.output's existing UTF-8 jsonb::text ceiling. */
export const IDENTITY_STEP_OUTPUT_MAX_BYTES = 1_048_576;
const ownership = { ownerId: z.uuid(), projectId: z.uuid() };
const stepKey = z.string().min(1).max(200);
const timestamp = z.iso.datetime({ offset: true }).max(64);
const sameScope = (a: { ownerId: string; projectId: string }, b: { ownerId: string; projectId: string }) => a.ownerId === b.ownerId && a.projectId === b.projectId;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Compare parsed JSON structurally; object insertion order is not immutable evidence. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => child && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : child);
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const issue = (ctx: z.RefinementCtx, message: string) => ctx.addIssue({ code: "custom", message });

const encoder = new TextEncoder();
/** Account for jsonb's spaces and expanded numeric exponents, rather than compact JSON's smaller size. */
function postgresJsonBytes(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "string") {
    // PostgreSQL JSONB cannot store NUL or unpaired UTF-16 surrogates.
    for (const character of value) {
      const point = character.codePointAt(0)!;
      if (point === 0 || (point >= 0xD800 && point <= 0xDFFF)) throw new Error("Unrepresentable JSONB string");
    }
    return encoder.encode(JSON.stringify(value)).byteLength;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const text = JSON.stringify(value), [mantissa, exponent] = text.split("e");
    if (exponent === undefined) return text.length;
    const unsigned = mantissa!.replace("-", ""), digits = unsigned.replace(".", "");
    const point = (unsigned.indexOf(".") < 0 ? unsigned.length : unsigned.indexOf(".")) + Number(exponent);
    return (text.startsWith("-") ? 1 : 0) + (point <= 0 ? 2 - point + digits.length : point >= digits.length ? point : digits.length + 1);
  }
  if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) * 2 + value.reduce((bytes, child: unknown) => bytes + postgresJsonBytes(child), 0);
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined);
    return 2 + Math.max(0, entries.length - 1) * 2 + entries.reduce((bytes, [key, child]) => bytes + postgresJsonBytes(key) + 2 + postgresJsonBytes(child), 0);
  }
  throw new Error("A step output must contain JSON values");
}

const generatedSystemSchema = identitySystemVersionSchema.refine(value => value.source.kind === "generated", "Only complete generated systems count toward a batch");
const generatedSystemsSchema = z.array(generatedSystemSchema).max(IDENTITY_BATCH_TARGET);
/** This spans all accepted systems, including systems produced by different completed steps. */
function validateUniqueSystems(systems: IdentitySystemVersion[], ctx: z.RefinementCtx): void {
  const systemIds = new Set<string>(), boardVersions = new Set<string>(), boardHashes = new Set<string>();
  const versions = new Map<string, IdentitySystemAsset>();
  for (const system of systems) {
    const board = system.board.asset;
    if (systemIds.has(system.id) || boardVersions.has(board.versionId) || boardHashes.has(board.contentHash)) issue(ctx, "Accepted systems require distinct IDs, board versions and board bytes");
    systemIds.add(system.id); boardVersions.add(board.versionId); boardHashes.add(board.contentHash);
  }
  for (const system of systems) {
    for (const asset of [system.board.asset, ...system.productionFiles.map(file => file.asset)]) {
      const previous = versions.get(asset.versionId);
      if (previous && !same(previous, asset)) issue(ctx, "Repeated immutable file versions must retain exact metadata");
      versions.set(asset.versionId, asset);
    }
    if (system.productionFiles.some(file => boardVersions.has(file.asset.versionId) || boardHashes.has(file.asset.contentHash))) issue(ctx, "A coordinated board cannot become another system's production file");
  }
}

/** Exact stored path: job_steps.output.identity.systems[outputIndex]. This shape alone proves no provider execution. */
export const identityStepOutputSchema = z.strictObject({ identity: z.strictObject({
  version: z.literal(1), operation: z.literal("identity.image"), ...ownership,
  batchId: z.uuid(), jobId: z.uuid(), stepKey, targetCount: z.literal(IDENTITY_BATCH_TARGET),
  input: identityInputSnapshotSchema, systems: generatedSystemsSchema,
}) }).superRefine((value, ctx) => {
  const output = value.identity;
  if (!sameScope(output, output.input)) issue(ctx, "Output and captured input must belong to the same owned project");
  for (const system of output.systems) {
    const source = system.source;
    if (!sameScope(output, system) || source.kind !== "generated" || source.batchId !== output.batchId || source.jobId !== output.jobId || source.stepKey !== output.stepKey || !same(system.input, output.input)) issue(ctx, "Each generated system must bind the exact output source and full captured input");
  }
  validateUniqueSystems(output.systems, ctx);
  try {
    if (postgresJsonBytes(value) > IDENTITY_STEP_OUTPUT_MAX_BYTES) issue(ctx, "Complete output exceeds the existing step-output byte limit");
  } catch { issue(ctx, "Complete output must be representable as PostgreSQL JSONB"); }
}).transform(freeze);
export type IdentityStepOutput = z.infer<typeof identityStepOutputSchema>;

/** Server-loaded immutable batch evidence, never browser authority to create a batch. */
export const identityBatchBindingSchema = z.strictObject({
  id: z.uuid(), ...ownership, jobId: z.uuid(), targetCount: z.literal(IDENTITY_BATCH_TARGET), input: identityInputSnapshotSchema,
}).refine(value => sameScope(value, value.input), "Batch and captured input must belong to the same owned project").transform(freeze);
export type IdentityBatchBinding = z.infer<typeof identityBatchBindingSchema>;

/** The DAL must load the actual owned row and identity.image job. Generic job success is not evidence. */
export const identityCompletedStepEvidenceSchema = z.strictObject({
  ...ownership, jobId: z.uuid(), stepKey, state: z.literal("succeeded"), completedAt: timestamp, output: identityStepOutputSchema,
}).refine(value => sameScope(value, value.output.identity) && value.jobId === value.output.identity.jobId && value.stepKey === value.output.identity.stepKey,
  "Completed evidence must bind its exact owned step output").transform(freeze);
export type IdentityCompletedStepEvidence = z.infer<typeof identityCompletedStepEvidenceSchema>;

/** Read-only metadata pointer. Persistence must resolve its actual completed source, immutable manifest and owned files. */
export const identityGeneratedSystemReceiptSchema = z.strictObject({
  version: z.literal(1), ...ownership, batchId: z.uuid(), jobId: z.uuid(), stepKey,
  outputIndex: z.number().int().min(0).max(IDENTITY_BATCH_TARGET - 1), systemVersionId: z.uuid(),
  board: identitySystemAssetSchema.extend({ mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]) }),
}).refine(value => sameScope(value, value.board), "Receipt and board must belong to the same owned project").transform(freeze);
export type IdentityGeneratedSystemReceipt = z.infer<typeof identityGeneratedSystemReceiptSchema>;

export const identityGeneratedSystemBindingSchema = z.strictObject({
  batch: identityBatchBindingSchema, step: identityCompletedStepEvidenceSchema,
  receipt: identityGeneratedSystemReceiptSchema, system: generatedSystemSchema,
}).superRefine((value, ctx) => {
  const { batch, step, receipt, system } = value, output = step.output.identity;
  if (!sameScope(batch, step) || !sameScope(batch, receipt) || !sameScope(batch, system) || batch.id !== receipt.batchId || batch.id !== output.batchId
    || batch.jobId !== step.jobId || batch.jobId !== receipt.jobId || step.stepKey !== receipt.stepKey || system.id !== receipt.systemVersionId
    || !same(receipt.board, system.board.asset) || !same(system, output.systems[receipt.outputIndex]) || !same(batch.input, output.input))
    issue(ctx, "A generated receipt must resolve the exact owned batch, completed output position, complete system and board");
}).transform(freeze);
export type IdentityGeneratedSystemBinding = z.infer<typeof identityGeneratedSystemBindingSchema>;
export function validateIdentityGeneratedSystemBinding(value: unknown): IdentityGeneratedSystemBinding {
  return identityGeneratedSystemBindingSchema.parse(value);
}

const acceptedCount = z.number().int().min(0).max(IDENTITY_BATCH_TARGET);
const collectedStatus = (count: number) => count === 0 ? "none" : count === IDENTITY_BATCH_TARGET ? "complete" : "partial";
export const identityFulfillmentSchema = z.strictObject({
  targetCount: z.literal(IDENTITY_BATCH_TARGET), acceptedCount, status: z.enum(["pending", "none", "partial", "complete"]),
}).refine(value => value.status === "pending" ? value.acceptedCount === 0 : value.status === collectedStatus(value.acceptedCount),
  "Fulfillment must describe the actual accepted count").transform(freeze);
export type IdentityFulfillment = z.infer<typeof identityFulfillmentSchema>;
export function pendingIdentityFulfillment(): IdentityFulfillment {
  return identityFulfillmentSchema.parse({ targetCount: IDENTITY_BATCH_TARGET, acceptedCount: 0, status: "pending" });
}

/** Job outcome, file presence, licensing and production readiness are separate observations. */
export const identityBatchResultSchema = z.strictObject({
  version: z.literal(1), ...ownership, batchId: z.uuid(), jobId: z.uuid(), systems: generatedSystemsSchema, fulfillment: identityFulfillmentSchema,
}).superRefine((value, ctx) => {
  if (value.fulfillment.status === "pending" || value.fulfillment.acceptedCount !== value.systems.length) issue(ctx, "Collected fulfillment must describe the actual complete systems");
  for (const system of value.systems) {
    const source = system.source;
    if (!sameScope(value, system) || source.kind !== "generated" || source.batchId !== value.batchId || source.jobId !== value.jobId || !same(system.input, value.systems[0]!.input)) issue(ctx, "Collected systems must retain one exact owned batch and captured input");
  }
  validateUniqueSystems(value.systems, ctx);
}).transform(freeze);
export type IdentityBatchResult = z.infer<typeof identityBatchResultSchema>;

/** Collect only resolved completed-step bindings. A later failed/cancelled job does not erase earlier accepted systems. */
export function collectIdentityBatchResult(batch: unknown, bindings: unknown): IdentityBatchResult {
  const actualBatch = identityBatchBindingSchema.parse(batch);
  const actualBindings = z.array(identityGeneratedSystemBindingSchema).max(IDENTITY_BATCH_TARGET).parse(bindings);
  const steps = new Map<string, IdentityCompletedStepEvidence>();
  for (const binding of actualBindings) {
    if (!same(binding.batch, actualBatch)) throw new Error("Collected binding belongs to a different immutable batch");
    const previous = steps.get(binding.step.stepKey);
    if (previous && !same(previous, binding.step)) throw new Error("One completed step cannot have conflicting immutable evidence");
    steps.set(binding.step.stepKey, binding.step);
  }
  return identityBatchResultSchema.parse({ version: 1, ownerId: actualBatch.ownerId, projectId: actualBatch.projectId, batchId: actualBatch.id, jobId: actualBatch.jobId,
    systems: actualBindings.map(binding => binding.system), fulfillment: { targetCount: IDENTITY_BATCH_TARGET, acceptedCount: actualBindings.length, status: collectedStatus(actualBindings.length) } });
}

export const IDENTITY_IMAGE_HANDLER_VERSION = "identity-image-v1" as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Execution/resource bounds, not a monetary allowance or client authority. */
export const identityTextPolicySchema = z.strictObject({
  version: z.literal(1), model: z.literal("gpt-6.1-sol"), serviceTier: z.literal("default"), pricingVersion: z.literal("2026-10-03"),
  maxInputTokens: z.number().int().min(1).max(32_768), maxOutputTokens: z.number().int().min(1).max(8192),
  maxInputBytes: z.number().int().min(1024).max(131_072), maxOutputBytes: z.number().int().min(1024).max(65_536),
  deadlineMs: z.number().int().min(1000).max(240_000), maxTools: z.literal(0),
});
export type IdentityTextPolicy = z.infer<typeof identityTextPolicySchema>;
export const identityGenerationCapabilitySchema = z.strictObject({
  operation: z.literal("identity.image"), policyIdentity: digest, handlerVersion: z.literal(IDENTITY_IMAGE_HANDLER_VERSION),
  provider: z.literal("openai"), model: sharedImageModelSchema, engine: z.null(), maxCostMicrousd: z.literal(0),
  spendControl: z.literal("uncapped"), textPolicy: identityTextPolicySchema,
});
export type IdentityGenerationCapability = z.infer<typeof identityGenerationCapabilitySchema>;
const legacyIdentityGenerationJobInputSchema = z.strictObject({
  version: z.literal(2), operation: z.literal("identity.image"), ownerId: z.uuid(), projectId: z.uuid(), batchId: z.uuid(),
  input: identityInputSnapshotSchema, policyIdentity: digest, handlerVersion: z.literal(IDENTITY_IMAGE_HANDLER_VERSION),
  spendControl: z.literal("uncapped"), textPolicy: identityTextPolicySchema,
  systemIds: z.array(z.uuid()).length(3).refine(ids => new Set(ids).size === 3),
});
export const identityGenerationJobInputSchema = z.union([
  legacyIdentityGenerationJobInputSchema,
  legacyIdentityGenerationJobInputSchema.extend({ version: z.literal(3), sourceLogo: identityLogoSourceSchema }),
]).refine(v => sameScope(v,v.input) && (v.version !== 3 || sameScope(v, v.sourceLogo.brief) && v.input.version === 2 && same(v.input.logoBrief, v.sourceLogo.brief)), "Job must capture its actual owned full input and logo");
export type IdentityGenerationJobInput = z.infer<typeof identityGenerationJobInputSchema>;
export const identitySystemSpecificationSchema = z.strictObject({ components: identityComponentsSchema, boardPrompt: z.string().trim().min(1).max(6000), applicationDesign: brandBoardApplicationDesignSchema.optional() })
  .refine(v => !v.applicationDesign || validIdentityApplicationDesign(v.components, v.applicationDesign), "Application design must reference actual specification components");
export type IdentitySystemSpecification = z.infer<typeof identitySystemSpecificationSchema>;
const imageCount = z.number().int().nonnegative().max(1_000_000_000);
/** Passive copy of the existing Images usage contract; no server imports enter the domain graph. */
const imageUsage = z.object({ input_tokens: imageCount, output_tokens: imageCount,
  input_tokens_details: z.object({text_tokens:imageCount,image_tokens:imageCount}), total_tokens: z.number().int().nonnegative().max(2_000_000_000).optional(),
  output_tokens_details:z.object({text_tokens:imageCount,image_tokens:imageCount}).optional(),
}).refine(v=>v.input_tokens===v.input_tokens_details.text_tokens+v.input_tokens_details.image_tokens
  &&(v.total_tokens===undefined||v.total_tokens===v.input_tokens+v.output_tokens)
  &&(!v.output_tokens_details||v.output_tokens_details.text_tokens===0&&v.output_tokens_details.image_tokens===v.output_tokens));
export const identityGenerationObservationSchema = z.strictObject({
  version:z.literal(1), phase:z.enum(["specifications","board"]),provider:z.literal("openai"),model:z.string().min(1).max(150).nullable(),
  requestKey:digest,requestHash:digest,responseId:z.string().min(1).max(200).nullable(),providerRequestId:z.string().min(1).max(200).nullable(),
  responseHash:digest.nullable(),observedAt:timestamp,responseComplete:z.boolean(),serviceTier:z.string().min(1).max(100).nullable(),
  usage:z.union([logoVectorProposalUsageSchema,imageUsage]).nullable(),
  billing:z.discriminatedUnion("status",[z.strictObject({status:z.literal("recorded"),confirmedMicrousd:moneySchema}),z.strictObject({status:z.literal("unknown"),confirmedMicrousd:z.null()})]),
  specification:identitySystemSpecificationSchema.nullable(),artifactHash:digest.nullable(),
}).refine(v=>v.phase==="specifications"?v.artifactHash===null:v.specification===null,"Phases retain only their actual output kind");
export type IdentityGenerationObservation = z.infer<typeof identityGenerationObservationSchema>;
export const identityGenerationProviderReceiptSchema=z.strictObject({id:z.uuid(),ownerId:z.uuid(),projectId:z.uuid(),jobId:z.uuid(),leaseToken:z.uuid(),callId:z.uuid(),observation:identityGenerationObservationSchema});
export type IdentityGenerationProviderReceipt=z.infer<typeof identityGenerationProviderReceiptSchema>;
export const identityBatchStateSchema=z.strictObject({ownerId:z.uuid(),projectId:z.uuid(),batchId:z.uuid(),jobId:z.uuid(),status:jobStatusSchema,terminal:z.boolean(),
  intent:identityGenerationIntentSchema,input:identityInputSnapshotSchema,systems:generatedSystemsSchema,fulfillment:identityFulfillmentSchema,
  sourceLogo:identityLogoSourceSchema.optional(),sourceLogoCurrent:z.boolean().optional(),
  usage:z.strictObject({status:z.enum(["pending","recorded","unknown"]),knownCostMicrousd:moneySchema}).optional(),
}).superRefine((v,ctx)=>{
  if ("version" in v.intent && v.intent.version === 3) {
    if (!v.sourceLogo || !v.usage || typeof v.sourceLogoCurrent !== "boolean" || !sameScope(v, v.sourceLogo.brief)
      || v.input.version !== 2 || !same(v.input.logoBrief, v.sourceLogo.brief) || !same(v.intent.sourceLogo, v.sourceLogo.source) || v.intent.expectedLogoRevision !== v.sourceLogo.selectionRevision)
      issue(ctx, "Logo board batches must retain the exact admitted selection and current-source status");
  } else if (v.sourceLogo || v.sourceLogoCurrent !== undefined) issue(ctx, "Historical system batches cannot invent a selected logo");
  if(!sameScope(v,v.input)||v.fulfillment.acceptedCount!==v.systems.length)issue(ctx,"Batch progress must describe its actual owned completed systems");
  if(v.intent.expectedProjectRevision!==v.input.projectRevision||v.intent.expectedReferenceRevision!==v.input.referenceSnapshot.referenceRevision
    ||v.intent.expectedPreferencesRevision!==v.input.preferencesRevision)issue(ctx,"Batch intent must bind the exact captured revisions");
  if(v.status==="succeeded"&&v.systems.length!==IDENTITY_BATCH_TARGET||v.fulfillment.status==="pending"&&!["queued","running","cancel_requested"].includes(v.status))issue(ctx,"Batch state cannot imply missing complete systems or pending terminal work");
  if(v.terminal!==["succeeded","failed","cancelled","partial"].includes(v.status))issue(ctx,"Identity terminal states must reflect the actual finished batch");
  for(const s of v.systems)if(!sameScope(v,s)||s.source.kind!=="generated"||s.source.batchId!==v.batchId||s.source.jobId!==v.jobId||!same(s.input,v.input))issue(ctx,"Batch systems must retain exact immutable source");
  validateUniqueSystems(v.systems,ctx);
}).transform(freeze);
export type IdentityBatchState=z.infer<typeof identityBatchStateSchema>;

/** Read-only recovery includes the last durable request even when new work is unavailable. */
export const identityBatchOverviewSchema = z.strictObject({ ...ownership, availability: identityAvailabilitySchema, latest: identityBatchStateSchema.nullable() })
  .refine(value => sameScope(value, value.availability) && (!value.latest || sameScope(value, value.latest)), "Batch overview must belong to one owned project").transform(freeze);
export type IdentityBatchOverview = z.infer<typeof identityBatchOverviewSchema>;
export const identityBatchRequestLookupSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_found") }), z.strictObject({ status: z.literal("found"), batch: identityBatchStateSchema }),
]);
export type IdentityBatchRequestLookup = z.infer<typeof identityBatchRequestLookupSchema>;
/** Only a durable SQL tombstone may prove that an uncertain request cannot
 * admit later. An already admitted request retains its real cancellation state. */
export const identityBatchRequestCloseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_admitted"), ...ownership, intent: identityGenerationIntentSchema.refine(value => "version" in value && (value.version === 2 || value.version === 3)) }),
  z.strictObject({ status: z.literal("admitted"), batch: identityBatchStateSchema }),
]);
export type IdentityBatchRequestClose = z.infer<typeof identityBatchRequestCloseSchema>;
