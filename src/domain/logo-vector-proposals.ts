import { z } from "zod";
import { logoExpectedHeadsSchema } from "./logo-workspace";
import {
  boundedLogoJson,
  logoComponentRoleSchema,
  logoHashSchema,
  logoIdentifierSchema,
  logoInputRevisionsSchema,
  logoIssue,
  logoLocksSchema,
  logoManualEditSchema,
  logoRasterSourceSchema,
  logoRevisionSchema,
  logoScopeShape,
  logoStringSchema,
  logoTextSourceSchema,
  logoTransformSchema,
  logoUuidSchema,
  logoVectorDocumentSchema,
  uniqueLogoValues,
} from "./logo-vector";

/** Passive, disconnected contracts. No operation registration, admission or candidate authority. */
export const LOGO_VECTOR_PROPOSAL_MAX_BYTES = 32_768;
export const LOGO_VECTOR_PROPOSAL_CONTEXT_MAX_BYTES = 65_536;
export const LOGO_VECTOR_PROPOSAL_OPERATIONS = ["size", "rotation", "color", "arrangement", "font", "spacing"] as const;
export const logoVectorProposalOperationSchema = z.enum(LOGO_VECTOR_PROPOSAL_OPERATIONS);
export type LogoVectorProposalOperation = z.infer<typeof logoVectorProposalOperationSchema>;
const operations = z.array(logoVectorProposalOperationSchema).max(6).refine(uniqueLogoValues, "Duplicate operation");
const targets = z.array(logoIdentifierSchema).min(1).max(64).refine(uniqueLogoValues, "Duplicate target");

// Reuse the actual bounded manual branches. Intentionally do not admit the whole manual union.
const [, fontEdit, spacingEdit, sizeEdit, rotationEdit, colorEdit, arrangementEdit] = logoManualEditSchema.options;
export const logoVectorProposalEditSchema = boundedLogoJson(
  z.discriminatedUnion("kind", [sizeEdit, rotationEdit, colorEdit, arrangementEdit, fontEdit, spacingEdit]),
);
export type LogoVectorProposalEdit = z.infer<typeof logoVectorProposalEditSchema>;
export const logoVectorProposalRequestSchema = boundedLogoJson(
  z.strictObject({
    operation: z.literal("propose_vector_edit"),
    expected: logoExpectedHeadsSchema,
    baseVectorRevisionId: logoUuidSchema,
    instruction: logoStringSchema
      .min(1)
      .max(4_000)
      .refine((value) => value.trim().length > 0, "An instruction is required"),
    targetComponentIds: targets,
  }),
);
export type LogoVectorProposalRequest = z.infer<typeof logoVectorProposalRequestSchema>;

const bounds = z
  .strictObject({
    minX: z.number().finite(),
    minY: z.number().finite(),
    maxX: z.number().finite(),
    maxY: z.number().finite(),
  })
  .refine((value) => value.minX <= value.maxX && value.minY <= value.maxY, "Invalid painted bounds");
const color = z
  .string()
  .regex(/^#[0-9A-F]{6}$/)
  .nullable();
const paint = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("uniform"), fill: color, stroke: color, textUniform: z.boolean() }),
  z.strictObject({ status: z.literal("nonuniform") }),
]);
const text = logoTextSourceSchema.shape;
const textSummary = z.strictObject({
  text: text.text,
  contentKind: text.contentKind,
  fontVersionId: logoUuidSchema.nullable(),
  fontAssetVersionId: logoUuidSchema,
  fontContentHash: logoHashSchema,
  rightsEvidenceId: text.rightsEvidenceId,
  faceIndex: text.faceIndex,
  size: text.size,
  variationAxes: text.variationAxes,
  featureTags: text.featureTags,
  language: text.language,
  script: text.script,
  direction: text.direction,
  letterSpacing: text.letterSpacing,
  lineHeight: text.lineHeight,
  shapingEngine: text.shapingEngine,
});
export const logoVectorProposalComponentSchema = z
  .strictObject({
    id: logoIdentifierSchema,
    role: logoComponentRoleSchema,
    editingKind: z.enum(["geometry", "outlined_custom", "editable_text"]),
    transform: logoTransformSchema,
    paintedBounds: bounds.nullable(),
    localPaintedBounds: bounds.nullable(),
    paint,
    text: textSummary.nullable(),
    allowedOperations: operations,
  })
  .refine(
    (value) => (value.editingKind === "editable_text") === (value.text !== null),
    "Text metadata must reflect the actual editing kind",
  );
