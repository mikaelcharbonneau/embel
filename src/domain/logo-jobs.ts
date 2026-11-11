import { z } from "zod";
import { moneySchema } from "./jobs";
import {
  LOGO_REFERENCE_SNAPSHOT_MAX_BYTES,
  logoExpectedHeadsSchema,
  logoBriefRevisionSchema,
  logoReferenceSnapshotSchema,
  logoMutationReceiptSchema,
  type LogoMutationReceipt,
} from "./logo-workspace";
import {
  committedIdentityAssetReceiptSchema,
  logoVariantSetSchema,
  logoExportRejectionSchema,
  type LogoExportRejection,
  type IdentityAssetReceipt,
  type LogoVariantSet,
} from "./logo-deliverables";
import {
  LOGO_MUTATION_MAX_BYTES,
  logoUuidSchema as uuid,
  logoHashSchema as hash,
  logoStringSchema as text,
  logoTimestampSchema as timestamp,
  logoIdentifierSchema as identifier,
  logoScopeShape as scope,
  logoTypeSchema,
  logoRasterSourceSchema,
  logoRevisionSchema as revision,
  logoAssetReferenceSchema,
  logoInputRevisionsSchema,
  logoLocksSchema,
  logoTraceSettingsSchema,
  boundedLogoJson as bounded,
  uniqueLogoValues as unique,
  sameLogoScope,
  logoIssue as issue,
} from "./logo-vector";
export const logoOperationSchema = z.enum([
  "identity.logo_concept",
  "identity.logo_refine",
  "identity.logo_vectorize",
  "identity.logo_directions",
  "identity.logo_export",
]);
export const logoBillingObservationSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unknown"), confirmedMicrousd: z.null() }),
  z.strictObject({ status: z.literal("recorded"), confirmedMicrousd: moneySchema }),
]);
export type LogoBillingObservation = z.infer<typeof logoBillingObservationSchema>;
/** Text-request policy of Creative direction, which the style-note request below extends. */
const logoDirectionsApiPolicySchema = z.strictObject({
  version: z.literal(1),
  billingMode: z.literal("openai_api"),
  spendControl: z.literal("uncapped"),
  handlerVersion: z.literal("logo-directions-api-v1"),
  adapterVersion: z.literal("logo-directions-openai-v1"),
  model: z.literal("gpt-6.1-sol"),
  pricingVersion: z.literal("2026-10-03"),
  serviceTier: z.literal("default"),
  maxInputTokens: z.number().int().min(1).max(32768),
  maxOutputTokens: z.number().int().min(1).max(4096),
  maxInputBytes: z.number().int().min(1024).max(131072),
  maxOutputBytes: z.number().int().min(1024).max(32768),
  maxStreamBytes: z.number().int().min(1024).max(2097152),
  deadlineMs: z.number().int().min(1000).max(240000),
  maxTools: z.literal(0),
  inputMicrousdPerMillionTokens: z.literal(2000000),
  cachedInputMicrousdPerMillionTokens: z.literal(100000),
  cacheWriteMicrousdPerMillionTokens: z.literal(2500000),
  outputMicrousdPerMillionTokens: z.literal(10000000),
});
const ordinal = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const plannedSlot = z.strictObject({ ordinal, type: logoTypeSchema, directionId: identifier });
const typeList = z.array(logoTypeSchema).max(7).refine(unique, "Duplicate logo type");
export const logoConceptPlanSchema = bounded(
  z
    .strictObject({
      version: z.literal(1),
      targetCount: z.literal(6),
      requestedTypes: typeList.min(1),
      slots: z.array(plannedSlot).length(6),
      coveredTypes: typeList.min(1),
      uncoveredTypes: typeList,
    })
    .superRefine((v, ctx) => {
      const covered = new Set(v.slots.map((s) => s.type));
      if (
        !unique(v.slots.map((s) => s.ordinal)) ||
        !unique(v.slots.map((s) => s.directionId)) ||
        v.slots.some((s) => !v.requestedTypes.includes(s.type))
      )
        issue(ctx, "Six planned slots require distinct ordinals/directions and requested types");
      if (
        v.coveredTypes.length !== covered.size ||
        v.coveredTypes.some((t) => !covered.has(t)) ||
        v.uncoveredTypes.length !== v.requestedTypes.length - covered.size ||
        v.requestedTypes.some((t) => covered.has(t) === v.uncoveredTypes.includes(t))
      )
        issue(ctx, "Coverage must report exactly the actually assigned requested types");
    }),
);
export type LogoConceptPlan = z.infer<typeof logoConceptPlanSchema>;
const state = z.enum(["queued", "running", "succeeded", "failed", "cancelled", "needs_reconciliation"]);
const observationShape = {
  preview: z.lazy(() => committedIdentityAssetReceiptSchema).nullable(),
  providerResponseReceiptId: uuid.nullable(),
  state,
  billing: logoBillingObservationSchema,
  reason: text.min(1).nullable(),
};
function checkObservation(
  v: {
    preview: IdentityAssetReceipt | null;
    providerResponseReceiptId: string | null;
    state: string;
    billing: LogoBillingObservation;
    reason: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (v.preview && !v.providerResponseReceiptId) issue(ctx, "A verified preview requires retained provider evidence");
  if (v.state === "succeeded" && (!v.preview || v.billing.status !== "recorded"))
    issue(ctx, "Success requires committed output and confirmed billing");
  if (
    v.preview &&
    v.billing.status === "unknown" &&
    (v.state !== "needs_reconciliation" || v.reason !== "billing_unknown")
  )
    issue(ctx, "Output with unknown billing remains pending reconciliation");
  if (v.state === "needs_reconciliation" && v.reason === null) issue(ctx, "Reconciliation must preserve its reason");
}
export const logoConceptAttemptSchema = bounded(
  z
    .strictObject({
      id: uuid,
      jobId: uuid,
      slotId: uuid,
      requestKey: uuid,
      previousAttemptId: uuid.nullable(),
      attemptNumber: revision,
      inputHash: hash,
      reservedCostMicrousd: moneySchema,
      ...observationShape,
    })
    .superRefine((v, ctx) => {
      checkObservation(v, ctx);
      if (v.previousAttemptId === v.id || (v.attemptNumber === 1) !== (v.previousAttemptId === null))
        issue(ctx, "Attempts require exact immutable predecessor lineage");
    }),
);
export const logoConceptSlotSchema = bounded(
  z
    .strictObject({
      id: uuid,
      ...plannedSlot.shape,
      attempts: z.array(logoConceptAttemptSchema).max(100),
      acceptedPreview: z.lazy(() => committedIdentityAssetReceiptSchema).nullable(),
    })
    .superRefine((v, ctx) => {
      if (
        !unique(v.attempts.map((a) => a.id)) ||
        v.attempts.some(
          (a, i) =>
            a.slotId !== v.id ||
            a.attemptNumber !== i + 1 ||
            a.previousAttemptId !== (i === 0 ? null : v.attempts[i - 1]!.id),
        )
      )
        issue(ctx, "Slot attempts must retain contiguous exact lineage");
      if (
        v.acceptedPreview &&
        !v.attempts.some((a) => a.preview && JSON.stringify(a.preview) === JSON.stringify(v.acceptedPreview))
      )
        issue(ctx, "Accepted preview must be an actual retained attempt result");
    }),
  131_072,
);
export type LogoConceptSlot = z.infer<typeof logoConceptSlotSchema>;
export const logoConceptBatchSchema = bounded(
  z
    .strictObject({
      version: z.literal(2),
      id: uuid,
      ...scope,
      requestKey: uuid,
      briefRevisionId: uuid,
      referenceSnapshotId: uuid,
      targetCount: z.literal(6),
      plan: logoConceptPlanSchema,
      slots: z.array(logoConceptSlotSchema).length(6),
      createdAt: timestamp,
    })
    .superRefine((v, ctx) => {
      if (!unique(v.slots.map((s) => s.id)) || !unique(v.slots.map((s) => s.ordinal)))
        issue(ctx, "Batch requires six stable unique slots");
      for (const s of v.slots) {
        const planned = v.plan.slots.find((p) => p.ordinal === s.ordinal);
        if (!planned || s.type !== planned.type || s.directionId !== planned.directionId)
          issue(ctx, "Batch slots must match the immutable plan");
        if ([s.acceptedPreview, ...s.attempts.map((a) => a.preview)].some((p) => p && !sameLogoScope(v, p.reference)))
          issue(ctx, "Batch previews must be owned");
      }
    }),
  1_048_576,
);
export type LogoConceptBatch = z.infer<typeof logoConceptBatchSchema>;
export const logoConceptBatchSummarySchema = z.strictObject({ id: uuid, requestKey: uuid, createdAt: timestamp });
/** Discovery never repeats full batches, provider receipts or private asset URLs. */
export const logoConceptBatchPageSchema = bounded(
  z
    .strictObject({
      ...scope,
      items: z.array(logoConceptBatchSummarySchema).max(50),
      nextCursor: text.min(1).max(2048).nullable(),
    })
    .refine(
      (v) => unique(v.items.map((i) => i.id)) && unique(v.items.map((i) => i.requestKey)),
      "Batch summaries must retain unique immutable batch/request identities",
    ),
  16_384,
);
export type LogoConceptBatchPage = z.infer<typeof logoConceptBatchPageSchema>;

export const logoRasterRefinementSchema = bounded(
  z
    .strictObject({
      version: z.literal(2),
      id: uuid,
      ...scope,
      requestKey: uuid,
      jobId: uuid,
      source: z.union([logoRasterSourceSchema, z.strictObject({ kind: z.literal("vector"), vectorRevisionId: uuid })]),
      logoType: logoTypeSchema,
      ...observationShape,
      inputRevisions: logoInputRevisionsSchema,
      createdAt: timestamp,
    })
    .superRefine((v, ctx) => {
      checkObservation(v, ctx);
      if (v.preview && !sameLogoScope(v, v.preview.reference)) issue(ctx, "Refinement preview must retain ownership");
      if (v.source.kind === "refinement" && v.source.rasterRevisionId === v.id)
        issue(ctx, "A refinement cannot be its own source");
    }),
);
export type LogoRasterRefinement = z.infer<typeof logoRasterRefinementSchema>;
export const logoRasterRefinementPageSchema = bounded(
  z
    .strictObject({
      ...scope,
      items: z.array(logoRasterRefinementSchema).max(50),
      nextCursor: text.min(1).max(2048).nullable(),
    })
    .refine(
      (v) => v.items.every((r) => sameLogoScope(v, r)) && unique(v.items.map((r) => r.id)),
      "Refinement page must be uniquely owned",
    ),
  1_638_400,
);
export type LogoRasterRefinementPage = z.infer<typeof logoRasterRefinementPageSchema>;
const expected = { expected: logoExpectedHeadsSchema };
/** What one Logo action asks the engine to draw, bound to the saved heads it reads. The Logo
 * step builds exactly these four requests; the engine has its own start input. */
export const logoRunRequestSchema = bounded(
  z.discriminatedUnion("operation", [
    z.strictObject({ ...expected, operation: z.literal("concepts"), briefRevisionId: uuid, referenceSnapshotId: uuid }),
    z.strictObject({
      ...expected,
      operation: z.literal("more_concepts"),
      briefRevisionId: uuid,
      referenceSnapshotId: uuid,
    }),
    z.strictObject({
      ...expected,
      operation: z.literal("retry_failed"),
      sourceBatchId: uuid,
      failedSlotIds: z.array(uuid).min(1).max(6).refine(unique, "Duplicate failed slot"),
    }),
    z.strictObject({
      ...expected,
      operation: z.literal("refine_preview"),
      source: logoRasterSourceSchema,
      instruction: text.min(1),
    }),
  ]),
);
export type LogoRunRequest = z.infer<typeof logoRunRequestSchema>;
/** A liked upload's style note: one text request under Creative direction's exact
 * price and limits, with its own handler and adapter versions. */
export const logoStyleNoteApiPolicySchema = logoDirectionsApiPolicySchema.extend({
  handlerVersion: z.literal("logo-style-note-v1"),
  adapterVersion: z.literal("logo-style-note-openai-v1"),
});
export type LogoStyleNoteApiPolicy = z.infer<typeof logoStyleNoteApiPolicySchema>;
export const logoDispatchReceiptSchema = bounded(
  z
    .strictObject({
      ...scope,
      requestKey: uuid,
      operation: z.union([
        logoOperationSchema,
        z.literal("identity.logo_vector_propose"),
        z.literal("identity.logo_style_note"),
      ]),
      batchId: uuid.nullable(),
      jobIds: z.array(uuid).min(1).max(6).refine(unique, "Duplicate admitted job"),
      inputHash: hash,
    })
    .refine(
      (v) => (v.operation === "identity.logo_concept") === (v.batchId !== null),
      "Only concept operations have a batch",
    )
    .refine(
      (v) =>
        !["identity.logo_vector_propose", "identity.logo_style_note"].includes(v.operation) || v.jobIds.length === 1,
      "A vector proposal or style note must bind exactly one durable job",
    ),
);
export type LogoDispatchReceipt = z.infer<typeof logoDispatchReceiptSchema>;
export type LogoRequestState =
  | { status: "not_found" }
  | {
      status: "admitted" | "running" | "partial" | "succeeded" | "failed" | "cancelled" | "needs_reconciliation";
      requestKey: string;
      receipt: LogoDispatchReceipt | LogoMutationReceipt | LogoVariantSet | null;
      outputs: IdentityAssetReceipt[];
      billing: LogoBillingObservation;
      reason: string | null;
      rejection?: LogoExportRejection;
    };
export const logoRequestStateSchema: z.ZodType<LogoRequestState> = bounded(
  z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("not_found") }),
    z
      .strictObject({
        status: z.enum(["admitted", "running", "partial", "succeeded", "failed", "cancelled", "needs_reconciliation"]),
        requestKey: uuid,
        receipt: z
          .union([logoDispatchReceiptSchema, logoMutationReceiptSchema, z.lazy(() => logoVariantSetSchema)])
          .nullable(),
        outputs: z.array(z.lazy(() => committedIdentityAssetReceiptSchema)).max(100),
        billing: logoBillingObservationSchema,
        reason: text.min(1).nullable(),
        rejection: z.lazy(() => logoExportRejectionSchema).optional(),
      })
      .superRefine((v, ctx) => {
        if (
          v.rejection &&
          (v.status !== "failed" ||
            v.reason !== "admission_rejected" ||
            v.receipt !== null ||
            v.outputs.length !== 0 ||
            v.billing.status !== "recorded" ||
            v.billing.confirmedMicrousd !== 0 ||
            v.rejection.requestKey !== v.requestKey)
        )
          issue(ctx, "Export rejection requires exact failed empty zero-cost state");
        if (v.status === "succeeded" && v.receipt === null)
          issue(ctx, "Successful recovery requires its durable receipt");
        if (v.receipt && "requestKey" in v.receipt && v.receipt.requestKey !== v.requestKey)
          issue(ctx, "Recovery receipt must bind the original request key");
        if (v.receipt && v.outputs.some((o) => !sameLogoScope(v.receipt!, o.reference)))
          issue(ctx, "Recovered outputs must belong to the receipt owner/project");
        if (v.status === "needs_reconciliation" && v.reason === null)
          issue(ctx, "Uncertain requests retain their reason");
        if (
          v.outputs.length &&
          v.billing.status === "unknown" &&
          (v.status !== "needs_reconciliation" || v.reason !== "billing_unknown")
        )
          issue(ctx, "Verified output does not settle unknown billing");
      }),
  ]),
  262_144,
);
const jobBasis = {
  version: z.literal(2),
  ...scope,
  requestKey: uuid,
  quoteId: uuid,
  policyIdentity: hash,
  handlerVersion: identifier,
  inputHash: hash,
};
const logoConceptInputFields = z.strictObject({
  ...jobBasis,
  operation: z.literal("identity.logo_concept"),
  batchId: uuid,
  slotId: uuid,
  attemptId: uuid,
  attemptNumber: revision,
  previousAttemptId: uuid.nullable(),
  directionId: identifier,
  plan: logoConceptPlanSchema,
  ordinal,
  briefRevisionId: uuid,
  referenceSnapshotId: uuid,
  references: z.array(logoAssetReferenceSchema).max(100),
});
const checkConceptInput = (
  v:
    z.infer<typeof logoConceptInputFields> | (Omit<z.infer<typeof logoConceptInputFields>, "version"> & { version: 3 }),
  ctx: z.RefinementCtx,
) => {
  if (
    v.references.some((r) => !sameLogoScope(v, r)) ||
    !v.plan.slots.some((s) => s.ordinal === v.ordinal && s.directionId === v.directionId) ||
    (v.attemptNumber === 1) !== (v.previousAttemptId === null) ||
    v.attemptId === v.previousAttemptId
  )
    issue(ctx, "Concept job must bind the owned plan, references and lineage");
};
export const logoConceptJobInputSchema = bounded(
  z.union([
    logoConceptInputFields.superRefine(checkConceptInput),
    logoConceptInputFields
      .extend({ version: z.literal(3), billingMode: z.literal("openai_api"), spendControl: z.literal("uncapped") })
      .superRefine(checkConceptInput),
  ]),
);
const legacyLogoRefinementJobInputSchema = z.strictObject({
  ...jobBasis,
  operation: z.literal("identity.logo_refine"),
  rasterRevisionId: uuid,
  instruction: text.min(1),
  briefRevisionId: uuid,
  referenceSnapshotId: uuid,
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("preview"), raster: logoRasterSourceSchema }),
    z.strictObject({
      kind: z.literal("vector"),
      vectorRevisionId: uuid,
      documentHash: hash,
      logoType: logoTypeSchema,
      locks: logoLocksSchema,
      traceSettings: logoTraceSettingsSchema,
    }),
  ]),
});
export const logoRefinementJobInputSchema = bounded(
  z.union([
    legacyLogoRefinementJobInputSchema,
    legacyLogoRefinementJobInputSchema.extend({
      version: z.literal(3),
      billingMode: z.literal("openai_api"),
      spendControl: z.literal("uncapped"),
      source: z.strictObject({ kind: z.literal("preview"), raster: logoRasterSourceSchema }),
    }),
  ]),
);
// Server-resolved inputs compose independently bounded immutable records and exact publication lineage.
// Wrappers have no free text; 128 bytes covers their JSONB keys/separators.
export const LOGO_RESOLVED_CONCEPT_INPUT_MAX_BYTES =
  3 * LOGO_MUTATION_MAX_BYTES + LOGO_REFERENCE_SNAPSHOT_MAX_BYTES + 128;
