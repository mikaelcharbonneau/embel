import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { fontRecordSchema, fontPurposeSchema } from "../../src/domain/logo-directions";
import { logoHashSchema, logoTextSourceSchema } from "../../src/domain/logo-vector";
import { LogoVectorError, type LogoVectorErrorCode } from "../../src/features/logo-vector/model/errors";
import { LOGO_TEXT_LIMITS, shapedLogoTextSchema, snapshotLogoTextInput, type LogoTextInput, type ShapedLogoText } from "./text-engine";
declare const __EMBEL_LOGO_TEXT_ENTRYPOINT__: string;
declare const __EMBEL_LOGO_TEXT_CHILD__: boolean;
const HEADER_LIMIT = 65_536, STDERR_LIMIT = 65_536;
const codes = z.enum(["invalid_geometry", "unsupported_svg", "limit_exceeded", "empty_artwork", "invalid_font", "font_rights_required", "unsupported_text", "unsupported_edit", "locked_component_changed", "unsupported_locked_refinement", "source_mismatch", "engine_unavailable", "conversion_failed", "cancelled", "timeout"]);
const headerSchema = z.strictObject({ source: logoTextSourceSchema, record: fontRecordSchema, purpose: fontPurposeSchema, contentHash: logoHashSchema, byteLength: z.number().int().min(1).max(LOGO_TEXT_LIMITS.fontBytes) });
const responseSchema = z.discriminatedUnion("status", [z.strictObject({ status: z.literal("ok"), output: shapedLogoTextSchema }), z.strictObject({ status: z.literal("error"), code: codes, message: z.string().min(1).max(300) })]);
function launchChild(): ChildProcessWithoutNullStreams {
  // Fixed entrypoint and clean environment. Heap limits do not cap all native/WASM memory.
  const compiled = typeof __EMBEL_LOGO_TEXT_ENTRYPOINT__ === "string" ? __EMBEL_LOGO_TEXT_ENTRYPOINT__ : null;
  const arguments_ = compiled ? ["--conditions=react-server", "--max-old-space-size=128", resolve(process.cwd(), compiled)]
    : ["--conditions=react-server", "--max-old-space-size=128", "--import", "tsx", resolve(process.cwd(), "worker/logo-vector/text-process.ts")];
  return spawn(process.execPath, arguments_, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp" } });
}
export type LogoTextProcessOptions = { timeoutMs?: number; launch?: () => ChildProcessWithoutNullStreams };
let activeProcesses = 0;
/** The injected launcher exists only for deterministic process-boundary qualification. */
export function createLogoTextProcessRunner(options: LogoTextProcessOptions = {}) {
  const timeoutMs = options.timeoutMs ?? LOGO_TEXT_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LOGO_TEXT_LIMITS.timeoutMs) throw new TypeError("Text shaping has a maximum five-second deadline.");
  return async (input: LogoTextInput, signal: AbortSignal): Promise<ShapedLogoText> => {
    if (signal.aborted) throw new LogoVectorError("cancelled", "Text shaping was cancelled.");
    const frozen = snapshotLogoTextInput(input);
    const header = JSON.stringify({ source: frozen.source, record: frozen.font.record, purpose: frozen.font.purpose, contentHash: frozen.font.contentHash, byteLength: frozen.font.bytes.byteLength }) + "\n";
    if (Buffer.byteLength(header) > HEADER_LIMIT) throw new LogoVectorError("limit_exceeded", "Text shaping metadata exceeds its byte limit.");
    if (activeProcesses >= 4) throw new LogoVectorError("engine_unavailable", "Text shaping is busy. Try again.");
    activeProcesses++;
    try { return await new Promise<ShapedLogoText>((accept, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = (options.launch ?? launchChild)(); }
      catch { return reject(new LogoVectorError("engine_unavailable", "The isolated local text process could not start.")); }
      let completed = false, pendingError: LogoVectorError | undefined, size = 0, stderrSize = 0;
      const chunks: Buffer[] = [];
      let teardown: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { clearTimeout(deadline); clearTimeout(teardown); signal.removeEventListener("abort", abort); };
      const fail = (code: LogoVectorErrorCode, message: string) => {
        if (completed || pendingError) return;
        pendingError = new LogoVectorError(code, message); chunks.length = 0; child.kill("SIGKILL");
        teardown = setTimeout(() => { if (!completed) { completed = true; cleanup(); reject(pendingError); } }, 1_000);
      };
      const abort = () => fail("cancelled", "Text shaping was cancelled. The previous artwork is unchanged.");
      const deadline = setTimeout(() => fail("timeout", "Text shaping exceeded its five-second limit. The previous artwork is unchanged."), timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (completed || pendingError) return;
        size += chunk.length;
        if (size > LOGO_TEXT_LIMITS.outputBytes) return fail("limit_exceeded", "Text outlines exceed the 8 MiB output limit.");
        chunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => { stderrSize += chunk.length; if (stderrSize > STDERR_LIMIT) fail("conversion_failed", "The text engine failed without a usable result."); });
      child.stdin.on("error", () => { /* Process exit determines the result; no retry. */ });
      child.once("error", () => { if (completed) return; completed = true; cleanup(); reject(pendingError ?? new LogoVectorError("engine_unavailable", "The isolated text process could not start.")); });
      child.once("close", (code: number | null) => {
        if (completed) return; completed = true; cleanup();
        if (pendingError) return reject(pendingError);
        if (signal.aborted) return reject(new LogoVectorError("cancelled", "Text shaping was cancelled."));
        if (code !== 0) return reject(new LogoVectorError("conversion_failed", "The text process exited without usable outlines."));
        try {
          const result = responseSchema.parse(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
          if (result.status === "error") reject(new LogoVectorError(result.code, result.message)); else accept(result.output);
        } catch { reject(new LogoVectorError("conversion_failed", "The text process returned an invalid result.")); }
      });
      if (signal.aborted) { abort(); return; }
      child.stdin.write(header); child.stdin.end(frozen.font.bytes);
    }); } finally { activeProcesses--; }
  };
}
export const runLogoTextProcess = createLogoTextProcessRunner();
async function childMain(): Promise<void> {
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const part of process.stdin) {
      const chunk = Buffer.from(part); size += chunk.length;
      if (size > LOGO_TEXT_LIMITS.fontBytes + HEADER_LIMIT) throw new LogoVectorError("limit_exceeded", "Text process input exceeds its byte limit.");
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks, size), separator = input.indexOf(10);
    if (separator < 1 || separator > HEADER_LIMIT) throw new LogoVectorError("invalid_font", "Text process metadata is invalid.");
    const header = headerSchema.parse(JSON.parse(input.subarray(0, separator).toString("utf8"))), bytes = input.subarray(separator + 1);
    if (bytes.length !== header.byteLength) throw new LogoVectorError("source_mismatch", "Text process font input is incomplete.");
    const output = await (await import("./text-engine")).shapeLogoTextInProcess({ source: header.source, font: { record: header.record, purpose: header.purpose, contentHash: header.contentHash, bytes } });
    const response = JSON.stringify({ status: "ok", output });
    if (Buffer.byteLength(response) > LOGO_TEXT_LIMITS.outputBytes) throw new LogoVectorError("limit_exceeded", "Text outlines exceed the output byte limit.");
    process.stdout.write(response);
  } catch (error) {
    const known = error instanceof LogoVectorError ? error : new LogoVectorError("invalid_font", "The supplied font or text could not be processed safely.");
    process.stdout.write(JSON.stringify({ status: "error", code: known.code, message: known.message }));
  }
}
if (typeof __EMBEL_LOGO_TEXT_CHILD__ === "boolean" ? __EMBEL_LOGO_TEXT_CHILD__
  : process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void childMain().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
