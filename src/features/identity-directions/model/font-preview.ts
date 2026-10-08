import { z } from "zod";
import { identityTypographyVersionSchema, type FontRecord } from "@/domain/logo-directions";
import { logoHashSchema, logoUuidSchema, logoVectorDocumentSchema, type LogoVectorDocument } from "@/domain/logo-vector";
import { validateLogoVectorDocument } from "@/features/logo-vector/model/geometry";

export const FONT_PREVIEW_REQUEST_BYTES = 4096;
export const FONT_PREVIEW_RESPONSE_BYTES = 1_048_576;
export const fontPreviewInputSchema = identityTypographyVersionSchema.shape.styles.element.pick({ sampleText: true, weight: true, style: true, sizePx: true, lineHeight: true }).extend({
  fontContentHash: logoHashSchema,
  rightsEvidenceId: logoUuidSchema,
}).strict();
export type FontPreviewInput = z.infer<typeof fontPreviewInputSchema>;
export const fontPreviewUnavailableSchema = z.enum(["sample_unsupported", "style_unsupported", "missing_glyphs", "outline_permission_required"]);
export type FontPreviewUnavailable = z.infer<typeof fontPreviewUnavailableSchema>;
const geometrySchema = logoVectorDocumentSchema.refine(document => document.components.length === 1 && document.components.every(component =>
  component.editingKind === "geometry" && component.transform.x === 0 && component.transform.y === 0 && component.transform.scale === 1 && component.transform.rotation === 0
  && component.paths.every(path => path.stroke === null && path.fill?.color === "#000000" && path.fill.opacity === 1)), "Only passive monochrome specimen paths are supported.");
export const fontPreviewResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready"), document: geometrySchema }),
  z.strictObject({ status: z.literal("unavailable"), reason: fontPreviewUnavailableSchema }),
]);
export type FontPreviewResult = z.infer<typeof fontPreviewResultSchema>;
export const fontPreviewResponseSchema = z.strictObject({
  ownerId: logoUuidSchema, projectId: logoUuidSchema, fontVersionId: logoUuidSchema,
  input: fontPreviewInputSchema, result: fontPreviewResultSchema,
});
export type FontPreviewResponse = z.infer<typeof fontPreviewResponseSchema>;
export type FontPreviewReader = (font: FontRecord, input: FontPreviewInput, signal: AbortSignal) => Promise<FontPreviewResult | null>;
export function validateFontPreviewGeometry(document: LogoVectorDocument): LogoVectorDocument {
  return validateLogoVectorDocument(geometrySchema.parse(document));
}
