import {
  brandBoardFont,
  brandBoardFontByteLength,
  brandTextReadiness,
  fontSupportsBrandText,
} from "@/domain/brand-board-fonts";
export { fontSupportsBrandText } from "@/domain/brand-board-fonts";
import type { AssetVersionReference } from "@/domain/asset-library";
import { BrandAssetError } from "../model/snapshot";
import type { BrandArtwork, BrandFontNames } from "../model/artwork";

export const BRAND_ASSET_TIMEOUT_MS = 60_000;
export const MAX_BRAND_ASSET_BYTES = 52_428_800;
export const MAX_BRAND_FONT_BYTES = 20_971_520;
export function checkBrandAssetSignal(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
}
export function observed<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    if (signal.aborted) {
      void promise.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
export async function boundedBrandAssetWork<T>(
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  checkBrandAssetSignal(signal);
  const controller = new AbortController(),
    abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new BrandAssetError("timeout")), BRAND_ASSET_TIMEOUT_MS);
  try {
    return await observed(work(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort();
  }
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function bytesFrom(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.ok) throw new BrandAssetError("source");
  const reader = response.body?.getReader();
  if (!reader) throw new BrandAssetError("source");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      checkBrandAssetSignal(signal);
      const { done, value } = await observed(reader.read(), signal);
      if (done) break;
      size += value.length;
      if (size > maximum) throw new BrandAssetError("size");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!size) throw new BrandAssetError("source");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
function rasterSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/png")
    return (
      bytes.length >= 33 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte) &&
      String.fromCharCode(...bytes.slice(12, 16)) === "IHDR"
    );
  if (mime === "image/jpeg") return bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return (
    mime === "image/webp" &&
    bytes.length > 16 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  );
}
function dataUrl(bytes: Uint8Array, mime: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return `data:${mime};base64,${btoa(chunks.join(""))}`;
}
type Preview = { url: string; release(): void };
export async function readBrandImage(
  reference: AssetVersionReference,
  mimeType: string,
  getPreview: (signal: AbortSignal) => Promise<Preview | null>,
  signal: AbortSignal,
) {
  const pending = getPreview(signal).then((value) => {
    if (signal.aborted) {
      value?.release();
      checkBrandAssetSignal(signal);
    }
    return value;
  });
  const preview = await observed(pending, signal);
  if (!preview) throw new BrandAssetError("source");
  const image = new Image();
  const release = () => {
    image.src = "";
    preview.release();
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    if (!preview.url.startsWith("blob:")) throw new BrandAssetError("source");
    const response = await observed(
      fetch(preview.url, { signal, credentials: "omit", mode: "same-origin", redirect: "error" }),
      signal,
    );
    if (response.headers.get("content-type")?.split(";", 1)[0] !== mimeType) throw new BrandAssetError("source");
    const bytes = await bytesFrom(response, MAX_BRAND_ASSET_BYTES, signal);
    if (!rasterSignature(bytes, mimeType) || (await observed(sha256(bytes), signal)) !== reference.contentHash)
      throw new BrandAssetError("source");
    image.src = preview.url;
    await observed(image.decode(), signal);
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth > 8192 ||
      image.naturalHeight > 8192 ||
      image.naturalWidth * image.naturalHeight > 32_000_000
    )
      throw new BrandAssetError("source");
    checkBrandAssetSignal(signal);
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      bytes,
      dataUrl: dataUrl(bytes, mimeType),
      release() {
        signal.removeEventListener("abort", release);
        release();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", release);
    release();
    throw error;
  }
}
export async function loadBrandFonts(
  artworks: readonly BrandArtwork[],
  signal: AbortSignal,
): Promise<{ names: BrandFontNames; release(): void }> {
  if (typeof FontFace === "undefined" || !document.fonts?.add) throw new BrandAssetError("font");
  const used = new Map<string, string>();
  for (const art of artworks)
    for (const node of art.nodes)
      if (node.kind === "text") used.set(node.family, (used.get(node.family) ?? "") + node.text);
  const names = new Map<string, string>(),
    faces: FontFace[] = [];
  try {
    for (const [family, text] of used) {
      const font = brandBoardFont(family);
      if (!font) throw new BrandAssetError("font");
      if (!fontSupportsBrandText(font, text))
        throw new BrandAssetError(brandTextReadiness(text).supported ? "font_coverage" : "unsupported_text");
      const byteLength = brandBoardFontByteLength(font);
      if (byteLength <= 0 || byteLength > MAX_BRAND_FONT_BYTES) throw new BrandAssetError("font");
      const response = await observed(
        fetch(font.file, { signal, credentials: "omit", mode: "same-origin", redirect: "error", cache: "force-cache" }),
        signal,
      );
      const bytes = await bytesFrom(response, byteLength, signal);
      if (bytes.byteLength !== byteLength || (await observed(sha256(bytes), signal)) !== font.sha256)
        throw new BrandAssetError("font");
      const name = `EmbelBrand_${font.id.replace(/-/g, "_")}_${font.sha256.slice(0, 10)}`;
      const face = new FontFace(name, bytes.buffer, {
        style: "normal",
        weight: `${font.minWeight} ${font.maxWeight}`,
        display: "block",
      });
      await observed(face.load(), signal);
      checkBrandAssetSignal(signal);
      if (face.status !== "loaded") throw new BrandAssetError("font");
      document.fonts.add(face);
      faces.push(face);
      names.set(family, name);
    }
    return {
      names,
      release() {
        faces.forEach((face) => document.fonts.delete(face));
      },
    };
  } catch (error) {
    faces.forEach((face) => document.fonts.delete(face));
    checkBrandAssetSignal(signal);
    throw error instanceof BrandAssetError ? error : new BrandAssetError("font");
  }
}
export async function brandCanvasPng(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const width = canvas.width,
    height = canvas.height;
  try {
    const blob = await observed(
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new BrandAssetError("canvas"))), "image/png"),
      ),
      signal,
    );
    if (blob.type !== "image/png" || blob.size > MAX_BRAND_ASSET_BYTES) throw new BrandAssetError("canvas");
    const bytes = new Uint8Array(await observed(blob.arrayBuffer(), signal));
    if (!rasterSignature(bytes, "image/png")) throw new BrandAssetError("canvas");
    const header = new DataView(bytes.buffer);
    if (header.getUint32(16) !== width || header.getUint32(20) !== height) throw new BrandAssetError("canvas");
    return bytes;
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}
