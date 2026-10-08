import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { buildLogoVectorProposalContext } from "../../../src/features/logo-vector/server/proposal-context";
import { logoVectorProposalContextSchema, LOGO_VECTOR_PROPOSAL_CONTEXT_MAX_BYTES } from "../../../src/domain/logo-vector-proposals";
import { captureLogoComponentLocks } from "../../../src/features/logo-vector/model/locks";
import { logoJsonBytes } from "../../../src/domain/logo-vector";
import { proposalFixture, proposalId } from "./proposal-fixtures";

describe("exact metadata-only vector proposal context", () => {
  it("binds the actual revision, brief, saved locks, component order, paint and owned font evidence", () => {
    const f = proposalFixture(true); f.seal(["synthetic-symbol"]);
    const context = buildLogoVectorProposalContext(f);
    expect(context).toMatchObject({ version: 1, ownerId: f.revision.ownerId, projectId: f.revision.projectId, baseVectorRevisionId: f.revision.id,
      documentHash: f.revision.documentHash, locks: f.revision.locks, inputRevisions: f.revision.inputRevisions,
      brief: { id: f.brief.id, revision: f.brief.revision, inputHash: f.brief.inputHash, name: "Aster" } });
    expect(context.components.map(c => c.id)).toEqual(f.document.components.map(c => c.id));
    expect(context.components[0]).toMatchObject({ role: "symbol", editingKind: "geometry", transform: f.document.components[0]!.transform, paintedBounds: { minX: 20, minY: 20, maxX: 60, maxY: 60 }, paint: { status: "uniform", fill: "#DB2777", stroke: null }, allowedOperations: [] });
    expect(context.components[1]!.text).toMatchObject({ text: "Aster", contentKind: "brand_name", fontVersionId: f.fonts[0]!.id, size: 40, letterSpacing: 0, lineHeight: 1 });
    expect(context.fonts.map(font => font.id)).toEqual(f.fonts.map(font => font.id));
    expect(context.fonts[0]).toMatchObject({ family: "Synthetic A", assetVersionId: f.fonts[0]!.asset.versionId, fontContentHash: f.fonts[0]!.asset.contentHash, rightsEvidenceId: f.fonts[0]!.rights.id });
    expect(context.components[1]!.allowedOperations).toEqual(expect.arrayContaining(["font", "spacing"]));
  });
  it("freezes a detached JSON context and never discloses paths, font bytes, rights URLs or storage paths", () => {
    const f = proposalFixture(true), context = buildLogoVectorProposalContext(f), serialized = JSON.stringify(context);
    expect(serialized).not.toContain("M 20"); expect(serialized).not.toContain("M 85"); expect(serialized).not.toContain("https://");
    for (const forbidden of ["paths", "d", "bytes", "sourceUrl", "storagePath", "svg", "sourcePreview", "documentAsset", "svgAsset"]) {
      const walk = (value: unknown): void => { if (value && typeof value === "object") { expect(Object.keys(value)).not.toContain(forbidden); Object.values(value).forEach(walk); } }; walk(context);
    }
    expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.components[1]!.text)).toBe(true);
    f.document.components[0]!.transform.scale = 2; f.fonts[0]!.family = "Mutated"; f.brief.payload.name = "Mutated";
    expect(context.components[0]!.transform.scale).toBe(1); expect(context.fonts[0]!.family).toBe("Synthetic A"); expect(context.brief.name).toBe("Aster");
    expect(logoVectorProposalContextSchema.safeParse(JSON.parse(serialized)).success).toBe(true);
  });
  it.each(["owner", "project", "brief_id", "brief_revision", "brief_ambiguous", "document_hash", "proof_count", "proof_canvas", "proof_svg", "stale_locks"])("rejects mismatched %s binding before summarizing", alteration => {
    const f = proposalFixture(true);
    if (alteration === "owner") f.brief.ownerId = proposalId(90);
    if (alteration === "project") f.brief.projectId = proposalId(90);
    if (alteration === "brief_id") f.brief.id = proposalId(90);
    if (alteration === "brief_revision") { f.brief.revision = 2; f.brief.parentRevisionId = proposalId(90); }
    if (alteration === "brief_ambiguous") f.revision.inputRevisions.push({ stage: "brief_references", id: proposalId(90), revision: 1 });
    if (alteration === "document_hash") f.document.components[0]!.paths[0]!.fill!.color = "#000000";
    if (alteration === "proof_count") f.revision.proof.componentCount++;
    if (alteration === "proof_canvas") f.revision.proof.viewBox = [0, 0, 999, 500];
    if (alteration === "proof_svg") f.revision.proof.svgContentHash = f.revision.svgAsset.contentHash = "e".repeat(64);
    if (alteration === "stale_locks") { f.revision.locks = structuredClone([...captureLogoComponentLocks(f.document, ["synthetic-symbol"])]); f.revision.locks[0]!.geometryHash = "e".repeat(64); }
    expect(() => buildLogoVectorProposalContext(f)).toThrow();
  });
  it("requires nonempty unique actual targets, without renamed or inferred parts", () => {
    for (const targets of [[], ["synthetic-symbol", "synthetic-symbol"], ["face"], ["synthetic-symbol", "missing"]]) expect(() => buildLogoVectorProposalContext({ ...proposalFixture(), targetComponentIds: targets })).toThrow();
    const f = proposalFixture(); f.document.components[0]!.id = "renamed"; f.seal();
    expect(() => buildLogoVectorProposalContext(f)).toThrow();
  });
  it("retains a whole-artwork mascot as one actual geometry component", () => {
    const f = proposalFixture(); f.document.components = [{ ...f.document.components[0]!, id: "whole-mascot", role: "whole_artwork" }]; f.brief.payload.logoTypes = ["mascot"]; f.targetComponentIds = ["whole-mascot"]; f.seal();
    const context = buildLogoVectorProposalContext(f);
    expect(context.components).toHaveLength(1); expect(context.components[0]).toMatchObject({ id: "whole-mascot", role: "whole_artwork", text: null });
    expect(context.components[0]!.allowedOperations).toEqual(expect.arrayContaining(["size", "rotation"])); expect(context.components[0]!.allowedOperations).not.toContain("font");
  });
  it("does not convert outlined or fused lettering into editable text", () => {
    const f = proposalFixture(), context = buildLogoVectorProposalContext(f);
    expect(context.components[1]!.text).toBeNull(); expect(context.components[1]!.allowedOperations).not.toContain("font"); expect(context.components[1]!.allowedOperations).not.toContain("spacing");
    const editable = proposalFixture(true); editable.document.components[1]!.role = "whole_artwork"; editable.seal();
    expect(buildLogoVectorProposalContext(editable).components[1]!.allowedOperations).not.toContain("font");
  });
  it("preserves exact spelling without normalization and rejects a different saved brand name", () => {
    const f = proposalFixture(true); const c = f.document.components[1]!; if (c.editingKind !== "editable_text") throw new Error();
    c.textSource.text = f.brief.payload.name = "A\u0301ster"; f.seal();
    expect(buildLogoVectorProposalContext(f).components[1]!.text!.text).toBe("A\u0301ster");
    f.brief.payload.name = "Áster"; expect(() => buildLogoVectorProposalContext(f)).toThrow();
  });
  it("keeps exact saved initials separate from the unchanged full brand name", () => {
    const f = proposalFixture(true); const c = f.document.components[1]!; if (c.editingKind !== "editable_text") throw new Error();
    c.textSource.contentKind = "approved_initials"; c.textSource.text = "AS"; f.brief.payload.logoTypes = ["lettermark_monogram"]; f.seal();
    const context = buildLogoVectorProposalContext(f); expect(context.brief.name).toBe("Aster"); expect(context.components[1]!.text).toMatchObject({ text: "AS", contentKind: "approved_initials" });
  });
  it("rejects foreign/duplicate font identities and excludes unqualified rights without inventing a font", () => {
    const foreign = proposalFixture(true); foreign.fonts[0]!.asset.ownerId = proposalId(90); expect(() => buildLogoVectorProposalContext(foreign)).toThrow();
    const duplicate = proposalFixture(); duplicate.fonts.push(structuredClone(duplicate.fonts[0]!)); expect(() => buildLogoVectorProposalContext(duplicate)).toThrow();
    const denied = proposalFixture(true); denied.fonts[0]!.rights.permissions.outline = "denied"; const context = buildLogoVectorProposalContext(denied);
    expect(context.fonts.map(f => f.id)).toEqual([denied.fonts[1]!.id]); expect(context.components[1]!.allowedOperations).not.toContain("font"); expect(context.components[1]!.text!.fontVersionId).toBeNull();
  });
  it("requires exact current font asset/hash and rights, rather than a matching family", () => {
    const f = proposalFixture(true); const c = f.document.components[1]!; if (c.editingKind !== "editable_text") throw new Error();
    c.textSource.rightsEvidenceId = proposalId(90); f.seal(); const context = buildLogoVectorProposalContext(f);
    expect(context.components[1]!.text!.fontVersionId).toBeNull(); expect(context.components[1]!.allowedOperations).not.toContain("spacing");
  });
  it("distinguishes uniform recolor eligibility from stricter uniform text paint", () => {
    const f = proposalFixture(true); const c = f.document.components[1]!; c.paths.push({ ...structuredClone(c.paths[0]!), id: "second-letter", fill: { color: "#111827", opacity: 0.4 } }); f.seal();
    const context = buildLogoVectorProposalContext(f); expect(context.components[1]!.paint).toMatchObject({ status: "uniform", fill: "#111827", stroke: null, textUniform: false });
    expect(context.components[1]!.allowedOperations).toContain("color"); expect(context.components[1]!.allowedOperations).not.toContain("font");
  });
  it("fails closed at the full context byte/record limits without truncating", () => {
    expect(LOGO_VECTOR_PROPOSAL_CONTEXT_MAX_BYTES).toBe(65536);
    const f = proposalFixture(true); f.fonts = Array.from({ length: 101 }, (_, n) => ({ ...structuredClone(f.fonts[0]!), id: proposalId(100 + n) }));
    expect(() => buildLogoVectorProposalContext(f)).toThrow();
    const base = proposalFixture(true), source = base.document.components[1]!;
    base.document.components = Array.from({ length: 64 }, (_, n) => ({ ...structuredClone(source), id: `c${n}${"x".repeat(195)}`, paths: source.paths.map(p => ({ ...structuredClone(p), id: `p${n}` })) }));
    for (const c of base.document.components) if (c.editingKind === "editable_text") c.textSource.variationAxes = Object.fromEntries(Array.from({ length: 64 }, (_, n) => [`a${String(n).padStart(3, "0")}`, 1e-300]));
    base.targetComponentIds = base.document.components.map(c => c.id); base.seal();
    expect(() => buildLogoVectorProposalContext(base)).toThrow();
    const context = buildLogoVectorProposalContext(proposalFixture(true)); expect(logoJsonBytes(context)).toBeLessThanOrEqual(65536);
    expect(logoVectorProposalContextSchema.safeParse({ ...context, paths: [] }).success).toBe(false);
  });
});
