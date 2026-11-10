import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { assertLogoComponentLocks, captureLogoComponentLocks, getVectorRefinementCapability } from "../../../src/features/logo-vector/model/locks";
import { applyLogoManualEdit } from "../../fixtures/logo-vector/edits";
import { separatedLogoDocument } from "./fixtures";

describe("authoritative geometry lock comparison", () => {
  it("preserves the actual locked content while allowing unrelated nonoverlapping edits", () => {
    const base = separatedLogoDocument(), locks = captureLogoComponentLocks(base, ["synthetic-symbol"]);
    const candidate = applyLogoManualEdit(base, { kind: "color", componentId: "synthetic-lettering", fill: "#123456", stroke: null });
    expect(() => assertLogoComponentLocks(base, candidate, locks)).not.toThrow();
    expect(locks[0]!.effectiveHash).toMatch(/^[a-f0-9]{64}$/);
    expect(getVectorRefinementCapability(locks)).toEqual({ status: "unavailable", reason: "unsupported_locked_refinement" });
    expect(getVectorRefinementCapability([])).toEqual({ status: "available" });
  });
  it("rejects geometry, paint, transform, ID, deletion and order attacks", () => {
    const base = separatedLogoDocument(), before = JSON.stringify(base), locks = captureLogoComponentLocks(base, ["synthetic-symbol"]);
    const attacks = [
      () => { const c = separatedLogoDocument(); c.components[0]!.paths[0]!.d = "M20 40L40 20L61 40L40 60Z"; return c; },
      () => applyLogoManualEdit(base, { kind: "color", componentId: "synthetic-symbol", fill: "#000000", stroke: null }),
      () => applyLogoManualEdit(base, { kind: "size", componentId: "synthetic-symbol", scale: 1.1 }),
      () => { const c = separatedLogoDocument(); c.components[0]!.id = "replacement"; return c; },
      () => ({ ...base, components: base.components.slice(1) }),
      () => ({ ...base, components: [...base.components].reverse() }),
    ];
    for (const candidate of attacks) expect(() => assertLogoComponentLocks(base, candidate(), locks)).toThrowError(expect.objectContaining({ code: "locked_component_changed" }));
    expect(JSON.stringify(base)).toBe(before);
  });
  it("rejects new occlusion, moving/removing old overlap and forged base digests", () => {
    const base = separatedLogoDocument(), locks = captureLogoComponentLocks(base, ["synthetic-symbol"]);
    const occluded = applyLogoManualEdit(base, { kind: "arrangement", placements: [{ componentId: "synthetic-lettering", transform: { x: -60, y: 0, scale: 1, rotation: 0 } }], order: base.components.map(item => item.id) });
    expect(() => assertLogoComponentLocks(base, occluded, locks)).toThrowError(expect.objectContaining({ code: "locked_component_changed" }));
    const overlappingLocks = captureLogoComponentLocks(occluded, ["synthetic-symbol"]);
    expect(() => assertLogoComponentLocks(occluded, base, overlappingLocks)).toThrowError(expect.objectContaining({ code: "locked_component_changed" }));
    expect(() => assertLogoComponentLocks(base, base, [{ ...locks[0]!, geometryHash: "0".repeat(64) }])).toThrowError(expect.objectContaining({ code: "locked_component_changed" }));
    const newInk = separatedLogoDocument();
    newInk.components.push({ ...newInk.components[0]!, id: "new-occluder", paths: [{ ...newInk.components[0]!.paths[0]!, id: "new-path" }] });
    expect(() => assertLogoComponentLocks(base, newInk, locks)).toThrowError(expect.objectContaining({ code: "locked_component_changed" }));
  });
});


describe("P3-R1: locked canvas context", () => {
  it.each([[0, 0, 400, 240], [10, 10, 200, 120]])("rejects a valid canvas change while a saved component lock exists: %s", (x, y, width, height) => {
    const base = separatedLogoDocument(), locks = captureLogoComponentLocks(base, ["synthetic-symbol"]);
    const candidate = { ...base, viewBox: [x, y, width, height] as [number, number, number, number] };
    expect(() => assertLogoComponentLocks(base, candidate, locks)).toThrowError(expect.objectContaining({ code: "locked_component_changed" }));
    expect(base.viewBox).toEqual([0, 0, 200, 120]);
  });
  it("allows unchanged locked context and valid unlocked canvas changes", () => {
    const base = separatedLogoDocument(), locks = captureLogoComponentLocks(base, ["synthetic-symbol"]);
    expect(() => assertLogoComponentLocks(base, base, locks)).not.toThrow();
    expect(() => assertLogoComponentLocks(base, { ...base, viewBox: [10, 10, 400, 240] }, [])).not.toThrow();
  });
});
