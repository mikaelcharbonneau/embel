import { FatalError, getStepMetadata, RetryableError } from "workflow";
import type { ClaimedRun } from "./engine-steps";
import type { LogoDrawResult, LogoImageTarget, LogoRunDeps } from "@/server/engine/logo-run";
import type { PreparedStyleNote, StyleNotePoll, StyleNoteResult, StyleNoteRunDeps } from "@/server/engine/logo-style-note-run";

// Step functions only. Server modules load inside each step body so nothing
// Node-specific (pg, fs, child processes, the server-only guard) enters the
// workflow sandbox bundle.

/** Backoff 2 s, 4 s, 8 s. Outside a workflow (tests, direct calls) there is no attempt count. */
function stepAttempt(): number {
  try { return getStepMetadata().attempt; } catch { return 1; }
}
/** Provider and run failures become the workflow's retry decision, as for Strategy:
 * 429, 5xx and connections that never opened retry; other refusals and creates
 * whose outcome is unknown fail at once. Database outages keep the default retries. */
function stepFailure(error: unknown): unknown {
  const name = error instanceof Error ? error.name : "";
  if (name === "EngineProviderError") {
    const { disposition, retryAfterMs } = error as Error & { disposition: string; retryAfterMs: number | null };
    if (disposition === "retry") return new RetryableError("provider_unavailable", { retryAfter: retryAfterMs ?? 2 ** stepAttempt() * 1000 });
    return new FatalError(disposition === "rejected" ? "provider_request_rejected" : "provider_outcome_unknown");
  }
  if (name === "LogoRunError" || name === "StyleNoteRunError") return new FatalError((error as Error & { code: string }).code);
  if (error instanceof Error && ["provider_unconfigured", "storage_unconfigured"].includes(error.message)) return new FatalError(error.message);
  return error;
}

async function engineDb(): Promise<LogoRunDeps["db"]> {
  const { engineCall } = await import("@/server/engine/database");
  return {
    check: runId => engineCall("engine_check", [runId]),
    begin: runId => engineCall("engine_logo_begin", [runId]),
    saveImage: (runId, key, image, responseId, cost) => engineCall("engine_logo_save_image", [runId, key, JSON.stringify(image), responseId, cost]),
    saveOutput: (runId, key, output, responseId, cost) => engineCall<boolean>("engine_save_output", [runId, key, JSON.stringify(output), responseId, cost]),
  };
}
async function logoDeps(): Promise<LogoRunDeps> {
  const [{ randomUUID }, { engineImages }, { engineStorage }, { normalizeLogoConceptRaster, inspectIdentityRaster }] = await Promise.all([
    import("node:crypto"), import("@/server/engine/openai-images"), import("@/server/engine/storage"), import("@/features/logo-vector/server/converter")]);
  return {
    db: await engineDb(), images: engineImages(), storage: engineStorage(), newId: randomUUID, now: () => new Date(),
    raster: {
      normalize: bytes => normalizeLogoConceptRaster(bytes, AbortSignal.timeout(60_000)),
      inspect: (bytes, mimeType) => inspectIdentityRaster(bytes, mimeType, AbortSignal.timeout(60_000)),
    },
  };
}
async function styleNoteDeps(): Promise<StyleNoteRunDeps> {
  const [{ engineOpenAI }, { engineStorage }, { runLogoReferenceOnWhiteProcess }] = await Promise.all([
    import("@/server/engine/openai"), import("@/server/engine/storage"), import("../../worker/logo-vector/process")]);
  const db = await engineDb();
  return {
    openai: engineOpenAI(), storage: engineStorage(), check: db.check,
    onWhite: (bytes, mimeType) => runLogoReferenceOnWhiteProcess({ bytes, mimeType }, AbortSignal.timeout(60_000)),
    async save(runId, key, output, responseId, cost) { return db.saveOutput(runId, key, output, responseId, cost); },
  };
}

// Logo images ------------------------------------------------------------------

