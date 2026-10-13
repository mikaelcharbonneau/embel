import { z } from "zod";
import { INSPIRATION_CATALOG_VERSION, inspirationCatalog, inspirationOverviewSchema, hasInspirationChoice, type InspirationOverview } from "./inspiration";
import { referenceElementSchema } from "./identity-references";

export const VISUAL_DIRECTION_MAX_BYTES = 32768;
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const note = z.string().trim().max(1200).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), "Unsupported control character");
export const visualDirectionGuidanceSchema = z.strictObject({ character: note, colors: note, typography: note, graphics: note });
export type VisualDirectionGuidance = z.infer<typeof visualDirectionGuidanceSchema>;
export const emptyVisualGuidance = (): VisualDirectionGuidance => ({ character: "", colors: "", typography: "", graphics: "" });
export const sameVisualGuidance = (a: VisualDirectionGuidance, b: VisualDirectionGuidance) =>
  (Object.keys(a) as (keyof VisualDirectionGuidance)[]).every(key => a[key] === b[key]);
/** Catalog text is attributed guidance, never an owned asset or proof of rights. */
export const visualDirectionReferenceSchema = z.strictObject({
  referenceId: z.uuid(), brand: z.string().min(1).max(200), creator: z.string().min(1).max(200),
  description: z.string().min(1).max(2000), sourceUrl: z.url().max(2048), contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  ensemble: z.boolean(), elements: z.array(referenceElementSchema).max(6),
}).superRefine((value, ctx) => {
  const design = inspirationCatalog.find(item => item.id === value.referenceId);
  if (!design || !hasInspirationChoice(value) || new Set(value.elements).size !== value.elements.length ||
    value.elements.some(element => !design.elements.includes(element)) ||
    (["brand", "creator", "description", "sourceUrl", "contentHash"] as const).some(key => design[key] !== value[key]))
    ctx.addIssue({ code: "custom", message: "Reference must retain its exact attributed catalog descriptor and selected aspects" });
});
export const reviewedVisualDirectionSchema = z.strictObject({
  id: z.uuid(), ownerId: z.uuid(), projectId: z.uuid(), revision: revision.min(1), projectRevision: revision.min(1),
  selectionRevision: revision, catalogVersion: z.literal(INSPIRATION_CATALOG_VERSION),
  guidance: visualDirectionGuidanceSchema, references: z.array(visualDirectionReferenceSchema).max(15),
  reviewedAt: z.iso.datetime({ offset: true }),
}).superRefine((value, ctx) => {
  if (new Set(value.references.map(row => row.referenceId)).size !== value.references.length ||
    !value.references.length && !Object.values(value.guidance).some(Boolean))
    ctx.addIssue({ code: "custom", message: "Review requires saved inspiration or written guidance" });
});
export type ReviewedVisualDirection = z.infer<typeof reviewedVisualDirectionSchema>;
export const reviewVisualDirectionSchema = z.strictObject({
  expectedRevision: revision, expectedProjectRevision: revision.min(1), expectedSelectionRevision: revision,
  catalogVersion: z.literal(INSPIRATION_CATALOG_VERSION), guidance: visualDirectionGuidanceSchema,
});
export type ReviewVisualDirection = z.infer<typeof reviewVisualDirectionSchema>;
export function visualDirectionReferences(inspiration: InspirationOverview) {
  return inspiration.choices.filter(hasInspirationChoice).map(choice => {
    const design = inspirationCatalog.find(item => item.id === choice.referenceId)!;
    return visualDirectionReferenceSchema.parse({ referenceId: choice.referenceId, brand: design.brand, creator: design.creator,
      description: design.description, sourceUrl: design.sourceUrl, contentHash: design.contentHash, ensemble: choice.ensemble, elements: choice.elements });
  }).sort((a, b) => a.referenceId.localeCompare(b.referenceId));
}
export function visualDirectionIsCurrent(value: ReviewedVisualDirection, inspiration: InspirationOverview) {
  return value.ownerId === inspiration.ownerId && value.projectId === inspiration.projectId &&
    value.projectRevision === inspiration.projectRevision && value.selectionRevision === inspiration.selectionRevision && value.catalogVersion === inspiration.catalogVersion;
}
export const visualDirectionOverviewSchema = z.strictObject({
  inspiration: inspirationOverviewSchema, current: reviewedVisualDirectionSchema.nullable(),
  history: z.array(reviewedVisualDirectionSchema).max(20), hasEarlierHistory: z.boolean(), stale: z.boolean(),
}).superRefine((value, ctx) => {
  const rows = [value.current, ...value.history].filter((row): row is ReviewedVisualDirection => !!row);
  if (rows.some(row => row.ownerId !== value.inspiration.ownerId || row.projectId !== value.inspiration.projectId) ||
    new Set(rows.map(row => row.id)).size !== rows.length ||
    value.history.some((row, index) => row.revision >= (index ? value.history[index - 1]!.revision : value.current?.revision ?? 0)) ||
    value.stale !== Boolean(value.current && !visualDirectionIsCurrent(value.current, value.inspiration)))
    ctx.addIssue({ code: "custom", message: "Reviewed direction history must bind this owned project and its current inputs" });
});
export type VisualDirectionOverview = z.infer<typeof visualDirectionOverviewSchema>;