// The additional fixed asset reference and its wrapper fit within 512 bytes.
export const LOGO_RESOLVED_REFINEMENT_INPUT_MAX_BYTES = LOGO_RESOLVED_CONCEPT_INPUT_MAX_BYTES + 512;
export const logoResolvedConceptInputSchema = bounded(
  z
    .strictObject({
      inputRevisions: logoInputRevisionsSchema,
      input: logoConceptJobInputSchema,
      brief: logoBriefRevisionSchema,
      referenceSnapshot: logoReferenceSnapshotSchema,
    })
    .refine(
      (v) =>
        sameLogoScope(v.input, v.brief) &&
        sameLogoScope(v.input, v.referenceSnapshot) &&
        v.input.briefRevisionId === v.brief.id &&
        v.input.referenceSnapshotId === v.referenceSnapshot.id &&
        v.brief.payload.referenceSnapshotId === v.referenceSnapshot.id &&
        v.inputRevisions.length === 1 &&
        v.inputRevisions[0]!.stage === "brief_references" &&
        v.inputRevisions[0]!.id === v.brief.id &&
        v.inputRevisions[0]!.revision === v.brief.revision &&
        JSON.stringify(v.input.references) === JSON.stringify(v.referenceSnapshot.references.map((s) => s.asset)),
      "Resolved concept sources must match exact owned input IDs",
    ),
  LOGO_RESOLVED_CONCEPT_INPUT_MAX_BYTES,
);
export type LogoResolvedConceptInput = z.infer<typeof logoResolvedConceptInputSchema>;
export const logoResolvedRefinementInputSchema = bounded(
  z
    .strictObject({
      inputRevisions: logoInputRevisionsSchema,
      input: logoRefinementJobInputSchema,
      brief: logoBriefRevisionSchema,
      referenceSnapshot: logoReferenceSnapshotSchema,
      basePreview: logoAssetReferenceSchema,
    })
    .refine(
      (v) =>
        [v.brief, v.referenceSnapshot, v.basePreview].every((r) => sameLogoScope(v.input, r)) &&
        v.input.briefRevisionId === v.brief.id &&
        v.input.referenceSnapshotId === v.referenceSnapshot.id &&
        v.brief.payload.referenceSnapshotId === v.referenceSnapshot.id &&
        v.inputRevisions.some(
          (r) => r.stage === "brief_references" && r.id === v.brief.id && r.revision === v.brief.revision,
        ),
      "Resolved refinement sources must match exact owned input IDs",
    ),
  LOGO_RESOLVED_REFINEMENT_INPUT_MAX_BYTES,
);
export type LogoResolvedRefinementInput = z.infer<typeof logoResolvedRefinementInputSchema>;
