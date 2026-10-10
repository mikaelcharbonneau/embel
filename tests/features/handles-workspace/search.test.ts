import { describe, expect, it } from "vitest";
import { previewHandleSearch } from "@/features/handles-workspace/search";
import { handleStatus, type HandleNameSource } from "@/features/handles-workspace/domain";

const source: HandleNameSource = { id: "fixture", name: "Morrow", origin: "project", projectId: "fixture-project", projectTitle: "Fixture project" };
describe("Handles guided search boundaries", () => {
  it("excludes unsupported platform combinations without changing the exact candidate or its provenance", () => {
    const result = previewHandleSearch([source], ["instagram", "x", "linkedin"], { prefixes: "hello", suffixes: "studio", separators: [".", "_"] });
    const dotted = result.rows.find(row => row.entries[0]?.handle === "hello.morrow")!;
    expect(dotted.entries.map(entry => entry.platform)).toEqual(["instagram"]);
    expect(result.rows.find(row => row.entries[0]?.handle === "hello_morrow")!.entries.map(entry => entry.platform)).toEqual(["instagram", "x"]);
    expect(result.excluded).toBeGreaterThan(0);
    expect(result.rows.every(row => row.source.projectId === source.projectId && row.entries.every(entry => handleStatus(entry) === "to_check" && !entry.evidence.length))).toBe(true);
  });
  it("does not silently shorten or repair names that fail syntax screening", () => {
    const rows = previewHandleSearch([{ ...source, name: "abcdefghijklmnop" }], ["instagram", "x"], { prefixes: "", suffixes: "", separators: [""] }).rows;
    expect(rows[0]!.entries).toMatchObject([{ platform: "instagram", handle: "abcdefghijklmnop" }]);
    expect(() => previewHandleSearch([{ ...source, name: "flower🌸" }], ["instagram"], { prefixes: "", suffixes: "", separators: [""] })).toThrow();
  });
  it("bounds expansion and rejects empty platforms, separators and invalid custom affixes", () => {
    const options = { prefixes: "get", suffixes: "hq", separators: [""] as [""] };
    expect(() => previewHandleSearch([source], [], options)).toThrow("platform");
    expect(() => previewHandleSearch([source], ["instagram"], { ...options, separators: [] })).toThrow("separator");
    expect(() => previewHandleSearch([source], ["instagram"], { ...options, prefixes: "get1" })).toThrow("letters");
    const sources = Array.from({ length: 30 }, (_, index) => ({ ...source, id: `fixture-${index}`, name: `fixture${index}` }));
    expect(() => previewHandleSearch(sources, ["instagram"], { prefixes: "get, hello, try", suffixes: "hq, studio, co", separators: ["", ".", "_"] })).toThrow("too large");
  });
});
