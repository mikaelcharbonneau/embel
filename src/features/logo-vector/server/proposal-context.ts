import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fontRecordSchema, type FontRecord } from "../../../domain/logo-directions";
import { logoVectorProposalContextSchema, type LogoVectorProposalComponent, type LogoVectorProposalContext } from "../../../domain/logo-vector-proposals";
import { logoBriefRevisionSchema, type LogoBriefRevision } from "../../../domain/logo-workspace";
import { logoVectorRevisionSchema, sameLogoScope, type LogoVectorComponent, type LogoVectorDocument, type LogoVectorRevision } from "../../../domain/logo-vector";
import { fontPurposeAllowed } from "../../identity-directions/model/font-rights";
import { canonicalLogoDocumentBytes } from "../model/canonical";
import { getLogoComponentPaintedBounds, validateLogoVectorDocument } from "../model/geometry";
import { assertLogoComponentLocks } from "../model/locks";
import { getLogoVectorProposalComponentOperations } from "../model/proposal";
import { serializeLogoSvg } from "../model/svg";
import { LogoVectorError } from "../model/errors";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const mismatch = (): never => { throw new LogoVectorError("source_mismatch", "The context must bind the exact verified owned vector, brief and font records."); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
function summarizePaint(component: LogoVectorComponent): LogoVectorProposalComponent["paint"] {
  const first = component.paths[0]!;
  if (component.paths.some(path => (path.fill?.color ?? null) !== (first.fill?.color ?? null) || (path.stroke?.color ?? null) !== (first.stroke?.color ?? null))) return { status: "nonuniform" };
  return { status: "uniform", fill: first.fill?.color ?? null, stroke: first.stroke?.color ?? null,
    textUniform: component.paths.every(path => isDeepStrictEqual(path.fill, first.fill) && isDeepStrictEqual(path.stroke, first.stroke)) };
}

/** Pure summary after verified owned reads. This rechecks bindings, but does not authenticate records, read bytes or grant candidate authority. */
export function buildLogoVectorProposalContext(input: {
  revision: LogoVectorRevision; document: LogoVectorDocument; brief: LogoBriefRevision;
  fonts: readonly FontRecord[]; targetComponentIds: readonly string[];
}): LogoVectorProposalContext {
  const revisionResult = logoVectorRevisionSchema.safeParse(input.revision), briefResult = logoBriefRevisionSchema.safeParse(input.brief);
  if (!revisionResult.success || !briefResult.success || briefResult.data.stage !== "brief_references") return mismatch();
  const revision = revisionResult.data, brief = briefResult.data, document = validateLogoVectorDocument(input.document);
  const documentHash = digest(canonicalLogoDocumentBytes(document)), svgContentHash = digest(serializeLogoSvg(document));
  const proof = { version: 1, documentHash, svgContentHash, validator: { id: "fluid.logo-vector", version: "1" }, viewBox: document.viewBox,
    pathCount: document.components.reduce((n, component) => n + component.paths.length, 0), componentCount: document.components.length, externalFontDependencies: [] };
  if (documentHash !== revision.documentHash || !isDeepStrictEqual(proof, revision.proof) || !sameLogoScope(revision, brief)) return mismatch();
  assertLogoComponentLocks(document, document, revision.locks);
  const refs = revision.inputRevisions.filter(ref => ref.stage === "brief_references");
  if (refs.length !== 1 || refs[0]!.id !== brief.id || refs[0]!.revision !== brief.revision) return mismatch();
  if (!Array.isArray(input.fonts) || input.fonts.length > 100) return mismatch();
  const fontRecords: FontRecord[] = [];
  for (const value of input.fonts) {
    const parsed = fontRecordSchema.safeParse(value);
    if (!parsed.success || !sameLogoScope(revision, parsed.data.asset) || fontRecords.some(record => record.id === parsed.data.id)) return mismatch();
    fontRecords.push(parsed.data);
  }
  const permitted = fontRecords.filter(record => fontPurposeAllowed(record, "render") && fontPurposeAllowed(record, "outline"));
  const fonts = permitted.map(record => ({ id: record.id, family: record.family, source: record.source,
    assetVersionId: record.asset.versionId, fontContentHash: record.asset.contentHash, rightsEvidenceId: record.rights.id, recordHash: digest(canonical(record)) }));
  const components = document.components.map(component => {
    const paint = summarizePaint(component);
    let text: LogoVectorProposalComponent["text"] = null;
    if (component.editingKind === "editable_text") {
      const source = component.textSource;
      if (!sameLogoScope(revision, source.font) || source.contentKind === "brand_name" && source.text !== brief.payload.name) return mismatch();
      const matches = permitted.filter(record => isDeepStrictEqual(record.asset, source.font) && record.rights.id === source.rightsEvidenceId);
      if (matches.length > 1) return mismatch();
      text = { text: source.text, contentKind: source.contentKind, fontVersionId: matches[0]?.id ?? null,
        fontAssetVersionId: source.font.versionId, fontContentHash: source.font.contentHash, rightsEvidenceId: source.rightsEvidenceId,
        faceIndex: source.faceIndex, size: source.size, variationAxes: source.variationAxes, featureTags: source.featureTags,
        language: source.language, script: source.script, direction: source.direction, letterSpacing: source.letterSpacing,
        lineHeight: source.lineHeight, shapingEngine: source.shapingEngine };
    }
    const summary = { id: component.id, role: component.role, editingKind: component.editingKind, transform: component.transform,
      paintedBounds: getLogoComponentPaintedBounds(component),
      localPaintedBounds: getLogoComponentPaintedBounds({ ...component, transform: { x: 0, y: 0, scale: 1, rotation: 0 } }), paint, text };
    return { ...summary, allowedOperations: getLogoVectorProposalComponentOperations(summary, revision.locks.some(lock => lock.componentId === component.id)) };
  });
  const allowed = new Set(components.filter(component => input.targetComponentIds.includes(component.id)).flatMap(component => component.allowedOperations));
  const result = logoVectorProposalContextSchema.safeParse({ version: 1, ownerId: revision.ownerId, projectId: revision.projectId,
    baseVectorRevisionId: revision.id, documentHash: revision.documentHash, source: revision.source, viewBox: document.viewBox,
    locks: revision.locks, inputRevisions: revision.inputRevisions,
    brief: { id: brief.id, revision: brief.revision, inputHash: brief.inputHash, name: brief.payload.name },
    components, fonts, targetComponentIds: [...input.targetComponentIds], allowedOperations: [...allowed] });
  if (!result.success) throw new LogoVectorError("unsupported_edit", "The complete exact proposal context is invalid or exceeds its 65,536-byte limit. Nothing was truncated.");
  return result.data;
}
