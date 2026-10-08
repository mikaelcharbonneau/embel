import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { validateLogoVectorProposal } from "../../../src/features/logo-vector/model/proposal";
import { buildLogoVectorProposalContext } from "../../../src/features/logo-vector/server/proposal-context";
import { applyLogoManualEdit } from "../../../src/features/logo-vector/model/edits";
import { assertLogoComponentLocks } from "../../../src/features/logo-vector/model/locks";
import { LOGO_VECTOR_PROPOSAL_CANDIDATE_CHECKS } from "../../../src/domain/logo-vector-proposals";
import { proposed, proposalFixture, proposalId } from "./proposal-fixtures";

const symbol = "synthetic-symbol", lettering = "synthetic-lettering";
describe("one-command provisional vector proposal validation", () => {
  it.each([
    { kind: "size", componentId: symbol, scale: 0.8 }, { kind: "rotation", componentId: symbol, degrees: 10 },
    { kind: "color", componentId: symbol, fill: "#0011FF", stroke: null }, { kind: "font", componentId: lettering, fontVersionId: proposalId(30) },
    { kind: "spacing", componentId: lettering, letterSpacing: 2, lineHeight: 1 },
    { kind: "arrangement", placements: [{ componentId: symbol, transform: { x: 5, y: 0, scale: 1, rotation: 0 } }, { componentId: lettering, transform: { x: 0, y: 5, scale: 1, rotation: 0 } }], order: [symbol, lettering] },
  ])("accepts one actual $kind intent without issuing an applicable/safe candidate", edit => {
    const f = proposalFixture(true), context = buildLogoVectorProposalContext(f), result = validateLogoVectorProposal(proposed(edit), context);
    expect(result).toEqual(proposed(edit)); expect(Object.keys(result).sort()).toEqual(["edit", "explanation", "status", "version"]);
    expect(result).not.toHaveProperty("safe"); expect(result).not.toHaveProperty("applicable"); expect(result).not.toHaveProperty("candidate");
    expect(LOGO_VECTOR_PROPOSAL_CANDIDATE_CHECKS).toEqual(["exact_owned_base_and_current_heads", "current_saved_locks", "font_rights_bytes_and_shaping", "geometry_and_occlusion", "non_target_preservation"]);
  });
  it("retains an explicit unsupported/no-change response without applying anything", () => {
    const payload = { version: 1, status: "unsupported", code: "multiple_changes", explanation: "Please request size and color separately." };
    expect(validateLogoVectorProposal(payload, buildLogoVectorProposalContext(proposalFixture()))).toEqual(payload);
  });
  it("never picks half a multi-command response or expands an unsupported edit", () => {
    const context = buildLogoVectorProposalContext(proposalFixture(true));
    for (const value of [
      { version: 1, status: "proposed", edits: [{ kind: "size", componentId: symbol, scale: 0.7 }, { kind: "font", componentId: lettering, fontVersionId: proposalId(30) }], explanation: "Two controls" },
      proposed({ kind: "size", componentId: symbol, scale: 0.7, fontVersionId: proposalId(30) }),
      proposed({ kind: "text", componentId: lettering, text: "Another name" }), proposed({ kind: "locks", componentIds: [] }),
      proposed({ kind: "replace_outlined_lettering", componentId: lettering, fontVersionId: proposalId(30), text: "Aster" }),
      proposed({ kind: "group_components", regions: [{ id: "face", role: "symbol", bounds: [0, 0, 50, 50] }] }),
    ]) expect(() => validateLogoVectorProposal(value, context)).toThrow();
  });
  it("rejects foreign, inferred, missing and unselected components", () => {
    const f = proposalFixture(true); f.targetComponentIds = [symbol]; const context = buildLogoVectorProposalContext(f);
    for (const componentId of ["face", "foreign", "missing", lettering]) expect(() => validateLogoVectorProposal(proposed({ kind: "size", componentId, scale: 0.5 }), context)).toThrow();
  });
  it("rejects changed non-target order/placement while preserving all components", () => {
    const f = proposalFixture(); f.targetComponentIds = [symbol]; const context = buildLogoVectorProposalContext(f);
    for (const edit of [
      { kind: "arrangement", placements: [{ componentId: symbol, transform: { x: 5, y: 0, scale: 1, rotation: 0 } }], order: [lettering, symbol] },
      { kind: "arrangement", placements: [{ componentId: lettering, transform: { x: 5, y: 0, scale: 1, rotation: 0 } }], order: [symbol, lettering] },
      { kind: "arrangement", placements: [{ componentId: symbol, transform: { x: 5, y: 0, scale: 1, rotation: 0 } }], order: [symbol] },
    ]) expect(() => validateLogoVectorProposal(proposed(edit), context)).toThrow();
  });
  it("allows an atomic order change of selected components", () => {
    const context = buildLogoVectorProposalContext(proposalFixture());
    const edit = { kind: "arrangement", placements: [{ componentId: symbol, transform: { x: 0, y: 0, scale: 1, rotation: 0 } }], order: [lettering, symbol] };
    expect(validateLogoVectorProposal(proposed(edit), context)).toEqual(proposed(edit));
  });
  it.each(["size", "rotation", "color", "font", "spacing"])("rejects %s on its actually locked target", kind => {
    const f = proposalFixture(true); f.seal([symbol, lettering]); const context = buildLogoVectorProposalContext(f);
    const edits = { size: { kind, componentId: symbol, scale: 0.5 }, rotation: { kind, componentId: symbol, degrees: 10 }, color: { kind, componentId: symbol, fill: "#AAAAAA", stroke: null }, font: { kind, componentId: lettering, fontVersionId: proposalId(30) }, spacing: { kind, componentId: lettering, letterSpacing: 2, lineHeight: 1 } };
    expect(() => validateLogoVectorProposal(proposed(edits[kind as keyof typeof edits]), context)).toThrow();
  });
  it("rejects locked order changes and conservative new occlusion from an unlocked target", () => {
    const f = proposalFixture(); f.seal([lettering]); const context = buildLogoVectorProposalContext(f);
    const edit = { kind: "arrangement", placements: [{ componentId: symbol, transform: { x: 70, y: 0, scale: 1, rotation: 0 } }], order: [symbol, lettering] };
    expect(() => validateLogoVectorProposal(proposed(edit), context)).toThrow();
    expect(() => validateLogoVectorProposal(proposed({ ...edit, placements: [{ componentId: symbol, transform: { x: 0, y: 0, scale: 1, rotation: 0 } }], order: [lettering, symbol] }), context)).toThrow();
  });
  it("checks raw arrangement transform changes against saved lock digests even at equivalent rotations", () => {
    const f = proposalFixture();
    f.document.components[1]!.transform = { x: 160, y: 100, scale: 1, rotation: -180 };
    f.document.components.push({ ...structuredClone(f.document.components[0]!), id: "third", transform: { x: 300, y: 0, scale: 1, rotation: 0 }, paths: [{ ...structuredClone(f.document.components[0]!.paths[0]!), id: "third-path" }] });
    f.targetComponentIds = [lettering, "third"]; f.seal([symbol]);
    const edit = { kind: "arrangement" as const, placements: [
      { componentId: lettering, transform: { ...f.document.components[1]!.transform, rotation: 180 } },
      { componentId: "third", transform: { x: 310, y: 0, scale: 1, rotation: 0 } },
    ], order: [symbol, lettering, "third"] };
    const candidate = applyLogoManualEdit(f.document, edit);
    expect(() => assertLogoComponentLocks(f.document, candidate, f.revision.locks)).toThrow();
    expect(() => validateLogoVectorProposal(proposed(edit), buildLogoVectorProposalContext(f))).toThrow();
  });
  it("does not call unrelated locked geometry a blanket text prohibition", () => {
    const f = proposalFixture(true); f.seal([symbol]); const context = buildLogoVectorProposalContext(f);
    const payload = proposed({ kind: "font", componentId: lettering, fontVersionId: proposalId(30) });
    expect(validateLogoVectorProposal(payload, context)).toEqual(payload); expect(context.locks).toEqual(f.revision.locks);
  });
  it("rejects text intent with an existing conservative saved-lock overlap", () => {
    const f = proposalFixture(true); f.document.components[1]!.transform.x = -65; f.seal([symbol]);
    const context = buildLogoVectorProposalContext(f);
    expect(() => validateLogoVectorProposal(proposed({ kind: "font", componentId: lettering, fontVersionId: proposalId(30) }), context)).toThrow();
  });
  it("rejects ambiguous multi-color or mixed-presence painting", () => {
    for (const fill of [{ color: "#00FF00", opacity: 1 }, null]) {
      const f = proposalFixture(); const component = f.document.components[0]!; component.paths.push({ ...structuredClone(component.paths[0]!), id: "second", fill }); f.seal();
      const context = buildLogoVectorProposalContext(f); expect(context.components[0]!.paint.status).toBe("nonuniform");
      expect(() => validateLogoVectorProposal(proposed({ kind: "color", componentId: symbol, fill: "#0011FF", stroke: null }), context)).toThrow();
    }
  });
  it("preserves existing null channels, per-path opacity and stroke attributes", () => {
    const f = proposalFixture(); const c = f.document.components[0]!; c.paths[0]!.stroke = { color: "#001122", opacity: 0.5, width: 2, linecap: "round", linejoin: "bevel", miterLimit: 3 };
    c.paths.push({ ...structuredClone(c.paths[0]!), id: "second", fill: { color: "#DB2777", opacity: 0.25 }, stroke: { ...c.paths[0]!.stroke, width: 3, opacity: 0.7 } }); f.seal();
    const context = buildLogoVectorProposalContext(f), payload = proposed({ kind: "color", componentId: symbol, fill: "#AABBCC", stroke: "#DDEEFF" }), result = validateLogoVectorProposal(payload, context);
    if (result.status !== "proposed") throw new Error(); const candidate = applyLogoManualEdit(f.document, result.edit);
    expect(candidate.components[0]!.paths.map(p => p.d)).toEqual(c.paths.map(p => p.d));
    candidate.components[0]!.paths.forEach((p, i) => { expect(p.fill).toEqual({ ...c.paths[i]!.fill, color: "#AABBCC" }); expect(p.stroke).toEqual({ ...c.paths[i]!.stroke, color: "#DDEEFF" }); });
    expect(candidate.components[1]).toEqual(f.document.components[1]);
    expect(() => validateLogoVectorProposal(proposed({ kind: "color", componentId: symbol, fill: null, stroke: "#001122" }), context)).toThrow();
    const absent = buildLogoVectorProposalContext(proposalFixture()); expect(() => validateLogoVectorProposal(proposed({ kind: "color", componentId: symbol, fill: "#0011FF", stroke: "#000000" }), absent)).toThrow();
  });
  it("does not mutate source geometry or non-target state through accepted whole-component commands", () => {
    const f = proposalFixture(); f.targetComponentIds = [symbol]; f.seal([lettering]); const before = structuredClone(f.document), context = buildLogoVectorProposalContext(f);
    for (const edit of [{ kind: "size", componentId: symbol, scale: 0.8 }, { kind: "rotation", componentId: symbol, degrees: 10 }, { kind: "color", componentId: symbol, fill: "#0011FF", stroke: null }]) {
      const result = validateLogoVectorProposal(proposed(edit), context); if (result.status !== "proposed") throw new Error();
      const candidate = applyLogoManualEdit(f.document, result.edit); assertLogoComponentLocks(f.document, candidate, f.revision.locks);
      expect(candidate.components[1]).toEqual(before.components[1]); expect(candidate.components.flatMap(c => c.paths.map(p => ({ id: p.id, d: p.d })))).toEqual(before.components.flatMap(c => c.paths.map(p => ({ id: p.id, d: p.d }))));
    }
    expect(f.document).toEqual(before);
  });
  it("requires actual editable lettering and exact allowed font membership", () => {
    const outlined = buildLogoVectorProposalContext(proposalFixture()); expect(() => validateLogoVectorProposal(proposed({ kind: "font", componentId: lettering, fontVersionId: proposalId(30) }), outlined)).toThrow();
    const f = proposalFixture(true), context = buildLogoVectorProposalContext(f);
    expect(() => validateLogoVectorProposal(proposed({ kind: "font", componentId: lettering, fontVersionId: proposalId(90) }), context)).toThrow();
    expect(() => validateLogoVectorProposal(proposed({ kind: "spacing", componentId: symbol, letterSpacing: 1, lineHeight: 1 }), context)).toThrow();
  });
  it("does not trust forged operation advertisements for outlined or locked targets", () => {
    const outlined = structuredClone(buildLogoVectorProposalContext(proposalFixture()));
    outlined.allowedOperations.push("font"); outlined.components[1]!.allowedOperations.push("font");
    expect(() => validateLogoVectorProposal(proposed({ kind: "font", componentId: lettering, fontVersionId: proposalId(30) }), outlined)).toThrow();
    const f = proposalFixture(); f.seal([symbol]); const locked = structuredClone(buildLogoVectorProposalContext(f));
    locked.components[0]!.allowedOperations.push("size");
    expect(() => validateLogoVectorProposal(proposed({ kind: "size", componentId: symbol, scale: 0.5 }), locked)).toThrow();
  });
  it("preserves line height and refuses unsupported joining-script spacing", () => {
    const f = proposalFixture(true), context = buildLogoVectorProposalContext(f);
    expect(() => validateLogoVectorProposal(proposed({ kind: "spacing", componentId: lettering, letterSpacing: 2, lineHeight: 2 }), context)).toThrow();
    const c = f.document.components[1]!; if (c.editingKind !== "editable_text") throw new Error(); c.textSource.script = "Arab"; c.textSource.direction = "rtl"; c.textSource.language = "ar"; c.textSource.text = f.brief.payload.name = "سلام"; f.seal();
    expect(() => validateLogoVectorProposal(proposed({ kind: "spacing", componentId: lettering, letterSpacing: 2, lineHeight: 1 }), buildLogoVectorProposalContext(f))).toThrow();
  });
  it.each(["face", "engine", "script", "direction"])("rejects text with an unsupported %s layout capability", field => {
    const f = proposalFixture(true), c = f.document.components[1]!; if (c.editingKind !== "editable_text") throw new Error();
    if (field === "face") c.textSource.faceIndex = 1; if (field === "engine") c.textSource.shapingEngine.version = "future"; if (field === "script") c.textSource.script = "Deva"; if (field === "direction") c.textSource.direction = "rtl"; f.seal();
    expect(() => validateLogoVectorProposal(proposed({ kind: "font", componentId: lettering, fontVersionId: proposalId(30) }), buildLogoVectorProposalContext(f))).toThrow();
  });
  it.each([
    { kind: "size", componentId: symbol, scale: 1 }, { kind: "rotation", componentId: symbol, degrees: 0 },
    { kind: "color", componentId: symbol, fill: "#DB2777", stroke: null }, { kind: "font", componentId: lettering, fontVersionId: proposalId(20) },
    { kind: "spacing", componentId: lettering, letterSpacing: 0, lineHeight: 1 },
    { kind: "arrangement", placements: [{ componentId: symbol, transform: { x: 0, y: 0, scale: 1, rotation: 0 } }], order: [symbol, lettering] },
  ])("rejects a no-op $kind proposal", edit => {
    expect(() => validateLogoVectorProposal(proposed(edit), buildLogoVectorProposalContext(proposalFixture(true)))).toThrow();
  });
  it("rejects a relabeled font record with the same bytes as a visual no-op", () => {
    const f = proposalFixture(true); f.fonts[1]!.asset.contentHash = f.fonts[1]!.rights.fontContentHash = f.fonts[0]!.asset.contentHash;
    expect(() => validateLogoVectorProposal(proposed({ kind: "font", componentId: lettering, fontVersionId: proposalId(30) }), buildLogoVectorProposalContext(f))).toThrow();
  });
});
