import { describe, expect, it } from "vitest";
import { applyLogoManualEdit } from "../../../src/features/logo-vector/model/edits";
import { separatedLogoDocument } from "./fixtures";

describe("non-text manual previews", () => {
  it("changes one component while preserving base, alpha and unrelated geometry", () => {
    const base = separatedLogoDocument(), before = JSON.stringify(base);
    base.components[0]!.paths[0]!.fill!.opacity = .6;
    const sized = applyLogoManualEdit(base, { kind: "size", componentId: "synthetic-symbol", scale: 1.25 });
    const rotated = applyLogoManualEdit(sized, { kind: "rotation", componentId: "synthetic-symbol", degrees: 5 });
    const colored = applyLogoManualEdit(rotated, { kind: "color", componentId: "synthetic-symbol", fill: "#123456", stroke: null });
    expect(colored.components[0]!.transform).toEqual({ x: 0, y: 0, scale: 1.25, rotation: 5 });
    expect(colored.components[0]!.paths[0]!.fill).toEqual({ color: "#123456", opacity: .6 });
    expect(colored.components[1]).toEqual(base.components[1]);
    expect(base.components[0]!.transform.scale).toBe(1);
    expect(JSON.stringify(separatedLogoDocument())).toBe(before);
    expect(Object.isFrozen(colored.components[0])).toBe(true);
  });
  it("applies exact placements/order and rejects omissions or out-of-canvas edits", () => {
    const base = separatedLogoDocument();
    const result = applyLogoManualEdit(base, { kind: "arrangement", placements: [{ componentId: "synthetic-symbol", transform: { x: 2, y: 5, scale: 1, rotation: 0 } }], order: ["synthetic-lettering", "synthetic-symbol"] });
    expect(result.components.map(item => item.id)).toEqual(["synthetic-lettering", "synthetic-symbol"]);
    expect(result.components[1]!.transform.x).toBe(2);
    expect(() => applyLogoManualEdit(base, { kind: "arrangement", placements: [], order: ["synthetic-symbol"] })).toThrow();
    expect(() => applyLogoManualEdit(base, { kind: "size", componentId: "synthetic-symbol", scale: 100 })).toThrowError(expect.objectContaining({ code: "invalid_geometry" }));
  });
  it("retains geometry on a lock intent and refuses unavailable text even with supplied glyphs", () => {
    const base = separatedLogoDocument();
    expect(applyLogoManualEdit(base, { kind: "locks", componentIds: ["synthetic-symbol"] })).toEqual(base);
    expect(() => applyLogoManualEdit(base, { kind: "spacing", componentId: "synthetic-lettering", letterSpacing: 1, lineHeight: 1 }, base.components[0]!.paths)).toThrowError(expect.objectContaining({ code: "font_rights_required" }));
  });
});
