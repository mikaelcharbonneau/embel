import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  filterInspirationBrands,
  filterInspirationParts,
  hasInspirationChoice,
  inspirationBrands,
  inspirationCatalog,
  inspirationLikeCount,
  inspirationPartElements,
  inspirationParts,
  partLiked,
  togglePart,
} from "@/domain/inspiration";

describe("inspiration catalog", () => {
  it("keeps the 30 earlier designs readable and gives every brand a unique id", async () => {
    const earlier = inspirationCatalog.filter((design) => !design.parts);
    expect(earlier).toHaveLength(30);
    expect(new Set(inspirationCatalog.map((row) => row.id)).size).toBe(inspirationCatalog.length);
    for (const design of earlier) {
      const bytes = readFileSync(`public${design.image}`),
        meta = await sharp(bytes).metadata();
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(design.contentHash);
      expect([meta.width, meta.height]).toEqual([design.width, design.height]);
    }
  });

  it("ships five described images per brand, in order, with matching bytes, sizes and small copies", async () => {
    expect(inspirationBrands.length).toBeGreaterThan(1);
    for (const brand of inspirationBrands) {
      expect(brand.parts.map((part) => part.part)).toEqual(inspirationParts);
      expect(brand.elements).toEqual(["logo", "typography", "colors", "images", "composition"]);
      expect([brand.image, brand.width, brand.height, brand.contentHash]).toEqual([
        brand.parts[0]!.image,
        brand.parts[0]!.width,
        brand.parts[0]!.height,
        brand.parts[0]!.contentHash,
      ]);
      expect(brand.description.length).toBeGreaterThan(20);
      // No designer or source has been supplied yet; nothing is invented.
      expect(brand.creator).toBeUndefined();
      expect(brand.sourceUrl).toBeUndefined();
      for (const part of brand.parts) {
        const bytes = readFileSync(`public${part.image}`),
          meta = await sharp(bytes).metadata();
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(part.contentHash);
        expect([meta.width, meta.height]).toEqual([part.width, part.height]);
        expect(existsSync(`public${part.thumbnail}`)).toBe(true);
        expect(part.description.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("brand likes and search", () => {
  const [first, second] = inspirationBrands;
  it("maps each part to its own element and counts whole-brand and part likes separately", () => {
    expect(new Set(Object.values(inspirationPartElements)).size).toBe(5);
    const liked = togglePart(togglePart({ ensemble: true, elements: [] }, "colors"), "visuals");
    expect(liked).toEqual({ ensemble: true, elements: ["colors", "images"] });
    expect(partLiked(liked, "colors")).toBe(true);
    expect(partLiked(liked, "logo")).toBe(false);
    expect(inspirationLikeCount(liked)).toBe(3);
    expect(togglePart(liked, "colors")).toEqual({ ensemble: true, elements: ["images"] });
    expect(hasInspirationChoice({ ensemble: false, elements: ["images"] })).toBe(true);
  });

  it("searches brand names, descriptions and image descriptions, and lists one part per brand", () => {
    expect(filterInspirationBrands(inspirationBrands, "")).toHaveLength(inspirationBrands.length);
    expect(filterInspirationBrands(inspirationBrands, second!.brand.toUpperCase()).map((brand) => brand.id)).toContain(
      second!.id,
    );
    expect(filterInspirationBrands(inspirationBrands, "nothing-matches-this")).toHaveLength(0);
    const logos = filterInspirationParts(inspirationBrands, "logo", "");
    expect(logos).toHaveLength(inspirationBrands.length);
    expect(logos[0]).toEqual({ brand: first, image: first!.parts[0] });
    expect(filterInspirationParts(inspirationBrands, "colors", first!.brand).map((item) => item.brand.id)).toContain(
      first!.id,
    );
  });
});
