import "server-only";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import { logoId, logoOwner } from "@/server/data/logo-transaction";
import { fontRecordSchema } from "@/domain/logo-directions";
import type { LogoTextSource, LogoVectorDocument } from "@/domain/logo-vector";
import { shapeLogoText } from "@/features/logo-vector/server/text";
import { getLogoPathPaintedBounds } from "@/features/logo-vector/model/geometry";
import { LogoVectorError } from "@/features/logo-vector/model/errors";
import { VECTOR_LIMITS } from "@/features/logo-vector/model/limits";
import { createFontResolver, type FontResolverDependencies } from "./fonts";
import { inspectFontBytes } from "./font-inspection";
import { fontPurposeAllowed } from "../model/font-rights";
import { FONT_PREVIEW_RESPONSE_BYTES, fontPreviewInputSchema, fontPreviewResponseSchema, validateFontPreviewGeometry, type FontPreviewResponse, type FontPreviewUnavailable } from "../model/font-preview";

/** Conservative single-script layout; the qualified shaper independently checks
 * every character, bidi class and glyph. No language or fallback face is guessed. */
function specimenRun(text: string): Pick<LogoTextSource, "language" | "script" | "direction"> | null {
  if ([...text].length > 200 || /[\p{Control}\p{Format}\p{Line_Separator}\p{Paragraph_Separator}\p{Surrogate}]/u.test(text)) return null;
  const scripts = [["Latn", /\p{Script_Extensions=Latin}/u, "ltr"], ["Grek", /\p{Script_Extensions=Greek}/u, "ltr"], ["Cyrl", /\p{Script_Extensions=Cyrillic}/u, "ltr"], ["Arab", /\p{Script_Extensions=Arabic}/u, "rtl"], ["Hebr", /\p{Script_Extensions=Hebrew}/u, "rtl"]] as const;
  const strong = [...text].filter(character => /[\p{Letter}\p{Mark}]/u.test(character));
  const script = scripts.find(([, pattern]) => strong.every(character => pattern.test(character)));
  return script ? { language: "und", script: script[0], direction: script[2] } : null;
}

/** Read-only derived preview: existing ownership, immutable bytes and actual
 * license verification stay authoritative. No registration, selection or upload. */
export function createOwnedFontPreview(dependencies: FontResolverDependencies) {
  return async (auth: AuthenticatedContext, projectId: string, fontVersionId: string, rawInput: unknown, signal: AbortSignal): Promise<FontPreviewResponse> => {
    signal.throwIfAborted();
    const ownerId = logoOwner(auth); projectId = logoId(projectId); fontVersionId = logoId(fontVersionId);
    const parsed = fontPreviewInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ApiError("invalid_input");
    const input = parsed.data, record = fontRecordSchema.parse(await dependencies.loadRecord(auth, fontVersionId, signal));
    signal.throwIfAborted();
    if (record.id !== fontVersionId || record.asset.ownerId !== ownerId || record.asset.projectId !== projectId || record.asset.contentHash !== input.fontContentHash || record.rights.id !== input.rightsEvidenceId) throw new ApiError("not_found");
    const binding = { ownerId, projectId, fontVersionId, input };
    const unavailable = (reason: FontPreviewUnavailable): FontPreviewResponse => ({ ...binding, result: { status: "unavailable", reason } });
    if (!fontPurposeAllowed(record, "render") || !fontPurposeAllowed(record, "outline")) return unavailable("outline_permission_required");
    const run = specimenRun(input.sampleText);
    if (!run || input.sizePx * input.lineHeight > VECTOR_LIMITS.dimension) return unavailable("sample_unsupported");
    const resolve = createFontResolver({ ...dependencies, loadRecord: async () => record });
    const font = await resolve(auth, fontVersionId, "outline", signal);
    signal.throwIfAborted();
    const mime = Buffer.from(font.bytes.subarray(0, 4)).toString("latin1") === "OTTO" ? "font/otf" : "font/ttf";
    const inspected = await inspectFontBytes(font.bytes, mime, signal), weight = inspected.variations.wght;
    signal.throwIfAborted();
    if ((weight ? input.weight < weight.min || input.weight > weight.max : input.weight !== inspected.weight) || inspected.italic !== (input.style === "italic")) return unavailable("style_unsupported");
    const points = new Set(inspected.codePoints);
    if ([...input.sampleText].some(character => !points.has(character.codePointAt(0)!))) return unavailable("missing_glyphs");
    const source: LogoTextSource = { text: input.sampleText, contentKind: "brand_name", font: record.asset, rightsEvidenceId: record.rights.id, faceIndex: 0, size: input.sizePx,
      variationAxes: weight ? { wght: input.weight } : {}, featureTags: {}, ...run, letterSpacing: 0, lineHeight: input.lineHeight, shapingEngine: { id: "harfbuzzjs", version: "1.6.2" } };
    try {
      const shaped = await shapeLogoText({ source, font }, signal); signal.throwIfAborted();
      const ink = shaped.paths.map(getLogoPathPaintedBounds);
      if (ink.some(bounds => !bounds)) return unavailable("sample_unsupported");
      const bounds = ink.filter(value => value !== null), pad = Math.max(1, input.sizePx / 10);
      const x = Math.min(...bounds.map(value => value.minX)) - pad, y = Math.min(...bounds.map(value => value.minY)) - pad;
      const width = Math.max(...bounds.map(value => value.maxX)) - x + pad;
      const height = Math.max(Math.max(...bounds.map(value => value.maxY)) - y + pad, input.sizePx * input.lineHeight);
      if (width > VECTOR_LIMITS.dimension || height > VECTOR_LIMITS.dimension) return unavailable("sample_unsupported");
      const document: LogoVectorDocument = { version: 1, viewBox: [x, y, width, height], components: [{ id: "font-specimen", role: "lettering", editingKind: "geometry", transform: { x: 0, y: 0, scale: 1, rotation: 0 }, paths: [...shaped.paths] }] };
      const response = fontPreviewResponseSchema.parse({ ...binding, result: { status: "ready", document: validateFontPreviewGeometry(document) } });
      if (Buffer.byteLength(JSON.stringify(response)) > FONT_PREVIEW_RESPONSE_BYTES) return unavailable("sample_unsupported");
      signal.throwIfAborted(); return response;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof LogoVectorError && ["unsupported_text", "empty_artwork", "limit_exceeded", "invalid_geometry"].includes(error.code)) return unavailable("sample_unsupported");
      throw error;
    }
  };
}
