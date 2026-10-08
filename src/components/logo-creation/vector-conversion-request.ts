import { logoQuoteRequestSchema, type LogoQuoteRequest } from "@/domain/logo-jobs";
import { logoExpectedHeadsSchema, type LogoExpectedHeads } from "@/domain/logo-workspace";
import { freezeLogoRecord, logoCounterSchema, logoRasterSourceSchema, logoTraceSettingsSchema, logoUuidSchema, type LogoRasterSource } from "@/domain/logo-vector";

/** A local view binding, never an authorization payload sent to the server. */
export type LogoVectorReviewContext = {
  ownerId: string;
  projectId: string;
  generation: number;
  expected: LogoExpectedHeads;
  source: LogoRasterSource | null;
};
type VectorRequest = Extract<LogoQuoteRequest, { operation: "vectorize" }>;

export function captureLogoVectorReviewContext(value: LogoVectorReviewContext | null): LogoVectorReviewContext | null {
  if (!value || !logoUuidSchema.safeParse(value.ownerId).success || !logoUuidSchema.safeParse(value.projectId).success
    || !logoCounterSchema.safeParse(value.generation).success) return null;
  const expected = logoExpectedHeadsSchema.safeParse(value.expected), source = logoRasterSourceSchema.nullable().safeParse(value.source);
  if (!expected.success || !source.success) return null;
  return freezeLogoRecord({ ownerId: value.ownerId, projectId: value.projectId, generation: value.generation,
    expected: expected.data, source: source.data });
}

/** The caller must obtain current context from its verified account/workspace.
 * This client fence supplements the existing authoritative quote/admission checks. */
export function createLogoVectorReviewRequest(captured: LogoVectorReviewContext | null, current: LogoVectorReviewContext | null, settings: unknown): VectorRequest | null {
  const before = captureLogoVectorReviewContext(captured), now = captureLogoVectorReviewContext(current);
  if (!before || !now || !before.source || before.ownerId !== now.ownerId || before.projectId !== now.projectId
    || before.generation !== now.generation || JSON.stringify(before.expected) !== JSON.stringify(now.expected)
    || JSON.stringify(before.source) !== JSON.stringify(now.source)) return null;
  const parsedSettings = logoTraceSettingsSchema.safeParse(settings);
  if (!parsedSettings.success) return null;
  const parsed = logoQuoteRequestSchema.safeParse({ operation: "vectorize", expected: before.expected, source: before.source, settings: parsedSettings.data });
  return parsed.success && parsed.data.operation === "vectorize" ? freezeLogoRecord(parsed.data) : null;
}
