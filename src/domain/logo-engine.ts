import { z } from "zod";
import { isActiveRun } from "./generation-run";
import { generationRunSchema, type GenerationRun } from "./generations";
import type { LogoConceptBatch } from "./logo-jobs";

/** Logo kinds on the generation engine (docs/generation-engine.md, step 4). */
export const LOGO_ENGINE_KINDS = Object.freeze({
  concepts: "logo.concepts",
  refine: "logo.refine",
  styleNote: "logo.style_note",
} as const);
export type LogoEngineKind = (typeof LOGO_ENGINE_KINDS)[keyof typeof LOGO_ENGINE_KINDS];

/** GET /api/projects/[id]/logo/engine: whether the Logo step uses the engine, and its latest runs. */
export const logoEngineStatusSchema = z.strictObject({
  engine: z.boolean(),
  runs: z.array(generationRunSchema).max(64),
});
export type LogoEngineStatus = z.infer<typeof logoEngineStatusSchema>;

export const isActiveLogoRun = (run: GenerationRun) => isActiveRun(run);
/** The newest run of one kind. */
export function latestLogoRun(runs: readonly GenerationRun[], kind: LogoEngineKind): GenerationRun | null {
  return (
    runs
      .filter((run) => run.kind === kind)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null
  );
}
/** The concept batch a round draws into, once the engine has opened it. */
export function logoRunBatchId(run: GenerationRun | null): string | null {
  const output = run?.outputs.find((item) => item.key === "batch")?.output;
  const parsed = z.object({ batchId: z.uuid() }).safeParse(output);
  return parsed.success ? parsed.data.batchId : null;
}
/** Slots a running round is still drawing: every empty slot of its own batch, or,
 * when it retries an earlier round, each slot whose latest image failed. */
export function logoDrawingSlotIds(run: GenerationRun | null, batch: LogoConceptBatch | null): Set<string> {
  if (!run || !batch || !isActiveLogoRun(run) || run.kind !== LOGO_ENGINE_KINDS.concepts) return new Set();
  const done = new Set(
    run.outputs.flatMap((item) => (/^image\.[0-5]$/u.test(item.key) ? [Number(item.key.slice(6))] : [])),
  );
  return new Set(
    batch.slots
      .filter(
        (slot) =>
          !done.has(slot.ordinal) &&
          (batch.requestKey === run.id
            ? slot.attempts.every((attempt) => attempt.requestKey !== run.id)
            : slot.attempts.at(-1)?.state === "failed"),
      )
      .map((slot) => slot.id),
  );
}
/** Slots of a round's own batch that the round ended without drawing (Stop, a timeout). */
export function logoUndrawnSlotIds(run: GenerationRun | null, batch: LogoConceptBatch | null): Set<string> {
  if (!run || !batch || isActiveLogoRun(run) || run.kind !== LOGO_ENGINE_KINDS.concepts || batch.requestKey !== run.id)
    return new Set();
  return new Set(batch.slots.filter((slot) => slot.attempts.length === 0).map((slot) => slot.id));
}
/** The browser's state of an engine refinement, in the old request vocabulary the screen reads. */
export function logoRefineRequestStatus(run: GenerationRun): "admitted" | "running" | "succeeded" | "failed" {
  if (run.status === "queued") return "admitted";
  if (run.status === "running") return "running";
  return run.status === "succeeded" ? "succeeded" : "failed";
}

/**
 * What the Logo step says about a run that ended without its result, or null when there is
 * nothing to say (docs/state-machines.md, rule 4). The order of the checks is the priority.
 *
 * Stopped is not a failure, whoever stopped it. A failed run returned the credits for what
 * it did not deliver (finish_generation_run), so the sentence may say so. A concepts round
 * that drew at least one concept is left to its cards, which already show what is missing.
 */
export function logoRunEndSentence(run: GenerationRun | null): string | null {
  if (!run || isActiveLogoRun(run) || run.status === "succeeded") return null;
  const refine = run.kind === LOGO_ENGINE_KINDS.refine;
  if (!refine && run.kind !== LOGO_ENGINE_KINDS.concepts) return null;
  if (!refine && run.outputs.some((item) => /^image\.[0-5]$/u.test(item.key))) return null;
  if (run.status === "cancelled")
    return refine ? "The change to your logo was stopped." : "Drawing was stopped before any concept was ready.";
  const outcome =
    run.errorCode === "run_timed_out"
      ? "took too long and didn’t finish"
      : run.errorCode === "start_failed"
        ? "couldn’t start"
        : "didn’t finish";
  return `${refine ? "The change to your logo" : "Drawing your concepts"} ${outcome}. Credits for anything not delivered were returned, so you can try again.`;
}
