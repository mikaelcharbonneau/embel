import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { inspectIdentityRaster, normalizeLogoConceptRaster } from "../../src/features/logo-vector/server/converter";
import { IMAGE_INPUT_LIMITS } from "../../src/domain/logo-image-limits";

describe("isolated concept grayscale normalization", () => {
  it("deterministically preserves dimensions, alpha and gray detail while producing exactly equal RGB channels", async () => {
    const pixels = Buffer.alloc(1024 * 1024 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      const value = i / 4 % 256;
      pixels[i] = value; pixels[i + 1] = 255 - value; pixels[i + 2] = 80; pixels[i + 3] = value;
    }
    const input = new Uint8Array(await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer());
    const normalized = await normalizeLogoConceptRaster(input, new AbortController().signal);
    expect(await normalizeLogoConceptRaster(input, new AbortController().signal)).toEqual(normalized);
    expect(await normalizeLogoConceptRaster(normalized, new AbortController().signal)).toEqual(normalized);
    const result = await sharp(normalized).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(result.info).toMatchObject({ width: 1024, height: 1024, channels: 4 });
    const shades = new Set<number>();
    for (let i = 0; i < result.data.length; i += 4) {
      if (result.data[i] !== result.data[i + 1] || result.data[i] !== result.data[i + 2] || result.data[i + 3] !== pixels[i + 3]) throw new Error("Grayscale or alpha changed unexpectedly");
      shades.add(result.data[i]!);
    }
    expect(shades.size).toBeGreaterThan(2);
    expect((await inspectIdentityRaster(normalized, "image/png")).isMonochrome).toBe(true);
  });
  it("keeps bounded admission and cancellation before normalization", async () => {
    await expect(normalizeLogoConceptRaster(new Uint8Array(IMAGE_INPUT_LIMITS.outputBytes + 1), new AbortController().signal)).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(normalizeLogoConceptRaster(new Uint8Array([1, 2, 3]), new AbortController().signal)).rejects.toMatchObject({ code: "source_mismatch" });
    await expect(normalizeLogoConceptRaster(new Uint8Array([1]), AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
  });
});
