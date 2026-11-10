import "server-only";
import { z } from "zod";
import {
  logoBriefDraftSchema,
  logoExpectedHeadsSchema,
  logoRasterSourceSchema,
  logoReferenceAspectSchema,
} from "@/domain/logo-workspace";
import { logoAssetReferenceSchema } from "@/domain/logo-vector";
import { LOGO_LIKED_UPLOAD_LIMIT } from "@/domain/logo-saved-inputs";

// The frozen inputs of the Logo generation kinds (docs/generation-engine.md, step 4).
// The route builds them with the person's own login (src/server/engine/logo.ts);
// the workflow steps read them back from the claimed run. Nothing here holds a
// price: credits are counted at admission, costs are recorded on outputs.

export const LOGO_CONCEPTS_KIND = "logo.concepts";
export const LOGO_REFINE_KIND = "logo.refine";
export const LOGO_STYLE_NOTE_KIND = "logo.style_note";
export const LOGO_KINDS = [LOGO_CONCEPTS_KIND, LOGO_REFINE_KIND, LOGO_STYLE_NOTE_KIND] as const;
export type LogoKind = (typeof LOGO_KINDS)[number];

const revision = z.number().int().positive();
/** The saved brief the images are made from: its revision and the fields a prompt reads. */
export const logoRunBriefSchema = z.strictObject({ id: z.uuid(), revision, payload: logoBriefDraftSchema });
export type LogoRunBrief = z.infer<typeof logoRunBriefSchema>;

/** A round of concepts: six new ones, or the failed ones of an earlier round. */
export const logoConceptsRunInputSchema = z
  .strictObject({
    version: z.literal(1),
    revision,
    operation: z.enum(["concepts", "more_concepts", "retry_failed"]),
    /** Logo workspace heads when the person asked. */
    expected: logoExpectedHeadsSchema,
    brief: logoRunBriefSchema,
    batchId: z.uuid(),
    slotIds: z.array(z.uuid()).min(1).max(6).optional(),
  })
  .refine((value) => (value.operation === "retry_failed") === (value.slotIds !== undefined), {
    message: "Only a retry names its slots",
    path: ["slotIds"],
  });
export type LogoConceptsRunInput = z.infer<typeof logoConceptsRunInputSchema>;

/** One refinement of a chosen image: its exact preview, then each liked upload. */
export const logoRefineRunInputSchema = z.strictObject({
  version: z.literal(1),
  revision,
  expected: logoExpectedHeadsSchema,
  brief: logoRunBriefSchema,
  source: logoRasterSourceSchema,
  basePreview: logoAssetReferenceSchema,
  references: z
    .array(
      z.strictObject({
        asset: logoAssetReferenceSchema,
        mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
        aspects: z.array(logoReferenceAspectSchema).min(1).max(4),
      }),
    )
    .max(3),
  instruction: z.string().trim().min(1).max(4000),
});
export type LogoRefineRunInput = z.infer<typeof logoRefineRunInputSchema>;

/** Style notes for liked uploads that have none yet, each for its exact version. */
export const logoStyleNoteRunInputSchema = z.strictObject({
  version: z.literal(1),
  revision,
  references: z
    .array(
      z.strictObject({
        referenceId: z.uuid(),
        asset: logoAssetReferenceSchema,
        mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
      }),
    )
    .min(1)
    .max(LOGO_LIKED_UPLOAD_LIMIT)
    .refine((rows) => new Set(rows.map((row) => row.referenceId)).size === rows.length, "Duplicate reference"),
});
export type LogoStyleNoteRunInput = z.infer<typeof logoStyleNoteRunInputSchema>;

/** What the browser names for each kind; the server freezes everything else. */
export const logoConceptsRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.enum(["concepts", "more_concepts"]),
    expected: logoExpectedHeadsSchema,
    briefRevisionId: z.uuid(),
  }),
  z.strictObject({
    operation: z.literal("retry_failed"),
    expected: logoExpectedHeadsSchema,
    sourceBatchId: z.uuid(),
    failedSlotIds: z.array(z.uuid()).min(1).max(6),
  }),
]);
export const logoRefineRequestSchema = z.strictObject({
  expected: logoExpectedHeadsSchema,
  source: logoRasterSourceSchema,
  instruction: z.string().trim().min(1).max(4000),
});
export const logoStyleNoteRequestSchema = z.strictObject({
  referenceIds: z.array(z.uuid()).min(1).max(LOGO_LIKED_UPLOAD_LIMIT),
});

/** A style note's output key: one per upload. */
export const styleNoteOutputKey = (referenceId: string) => `note.${referenceId}`;
