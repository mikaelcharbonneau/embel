import { decodeIdentityRaster } from "./raster";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import nodeModule from "node:module";
import { dirname, join } from "node:path";
import { logoTraceSettingsSchema, logoTypeSchema, type LogoTraceSettings, type LogoType, type LogoVectorDocument, type LogoVectorPath } from "../../src/domain/logo-vector";
import { LogoVectorError } from "../../src/features/logo-vector/model/errors";
import { canonicalizeLogoPath, encodeLogoPath, validateLogoVectorDocument } from "../../src/features/logo-vector/model/geometry";
import { validateLogoVectorSvg } from "../../src/features/logo-vector/model/svg";
import { VECTOR_LIMITS } from "../../src/features/logo-vector/model/limits";
import type { LogoRasterObservation } from "../../src/features/logo-vector/server/converter";

export const QUALIFIED_VTRACER = Object.freeze({
  version: "1.0.0-alpha.4", wasm: "63716b70497b7468ef97545b50f5f34b8bbb7acde2d7b00deb4eb40781446d45",
  entry: "efd6b937a73acc53705ec04fc8a8a0cddeb10fc3503018640587bf2377cb050f",
  bridge: "e1855e9bb29d785344f672abdc692ca90ffa7ed863b9186b51c4e95a2a7dc17d",
});
export type LogoVectorEngineInput = { bytes: Uint8Array; mimeType: string; logoType: LogoType; settings: LogoTraceSettings };
export type LogoVectorEngineOutput = { document: LogoVectorDocument; artifactHash: string; raster: LogoRasterObservation };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const failed = (message: string): never => { throw new LogoVectorError("conversion_failed", message); };
function verifyInstalledEngine(): typeof import("@visioncortex/vtracer") {
  try {
    const require = nodeModule.createRequire(join(process.cwd(), "package.json")), entry = require.resolve("@visioncortex/vtracer"), root = dirname(entry);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
    if (manifest.version !== QUALIFIED_VTRACER.version || hash(readFileSync(entry)) !== QUALIFIED_VTRACER.entry ||
      hash(readFileSync(join(root, "pkg/vtracer_wasm.js"))) !== QUALIFIED_VTRACER.bridge || hash(readFileSync(join(root, "pkg/vtracer_wasm_bg.wasm"))) !== QUALIFIED_VTRACER.wasm) throw new Error();
    return require("@visioncortex/vtracer") as typeof import("@visioncortex/vtracer");
  } catch { throw new LogoVectorError("engine_unavailable", "The exact qualified local tracing engine is unavailable."); }
}
/** Runs only inside the fixed killable process. Never accepts paths, URLs or credentials. */
export async function traceLogoRaster(input: LogoVectorEngineInput): Promise<LogoVectorEngineOutput> {
  const vtracer = verifyInstalledEngine();
  const settings = logoTraceSettingsSchema.parse(input.settings), logoType = logoTypeSchema.parse(input.logoType);
  if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > 33_554_432) throw new LogoVectorError("limit_exceeded", "Raster input exceeds the conversion byte limit.");
  const { raw, metadata, inspection } = await decodeIdentityRaster(input);
  const { width, height } = raw.info, rgbaHash = inspection.pixelHash;
  // B/W reads each pixel as it shows on white, giving one opaque layer of the
  // pixels darker than mid-gray, so a transparent background and its soft edges
  // trace as crisp shapes rather than one faint layer per alpha level. For an
  // opaque raster this is the plain luminance threshold. Poster keeps exact alpha.
  const level = (i: number): number => {
    const alpha = raw.data[i + 3]!;
    if (settings.preset !== "bw") return alpha;
    const luminance = 0.2126 * raw.data[i]! + 0.7152 * raw.data[i + 1]! + 0.0722 * raw.data[i + 2]!;
    return luminance * alpha / 255 + 255 - alpha < 128 ? 255 : 0;
  };
  const bounds = new Map<number, { x: number; y: number; right: number; bottom: number }>();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, alpha = level(i);
    if (!alpha) continue;
    const b = bounds.get(alpha);
    if (b) { b.x = Math.min(b.x, x); b.y = Math.min(b.y, y); b.right = Math.max(b.right, x); b.bottom = Math.max(b.bottom, y); }
    else bounds.set(alpha, { x, y, right: x, bottom: y });
  }
  const alphaLevels = [...bounds.keys()].sort((a, b) => a - b), paths: LogoVectorPath[] = [];
  let svgBytes = 0;
  // This prerelease drops fractional alpha, and BW ignores transparent RGB. Trace
  // disjoint exact-alpha color masks and restore alpha on each resulting path.
  for (const alpha of alphaLevels) {
    // Keep the original canvas: a tight region crop could clip spline extrema.
    const b = { x: 0, y: 0 }, layerWidth = width, layerHeight = height;
    const layer = new Uint8Array(layerWidth * layerHeight * 4);
    for (let y = 0; y < layerHeight; y++) for (let x = 0; x < layerWidth; x++) {
      const i = ((y + b.y) * width + x + b.x) * 4, target = (y * layerWidth + x) * 4;
      if (level(i) !== alpha) continue;
      if (settings.preset !== "bw") { layer[target] = raw.data[i]!; layer[target + 1] = raw.data[i + 1]!; layer[target + 2] = raw.data[i + 2]!; }
      layer[target + 3] = 255;
    }
    let svg: string;
    try { svg = vtracer.convertPixels(layer, layerWidth, layerHeight, { ...settings, clustering: "color-cluster", hierarchical: "cutout", colorPrecision: 8, mode: "spline", optimize: 0 }); }
    catch { return failed("The local engine could not trace this raster with the selected settings."); }
    svgBytes += Buffer.byteLength(svg);
    if (svgBytes > VECTOR_LIMITS.bytes) throw new LogoVectorError("limit_exceeded", "Traced geometry exceeds the 8 MiB limit.");
    let document: LogoVectorDocument;
    try { document = validateLogoVectorSvg(new TextEncoder().encode(svg)); }
    catch (error) { if (error instanceof LogoVectorError && error.code === "empty_artwork" && settings.filterSpeckle > 0) continue; throw error; }
    for (const path of document.components.flatMap(c => c.paths)) {
      paths.push({ ...path, id: `trace-${alpha}-${paths.length}`, d: encodeLogoPath(canonicalizeLogoPath(path.d, [1,0,0,1,b.x,b.y])), fill: path.fill ? { ...path.fill, opacity: path.fill.opacity * alpha / 255 } : null });
      if (paths.length > VECTOR_LIMITS.paths) throw new LogoVectorError("limit_exceeded", "Traced geometry exceeds the path-count limit.");
    }
  }
  if (!paths.length) throw new LogoVectorError("empty_artwork", "No visible logo remains at these trace settings. The original is retained.");
  const isLettering = logoType === "wordmark" || logoType === "lettermark_monogram";
  const document = validateLogoVectorDocument({ version: 1, viewBox: [0,0,width,height], components: [{ id: "traced-artwork", role: isLettering ? "lettering" : "whole_artwork", editingKind: isLettering ? "outlined_custom" : "geometry", transform: { x: 0, y: 0, scale: 1, rotation: 0 }, paths }] });
  return { document, artifactHash: QUALIFIED_VTRACER.wasm, raster: { inputFormat: metadata.format as "png" | "jpeg" | "webp", inputWidth: metadata.width!, inputHeight: metadata.height!, width, height,
    originalOrientation: metadata.orientation ?? 1, autoOriented: (metadata.orientation ?? 1) !== 1, inputColorSpace: metadata.space, outputColorSpace: "srgb", rgbaContentHash: rgbaHash, alphaStrategy: "exact-alpha-layers", alphaLevels } };
}
