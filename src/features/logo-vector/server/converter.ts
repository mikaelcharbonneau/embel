import "server-only";
import { createHash } from "node:crypto";
import type { AssetVersionReference } from "../../../domain/asset-library";
import { verifiedAssetBytesSchema, type VerifiedAssetBytes } from "../../../domain/logo-deliverables";
import { logoTraceSettingsSchema, logoTypeSchema, type LogoTraceSettings, type LogoVectorDocument } from "../../../domain/logo-vector";
import type { LogoType } from "../../../domain/logo-workspace";
import { LogoVectorError } from "../model/errors";
import { validateLogoVectorDocument } from "../model/geometry";
import { serializeLogoSvg } from "../model/svg";
import { runIdentityRasterProcess, runLogoConceptGrayscaleProcess, runLogoVectorProcess } from "../../../server/image-process/process";
import { IMAGE_INPUT_LIMITS } from "../../../domain/logo-image-limits";

export const LOGO_RASTER_LIMITS = Object.freeze({ bytes: 33_554_432, pixels: 16_777_216, edge: 8192, timeoutMs: 60_000, teardownMs: 5_000 });
export type LogoVectorWorkInput = { source: VerifiedAssetBytes; logoType: LogoType; settings: LogoTraceSettings };
export type LogoRasterObservation = {
  inputFormat: "png" | "jpeg" | "webp"; inputWidth: number; inputHeight: number;
  width: number; height: number; originalOrientation: number; autoOriented: boolean;
  inputColorSpace: string; outputColorSpace: "srgb"; rgbaContentHash: string;
  alphaStrategy: "exact-alpha-layers"; alphaLevels: number[];
};
export type LogoVectorConversionResult = {
  source: AssetVersionReference; sourceContentHash: string; logoType: LogoType;
  document: LogoVectorDocument; svg: Uint8Array;
  engine: { name: "@visioncortex/vtracer"; version: "1.0.0-alpha.4"; artifactHash: string; settings: LogoTraceSettings };
  raster: LogoRasterObservation;
};
export function assertLogoConversionNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new LogoVectorError("cancelled", "Logo conversion was cancelled. The original preview is unchanged.");
}
/** Recheck actual bytes; a VerifiedAssetBytes-shaped object is not verification. */
export function verifyLogoRasterSource(source: VerifiedAssetBytes): void {
  if (!(source?.bytes instanceof Uint8Array) || source.bytes.byteLength > LOGO_RASTER_LIMITS.bytes) {
    throw new LogoVectorError("limit_exceeded", "Raster input exceeds the 32 MiB conversion limit.");
  }
  if (!verifiedAssetBytesSchema.safeParse(source).success || createHash("sha256").update(source.bytes).digest("hex") !== source.reference.contentHash) {
    throw new LogoVectorError("source_mismatch", "Raster bytes do not match the exact verified source.");
  }
  assertIdentityRasterFormat(source.bytes, source.mimeType);
}
export function assertIdentityRasterFormat(bytes: Uint8Array, mimeType: string): void {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.byteLength > LOGO_RASTER_LIMITS.bytes) throw new LogoVectorError("limit_exceeded", "Raster input exceeds the 32 MiB conversion limit.");
  const png = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b);
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
  if (!((mimeType === "image/png" && png) || (mimeType === "image/jpeg" && jpeg) || (mimeType === "image/webp" && webp))) {
    throw new LogoVectorError("source_mismatch", "Raster MIME must match actual PNG, JPEG or WebP bytes.");
  }
}
export async function convertLogoRaster(input: LogoVectorWorkInput, signal: AbortSignal): Promise<LogoVectorConversionResult> {
  assertLogoConversionNotAborted(signal);
  verifyLogoRasterSource(input.source);
  const type = logoTypeSchema.safeParse(input.logoType), settings = logoTraceSettingsSchema.safeParse(input.settings);
  if (!type.success || !settings.success) throw new LogoVectorError("conversion_failed", "Logo type or trace settings are unsupported.");
  // Snapshot before yielding. Buffer.slice() aliases caller memory, so always copy.
  const frozen = { source: { ...input.source, reference: { ...input.source.reference }, verification: { ...input.source.verification }, bytes: Uint8Array.from(input.source.bytes) }, logoType: type.data, settings: settings.data };
  const output = await runLogoVectorProcess(frozen, signal);
  assertLogoConversionNotAborted(signal);
  const document = validateLogoVectorDocument(output.document);
  const svg = serializeLogoSvg(document);
  assertLogoConversionNotAborted(signal);
  return { source: frozen.source.reference, sourceContentHash: frozen.source.reference.contentHash, logoType: type.data, document, svg,
    engine: { name: "@visioncortex/vtracer", version: "1.0.0-alpha.4", artifactHash: output.artifactHash, settings: settings.data }, raster: output.raster };
}

/** Shared pre-publication inspector; no asset/provenance is invented from decoded pixels. */
export async function inspectIdentityRaster(bytes: Uint8Array, mimeType: string, signal = new AbortController().signal) {
  assertLogoConversionNotAborted(signal);
  assertIdentityRasterFormat(bytes, mimeType);
  const result = await runIdentityRasterProcess({ bytes: Uint8Array.from(bytes), mimeType }, signal);
  assertLogoConversionNotAborted(signal);
  return result;
}

/** Normalize newly generated concept and saved-preview refinement output.
 * Reference inputs, retained sources and vector/color producers are unchanged. */
export async function normalizeLogoConceptRaster(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  assertLogoConversionNotAborted(signal);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > IMAGE_INPUT_LIMITS.outputBytes) throw new LogoVectorError("limit_exceeded", "Concept preview exceeds its PNG byte limit.");
  assertIdentityRasterFormat(bytes, "image/png");
  const result = await runLogoConceptGrayscaleProcess({ bytes: Uint8Array.from(bytes), mimeType: "image/png" }, signal);
  assertLogoConversionNotAborted(signal);
  assertIdentityRasterFormat(result, "image/png");
  return result;
}
