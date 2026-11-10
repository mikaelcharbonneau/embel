import { createHash } from "node:crypto";
import { LogoVectorError } from "../../features/logo-vector/model/errors";
import { IMAGE_INPUT_LIMITS } from "../../domain/logo-image-limits";
export type IdentityRasterInspection = {
  width: number;
  height: number;
  format: "png" | "jpeg" | "webp";
  isMonochrome: boolean;
  pixelHash: string;
  originalOrientation: number;
  outputColorSpace: "srgb";
};
const failed = (message: string): never => {
  throw new LogoVectorError("conversion_failed", message);
};
function assertSingleFrame(bytes: Uint8Array, format: string): void {
  // APNG is not reported as multipage by every libvips build. Walk bounded chunks too.
  if (format === "png") {
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 8; offset + 12 <= view.length;) {
      const size = view.readUInt32BE(offset),
        end = offset + size + 12;
      if (end > view.length) return failed("The PNG is incomplete or corrupt.");
      const name = view.toString("ascii", offset + 4, offset + 8);
      if (name === "acTL" || name === "fcTL" || name === "fdAT")
        return failed("Animated images are not supported for logo conversion.");
      offset = end;
    }
  }
  if (format === "webp") {
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 12; offset + 8 <= view.length;) {
      const size = view.readUInt32LE(offset + 4),
        end = offset + 8 + size + (size % 2);
      if (end > view.length) return failed("The WebP image is incomplete or corrupt.");
      const name = view.toString("ascii", offset, offset + 4);
      if (name === "ANIM" || name === "ANMF" || (name === "VP8X" && size > 0 && view[offset + 8]! & 2))
        return failed("Animated images are not supported for logo conversion.");
      offset = end;
    }
  }
}
function boundedDimensions(width: number | undefined, height: number | undefined): asserts width is number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !width || !height || width < 1 || height < 1)
    return failed("Raster dimensions are missing or invalid.");
  if (width > 8192 || height > 8192 || width * height > 16_777_216)
    throw new LogoVectorError("limit_exceeded", "Raster exceeds the decoded 8192-pixel edge or 16-megapixel limit.");
}
export async function decodeIdentityRaster(input: { bytes: Uint8Array; mimeType: string }) {
  const sharp = (await import("sharp")).default;
  if (sharp.versions.sharp !== "0.35.5")
    throw new LogoVectorError("engine_unavailable", "The qualified raster decoder is unavailable.");
  sharp.cache(false);
  sharp.concurrency(1);
  let raw: { data: Buffer; info: { width: number; height: number; channels: number } };
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    const decoder = sharp(input.bytes, {
      failOn: "warning",
      unlimited: false,
      autoOrient: true,
      limitInputPixels: 16_777_216,
    });
    metadata = await decoder.metadata();
    const expected = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" }[input.mimeType];
    if (!expected || metadata.format !== expected)
      throw new LogoVectorError("source_mismatch", "Decoded raster type does not match its verified MIME.");
    boundedDimensions(metadata.width, metadata.height);
    if ((metadata.pages ?? 1) !== 1 || (metadata.delay?.length ?? 0) > 1)
      return failed("Animated images are not supported for logo conversion.");
    assertSingleFrame(input.bytes, metadata.format);
    raw = await decoder
      .toColourspace("srgb")
      .ensureAlpha()
      .raw({ depth: "uchar" })
      .toBuffer({ resolveWithObject: true });
    boundedDimensions(raw.info.width, raw.info.height);
    if (raw.info.channels !== 4 || raw.data.length !== raw.info.width * raw.info.height * 4)
      return failed("Decoded raster did not produce bounded RGBA8 pixels.");
  } catch (error) {
    if (error instanceof LogoVectorError) throw error;
    // Do not include decoder messages: they may echo input data or internal paths.
    return failed("The raster could not be decoded safely as a single still image.");
  }
  let isMonochrome = true;
  for (let i = 0; i < raw.data.length; i += 4) {
    if (raw.data[i + 3] === 0) {
      raw.data[i] = 0;
      raw.data[i + 1] = 0;
      raw.data[i + 2] = 0;
    } else if (raw.data[i] !== raw.data[i + 1] || raw.data[i] !== raw.data[i + 2]) isMonochrome = false;
  }
  const inspection: IdentityRasterInspection = {
    width: raw.info.width,
    height: raw.info.height,
    format: metadata.format as "png" | "jpeg" | "webp",
    isMonochrome,
    pixelHash: createHash("sha256").update(raw.data).digest("hex"),
    originalOrientation: metadata.orientation ?? 1,
    outputColorSpace: "srgb",
  };
  return { raw, metadata, inspection };
}
export async function inspectDecodedIdentityRaster(input: {
  bytes: Uint8Array;
  mimeType: string;
}): Promise<IdentityRasterInspection> {
  return (await decodeIdentityRaster(input)).inspection;
}

