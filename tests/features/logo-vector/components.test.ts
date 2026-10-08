import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { LogoManualEdit, LogoVectorComponent, LogoVectorDocument } from "../../../src/domain/logo-vector";
import { applyLogoManualEdit } from "../../../src/features/logo-vector/model/edits";
import { flattenLogoPaths } from "../../../src/features/logo-vector/model/geometry";
import { captureLogoComponentLocks, assertLogoComponentLocks } from "../../../src/features/logo-vector/model/locks";
import { separatedLogoDocument } from "./fixtures";

type Regions = Extract<LogoManualEdit, { kind: "group_components" }>["regions"];
const regions = (): Regions => [
  { id: "chosen-symbol", role: "symbol", bounds: [18, 18, 44, 44] },
  { id: "chosen-lettering", role: "lettering", bounds: [80, 25, 70, 40] },
];
function artwork(): LogoVectorDocument {
  const source = separatedLogoDocument();
  return { ...source, components: [{ id: "whole-trace", role: "whole_artwork", editingKind: "geometry", transform: { x: 0, y: 0, scale: 1, rotation: 0 }, paths: source.components.flatMap(component => component.paths) }] };
}
function group(document: LogoVectorDocument, choices: Regions) { return applyLogoManualEdit(document, { kind: "group_components", regions: choices }); }
const unsupported = (run: () => unknown) => expect(run).toThrowError(expect.objectContaining({ code: "unsupported_edit" }));