export type LogoVectorProposalComponent = z.infer<typeof logoVectorProposalComponentSchema>;
const fontSummary = z.strictObject({
  id: logoUuidSchema,
  family: logoStringSchema.min(1).max(200),
  source: z.enum(["free_catalog", "user_upload"]),
  assetVersionId: logoUuidSchema,
  fontContentHash: logoHashSchema,
  rightsEvidenceId: logoUuidSchema,
  recordHash: logoHashSchema,
});
export const logoVectorProposalContextSchema = boundedLogoJson(
  z
    .strictObject({
      version: z.literal(1),
      ...logoScopeShape,
      baseVectorRevisionId: logoUuidSchema,
      documentHash: logoHashSchema,
      source: logoRasterSourceSchema,
      viewBox: logoVectorDocumentSchema.shape.viewBox,
      locks: logoLocksSchema,
      inputRevisions: logoInputRevisionsSchema,
      brief: z.strictObject({
        id: logoUuidSchema,
        revision: logoRevisionSchema,
        inputHash: logoHashSchema,
        name: logoStringSchema.min(1).max(200),
      }),
      components: z.array(logoVectorProposalComponentSchema).min(1).max(64),
      fonts: z.array(fontSummary).max(100),
      targetComponentIds: targets,
      allowedOperations: operations,
    })
    .superRefine((value, ctx) => {
      const ids = value.components.map((component) => component.id),
        briefInputs = value.inputRevisions.filter((ref) => ref.stage === "brief_references");
      if (
        !uniqueLogoValues(ids) ||
        !uniqueLogoValues(value.fonts.map((font) => font.id)) ||
        value.targetComponentIds.some((id) => !ids.includes(id)) ||
        value.locks.some((lock) => !ids.includes(lock.componentId))
      )
        logoIssue(ctx, "Context must name unique existing components and fonts");
      if (
        briefInputs.length !== 1 ||
        briefInputs[0]!.id !== value.brief.id ||
        briefInputs[0]!.revision !== value.brief.revision
      )
        logoIssue(ctx, "Context must bind one exact brief revision");
      for (const component of value.components) {
        const source = component.text;
        if (source?.contentKind === "brand_name" && source.text !== value.brief.name)
          logoIssue(ctx, "Preserve the exact saved brand name");
        if (source && source.fontVersionId !== null) {
          const font = value.fonts.find((item) => item.id === source.fontVersionId);
          if (
            !font ||
            font.assetVersionId !== source.fontAssetVersionId ||
            font.fontContentHash !== source.fontContentHash ||
            font.rightsEvidenceId !== source.rightsEvidenceId
          )
            logoIssue(ctx, "Text font must bind the exact permitted font metadata");
        }
        if (value.locks.some((lock) => lock.componentId === component.id) && component.allowedOperations.length)
          logoIssue(ctx, "Locked components cannot advertise editable controls");
      }
    }),
  LOGO_VECTOR_PROPOSAL_CONTEXT_MAX_BYTES,
);
export type LogoVectorProposalContext = z.infer<typeof logoVectorProposalContextSchema>;

export const logoVectorProposalUnsupportedCodeSchema = z.enum([
  "unsupported_request",
  "multiple_changes",
  "unsupported_component",
  "unsupported_paint",
  "unsupported_text",
  "locked_component",
  "no_change",
]);
const explanation = logoStringSchema
  .min(1)
  .max(1_000)
  .refine((value) => value.trim().length > 0, "Explain the result");
/** `proposed` is metadata-validated intent, never safe/applicable artwork or approval. */
export const logoVectorProposalPayloadSchema = boundedLogoJson(
  z.discriminatedUnion("status", [
    z.strictObject({
      version: z.literal(1),
      status: z.literal("proposed"),
      edit: logoVectorProposalEditSchema,
      explanation,
    }),
    z.strictObject({
      version: z.literal(1),
      status: z.literal("unsupported"),
      code: logoVectorProposalUnsupportedCodeSchema,
      explanation,
    }),
  ]),
  LOGO_VECTOR_PROPOSAL_MAX_BYTES,
);
export type LogoVectorProposalPayload = z.infer<typeof logoVectorProposalPayloadSchema>;

/** Required future materialization checks; this declaration does not implement that producer. */
export const LOGO_VECTOR_PROPOSAL_CANDIDATE_CHECKS = Object.freeze([
  "exact_owned_base_and_current_heads",
  "current_saved_locks",
  "font_rights_bytes_and_shaping",
  "geometry_and_occlusion",
  "non_target_preservation",
] as const);