/** Bytes of the image a style-note request may carry, so the whole request
 * stays within the 128 KiB text-policy input bound. */
export const LOGO_REFERENCE_NOTE_IMAGE_BYTES = 90_000;
/** A liked upload as the style-note model sees it: decoded in this bounded
 * child, placed on white so a transparent logo is not read as solid black, and
 * at most 1024 pixels on its longer edge. A PNG is kept when it fits; a larger
 * image (a photo) steps down through JPEG sizes. The stored upload is unchanged. */
export async function flattenDecodedLogoReference(input: {
  bytes: Uint8Array;
  mimeType: string;
}): Promise<{ imageBase64: string; mimeType: "image/png" | "image/jpeg" }> {
  const { raw } = await decodeIdentityRaster(input);
  const sharp = (await import("sharp")).default;
  const onWhite = (edge: number) =>
    sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: 4 } })
      .flatten({ background: "#ffffff" })
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
  const png = await onWhite(1024).png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer();
  if (png.length && png.length <= LOGO_REFERENCE_NOTE_IMAGE_BYTES)
    return { imageBase64: png.toString("base64"), mimeType: "image/png" };
  for (const [edge, quality] of [
    [1024, 80],
    [768, 75],
    [512, 70],
  ] as const) {
    const jpeg = await onWhite(edge).jpeg({ quality, mozjpeg: false }).toBuffer();
    if (jpeg.length && jpeg.length <= LOGO_REFERENCE_NOTE_IMAGE_BYTES)
      return { imageBase64: jpeg.toString("base64"), mimeType: "image/jpeg" };
  }
  throw new LogoVectorError("limit_exceeded", "The reference is too detailed to send within the note request bound.");
}

/** Concept previews and their raster refinements have a grayscale contract.
 * Normalize in the same bounded child as inspection, before artifact identity
 * is assigned. Existing monochrome bytes and all alpha values are preserved. */
export async function normalizeDecodedLogoConcept(input: {
  bytes: Uint8Array;
  mimeType: string;
}): Promise<{ pngBase64: string }> {
  if (input.mimeType !== "image/png" || input.bytes.byteLength > IMAGE_INPUT_LIMITS.outputBytes)
    throw new LogoVectorError("limit_exceeded", "Concept preview exceeds its PNG byte limit.");
  const { raw, inspection } = await decodeIdentityRaster(input);
  if (inspection.width !== 1024 || inspection.height !== 1024)
    return failed("Concept preview must be 1024 by 1024 pixels.");
  if (inspection.isMonochrome) return { pngBase64: Buffer.from(input.bytes).toString("base64") };
  const sharp = (await import("sharp")).default;
  const bytes = await sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: 4 } })
    .grayscale()
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  if (!bytes.length || bytes.length > IMAGE_INPUT_LIMITS.outputBytes)
    throw new LogoVectorError("limit_exceeded", "Normalized concept preview exceeds its PNG byte limit.");
  return { pngBase64: bytes.toString("base64") };
}
