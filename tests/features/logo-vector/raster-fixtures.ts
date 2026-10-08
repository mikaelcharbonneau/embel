import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { VerifiedAssetBytes } from "../../../src/domain/logo-deliverables";
import type { LogoType } from "../../../src/domain/logo-workspace";
import type { LogoVectorWorkInput } from "../../../src/features/logo-vector/server/converter";

export const syntheticOwnerId = "11111111-1111-4111-8111-111111111111";
export const syntheticProjectId = "22222222-2222-4222-8222-222222222222";
export const digestBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function pngChunk(type: string, bytes: Uint8Array): Buffer {
  const data = Buffer.from(bytes), name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
/** Original synthetic RGBA artwork encoded as actual PNG bytes; no provider images. */
export function syntheticPng(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Uint8Array {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(rows)), pngChunk("IEND", new Uint8Array())]);
}
export function syntheticSource(inputBytes: Uint8Array, mimeType = "image/png"): VerifiedAssetBytes {
  const bytes = Uint8Array.from(inputBytes);
  const contentHash = digestBytes(bytes);
  return { reference: { ownerId: syntheticOwnerId, projectId: syntheticProjectId, assetId: "33333333-3333-4333-8333-333333333333", versionId: "44444444-4444-4444-8444-444444444444", contentHash }, mimeType, bytes,
    verification: { status: "verified", checkedAt: "2026-10-07T00:00:00Z", contentHash, mimeType, byteLength: bytes.byteLength } };
}
export function syntheticConversionInput(logoType: LogoType): LogoVectorWorkInput {
  const bytes = syntheticPng(48, 40, (x, y) => {
    const lettering = x >= 9 && x < 38 && y >= 15 && y < 26 && (x % 9 < 5 || y < 18 || y > 22);
    const diamond = Math.abs(x - 24) + Math.abs(y - 20) < 13;
    const circle = (x - 24) ** 2 + (y - 20) ** 2 < 13 ** 2;
    const eye = ((x - 19) ** 2 + (y - 17) ** 2 < 4) || ((x - 29) ** 2 + (y - 17) ** 2 < 4);
    const ring = (x - 24) ** 2 + (y - 20) ** 2 >= 10 ** 2;
    let ink = false;
    if (logoType === "wordmark" || logoType === "lettermark_monogram") ink = lettering;
    if (logoType === "abstract") ink = diamond && !(x > 22 && y < 18);
    if (logoType === "pictorial") ink = circle && !eye;
    if (logoType === "combination") ink = (x < 16 && Math.abs(x - 9) + Math.abs(y - 12) < 7) || (lettering && y > 20);
    if (logoType === "emblem") ink = (circle && ring) || (lettering && x > 16 && x < 32 && y > 17 && y < 24);
    if (logoType === "mascot") ink = (circle || ((x < 16 || x > 32) && y > 9 && y < 15 && x > 10 && x < 38)) && !eye && !(x > 20 && x < 28 && y > 24 && y < 27);
    return ink ? [0, 0, 0, 255] : [255, 255, 255, 255];
  });
  return { source: syntheticSource(bytes), logoType, settings: { preset: "bw", simplify: 0, filterSpeckle: 0, maxColors: 2 } };
}
