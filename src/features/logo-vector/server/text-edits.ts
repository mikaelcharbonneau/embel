import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fontRecordSchema, type FontRecord, type PermittedFont } from "../../../domain/logo-directions";
import { logoConceptBatchSchema, logoRasterRefinementSchema, type LogoConceptBatch, type LogoRasterRefinement } from "../../../domain/logo-jobs";
import { logoBriefRevisionSchema, type LogoBriefRevision } from "../../../domain/logo-workspace";
import { logoManualEditSchema, logoTextSourceSchema, logoVectorRevisionSchema, type LogoManualEdit, type LogoTextSource, type LogoVectorDocument, type LogoVectorPath, type LogoVectorRevision } from "../../../domain/logo-vector";
import type { AuthenticatedContext } from "../../../server/auth/context";
import { logoId, logoOwner } from "../../../server/data/logo-transaction";
import { canonicalizeLogoPath, encodeLogoPath, getLogoPathPaintedBounds, validateLogoVectorDocument } from "../model/geometry";
import { canonicalLogoDocumentBytes } from "../model/canonical";
import { LogoVectorError } from "../model/errors";
import { VECTOR_LIMITS } from "../model/limits";
import { assertLogoComponentLocks } from "../model/locks";
import { shapeLogoText } from "./text";

export type LogoTextEditDependencies = {
  readBriefRevision(auth: AuthenticatedContext, projectId: string, revisionId: string, signal?: AbortSignal): Promise<LogoBriefRevision>;
  readConceptBatch(auth: AuthenticatedContext, projectId: string, batchId: string, signal?: AbortSignal): Promise<LogoConceptBatch>;
  readRasterRefinement(auth: AuthenticatedContext, projectId: string, rasterRevisionId: string, signal?: AbortSignal): Promise<LogoRasterRefinement>;
  listFonts(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal): Promise<readonly FontRecord[]>;
  resolveFont(auth: AuthenticatedContext, fontVersionId: string, purpose: "outline", signal?: AbortSignal): Promise<PermittedFont>;
};
const active = (signal: AbortSignal) => { if (signal.aborted) throw new LogoVectorError("cancelled", "Text editing was cancelled."); };
const mismatch = (): never => { throw new LogoVectorError("source_mismatch", "The text edit must use its exact owned brief, source and font version."); };
const unsupported = (reason: string): never => { throw new LogoVectorError("unsupported_edit", reason); };
const rightsRequired = (): never => { throw new LogoVectorError("font_rights_required", "The exact owned font and its reviewed render/outline rights are required."); };
function bounds(paths: readonly LogoVectorPath[]) {
  const ink = paths.map(getLogoPathPaintedBounds).filter(item => item !== null);
  if (!ink.length) return unsupported("The lettering has no visible geometry to replace.");
  return { x: Math.min(...ink.map(item => item.minX)), y: Math.min(...ink.map(item => item.minY)), right: Math.max(...ink.map(item => item.maxX)), bottom: Math.max(...ink.map(item => item.maxY)) };
}
/** No language is inferred from a brand name. The engine checks every character,
 * bidi class, feature, axis and glyph against this conservative single run. */
function replacementRun(text: string): Pick<LogoTextSource, "language" | "script" | "direction"> {
  const scripts = [
    ["Latn", /\p{Script_Extensions=Latin}/u, "ltr"], ["Grek", /\p{Script_Extensions=Greek}/u, "ltr"],
    ["Cyrl", /\p{Script_Extensions=Cyrillic}/u, "ltr"], ["Arab", /\p{Script_Extensions=Arabic}/u, "rtl"], ["Hebr", /\p{Script_Extensions=Hebrew}/u, "rtl"],
  ] as const;
  const strong = [...text].filter(character => /[\p{Letter}\p{Mark}]/u.test(character));
  const match = scripts.find(([, expression]) => strong.length && strong.every(character => expression.test(character)));
  if (!match) return unsupported("This lettering needs an unsupported or mixed-script text layout. The original artwork is preserved.");
  return { language: "und", script: match[0], direction: match[2] };
}
/** New geometry only. The existing producer remains responsible for immutable
 * publication and its locked CAS transaction; this never selects or approves. */
