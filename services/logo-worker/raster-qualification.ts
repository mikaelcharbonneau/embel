import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { inspectIdentityRaster, normalizeLogoConceptRaster } from "../../src/features/logo-vector/server/converter";

function chunk(name: string, bytes: Uint8Array): Buffer {
  const type = Buffer.from(name), data = Buffer.concat([type, bytes]);
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, data, checksum]);
}

/** A generated fixed PNG sentinel exercises the actual isolated decoder and
 * grayscale process from the release cwd. No user image or network is involved. */
export async function qualifyCloudLogoRaster(signal: AbortSignal): Promise<void> {
  const width = 1024, height = 1024, scanlines = Buffer.alloc((width * 4 + 1) * height), pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = (y * width + x) * 4, row = y * (width * 4 + 1) + 1 + x * 4;
    pixels[pixel] = scanlines[row] = 220; pixels[pixel + 1] = scanlines[row + 1] = 30;
    pixels[pixel + 2] = scanlines[row + 2] = 90; pixels[pixel + 3] = scanlines[row + 3] = 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
  try {
    const original = await inspectIdentityRaster(png, "image/png", signal);
    if (original.width !== width || original.height !== height || original.isMonochrome || original.pixelHash !== createHash("sha256").update(pixels).digest("hex")) throw new Error();
    const normalized = await normalizeLogoConceptRaster(png, signal), inspected = await inspectIdentityRaster(normalized, "image/png", signal);
    if (inspected.width !== width || inspected.height !== height || !inspected.isMonochrome || inspected.pixelHash === original.pixelHash) throw new Error();
  } catch { throw new Error("cloud_logo_raster_unqualified"); }
}
