import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { logoTraceSettingsSchema, logoTypeSchema, logoHashSchema, logoVectorDocumentSchema } from "../../src/domain/logo-vector";
import { LogoVectorError, type LogoVectorErrorCode } from "../../src/features/logo-vector/model/errors";
import type { LogoVectorWorkInput } from "../../src/features/logo-vector/server/converter";
import type { LogoVectorEngineOutput } from "./engine";
import type { IdentityRasterInspection } from "./raster";
import { IMAGE_INPUT_LIMITS } from "../../src/domain/logo-image-limits";

// Only the isolated cloud build substitutes these literals. Local invocation
// keeps the reviewed TypeScript entrypoint and its ordinary direct-run guard.
declare const __EMBEL_LOGO_RASTER_ENTRYPOINT__: string;
declare const __EMBEL_LOGO_RASTER_CHILD__: boolean;

const OUTPUT_LIMIT = 8_388_608, INPUT_LIMIT = 33_554_432, HEADER_LIMIT = 2048;
const rasterObservationSchema = z.strictObject({
  inputFormat: z.enum(["png", "jpeg", "webp"]), inputWidth: z.number().int().min(1).max(8192), inputHeight: z.number().int().min(1).max(8192),
  width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192), originalOrientation: z.number().int().min(1).max(8), autoOriented: z.boolean(),
  inputColorSpace: z.string().max(100), outputColorSpace: z.literal("srgb"), rgbaContentHash: logoHashSchema,
  alphaStrategy: z.literal("exact-alpha-layers"), alphaLevels: z.array(z.number().int().min(1).max(255)).max(255),
});
const errorCodeSchema = z.enum(["invalid_geometry", "unsupported_svg", "limit_exceeded", "empty_artwork", "invalid_font", "font_rights_required", "unsupported_text", "unsupported_edit", "locked_component_changed", "unsupported_locked_refinement", "source_mismatch", "engine_unavailable", "conversion_failed", "cancelled", "timeout"]);
const inspectionSchema = z.strictObject({ width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192), format: z.enum(["png","jpeg","webp"]), isMonochrome: z.boolean(), pixelHash: logoHashSchema, originalOrientation: z.number().int().min(1).max(8), outputColorSpace: z.literal("srgb") });
const normalizedConceptSchema = z.strictObject({ pngBase64: z.string().min(4).max(Math.ceil(IMAGE_INPUT_LIMITS.outputBytes / 3) * 4) });
const referenceOnWhiteSchema = z.strictObject({ imageBase64: z.string().min(4).max(120_000), mimeType: z.enum(["image/png", "image/jpeg"]) });
const responseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok"), output: z.strictObject({ document: logoVectorDocumentSchema, artifactHash: logoHashSchema, raster: rasterObservationSchema }) }),
  z.strictObject({ status: z.literal("inspected"), output: inspectionSchema }),
  z.strictObject({ status: z.literal("concept_normalized"), output: normalizedConceptSchema }),
  z.strictObject({ status: z.literal("reference_flattened"), output: referenceOnWhiteSchema }),
  z.strictObject({ status: z.literal("error"), code: errorCodeSchema, message: z.string().min(1).max(300) }),
]);
const headerSchema = z.strictObject({ mode: z.enum(["trace", "inspect", "concept-grayscale", "reference-on-white"]), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), logoType: logoTypeSchema, settings: logoTraceSettingsSchema, byteLength: z.number().int().min(1).max(INPUT_LIMIT) });
function launchChild(): ChildProcessWithoutNullStreams {
  // Fixed repository-owned entrypoint; no user URL/path, shell, credentials, or
  // inherited NODE_OPTIONS. The heap flag is not a native/WASM memory guarantee.
  const compiled = typeof __EMBEL_LOGO_RASTER_ENTRYPOINT__ === "string" ? __EMBEL_LOGO_RASTER_ENTRYPOINT__ : null;
  const arguments_ = compiled ? ["--conditions=react-server", "--max-old-space-size=256", resolve(process.cwd(), compiled)]
    : ["--conditions=react-server", "--max-old-space-size=256", "--import", "tsx", resolve(process.cwd(), "worker/logo-vector/process.ts")];
  return spawn(process.execPath, arguments_, {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", VIPS_CONCURRENCY: "1" },
  });
}
export type LogoVectorProcessOptions = { timeoutMs?: number; launch?: () => ChildProcessWithoutNullStreams };
/** Injectable process launcher for resource-boundary tests; runtime uses the fixed child. */
function createRasterProcessRunner(mode: "trace" | "inspect" | "concept-grayscale" | "reference-on-white", options: LogoVectorProcessOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid conversion deadline");
  return (input: Pick<LogoVectorWorkInput, "logoType" | "settings"> & { source: { bytes: Uint8Array; mimeType: string } }, signal: AbortSignal): Promise<LogoVectorEngineOutput | IdentityRasterInspection | z.infer<typeof normalizedConceptSchema> | z.infer<typeof referenceOnWhiteSchema>> => new Promise((accept, reject) => {
    if (signal.aborted) return reject(new LogoVectorError("cancelled", "Logo conversion was cancelled."));
    let child: ChildProcessWithoutNullStreams;
    try { child = (options.launch ?? launchChild)(); }
    catch { return reject(new LogoVectorError("engine_unavailable", "The isolated local tracing process is unavailable.")); }
    let pendingError: LogoVectorError | undefined, completed = false, size = 0, stderrSize = 0;
    const chunks: Buffer[] = [];
    let teardown: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(deadline); clearTimeout(teardown); signal.removeEventListener("abort", abort); };
    const fail = (code: LogoVectorErrorCode, message: string) => {
      if (completed || pendingError) return;
      pendingError = new LogoVectorError(code, message);
      chunks.length = 0;
      child.kill("SIGKILL"); // No persistent child state needs graceful saving.
      teardown = setTimeout(() => { if (!completed) { completed = true; cleanup(); reject(pendingError); } }, 5_000);
    };
    const abort = () => fail("cancelled", "Logo conversion was cancelled. The original preview is retained.");
    const deadline = setTimeout(() => fail("timeout", "Logo conversion exceeded its 60-second bound. The original preview is retained."), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (completed || pendingError) return;
      size += chunk.length;
      if (size > OUTPUT_LIMIT) return fail("limit_exceeded", "Conversion output exceeds the 8 MiB limit.");
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrSize += chunk.length; if (stderrSize > 65_536) fail("conversion_failed", "The isolated tracer failed without a usable result."); });
    child.stdin.on("error", () => { /* close/error below determines the final outcome; no retry */ });
    child.once("error", () => {
      if (completed) return; completed = true; cleanup();
      reject(pendingError ?? new LogoVectorError("engine_unavailable", "The isolated local tracing process could not start."));
    });
    child.once("close", (code: number | null) => {
      if (completed) return; completed = true; cleanup();
      if (pendingError) return reject(pendingError);
      if (signal.aborted) return reject(new LogoVectorError("cancelled", "Logo conversion was cancelled."));
      if (code !== 0) return reject(new LogoVectorError("conversion_failed", "The isolated tracer exited without a usable result."));
      try {
        const result = responseSchema.parse(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
        if (result.status === "error") return reject(new LogoVectorError(result.code, result.message));
        const expectedStatus = mode === "trace" ? "ok" : mode === "inspect" ? "inspected" : mode === "reference-on-white" ? "reference_flattened" : "concept_normalized";
        if (result.status !== expectedStatus) throw new Error("Unexpected raster process response");
        accept(result.output);
      } catch { reject(new LogoVectorError("conversion_failed", "The isolated tracer returned an invalid result.")); }
    });
    if (signal.aborted) { abort(); return; }
    const header = JSON.stringify({ mode, mimeType: input.source.mimeType, logoType: input.logoType, settings: input.settings, byteLength: input.source.bytes.byteLength }) + "\n";
    child.stdin.write(header); child.stdin.end(input.source.bytes);
  });
}
export function createLogoVectorProcessRunner(options: LogoVectorProcessOptions = {}) {
  const run = createRasterProcessRunner("trace", options);
  return async (input: LogoVectorWorkInput, signal: AbortSignal): Promise<LogoVectorEngineOutput> => await run(input, signal) as LogoVectorEngineOutput;
}
export const runLogoVectorProcess = createLogoVectorProcessRunner();
const inspect = createRasterProcessRunner("inspect");
export async function runIdentityRasterProcess(input: { bytes: Uint8Array; mimeType: string }, signal: AbortSignal): Promise<IdentityRasterInspection> {
  return await inspect({ source: input, logoType: "abstract", settings: { preset: "bw", simplify: 0, filterSpeckle: 0, maxColors: 2 } }, signal) as IdentityRasterInspection;
}
const normalizeConcept = createRasterProcessRunner("concept-grayscale");
export async function runLogoConceptGrayscaleProcess(input: { bytes: Uint8Array; mimeType: string }, signal: AbortSignal): Promise<Uint8Array> {
  const result = normalizedConceptSchema.parse(await normalizeConcept({ source: input, logoType: "abstract", settings: { preset: "bw", simplify: 0, filterSpeckle: 0, maxColors: 2 } }, signal));
  const bytes = Buffer.from(result.pngBase64, "base64");
  if (!bytes.length || bytes.length > IMAGE_INPUT_LIMITS.outputBytes || bytes.toString("base64") !== result.pngBase64) throw new LogoVectorError("conversion_failed", "Normalized concept bytes are invalid.");
  return new Uint8Array(bytes);
}
const referenceOnWhite = createRasterProcessRunner("reference-on-white");
export async function runLogoReferenceOnWhiteProcess(input: { bytes: Uint8Array; mimeType: string }, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" }> {
  const result = referenceOnWhiteSchema.parse(await referenceOnWhite({ source: input, logoType: "abstract", settings: { preset: "bw", simplify: 0, filterSpeckle: 0, maxColors: 2 } }, signal));
  const bytes = Buffer.from(result.imageBase64, "base64");
  if (!bytes.length || bytes.length > 90_000 || bytes.toString("base64") !== result.imageBase64) throw new LogoVectorError("conversion_failed", "Reference bytes on white are invalid.");
  return { bytes: new Uint8Array(bytes), mimeType: result.mimeType };
}

