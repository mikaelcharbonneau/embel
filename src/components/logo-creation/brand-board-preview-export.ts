import type { InspirationChoice } from "@/domain/inspiration";
import { committedIdentityAssetReceiptSchema, type IdentityAssetReceipt } from "@/domain/logo-deliverables";
import type { LogoType } from "@/domain/logo-workspace";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import { AccountRequestError } from "@/components/workspace/account-api";
import { brandBoardDirection } from "./brand-board-direction";

export const BOARD_PREVIEW_WIDTH = 1600;
export const BOARD_PREVIEW_HEIGHT = 1800;
export const BOARD_PREVIEW_TIMEOUT_MS = 20_000;
const maxPixels = 32_000_000;

/** An in-memory presentation snapshot, not an approved identity or a saved export. */
export function createBoardPreviewSnapshot(input: { name: string; logoType: LogoType; choices: readonly InspirationChoice[]; receipt: IdentityAssetReceipt; logoNeedsReview: boolean }) {
  const receipt = committedIdentityAssetReceiptSchema.parse(input.receipt);
  const direction = brandBoardDirection(input.choices, input.logoType);
  return {
    version: 1 as const, name: input.name, receipt, logoNeedsReview: input.logoNeedsReview,
    paletteSource: direction.paletteSource, palette: direction.palette.map(color => ({ ...color })), type: { ...direction.type },
  };
}
export type BoardPreviewSnapshot = ReturnType<typeof createBoardPreviewSnapshot>;

export class BoardPreviewError extends Error {
  constructor(readonly reason: "unavailable" | "image" | "font" | "canvas" | "timeout") { super(reason); }
}
const cancelled = () => new DOMException("Cancelled", "AbortError");
function check(signal: AbortSignal) { if (signal.aborted) throw signal.reason ?? cancelled(); }

/** Observe even non-cooperative browser APIs without retaining an unbounded UI wait. */
function observed<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? cancelled());
    if (signal.aborted) { void promise.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(signal.reason ?? cancelled()); else resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
export async function boundedBoardPreview<T>(signal: AbortSignal, work: (boundedSignal: AbortSignal) => Promise<T>): Promise<T> {
  check(signal);
  const controller = new AbortController(), abort = () => controller.abort(signal.reason ?? cancelled());
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new BoardPreviewError("timeout")), BOARD_PREVIEW_TIMEOUT_MS);
  try { return await observed(work(controller.signal), controller.signal); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); }
}

function rasterSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/png") return bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte) && String.fromCharCode(...bytes.slice(12, 16)) === "IHDR";
  if (mime === "image/jpeg") return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return mime === "image/webp" && bytes.length >= 16 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
}
async function decodeImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  const image = new Image();
  if (typeof image.decode !== "function") throw new BoardPreviewError("image");
  const clear = () => { image.src = ""; };
  signal.addEventListener("abort", clear, { once: true });
  try {
    image.src = url;
    await observed(image.decode(), signal);
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 8192 || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > maxPixels) throw new BoardPreviewError("image");
    return image;
  } catch (error) { clear(); check(signal); throw error instanceof BoardPreviewError ? error : new BoardPreviewError("image"); }
  finally { signal.removeEventListener("abort", clear); }
}

/** No signed/public URL or new download API: only the client's verified private blob. */
async function readLogo(client: Pick<AccountLogoClient, "previewAsset">, snapshot: BoardPreviewSnapshot, signal: AbortSignal) {
  const pending = client.previewAsset(snapshot.receipt, signal).then(preview => {
    if (signal.aborted) { preview?.release(); throw signal.reason ?? cancelled(); }
    return preview;
  });
  const preview = await observed(pending, signal);
  if (!preview) throw new BoardPreviewError("unavailable");
  try {
    if (!preview.url.startsWith("blob:")) throw new BoardPreviewError("image");
    // This reads an already verified, local object URL, not another remote asset.
    const response = await observed(fetch(preview.url, { signal, credentials: "omit", mode: "same-origin", redirect: "error" }), signal);
    const blob = await observed(response.blob(), signal);
    if (!response.ok || blob.type !== snapshot.receipt.verification.mimeType || blob.size !== snapshot.receipt.verification.byteLength) throw new BoardPreviewError("image");
    const bytes = new Uint8Array(await observed(blob.arrayBuffer(), signal));
    if (!rasterSignature(bytes, blob.type)) throw new BoardPreviewError("image");
    const image = await decodeImage(preview.url, signal);
    return { image, release() { image.src = ""; preview.release(); } };
  } catch (error) { preview.release(); throw error; }
}

