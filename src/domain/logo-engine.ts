import { z } from "zod";
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

export const isActiveLogoRun = (run: GenerationRun) => run.status === "queued" || run.status === "running";
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