async function childMain(): Promise<void> {
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const part of process.stdin) {
      const chunk = Buffer.from(part); size += chunk.length;
      if (size > INPUT_LIMIT + HEADER_LIMIT) throw new LogoVectorError("limit_exceeded", "Raster process input exceeds its byte limit.");
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks, size), separator = input.indexOf(10);
    if (separator < 1 || separator > HEADER_LIMIT) throw new LogoVectorError("conversion_failed", "The raster process input header is invalid.");
    const header = headerSchema.parse(JSON.parse(input.subarray(0, separator).toString("utf8"))), bytes = input.subarray(separator + 1);
    if (bytes.length !== header.byteLength) throw new LogoVectorError("source_mismatch", "The raster process input is incomplete.");
    const output = header.mode === "trace" ? await (await import("./engine")).traceLogoRaster({ ...header, bytes })
      : header.mode === "inspect" ? await (await import("./raster")).inspectDecodedIdentityRaster({ bytes, mimeType: header.mimeType })
      : header.mode === "reference-on-white" ? await (await import("./raster")).flattenDecodedLogoReference({ bytes, mimeType: header.mimeType })
      : await (await import("./raster")).normalizeDecodedLogoConcept({ bytes, mimeType: header.mimeType });
    const response = JSON.stringify({ status: header.mode === "trace" ? "ok" : header.mode === "inspect" ? "inspected" : header.mode === "reference-on-white" ? "reference_flattened" : "concept_normalized", output });
    if (Buffer.byteLength(response) > OUTPUT_LIMIT) throw new LogoVectorError("limit_exceeded", "Conversion output exceeds the 8 MiB limit.");
    process.stdout.write(response);
  } catch (error) {
    const known = error instanceof LogoVectorError ? error : new LogoVectorError("conversion_failed", "The local raster conversion could not complete safely.");
    process.stdout.write(JSON.stringify({ status: "error", code: known.code, message: known.message }));
  }
}
if (typeof __EMBEL_LOGO_RASTER_CHILD__ === "boolean" ? __EMBEL_LOGO_RASTER_CHILD__
  : process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void childMain().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
}
