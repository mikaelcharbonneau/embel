import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { canonicalLogoDocumentBytes, validateLogoVectorCandidate, verifyLogoVectorRevision } from "../../../src/features/logo-vector/server/revisions";
import { captureLogoComponentLocks } from "../../../src/features/logo-vector/model/locks";
import { applyLogoManualEdit } from "../../../src/features/logo-vector/model/edits";
import type { LogoVectorRevision } from "../../../src/domain/logo-vector";
import { separatedLogoDocument } from "./fixtures";
import { digestBytes, syntheticConversionInput, syntheticSource } from "./raster-fixtures";
const id = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12,"0")}`;
function fixture() {
  const source = syntheticConversionInput("combination").source, candidate = separatedLogoDocument();
  const result = validateLogoVectorCandidate({ base: null, candidate, locks: [], expectedSource: source.reference, source });
  const document = syntheticSource(canonicalLogoDocumentBytes(candidate), "application/json"), svg = syntheticSource(result.svg, "image/svg+xml");
  document.reference.assetId = id(3); document.reference.versionId = id(4); svg.reference.assetId = id(5); svg.reference.versionId = id(6);
  const revision: LogoVectorRevision = { id: id(1), ownerId: source.reference.ownerId, projectId: source.reference.projectId!, parentRevisionId: null,
    source: { kind: "refinement", rasterRevisionId: id(2) }, sourcePreview: source.reference, documentAsset: document.reference, svgAsset: svg.reference,
    documentHash: result.documentHash, proof: result.proof, locks: [], inputRevisions: [], reviewStatus: "review_required", createdAt: "2026-10-07T00:00:00Z" };
  return { source, candidate, result, document, svg, revision };
}
describe("actual canonical-byte vector proof", () => {
  it("binds actual immutable canonical JSON and passive SVG bytes without an approval", async () => {
    const f = fixture();
    expect(f.result.documentHash).toBe(digestBytes(f.document.bytes));
    expect(f.result.proof.svgContentHash).toBe(digestBytes(f.svg.bytes));
    expect(f.result.proof.externalFontDependencies).toEqual([]);
    expect(await verifyLogoVectorRevision(f)).toEqual(f.candidate);
  });
  it("canonicalizes object order, not component paint order", () => {
    const document = separatedLogoDocument();
    expect(canonicalLogoDocumentBytes({ components: document.components, viewBox: document.viewBox, version: 1 })).toEqual(canonicalLogoDocumentBytes(document));
    expect(canonicalLogoDocumentBytes({ ...document, components: [...document.components].reverse() })).not.toEqual(canonicalLogoDocumentBytes(document));
  });
  it("rejects foreign source, altered bytes and unsupported client proof", () => {
    const f = fixture();
    for (const expectedSource of [{ ...f.source.reference, projectId: id(20) }, { ...f.source.reference, ownerId: id(21) }, { ...f.source.reference, contentHash: "a".repeat(64) }]) {
      expect(() => validateLogoVectorCandidate({ base: null, candidate: f.candidate, locks: [], expectedSource, source: f.source })).toThrowError(expect.objectContaining({ code: "source_mismatch" }));
    }
    f.source.bytes[40] = f.source.bytes[40]! ^ 1;
    expect(() => validateLogoVectorCandidate({ base: null, candidate: f.candidate, locks: [], expectedSource: f.source.reference, source: f.source })).toThrowError(expect.objectContaining({ code: "source_mismatch" }));
  });
  it("rechecks authoritative locks before producing a candidate proof", () => {
    const f = fixture(), locks = captureLogoComponentLocks(f.candidate, ["synthetic-symbol"]);
    const changed = applyLogoManualEdit(f.candidate, { kind: "color", componentId: "synthetic-symbol", fill: "#FFFF00", stroke: null });
    expect(() => validateLogoVectorCandidate({ base: f.candidate, candidate: changed, locks, expectedSource: f.source.reference, source: f.source })).toThrowError(expect.objectContaining({ code: "locked_component_changed" }));
  });
  it("rejects corrupted portable SVG, forged proof and foreign document version", async () => {
    const f = fixture();
    await expect(verifyLogoVectorRevision({ ...f, svg: syntheticSource(new TextEncoder().encode('<svg/>'), "image/svg+xml") })).rejects.toMatchObject({ code: "source_mismatch" });
    await expect(verifyLogoVectorRevision({ ...f, revision: { ...f.revision, proof: { ...f.revision.proof, pathCount: 1 } } })).rejects.toMatchObject({ code: "source_mismatch" });
    await expect(verifyLogoVectorRevision({ ...f, document: { ...f.document, reference: { ...f.document.reference, ownerId: id(22) } } })).rejects.toMatchObject({ code: "source_mismatch" });
  });
});
