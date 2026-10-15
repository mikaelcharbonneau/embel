import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { filterInspiration, hasInspirationChoice, inspirationCatalog } from "@/domain/inspiration";
describe("approved inspiration catalog", () => {
  it("ships the 15 original images with matching byte hashes and dimensions", async () => {
    expect(new Set(inspirationCatalog.map(row => row.id)).size).toBe(15);
    for (const design of inspirationCatalog) {
      const bytes = readFileSync(`public${design.image}`), meta = await sharp(bytes).metadata();
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(design.contentHash);
      expect([meta.width, meta.height]).toEqual([design.width, design.height]);
      expect(new URL(design.sourceUrl).protocol).toBe("https:");
    }
  });
  it("combines studio/brand/detail search with type and real whole-or-component likes", () => {
    const choices = new Map([[inspirationCatalog[0]!.id, { ensemble: false, elements: ["colors"] as const }]]);
    const mutable = new Map([...choices].map(([id, choice]) => [id, { ...choice, elements: [...choice.elements] }]));
    expect(filterInspiration(inspirationCatalog, "COLLINS blue", "logo", true, mutable)).toHaveLength(1);
    expect(filterInspiration(inspirationCatalog, "COLLINS blue", "identity", true, mutable)).toHaveLength(0);
    expect(filterInspiration(inspirationCatalog, "nothing-matches", "all", false, mutable)).toHaveLength(0);
    expect(filterInspiration(inspirationCatalog, "", "all", true, new Map())).toHaveLength(0);
    expect(hasInspirationChoice({ ensemble: true, elements: [] })).toBe(true);
  });
});
