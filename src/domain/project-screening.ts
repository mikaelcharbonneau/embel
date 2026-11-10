import { z } from "zod";
import { providerTargetSchema } from "./standalone-provider-evidence";
import { standaloneLookupResultSchema, type StandaloneLookupResult } from "./standalone-live-checks";

const uuid = z.uuid();
const timestamp = z.iso.datetime({ offset: true });
export const SCREENING_PAGE_SIZE = 20;
export const screeningSourceSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:[/?#].*)?$/.test(value) &&
        !/[\u0000-\u0020\u007f]/.test(value)
      );
    } catch {
      return false;
    }
  }, "Use an HTTPS source link without credentials.");
export const screeningBasisSchema = z.strictObject({
  ownerId: uuid,
  projectId: uuid,
  selectionId: uuid,
  candidateId: uuid,
  projectRevision: z.number().int().positive(),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(160),
});
export type ScreeningBasis = z.infer<typeof screeningBasisSchema>;
export const screeningCheckInputSchema = z.strictObject({
  selectionId: uuid,
  expectedProjectRevision: z.number().int().positive(),
  criteria: providerTargetSchema,
});
/** Findings are owner-authored notes, never a writable provider receipt or clearance. */
export const screeningRecordInputSchema = screeningCheckInputSchema.extend({
  requestId: uuid,
  notes: z.string().trim().min(1).max(3000),
  sourceUrls: z
    .array(screeningSourceSchema)
    .max(5)
    .refine((values) => new Set(values).size === values.length),
  observedAt: timestamp,
  acknowledged: z.literal(true),
});
export type ScreeningRecordInput = z.infer<typeof screeningRecordInputSchema>;
export const screeningRecordSchema = z
  .strictObject({
    id: uuid,
    requestId: uuid,
    basis: screeningBasisSchema,
    criteria: providerTargetSchema,
    provenance: z.literal("user_recorded"),
    verification: z.literal("unverified"),
    legalClearance: z.literal("not_assessed"),
    notes: z.string().min(1).max(3000),
    sourceUrls: z.array(screeningSourceSchema).max(5),
    observedAt: timestamp,
    recordedAt: timestamp,
  })
  .superRefine((value, ctx) => {
    if (Date.parse(value.observedAt) > Date.parse(value.recordedAt))
      ctx.addIssue({ code: "custom", message: "An observation cannot follow its recording." });
    if (value.criteria.tool === "trademarks" && value.criteria.mark !== value.basis.name)
      ctx.addIssue({ code: "custom", message: "Trademark criteria must retain the exact selected name." });
  });
export type ScreeningRecord = z.infer<typeof screeningRecordSchema>;
export const screeningCursorSchema = z.strictObject({ recordedAt: timestamp, id: uuid });
export type ScreeningCursor = z.infer<typeof screeningCursorSchema>;
export const screeningOverviewSchema = z
  .strictObject({
    ownerId: uuid,
    projectId: uuid,
    projectRevision: z.number().int().positive(),
    currentBasis: screeningBasisSchema.nullable(),
    records: z.array(screeningRecordSchema).max(SCREENING_PAGE_SIZE),
    nextCursor: screeningCursorSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const same = (basis: ScreeningBasis) =>
      basis.ownerId === value.ownerId &&
      basis.projectId === value.projectId &&
      basis.projectRevision <= value.projectRevision;
    if (
      (value.currentBasis &&
        (!same(value.currentBasis) || value.currentBasis.projectRevision !== value.projectRevision)) ||
      value.records.some((record) => !same(record.basis)) ||
      new Set(value.records.map((record) => record.id)).size !== value.records.length
    )
      ctx.addIssue({ code: "custom", message: "Screening records must belong to this owned project and context." });
    const last = value.records.at(-1);
    if (
      value.nextCursor &&
      (!last || value.nextCursor.id !== last.id || value.nextCursor.recordedAt !== last.recordedAt)
    )
      ctx.addIssue({ code: "custom", message: "Continuation must retain the last immutable record." });
  });
export type ScreeningOverview = z.infer<typeof screeningOverviewSchema>;
export function sameScreeningBasis(a: ScreeningBasis, b: ScreeningBasis | null): boolean {
  return (
    b !== null &&
    a.ownerId === b.ownerId &&
    a.projectId === b.projectId &&
    a.selectionId === b.selectionId &&
    a.candidateId === b.candidateId &&
    a.projectRevision === b.projectRevision &&
    a.contextHash === b.contextHash &&
    a.name === b.name
  );
}
export function screeningRecordFreshness(
  record: ScreeningRecord,
  basis: ScreeningBasis | null,
  criteria?: z.infer<typeof providerTargetSchema>,
): "current_context_unverified" | "earlier_context" | "different_criteria" {
  if (!sameScreeningBasis(record.basis, basis)) return "earlier_context";
  if (criteria && JSON.stringify(record.criteria) !== JSON.stringify(providerTargetSchema.parse(criteria)))
    return "different_criteria";
  return "current_context_unverified";
}
export function screeningResultMatches(
  criteria: z.infer<typeof providerTargetSchema>,
  result: StandaloneLookupResult,
): boolean {
  if (result.status === "failed") return true;
  if (criteria.tool === "domains")
    return (
      result.status === "domain" &&
      result.check.domain === criteria.domain &&
      (!result.quote ||
        (result.quote.domain === criteria.domain &&
          result.quote.checkId === result.check.id &&
          result.quote.provider === result.check.provider))
    );
  if (criteria.tool === "handles")
    return (
      result.status === "handle" &&
      result.evidence.platform === criteria.platform &&
      result.evidence.handle === criteria.handle
    );
  return result.status === "trademark" && JSON.stringify(result.research.query) === JSON.stringify(criteria);
}
export const screeningCheckResponseSchema = z
  .strictObject({
    basis: screeningBasisSchema,
    criteria: providerTargetSchema,
    result: standaloneLookupResultSchema,
    completedAt: timestamp,
  })
  .superRefine((value, ctx) => {
    if (!screeningResultMatches(value.criteria, value.result))
      ctx.addIssue({ code: "custom", message: "A lookup must match its exact criteria." });
  });
export type ScreeningCheckResponse = z.infer<typeof screeningCheckResponseSchema>;
