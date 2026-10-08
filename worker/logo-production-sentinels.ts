import "server-only";
import { zipSync } from "fflate";
import { z } from "zod";
import { runLogoVectorProcess } from "./logo-vector/process";
import { QUALIFIED_VTRACER } from "./logo-vector/engine";
import { flattenLogoPaths, validateLogoVectorDocument } from "../src/features/logo-vector/model/geometry";
import { serializeLogoSvg, validateLogoVectorSvg } from "../src/features/logo-vector/model/svg";
import { runLogoProcess } from "../src/features/identity-deliverables/server/process";
import { inspectLogoExportArchive } from "../src/features/identity-deliverables/server/validate-assets";
import { sha256 } from "../src/features/identity-deliverables/server/render-policy";

const unavailable = () => new Error("Logo production runtime qualification failed.");
const bytesSchema = z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= 1_048_576);
const renderedSchema = z.strictObject({ png: bytesSchema, pdf: bytesSchema });
const verificationSchema = z.strictObject({ pathPaintCount: z.number().int().min(1).max(4),
  meanAbsoluteNormalizedError: z.number().min(0).max(0.01), alphaBoundsDelta: z.number().min(0).max(1), pngPixelHash: z.string().regex(/^[a-f0-9]{64}$/) });
/** Original 16x16 transparent canvas with one central 8x8 opaque black square.
 * This is internal passive sentinel data, never an owned record or approval. */
function vectorSentinel() {
  const bytes = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAF0lEQVR4nGNgGAXYwH8CeNSAkWHASAMAKf8/wT4euD8AAAAASUVORK5CYII=", "base64"));
  const contentHash = sha256(bytes), id = "00000000-0000-4000-8000-000000000001";
  return { source: { bytes, mimeType: "image/png", reference: { ownerId: id, projectId: id, assetId: id, versionId: id, contentHash },
    verification: { status: "verified" as const, checkedAt: "2000-01-01T00:00:00Z", contentHash, mimeType: "image/png", byteLength: bytes.byteLength } },
    logoType: "abstract" as const, settings: { preset: "bw" as const, simplify: 0, filterSpeckle: 0, maxColors: 2 } };
}
export async function qualifyVectorSentinel(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const result = await runLogoVectorProcess(vectorSentinel(), signal);
  signal.throwIfAborted();
  const document = validateLogoVectorDocument(result.document), svg = serializeLogoSvg(document), parsed = validateLogoVectorSvg(svg);
  if (result.artifactHash !== QUALIFIED_VTRACER.wasm || JSON.stringify(document.viewBox) !== "[0,0,16,16]"
    || sha256(svg) !== "925e204e97f69a8ea4da4206763fe50c2c63dfc4f244efe42558e067e4c42009"
    || flattenLogoPaths(parsed).length !== 1 || result.raster.inputFormat !== "png" || result.raster.inputWidth !== 16 || result.raster.inputHeight !== 16
    || result.raster.width !== 16 || result.raster.height !== 16 || result.raster.originalOrientation !== 1 || result.raster.autoOriented
    || result.raster.outputColorSpace !== "srgb" || result.raster.alphaStrategy !== "exact-alpha-layers"
    || JSON.stringify(result.raster.alphaLevels) !== "[255]" || result.raster.rgbaContentHash !== "51f1ee56b003f623c3fe8768e2efac0307432ef151952fd2d0d4c0a774766ec0") throw unavailable();
  const path = flattenLogoPaths(parsed)[0]!;
  if (path.fill?.color !== "#000000" || path.fill.opacity !== 1 || path.stroke !== null) throw unavailable();
}
/** Exercises the unchanged production renderer and independent verifier without
 * fabricating an ApprovedDeliverableSnapshot or bypassing its job approvals. */
export async function qualifyExportSentinel(bodyFont: Uint8Array, bodyFontLicense: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const document = validateLogoVectorDocument({ version: 1, viewBox: [0, 0, 16, 16], components: [{ id: "qualification-square", role: "whole_artwork", editingKind: "geometry",
    transform: { x: 0, y: 0, scale: 1, rotation: 0 }, paths: [{ id: "square", d: "M4 4 L12 4 L12 12 L4 12 Z", fill: { color: "#000000", opacity: 1 }, stroke: null, fillRule: "nonzero" }] }] });
  const svg = serializeLogoSvg(document), variantHash = sha256(svg), dimensions = { width: 32, height: 32 };
  validateLogoVectorSvg(svg);
  const files = renderedSchema.parse(await runLogoProcess({ operation: "logo", svg, paths: flattenLogoPaths(document), viewBox: document.viewBox, variantHash, ...dimensions }, signal));
  const evidence = verificationSchema.parse(await runLogoProcess({ operation: "verify", svg, ...files, variantHash, expectedViewBox: document.viewBox, ...dimensions }, signal));
  // Pixel evidence comes from the independent real decoder, rather than file signatures alone.
  const expectedPixels = new Uint8Array(32 * 32 * 4);
  for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) expectedPixels[(y * 32 + x) * 4 + 3] = 255;
  if (evidence.pngPixelHash !== sha256(expectedPixels)) throw unavailable();
  const guidelines = bytesSchema.parse(await runLogoProcess({ operation: "guidelines", brandName: "Runtime qualification", logoApprovalId: "internal-sentinel", directionApprovalId: "internal-sentinel",
    variants: [{ id: "sentinel", role: "primary", colorway: "black", paths: flattenLogoPaths(document), viewBox: document.viewBox, clearSpace: 4, minimumDigitalSize: null }],
    colors: [], typography: [], bodyFont, bodyFontLicense, notice: "Internal runtime qualification only. No user asset or approval." }, signal));
  if (Buffer.from(guidelines.subarray(0, 5)).toString("ascii") !== "%PDF-") throw unavailable();
  const entries = { "sentinel.svg": svg, "sentinel.pdf": files.pdf, "sentinel.png": files.png, "guidelines.pdf": guidelines };
  const archive = zipSync(Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, [bytes, { mtime: new Date("2000-01-01T00:00:00Z") }]])), { level: 1 });
  const unpacked = inspectLogoExportArchive(archive);
  if (Object.keys(unpacked).length !== Object.keys(entries).length || Object.entries(entries).some(([name, bytes]) => !unpacked[name] || sha256(unpacked[name]!) !== sha256(bytes))) throw unavailable();
  signal.throwIfAborted();
}