/** Validates the frozen input; a concepts round gets its batch and six slots. */
export async function beginLogoImages(run: ClaimedRun): Promise<{ targets: LogoImageTarget[] }> {
  "use step";
  const { beginLogoImages: begin } = await import("@/server/engine/logo-run");
  try { return await begin({ db: await engineDb() }, run); }
  catch (error) { throw stepFailure(error); }
}
beginLogoImages.maxRetries = 2;

/** One paid image, once: no automatic retry, because a step that ran again after a
 * crash could pay twice. Nothing-drawn failures come back as `retry` instead. */
export async function drawLogoImage(run: ClaimedRun, target: LogoImageTarget, attempt: number): Promise<LogoDrawResult> {
  "use step";
  const { drawLogoImage: draw } = await import("@/server/engine/logo-run");
  try { return await draw(await logoDeps(), run, target, attempt); }
  catch (error) { throw stepFailure(error); }
}
drawLogoImage.maxRetries = 0;

/** Records an image that won't be drawn (idempotent). */
export async function recordLogoImageFailure(run: ClaimedRun, key: string, code: string): Promise<LogoDrawResult> {
  "use step";
  const { recordLogoImageFailure: record } = await import("@/server/engine/logo-run");
  try { return await record({ db: await engineDb() }, run, key, code); }
  catch (error) { throw stepFailure(error); }
}
recordLogoImageFailure.maxRetries = 3;

// Style notes ----------------------------------------------------------------------

export async function prepareStyleNote(run: ClaimedRun, referenceId: string): Promise<PreparedStyleNote> {
  "use step";
  const { prepareStyleNote: prepare } = await import("@/server/engine/logo-style-note-run");
  try { return await prepare(await styleNoteDeps(), run, referenceId); }
  catch (error) { throw stepFailure(error); }
}
prepareStyleNote.maxRetries = 2;

export async function createStyleNote(prepared: Extract<PreparedStyleNote, { request: unknown }>): Promise<{ responseId: string }> {
  "use step";
  const [{ createStyleNote: create }, { engineOpenAI }] = await Promise.all([import("@/server/engine/logo-style-note-run"), import("@/server/engine/openai")]);
  try { return await create(engineOpenAI(), prepared); }
  catch (error) { throw stepFailure(error); }
}
createStyleNote.maxRetries = 2;

export async function pollStyleNote(runId: string, responseId: string): Promise<StyleNotePoll> {
  "use step";
  const { pollStyleNote: poll } = await import("@/server/engine/logo-style-note-run");
  try { return await poll(await styleNoteDeps(), runId, responseId); }
  catch (error) { throw stepFailure(error); }
}
pollStyleNote.maxRetries = 2;

export async function settleStyleNote(run: ClaimedRun, referenceId: string, responseId: string): Promise<StyleNoteResult> {
  "use step";
  const { settleStyleNote: settle } = await import("@/server/engine/logo-style-note-run");
  try { return await settle(await styleNoteDeps(), run, referenceId, responseId); }
  catch (error) { throw stepFailure(error); }
}
settleStyleNote.maxRetries = 2;

export async function stopStyleNote(run: ClaimedRun, referenceId: string, responseId: string, code: string): Promise<StyleNoteResult> {
  "use step";
  const { stopStyleNote: stop } = await import("@/server/engine/logo-style-note-run");
  try { return await stop(await styleNoteDeps(), run, referenceId, responseId, code); }
  catch (error) { throw stepFailure(error); }
}
stopStyleNote.maxRetries = 2;

export async function failStyleNote(run: ClaimedRun, referenceId: string, code: string): Promise<StyleNoteResult> {
  "use step";
  const { failStyleNote: fail } = await import("@/server/engine/logo-style-note-run");
  try { return await fail(await styleNoteDeps(), run, referenceId, code); }
  catch (error) { throw stepFailure(error); }
}
failStyleNote.maxRetries = 2;
