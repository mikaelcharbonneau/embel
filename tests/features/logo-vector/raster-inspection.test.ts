import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { inspectIdentityRaster } from "../../../src/features/logo-vector/server/converter";
import { syntheticConversionInput, syntheticPng } from "./raster-fixtures";

describe("shared actual-byte isolated raster inspection", () => {
  it("reports real dimensions, normalized pixels and monochrome status", async () => {
    const input = syntheticConversionInput("mascot");
    const result = await inspectIdentityRaster(input.source.bytes, "image/png");
    expect(result).toMatchObject({ width: 48, height: 40, format: "png", isMonochrome: true, outputColorSpace: "srgb" });
    expect(result.pixelHash).toMatch(/^[a-f0-9]{64}$/);
    const colored = syntheticPng(8, 8, () => [30, 40, 80, 255]);
    expect((await inspectIdentityRaster(colored, "image/png")).isMonochrome).toBe(false);
  });
  it("snapshots Buffer-backed bytes before the caller overwrites them", async () => {
    const makePng = async (colored: boolean) => sharp(syntheticPng(256, 256, (x, y) =>
      x >= 24 && x < 72 && y >= 160 && y < 224 ? colored ? [255,0,0,255] : [0,0,0,255] : [255,255,255,255]
    )).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer();
    const original = await makePng(false), replacement = await makePng(true);
    expect(original.length).toBe(replacement.length);
    const mutable = Buffer.from(original);
    const pending = inspectIdentityRaster(mutable, "image/png");
    replacement.copy(mutable);
    const result = await pending;
    const expected = await inspectIdentityRaster(original, "image/png");
    const changed = await inspectIdentityRaster(replacement, "image/png");
    expect(changed.isMonochrome).toBe(false);
    expect(changed.pixelHash).not.toBe(expected.pixelHash);
    expect(result.isMonochrome).toBe(true);
    expect(result.pixelHash).toBe(expected.pixelHash);
  });
  it("applies EXIF orientation before inspection and conversion comparison", async () => {
    const input = syntheticConversionInput("abstract");
    const jpeg = await sharp(input.source.bytes).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect(await inspectIdentityRaster(jpeg, "image/jpeg")).toMatchObject({ width: 40, height: 48, originalOrientation: 6 });
  });
  it("ignores fully transparent RGB in the normalized pixel identity", async () => {
    const a = syntheticPng(4, 4, (x, y) => x === y ? [0, 0, 0, 255] : [255, 0, 0, 0]);
    const b = syntheticPng(4, 4, (x, y) => x === y ? [0, 0, 0, 255] : [0, 255, 0, 0]);
    expect((await inspectIdentityRaster(a, "image/png")).pixelHash).toBe((await inspectIdentityRaster(b, "image/png")).pixelHash);
  });
  it("rejects animated WebP and MIME mismatch", async () => {
    const rgba = Buffer.alloc(8 * 16 * 4, 255);
    for (let i = 8 * 8 * 4; i < rgba.length; i += 4) rgba[i] = 0;
    const animated = await sharp(rgba, { raw: { width: 8, height: 16, channels: 4, pageHeight: 8 } }).webp({ delay: [100,100], loop: 0 }).toBuffer();
    await expect(inspectIdentityRaster(animated, "image/webp")).rejects.toMatchObject({ code: "conversion_failed" });
    await expect(inspectIdentityRaster(animated, "image/png")).rejects.toMatchObject({ code: "source_mismatch" });
  });
});