/** A fresh owner-checked read prevents a prepared file bypassing expired/revoked access. */
export async function recheckBoardPreviewLogo(client: Pick<AccountLogoClient, "previewAsset">, snapshot: BoardPreviewSnapshot, signal: AbortSignal): Promise<void> {
  const logo = await readLogo(client, snapshot, signal);
  logo.release();
}

async function loadedFont(snapshot: BoardPreviewSnapshot, signal: AbortSignal) {
  const family = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-sans").split(",")[0]!.trim();
  // Use the actual Next/font family, never label a silently substituted font as Geist.
  if (!family || !/geist/i.test(family) || !/^[\w\s'"-]+$/.test(family) || !document.fonts?.load) throw new BoardPreviewError("font");
  const sample = `${snapshot.name} A clear direction. The quick brown fox jumps over the lazy dog. Aa Bb Cc & 0123456789`;
  for (const weight of [400, 500, snapshot.type.headingWeight]) {
    const font = `${weight} 24px ${family}`;
    try {
      const faces = await observed(document.fonts.load(font, sample), signal);
      if (!faces.length || faces.some(face => face.status !== "loaded") || !document.fonts.check(font, sample)) throw new BoardPreviewError("font");
    } catch { check(signal); throw new BoardPreviewError("font"); }
  }
  return family;
}

/** Explicit composition, not a DOM screenshot; no hidden content, raw brief, remote
 * image, invented marketing copy, production geometry or transparent logo export. */
export function drawBoardPreview(canvas: HTMLCanvasElement, image: HTMLImageElement, snapshot: BoardPreviewSnapshot, family: string): void {
  canvas.width = BOARD_PREVIEW_WIDTH; canvas.height = BOARD_PREVIEW_HEIGHT;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx || !("letterSpacing" in ctx)) throw new BoardPreviewError("canvas");
  const rect = (x: number, y: number, w: number, h: number, color: string) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
  const text = (value: string, x: number, y: number, size: number, weight = 400, color = "#191919", maxWidth = 1400, tracking = "0px") => {
    ctx.fillStyle = color; ctx.letterSpacing = tracking; ctx.textBaseline = "top";
    ctx.font = `${weight} ${size}px ${family}`;
    // Shrink rather than silently clipping a long saved name or palette label.
    while (ctx.measureText(value).width > maxWidth && size > 12) { size--; ctx.font = `${weight} ${size}px ${family}`; }
    ctx.fillText(value, x, y, maxWidth); ctx.letterSpacing = "0px";
  };
  rect(0, 0, canvas.width, canvas.height, "#F5F3EC");
  text("BRAND BOARD · PREVIEW", 64, 48, 20, 500, "#696965");
  text(snapshot.name, 64, 90, 54, 500, "#191919", 1472);
  text("Selected raster logo with proposed colors and default typography.", 64, 165, 23);
  rect(64, 230, 840, 430, "#FFFFFF"); rect(928, 230, 608, 430, "#FFFFFF"); rect(64, 684, 1472, 290, "#FFFFFF");
  text("Selected logo", 92, 256, 23, 500);
  const scale = Math.min(744 / image.naturalWidth, 282 / image.naturalHeight);
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
  ctx.drawImage(image, 112 + (744 - width) / 2, 302 + (282 - height) / 2, width, height);
  text(`Saved selection${snapshot.logoNeedsReview ? " · Review changed inputs" : ""}`, 92, 614, 19, 400, "#696965", 784);
  text("Proposed palette", 956, 256, 23, 500);
  text(snapshot.paletteSource === "saved_inspiration" ? "From saved inspiration" : "Neutral starting point", 956, 290, 18, 400, "#696965", 552);
  snapshot.palette.forEach((color, index) => {
    const y = 330 + index * 60;
    rect(956, y, 44, 44, "#E4E3DF"); rect(957, y + 1, 42, 42, color.hex);
    text(`${color.role.split(" · ")[0]} · ${color.name}`, 1016, y, 19, 500, "#191919", 492);
    text(color.hex, 1016, y + 26, 17, 400, "#696965");
  });
  text("Proposed typography", 92, 710, 23, 500);
  text(`${snapshot.type.family} · Default preview`, 92, 750, 20, 400, "#696965");
  text(`Heading · ${snapshot.type.headingWeight === 700 ? "Bold 700" : "Semibold 600"} · Tracking ${snapshot.type.tracking}`, 92, 800, 18, 400, "#696965", 700);
  text("A clear direction.", 92, 832, 48, snapshot.type.headingWeight, "#191919", 700, `${parseFloat(snapshot.type.tracking) * 48}px`);
  text("Labels · Medium 500", 92, 928, 18, 500, "#696965");
  text("Body · Regular 400", 850, 800, 18, 400, "#696965", 640);
  text("The quick brown fox jumps", 850, 836, 27, 400, "#191919", 640);
  text("over the lazy dog.", 850, 873, 27, 400, "#191919", 640);
  text("Aa Bb Cc & 0123456789", 850, 928, 23, 400, "#191919", 640);
  // Application artwork is part of this one board raster, never inside a device.
  const primary = snapshot.palette[0]!, accent = snapshot.palette[1] ?? primary;
  text("SOCIAL APPLICATIONS", 64, 1012, 20, 500, "#696965");
  rect(64, 1060, 560, 560, primary.hex);
  const socialScale = Math.min(380 / image.naturalWidth, 180 / image.naturalHeight);
  const sw = image.naturalWidth * socialScale, sh = image.naturalHeight * socialScale;
  ctx.drawImage(image, 154 + (380 - sw) / 2, 1130 + (180 - sh) / 2, sw, sh);
  text(snapshot.name, 104, 1400, 46, snapshot.type.headingWeight, primary.foreground, 480);
  text("Your announcement goes here.", 104, 1475, 24, 400, primary.foreground, 480);
  text("Social post · Artwork preview", 64, 1636, 18, 400, "#696965", 560);
  // X's wide header format is shown directly, without social UI or device chrome.
  rect(656, 1060, 880, 880 / 3, accent.hex);
  const bannerScale = Math.min(260 / image.naturalWidth, 170 / image.naturalHeight);
  const bw = image.naturalWidth * bannerScale, bh = image.naturalHeight * bannerScale;
  ctx.drawImage(image, 706 + (260 - bw) / 2, 1122 + (170 - bh) / 2, bw, bh);
  text(snapshot.name, 1000, 1150, 38, snapshot.type.headingWeight, accent.foreground, 470);
  text("X header · Artwork preview", 656, 1370, 18, 400, "#696965", 880);
  text("One cohesive visual identity.", 656, 1450, 40, snapshot.type.headingWeight, "#191919", 880);
  text("Selected logo · Color palette · Typography · Social artwork", 656, 1514, 22, 400, "#696965", 880);
  text("One raster Brand Board · Proposed design, not an approved identity.", 64, 1710, 20, 500, "#696965");
  text("Not SVG/PDF masters, transparent logo files or a final brand package. Social copy is a placeholder.", 64, 1750, 18, 400, "#696965", 1472);
}

export async function prepareBoardPreview(client: Pick<AccountLogoClient, "previewAsset">, snapshot: BoardPreviewSnapshot, signal: AbortSignal): Promise<Blob> {
  const logo = await readLogo(client, snapshot, signal);
  try {
    const family = await loadedFont(snapshot, signal); check(signal);
    const canvas = document.createElement("canvas");
    drawBoardPreview(canvas, logo.image, snapshot, family);
    const blob = await observed(new Promise<Blob>((resolve, reject) => {
      try { canvas.toBlob(value => value ? resolve(value) : reject(new BoardPreviewError("canvas")), "image/png"); }
      catch { reject(new BoardPreviewError("canvas")); }
    }), signal);
    if (blob.type !== "image/png" || blob.size > 16_777_216) throw new BoardPreviewError("canvas");
    const bytes = new Uint8Array(await observed(blob.arrayBuffer(), signal));
    if (!rasterSignature(bytes, "image/png")) throw new BoardPreviewError("canvas");
    const url = URL.createObjectURL(blob);
    try {
      const decoded = await decodeImage(url, signal);
      const valid = decoded.naturalWidth === BOARD_PREVIEW_WIDTH && decoded.naturalHeight === BOARD_PREVIEW_HEIGHT;
      decoded.src = "";
      if (!valid) throw new BoardPreviewError("canvas");
    } finally { URL.revokeObjectURL(url); }
    check(signal); return blob;
  } finally { logo.release(); }
}

export function boardPreviewFilename(snapshot: BoardPreviewSnapshot): string {
  // No raw brief, path characters, control characters, owner IDs or signed URLs.
  const name = snapshot.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64).replace(/-$/, "") || "brand";
  return `${name}-board-preview.png`;
}
export function boardPreviewError(error: unknown): string {
  if (error instanceof AccountRequestError && [401, 403, 404].includes(error.status)) return "Your selected image is no longer accessible. Reload the board or sign in again, then retry.";
  if (error instanceof BoardPreviewError && error.reason === "font") return "The board font could not be loaded. Reload the page and retry the preview.";
  if (error instanceof BoardPreviewError && error.reason === "canvas") return "This browser could not create a PNG preview. Retry in a browser with canvas support.";
  if (error instanceof BoardPreviewError && error.reason === "timeout") return "Preparing the preview took too long. Check your connection and retry.";
  return "The selected image could not be verified for download. Reload the board or retry. Your saved selection is unchanged.";
}
