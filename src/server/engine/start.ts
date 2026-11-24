import "server-only";
import type { z } from "zod";
import { start } from "workflow/api";
import { briefFilesGeneration } from "@/workflows/brief-files";
import { identityDirectionsGeneration } from "@/workflows/identity";
import { logoImagesGeneration, logoStyleNoteGeneration } from "@/workflows/logo";
import { namingGeneration } from "@/workflows/naming";
import { probeGeneration } from "@/workflows/probe";
import { strategyGeneration } from "@/workflows/strategy";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { BRIEF_FILES_KIND, buildBriefFilesRunInput } from "./brief-files";
import { IDENTITY_DIRECTIONS_KIND } from "./identity-input";
import { buildLogoConceptsRunInput, buildLogoRefineRunInput, buildLogoStyleNoteRunInput } from "./logo";
import { LOGO_CONCEPTS_KIND, LOGO_REFINE_KIND, LOGO_STYLE_NOTE_KIND } from "./logo-input";
import { buildNamingRunInput, NAMING_KIND } from "./naming";
import {
  admitGeneration,
  enabledGenerationKinds,
  findGeneration,
  runAwaitsWorkflow,
  type GenerationRunRow,
  type startGenerationSchema,
} from "./runs";
import { buildStrategyRunInput, STRATEGY_OPERATIONS } from "./strategy";

type InputBuilder = (auth: AuthenticatedContext, projectId: string, input: unknown) => Promise<Record<string, unknown>>;

/** Every kind the engine runs, and the workflow that runs it (docs/generation-engine.md). */
const workflows: Readonly<Record<string, (runId: string) => Promise<unknown>>> = {
  "engine.probe": probeGeneration,
  ...Object.fromEntries(STRATEGY_OPERATIONS.map((operation) => [operation, strategyGeneration])),
  [NAMING_KIND]: namingGeneration,
  [LOGO_CONCEPTS_KIND]: logoImagesGeneration,
  [LOGO_REFINE_KIND]: logoImagesGeneration,
  [LOGO_STYLE_NOTE_KIND]: logoStyleNoteGeneration,
  [IDENTITY_DIRECTIONS_KIND]: identityDirectionsGeneration,
  [BRIEF_FILES_KIND]: briefFilesGeneration,
};
/** Kinds admitted only through their own step's route, which freezes their input in
 * the same database transaction as their records (Creative directions: /identity/batches). */
const ROUTE_ONLY_KINDS: ReadonlySet<string> = new Set([IDENTITY_DIRECTIONS_KIND]);
/** Kinds whose input the server freezes from the person's own saved data. The browser only
 * names what to answer: the project revision for Strategy; the kind of request, the saved
 * versions and the seed names for Naming; the Logo workspace heads and what to draw for Logo. */
const inputs: Readonly<Record<string, InputBuilder>> = {
  ...Object.fromEntries(
    STRATEGY_OPERATIONS.map(
      (operation) =>
        [operation, (auth, projectId, input) => buildStrategyRunInput(auth, projectId, operation, input)] satisfies [
          string,
          InputBuilder,
        ],
    ),
  ),
  [NAMING_KIND]: buildNamingRunInput,
  [LOGO_CONCEPTS_KIND]: buildLogoConceptsRunInput,
  [LOGO_REFINE_KIND]: buildLogoRefineRunInput,
  [LOGO_STYLE_NOTE_KIND]: buildLogoStyleNoteRunInput,
  // The browser names nothing: the brand's own files are what is read.
  [BRIEF_FILES_KIND]: (auth, projectId) => buildBriefFilesRunInput(auth, projectId),
};

/** The run was admitted (and charged) but its workflow didn't start. Repeating the same
 * request (same key) starts it once; Stop ends it at once with a refund. */
export class WorkflowStartError extends Error {
  constructor() {
    super("workflow_start_failed");
    this.name = "WorkflowStartError";
  }
}

/**
 * Admits one run with the person's own login, then starts its workflow once. A replayed key
 * returns its run as admitted: its input is never rebuilt from newer data, and its workflow
 * starts only if it never did (a second start loses the claim and ends without touching it).
 */
export async function startGeneration(
  auth: AuthenticatedContext,
  projectId: string,
  request: z.infer<typeof startGenerationSchema>,
): Promise<{ run: GenerationRunRow; reused: boolean }> {
  const workflow = Object.hasOwn(workflows, request.kind) ? workflows[request.kind]! : null;
  if (!workflow || ROUTE_ONLY_KINDS.has(request.kind)) throw new ApiError("generation_unavailable");
  const build = Object.hasOwn(inputs, request.kind) ? inputs[request.kind]! : null;
  const existing = build ? await findGeneration(auth, projectId, request.idempotencyKey) : null;
  const admission = build
    ? { ...request, input: existing ? {} : await build(auth, projectId, request.input ?? {}) }
    : request;
  const run = await admitGeneration(auth, projectId, admission);
  if (runAwaitsWorkflow(run)) {
    try {
      await start(workflow, [run.id]);
    } catch {
      throw new WorkflowStartError();
    }
  }
  return { run, reused: existing !== null };
}

/** Starts the workflow of a run its step's route already admitted. A second start of
 * the same run loses the claim and ends without touching it. The run exists, so every
 * failure here is a WorkflowStartError, never "generation is unavailable". */
export async function startAdmittedRun(kind: string, runId: string): Promise<void> {
  const workflow = Object.hasOwn(workflows, kind) ? workflows[kind]! : null;
  if (!workflow) throw new WorkflowStartError();
  try {
    await start(workflow, [runId]);
  } catch {
    throw new WorkflowStartError();
  }
}

/** A start is given this long before a status read tries again, so a read never races the
 * first start; after the database's own limit the run is due to end as start_failed instead. */
const RESUME_AFTER_MS = 15_000,
  RESUME_UNTIL_MS = 10 * 60_000;
type UnstartedRun = Pick<GenerationRunRow, "id" | "kind" | "status" | "workflow_run_id" | "created_at">;
export function runNeedsStart(run: UnstartedRun, now = Date.now()): boolean {
  const age = now - Date.parse(run.created_at);
  return runAwaitsWorkflow(run) && age >= RESUME_AFTER_MS && age < RESUME_UNTIL_MS;
}

/**
 * Called from status reads: a run that was admitted but whose workflow never started (a
 * failed start, or a crash between admission and start) is started again while its kind is
 * on. Best effort, and it never fails the read. It cannot run a request twice: engine_claim
 * gives the run to one workflow and refuses every other. Creative direction rounds are left
 * to their own step's read (identity-jobs.ts), which does the same.
 */
export async function resumeUnstartedRuns(auth: AuthenticatedContext, runs: readonly UnstartedRun[]): Promise<void> {
  const waiting = runs.filter((run) => runNeedsStart(run) && !ROUTE_ONLY_KINDS.has(run.kind));
  if (!waiting.length) return;
  try {
    const enabled = await enabledGenerationKinds(auth);
    for (const run of waiting) if (enabled.has(run.kind)) await startAdmittedRun(run.kind, run.id);
  } catch {
    /* The run stays queued: Try again or Stop still work, and it ends with a refund after 10 minutes. */
  }
}
