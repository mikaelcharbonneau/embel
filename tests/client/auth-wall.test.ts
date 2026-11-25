import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { authWallBrands } from "@/components/auth/auth-wall";
import brands from "@/domain/inspiration-brands.json" with { type: "json" };

it("fills the sign-in overlay's wall only with pictures from the Inspiration step, each used once", () => {
  const known = new Set(brands.map((brand) => brand.slug));
  expect(new Set(authWallBrands).size).toBe(authWallBrands.length);
  for (const slug of authWallBrands) {
    expect(known.has(slug), slug).toBe(true);
    expect(existsSync(`public/inspiration/brands/${slug}/05-brand-poster-small.webp`), slug).toBe(true);
  }
});
