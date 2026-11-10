import { getWorkflowMetadata, sleep } from "workflow";
import { checkRun, claimRun, finishRun, type ClaimedRun } from "./engine-steps";
import type { LogoImageTarget } from "@/server/engine/logo-run";
import { beginLogoImages, createStyleNote, drawLogoImage, failStyleNote, pollStyleNote, prepareStyleNote, recordLogoImageFailure, settleStyleNote, stopStyleNote } from "./logo-steps";

/** Tries per image when nothing was drawn (429, 5xx, no connection). */
const IMAGE_TRIES = 3;
/** How often a running round checks for Stop while its images are drawn. */
const WATCH_SECONDS = 4;
/** Seconds between style-note lookups: quick at first, then every 5 s, for at most 4 minutes. */
const NOTE_POLL_DELAYS = [2, 3, 4, ...Array.from({ length: 46 }, () => 5)];

type ImageEnd = { state: string; code?: string | null };
const errorCode = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z_]{1,64}$/u.test(message) ? message : "generation_failed";
};

/**
 * Draws one Logo run's images (kinds logo.concepts and logo.refine): every image
 * of a round at once, each as its own steps, so one failure doesn't lose the
 * others and each finished image shows as soon as it is saved. Stop ends the run
 * within seconds; credits are kept only for delivered images.
 */
export async function logoImagesGeneration(runId: string) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  const run = await claimRun(runId, workflowRunId);
  if (run.status !== "running") return { status: run.status };
  try {
    const { targets } = await beginLogoImages(run);
    let settled = false;
    const work = Promise.all(targets.map(target => drawUntilSettled(run, target))).then(ends => { settled = true; return ends; });
    while (!settled) {
      await Promise.race([work, sleep(`${WATCH_SECONDS}s`)]);
      if (settled) break;
      const state = await checkRun(runId);
      if (state.status !== "running") return { status: state.status };
      if (state.cancelRequested || state.paused) return await finishRun(runId, "cancelled", state.paused ? "generation_paused" : "cancelled");
    }
    const ends = await work;
    const state = await checkRun(runId);
    if (state.status !== "running") return { status: state.status };
    if (state.cancelRequested || state.paused) return await finishRun(runId, "cancelled", state.paused ? "generation_paused" : "cancelled");
    // The database keeps a credit per delivered image; a round with none fails with its first reason.
    const reason = ends.find(end => end.state !== "succeeded")?.code ?? null;
    return await finishRun(runId, "succeeded", reason && /^[a-z_]{1,64}$/u.test(reason) ? reason : null);
  } catch (error) {
    await finishRun(runId, "failed", errorCode(error));
    throw error;
  }
}

/** One image: up to three tries while nothing is drawn, never another after a send. */
async function drawUntilSettled(run: ClaimedRun, target: LogoImageTarget): Promise<ImageEnd> {
  for (let attempt = 1; attempt <= IMAGE_TRIES; attempt++) {
    // No paid call starts after a Stop or while the engine is paused.
    const state = await checkRun(run.id);
    if (state.status !== "running" || state.cancelRequested || state.paused) return { state: "stopped", code: "cancelled" };
    let result;
    try { result = await drawLogoImage(run, target, attempt); }
    catch {
      // The step stopped answering after it may have sent the image.
      return recordLogoImageFailure(run, target.key, "provider_outcome_unknown");
    }
    if (result.state !== "retry") return result;
    if (attempt < IMAGE_TRIES) await sleep(`${Math.ceil(Math.max(1000, Math.min(result.retryAfterMs ?? 2 ** attempt * 2000, 60_000)) / 1000)}s`);
  }
  return recordLogoImageFailure(run, target.key, "provider_unavailable");
}

/**
 * Writes a style note for each liked upload in the run (kind logo.style_note),
 * side by side, in OpenAI background mode: create once, then look the response up
 * by id. A run succeeds when at least one note was written.
 */
export async function logoStyleNoteGeneration(runId: string) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  const run = await claimRun(runId, workflowRunId);
  if (run.status !== "running") return { status: run.status };
  try {
    const references = (run.input as { references?: { referenceId: string }[] }).references ?? [];
    const results = await Promise.all(references.map(ref => writeNote(run, ref.referenceId)));
    if (results.some(result => result.state === "stopped")) {
      const state = await checkRun(runId);
      return await finishRun(runId, "cancelled", state.paused ? "generation_paused" : "cancelled");
    }
    const written = results.some(result => result.state === "written");
    return await finishRun(runId, written ? "succeeded" : "failed", written ? null : results.find(result => result.code)?.code ?? "no_notes_written");
  } catch (error) {
    await finishRun(runId, "failed", errorCode(error));
    throw error;
  }
}

async function writeNote(run: ClaimedRun, referenceId: string) {
  const prepared = await prepareStyleNote(run, referenceId);
  if ("failed" in prepared) return { referenceId, state: "failed", code: prepared.failed };
  const state = await checkRun(run.id);
  if (state.status !== "running" || state.cancelRequested || state.paused) return { referenceId, state: "stopped", code: "cancelled" };
  let responseId: string;
  try { ({ responseId } = await createStyleNote(prepared)); }
  catch (error) { return failStyleNote(run, referenceId, errorCode(error) === "provider_request_rejected" ? "provider_rejected" : "send_interrupted"); }
  for (const seconds of NOTE_POLL_DELAYS) {
    await sleep(`${seconds}s`);
    const polled = await pollStyleNote(run.id, responseId);
    if (polled.state === "terminal") return settleStyleNote(run, referenceId, responseId);
    if (polled.state === "stop") return stopStyleNote(run, referenceId, responseId, polled.code);
  }
  return stopStyleNote(run, referenceId, responseId, "provider_timeout");
}