describe("explicit whole-path component grouping", () => {
  it("partitions traced artwork using explicit regions without changing paths, paint, order or the base", () => {
    const base = artwork(), before = structuredClone(base);
    base.components[0]!.paths[0]!.fill!.opacity = .5;
    before.components[0]!.paths[0]!.fill!.opacity = .5;
    const result = group(base, regions().reverse());
    expect(result.components.map(component => component.id)).toEqual(["chosen-symbol", "chosen-lettering"]);
    expect(result.components[0]!.paths).toEqual([base.components[0]!.paths[0]]);
    expect(result.components[1]!.paths).toEqual([base.components[0]!.paths[1]]);
    expect(flattenLogoPaths(result)).toEqual(flattenLogoPaths(base));
    expect(result.components[1]).toMatchObject({ role: "lettering", editingKind: "outlined_custom" });
    expect(result.components[1]).not.toHaveProperty("textSource");
    expect(result.components[0]!.transform).toEqual(base.components[0]!.transform);
    expect(base).toEqual(before);
    expect(Object.isFrozen(result.components[1]!.paths)).toBe(true);
  });

  it("keeps untouched components exactly in place while splitting another complete source", () => {
    const base = artwork(), first = separatedLogoDocument().components[0]!;
    first.id = "fixed-first"; first.paths[0]!.id = "fixed-first-path"; first.transform.y = 50;
    base.components.unshift(first);
    const locks = captureLogoComponentLocks(base, [first.id]);
    const result = group(base, regions());
    expect(result.components[0]).toEqual(first);
    expect(() => assertLogoComponentLocks(base, result, locks)).not.toThrow();
    expect(flattenLogoPaths(result)).toEqual(flattenLogoPaths(base));
  });

  it("retains exact local geometry and a nonidentity transform, including stroke alpha and width", () => {
    const base = artwork(), component = base.components[0]!;
    component.transform = { x: 20, y: 10, scale: .5, rotation: 10 };
    component.paths[0]!.stroke = { color: "#123456", width: 2, opacity: .6, linecap: "round", linejoin: "round", miterLimit: 4 };
    const result = group(base, [
      { id: "transformed-symbol", role: "symbol", bounds: [22, 20, 28, 30] },
      { id: "transformed-type", role: "lettering", bounds: [55, 30, 38, 30] },
    ]);
    expect(result.components.every(item => JSON.stringify(item.transform) === JSON.stringify(component.transform))).toBe(true);
    expect(result.components.flatMap(item => item.paths)).toEqual(component.paths);
    expect(flattenLogoPaths(result)).toEqual(flattenLogoPaths(base));
  });

  it("allows merging consecutive geometry with identical transforms, retaining exact path sequence", () => {
    const base = separatedLogoDocument();
    const result = group(base, [{ id: "explicit-combination", role: "whole_artwork", bounds: [10, 10, 150, 60] }]);
    expect(result.components).toHaveLength(1);
    expect(result.components[0]!.editingKind).toBe("outlined_custom");
    expect(result.components[0]!.paths).toEqual(base.components.flatMap(item => item.paths));
  });

  it.each([
    ["partial compound path", [{ id: "cut", role: "lettering", bounds: [80, 25, 70, 20] }]],
    ["omitted path in the touched source", [regions()[0]]],
    ["empty region", [...regions(), { id: "empty", role: "symbol", bounds: [160, 80, 20, 20] }]],
    ["overlapping rectangles", [...regions(), { id: "ambiguous", role: "symbol", bounds: [10, 10, 60, 60] }]],
    ["duplicate group IDs", [regions()[0], { ...regions()[1], id: regions()[0]!.id }]],
    ["changed source-ID membership", [{ ...regions()[0], id: "whole-trace" }, regions()[1]]],
    ["foreign geometry fields", [{ ...regions()[0], paths: [] }, regions()[1]]],
    ["nonfinite region", [{ ...regions()[0], bounds: [NaN, 0, 10, 10] }, regions()[1]]],
    ["out-of-range region", [{ ...regions()[0], bounds: [0, 0, 16385, 10] }, regions()[1]]],
  ])("rejects %s without modifying source", (_label, values) => {
    const base = artwork(), before = structuredClone(base);
    unsupported(() => group(base, values as Regions));
    expect(base).toEqual(before);
  });

  it("rejects interleaved region membership rather than reorder visually independent ink", () => {
    const base = artwork(), paths = base.components[0]!.paths;
    paths.push({ ...paths[0]!, id: "later-symbol", d: "M 22 42 L 25 42 L 25 45 L 22 45 Z" });
    unsupported(() => group(base, regions()));
  });

  it("rejects merging different transforms instead of silently rewriting geometry", () => {
    const base = separatedLogoDocument(); base.components[1]!.transform.x = 1;
    unsupported(() => group(base, [{ id: "merged", role: "whole_artwork", bounds: [10, 10, 150, 60] }]));
  });

  it("preserves an unchanged existing ID, but rejects a new group colliding with an untouched component", () => {
    const base = separatedLogoDocument();
    expect(group(base, [{ id: "synthetic-lettering", role: "lettering", bounds: [80, 25, 70, 40] }])).toEqual(base);
    unsupported(() => group(base, [{ id: "synthetic-symbol", role: "lettering", bounds: [80, 25, 70, 40] }]));
  });

  it("keeps text provenance atomic and does not turn real text into invented custom lettering", () => {
    const base = artwork(), component = base.components[0]!;
    base.components[0] = { ...component, role: "lettering", editingKind: "editable_text", textSource: {
      text: "Synthetic", contentKind: "brand_name", font: { assetId: "66100000-0000-4000-8000-000000000001", versionId: "66100000-0000-4000-8000-000000000002", ownerId: "66100000-0000-4000-8000-000000000003", projectId: "66100000-0000-4000-8000-000000000004", contentHash: "a".repeat(64) }, rightsEvidenceId: "66100000-0000-4000-8000-000000000005", size: 12, faceIndex: 0, variationAxes: {}, featureTags: {}, language: "en", script: "Latn", direction: "ltr", letterSpacing: 0, lineHeight: 1, shapingEngine: { id: "synthetic", version: "1" },
    } } as LogoVectorComponent;
    unsupported(() => group(base, regions()));
    expect(group(base, [{ id: component.id, role: "lettering", bounds: [10, 10, 150, 60] }])).toEqual(base);
  });

  it("keeps invisible paths rather than dropping them during a visible regrouping", () => {
    const base = artwork();
    base.components[0]!.paths.push({ ...base.components[0]!.paths[0]!, id: "invisible-path", d: "M 30 30 L 40 30 L 40 40 Z", fill: { color: "#123456", opacity: 0 } });
    unsupported(() => group(base, regions())); // Its interleaved position cannot be moved into the first region.
    base.components[0]!.paths.splice(1, 0, base.components[0]!.paths.pop()!);
    const result = group(base, regions());
    expect(result.components[0]!.paths.map(path => path.id)).toEqual(["synthetic-diamond", "invisible-path"]);
    expect(flattenLogoPaths(result)).toEqual(flattenLogoPaths(base));
  });

  it("passes grouping through the saved-lock validator without allowing touched or shifted locks", () => {
    const base = artwork(), locks = captureLogoComponentLocks(base, [base.components[0]!.id]);
    const result = group(base, regions());
    expect(() => assertLogoComponentLocks(base, result, locks)).toThrowError(expect.objectContaining({ code: "locked_component_changed" }));
    const later = separatedLogoDocument().components[0]!;
    later.id = "fixed-last"; later.paths[0]!.id = "fixed-last-path"; later.transform.y = 50;
    base.components.push(later);
    const shifted = group(base, regions());
    expect(() => assertLogoComponentLocks(base, shifted, captureLogoComponentLocks(base, [later.id]))).toThrowError(expect.objectContaining({ code: "locked_component_changed" }));
  });

  it("rejects final component overflow and region-count overflow before changing the document", () => {
    const base = artwork();
    for (let index = 0; index < 63; index++) base.components.push({ id: `kept-${index}`, role: "border", editingKind: "geometry", transform: { x: 0, y: 0, scale: 1, rotation: 0 }, paths: [{ id: `kept-path-${index}`, d: "M 170 90 L 175 90 L 175 95 Z", fill: { color: "#000000", opacity: 1 }, stroke: null, fillRule: "nonzero" }] });
    unsupported(() => group(base, regions()));
    unsupported(() => group(artwork(), Array.from({ length: 65 }, (_, index) => ({ id: `region-${index}`, role: "symbol", bounds: [index, 0, 1, 1] }))));
  });
});