export async function applyLogoTextEdit(input: { auth: AuthenticatedContext; projectId: string; revision: LogoVectorRevision; document: LogoVectorDocument; edit: LogoManualEdit }, deps: LogoTextEditDependencies, signal: AbortSignal): Promise<LogoVectorDocument> {
  active(signal);
  const ownerId = logoOwner(input.auth), projectId = logoId(input.projectId), parsedRevision = logoVectorRevisionSchema.safeParse(input.revision), parsedEdit = logoManualEditSchema.safeParse(input.edit);
  if (!parsedRevision.success) return mismatch();
  if (!parsedEdit.success) return unsupported("The text edit violates the saved command contract.");
  const revision = parsedRevision.data, document = validateLogoVectorDocument(input.document), edit = parsedEdit.data;
  if (revision.ownerId !== ownerId || revision.projectId !== projectId || createHash("sha256").update(canonicalLogoDocumentBytes(document)).digest("hex") !== revision.documentHash) return mismatch();
  if (edit.kind !== "replace_outlined_lettering" && edit.kind !== "text" && edit.kind !== "font" && edit.kind !== "spacing") return unsupported("This command is not a text edit.");
  const component = document.components.find(item => item.id === edit.componentId);
  if (!component || component.role !== "lettering" || (edit.kind === "replace_outlined_lettering" ? component.editingKind !== "outlined_custom" : component.editingKind !== "editable_text")) return unsupported("Choose explicitly separated lettering with the matching text controls. Fused artwork cannot be replaced as text.");
  if (revision.locks.some(lock => lock.componentId === component.id)) throw new LogoVectorError("locked_component_changed", "Save an explicit unlock before changing lettering.");
  const refs = revision.inputRevisions.filter(ref => ref.stage === "brief_references");
  // An ambiguous basis must be resolved in the source workflow, never guessed.
  if (refs.length !== 1) return mismatch();
  const ref = refs[0]!, parsedBrief = logoBriefRevisionSchema.safeParse(await deps.readBriefRevision(input.auth, projectId, ref.id, signal)); active(signal);
  if (!parsedBrief.success) return mismatch();
  const brief = parsedBrief.data;
  if (brief.id !== ref.id || brief.revision !== ref.revision || brief.ownerId !== ownerId || brief.projectId !== projectId) return mismatch();
  let logoType: string;
  if (revision.source.kind === "refinement") {
    const parsed = logoRasterRefinementSchema.safeParse(await deps.readRasterRefinement(input.auth, projectId, revision.source.rasterRevisionId, signal)); active(signal);
    if (!parsed.success) return mismatch();
    const raster = parsed.data;
    if (raster.id !== revision.source.rasterRevisionId || raster.ownerId !== ownerId || raster.projectId !== projectId || !isDeepStrictEqual(raster.preview?.reference, revision.sourcePreview) || !isDeepStrictEqual(raster.inputRevisions, revision.inputRevisions)) return mismatch();
    logoType = raster.logoType;
  } else {
    const source = revision.source, parsed = logoConceptBatchSchema.safeParse(await deps.readConceptBatch(input.auth, projectId, source.batchId, signal)); active(signal);
    if (!parsed.success) return mismatch();
    const batch = parsed.data, slot = batch.slots.find(item => item.id === source.slotId), attempt = slot?.attempts.find(item => item.id === source.attemptId);
    if (batch.id !== source.batchId || batch.ownerId !== ownerId || batch.projectId !== projectId || batch.briefRevisionId !== brief.id || !isDeepStrictEqual(attempt?.preview?.reference, revision.sourcePreview) || !slot) return mismatch();
    logoType = slot.type;
  }
  const originalText = component.editingKind === "editable_text" ? component.textSource : null;
  const contentKind = edit.kind === "replace_outlined_lettering" ? edit.contentKind ?? "brand_name" : originalText!.contentKind;
  const text = edit.kind === "text" || edit.kind === "replace_outlined_lettering" ? edit.text : originalText!.text;
  if (contentKind === "approved_initials" && logoType !== "lettermark_monogram") return unsupported("Approved initials are available only for the saved lettermark or monogram source.");
  if (contentKind === "brand_name" && (text !== brief.payload.name || originalText && originalText.text !== brief.payload.name)) return unsupported("Preserve the exact saved brand name. Update the brief and create a new source before changing its spelling.");
  if (edit.kind === "spacing" && edit.lineHeight !== originalText!.lineHeight) return unsupported("Line-height changes are unavailable for single-line lettering. The saved line height is preserved.");
  const paint = component.paths[0]!;
  if (component.paths.some(path => !isDeepStrictEqual(path.fill, paint.fill) || !isDeepStrictEqual(path.stroke, paint.stroke))) return unsupported("Text replacement needs uniform lettering paint. The original multi-paint geometry is preserved.");
  let fontVersionId: string;
  let savedFont: FontRecord | undefined;
  if (originalText) {
    const fonts = await deps.listFonts(input.auth, projectId, signal); active(signal);
    if (fonts.length > 100) return mismatch();
    const records = fonts.map(value => fontRecordSchema.safeParse(value));
    if (records.some(record => !record.success || record.data.asset.ownerId !== ownerId || record.data.asset.projectId !== projectId)) return mismatch();
    const matches = records.flatMap(record => record.success && isDeepStrictEqual(record.data.asset, originalText.font) && record.data.rights.id === originalText.rightsEvidenceId ? [record.data] : []);
    if (matches.length !== 1) return rightsRequired();
    savedFont = matches[0]!;
  }
  if (edit.kind === "font" || edit.kind === "replace_outlined_lettering") fontVersionId = edit.fontVersionId;
  else fontVersionId = savedFont!.id;
  const resolved = await deps.resolveFont(input.auth, fontVersionId, "outline", signal); active(signal);
  const parsedFont = fontRecordSchema.safeParse(resolved.record);
  if (!parsedFont.success) return rightsRequired();
  const record = parsedFont.data;
  if (record.id !== fontVersionId || record.asset.ownerId !== ownerId || record.asset.projectId !== projectId || savedFont && edit.kind !== "font" && !isDeepStrictEqual(savedFont, record)) return mismatch();
  const textSource: LogoTextSource = originalText ? { ...originalText, text, font: record.asset, rightsEvidenceId: record.rights.id,
    ...(edit.kind === "spacing" ? { letterSpacing: edit.letterSpacing, lineHeight: edit.lineHeight } : {}) } : {
    text, contentKind, font: record.asset, rightsEvidenceId: record.rights.id, faceIndex: 0, size: 100, variationAxes: {}, featureTags: {}, ...replacementRun(text), letterSpacing: 0, lineHeight: 1, shapingEngine: { id: "harfbuzzjs", version: "1.6.2" },
  };
  const shaped = await shapeLogoText({ source: textSource, font: resolved }, signal); active(signal);
  const painted = shaped.paths.map(path => ({ ...path, fill: paint.fill, stroke: paint.stroke }));
  const oldBounds = bounds(component.paths), newBounds = bounds(painted);
  let fit = 1;
  if (edit.kind === "replace_outlined_lettering") {
    // A stroke's absolute width is preserved. It cannot safely be included in a
    // glyph-body fit without a separately qualified stroke-layout operation.
    if (paint.stroke) return unsupported("Stroked custom lettering cannot yet be fitted to font outlines without changing its paint. The original is preserved.");
    fit = Math.min((oldBounds.right - oldBounds.x) / (newBounds.right - newBounds.x), (oldBounds.bottom - oldBounds.y) / (newBounds.bottom - newBounds.y));
    textSource.size *= fit;
    if (!Number.isFinite(textSource.size) || textSource.size <= 0 || textSource.size > VECTOR_LIMITS.dimension) throw new LogoVectorError("limit_exceeded", "Fitting this lettering would require an unsupported font size. The original artwork is preserved.");
  }
  const reserved = new Set(document.components.filter(item => item.id !== component.id).flatMap(item => item.paths.map(path => path.id)));
  const paths = painted.map((path, index) => {
    let counter = 0, id = `lettering-glyph-${index}`;
    while (reserved.has(id)) id = `lettering-glyph-${index}-${++counter}`;
    reserved.add(id);
    return { ...path, id, d: encodeLogoPath(canonicalizeLogoPath(path.d, [fit, 0, 0, fit, oldBounds.x - newBounds.x * fit, oldBounds.y - newBounds.y * fit])), fill: paint.fill, stroke: paint.stroke };
  });
  const candidate = validateLogoVectorDocument({ ...document, components: document.components.map(item => item.id === component.id ? { ...item, editingKind: "editable_text", textSource: logoTextSourceSchema.parse(textSource), paths } : item) });
  assertLogoComponentLocks(document, candidate, revision.locks);
  return candidate;
}
