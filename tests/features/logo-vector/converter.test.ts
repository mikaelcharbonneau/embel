import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { logoTypeSchema } from "../../../src/domain/logo-vector";
import { convertLogoRaster } from "../../../src/features/logo-vector/server/converter";
import { validateLogoVectorDocument } from "../../../src/features/logo-vector/model/geometry";
import { validateLogoVectorSvg } from "../../../src/features/logo-vector/model/svg";
import { digestBytes, pngChunk, syntheticConversionInput, syntheticPng, syntheticSource } from "./raster-fixtures";
const signal = () => new AbortController().signal;

describe("isolated real raster conversion", () => {
  it.each(logoTypeSchema.options)("retains the %s source while producing real editable paths", async logoType => {
    const input = syntheticConversionInput(logoType), original = input.source.bytes.slice();
    const result = await convertLogoRaster(input, signal());
    expect(result.logoType).toBe(logoType);
    expect(result.source).toEqual(input.source.reference);
    expect(result.sourceContentHash).toBe(digestBytes(original));
    expect(input.source.bytes).toEqual(original);
    expect(validateLogoVectorDocument(result.document).components.flatMap(c => c.paths).length).toBeGreaterThan(0);
    expect(validateLogoVectorSvg(result.svg).viewBox).toEqual([0, 0, 48, 40]);
    expect(new TextDecoder().decode(result.svg)).not.toMatch(/<(image|text|use)\b/);
    expect(result.engine).toMatchObject({ name: "@visioncortex/vtracer", version: "1.0.0-alpha.4", settings: input.settings });
    expect(result.engine.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    const component = result.document.components[0]!;
    expect(component.editingKind).toBe(logoType === "wordmark" || logoType === "lettermark_monogram" ? "outlined_custom" : "geometry");
    expect(component).not.toHaveProperty("textSource");
  });
  it("retains the mascot eye and mouth holes and the emblem internal gap", async () => {
    for (const [type, ink, holes] of [
      ["mascot", [24,20], [[19,17],[29,17],[24,25],[3,3]]],
      ["emblem", [24,8], [[24,12],[3,3]]],
    ] as const) {
      const result = await convertLogoRaster(syntheticConversionInput(type), signal());
      const { data, info } = await sharp(result.svg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const alpha = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
      expect(alpha(ink[0], ink[1])).toBe(255);
      for (const point of holes) expect(alpha(point[0], point[1])).toBe(0);
    }
  });
  it.each(["jpeg", "webp"] as const)("decodes and genuinely traces verified %s bytes", async format => {
    const input = syntheticConversionInput("combination");
    const bytes = await sharp(input.source.bytes).toFormat(format).toBuffer();
    const result = await convertLogoRaster({ ...input, source: syntheticSource(bytes, `image/${format}`) }, signal());
    expect(result.raster.inputFormat).toBe(format);
    expect(result.document.components[0]!.paths.length).toBeGreaterThan(0);
  });
  it("preserves fractional alpha and ignores hidden RGB rather than making it opaque", async () => {
    const bytes = syntheticPng(32, 24, (x, y) => x >= 8 && x < 24 && y >= 6 && y < 18 ? [30, 50, 90, 128] : [0, 0, 0, 0]);
    const input = { ...syntheticConversionInput("mascot"), source: syntheticSource(bytes), settings: { preset: "poster" as const, simplify: 0, filterSpeckle: 0, maxColors: 4 } };
    const result = await convertLogoRaster(input, signal());
    const paths = result.document.components.flatMap(c => c.paths);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every(p => p.fill?.opacity === 128 / 255)).toBe(true);
    expect(paths.every(p => p.fill?.color === "#1E325A")).toBe(true);
    expect(result.raster.alphaLevels).toEqual([128]);
    expect(result.raster.outputColorSpace).toBe("srgb");
  });
  it("snapshots Buffer-backed input before the caller overwrites it", async () => {
    // Larger than the process pipe buffer. The shared white prefix makes the
    // pending aliased write become a valid B image, not merely corrupt data.
    const makePng = async (left: number) => sharp(syntheticPng(256, 256, (x, y) =>
      x >= left && x < left + 48 && y >= 160 && y < 224 ? [0,0,0,255] : [255,255,255,255]
    )).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer();
    const original = await makePng(24), replacement = await makePng(160);
    expect(original.length).toBe(replacement.length);
    const input = syntheticConversionInput("abstract"), source = syntheticSource(original);
    const mutable = Buffer.from(original);
    source.bytes = mutable;
    const pending = convertLogoRaster({ ...input, source }, signal());
    replacement.copy(mutable);
    const result = await pending;
    const expected = await convertLogoRaster({ ...input, source: syntheticSource(original) }, signal());
    const changed = await convertLogoRaster({ ...input, source: syntheticSource(replacement) }, signal());
    expect(expected.svg).not.toEqual(changed.svg);
    expect(result.sourceContentHash).toBe(digestBytes(original));
    expect(result.document).toEqual(expected.document);
    expect(result.svg).toEqual(expected.svg);
  });
  it("rejects altered source bytes before any conversion", async () => {
    const input = syntheticConversionInput("emblem"); input.source.bytes[45] = input.source.bytes[45]! ^ 1;
    await expect(convertLogoRaster(input, signal())).rejects.toMatchObject({ code: "source_mismatch" });
  });
  it("rejects metadata byte length and MIME spoofing", async () => {
    const input = syntheticConversionInput("abstract");
    await expect(convertLogoRaster({ ...input, source: syntheticSource(input.source.bytes, "image/jpeg") }, signal())).rejects.toMatchObject({ code: "source_mismatch" });
    await expect(convertLogoRaster({ ...input, source: { ...input.source, verification: { ...input.source.verification, byteLength: 1 } } }, signal())).rejects.toMatchObject({ code: "source_mismatch" });
  });
  it("rejects corrupt PNG, empty art, and animated PNG without inventing paths", async () => {
    const input = syntheticConversionInput("emblem");
    const corrupt = input.source.bytes.slice(0, 45);
    await expect(convertLogoRaster({ ...input, source: syntheticSource(corrupt) }, signal())).rejects.toMatchObject({ code: "conversion_failed" });
    const empty = syntheticPng(4, 4, () => [0, 0, 0, 0]);
    await expect(convertLogoRaster({ ...input, source: syntheticSource(empty) }, signal())).rejects.toMatchObject({ code: "empty_artwork" });
    const animated = Buffer.concat([Buffer.from(input.source.bytes.subarray(0, 33)), pngChunk("acTL", new Uint8Array([0,0,0,2,0,0,0,0])), Buffer.from(input.source.bytes.subarray(33))]);
    await expect(convertLogoRaster({ ...input, source: syntheticSource(animated) }, signal())).rejects.toMatchObject({ code: "conversion_failed" });
  });
  it("rejects an over-limit decoded edge and over-limit encoded file", async () => {
    const input = syntheticConversionInput("abstract");
    const hugeEdge = syntheticPng(8193, 1, () => [0, 0, 0, 255]);
    await expect(convertLogoRaster({ ...input, source: syntheticSource(hugeEdge) }, signal())).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(convertLogoRaster({ ...input, source: syntheticSource(new Uint8Array(33_554_433)) }, signal())).rejects.toMatchObject({ code: "limit_exceeded" });
  });
  it("does not start a pre-cancelled conversion", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(convertLogoRaster(syntheticConversionInput("pictorial"), controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });
});
