import "server-only";
import type { z } from "zod";
import { start } from "workflow/api";
import { identityDirectionsGeneration } from "@/workflows/identity";
import { logoImagesGeneration, logoStyleNoteGeneration } from "@/workflows/logo";
import { namingGeneration } from "@/workflows/naming";
import { probeGeneration } from "@/workflows/probe";
import { strategyGeneration } from "@/workflows/strategy";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { IDENTITY_DIRECTIONS_KIND } from "./identity-input";
import { buildLogoConceptsRunInput, buildLogoRefineRunInput, buildLogoStyleNoteRunInput } from "./logo";
import { LOGO_CONCEPTS_KIND, LOGO_REFINE_KIND, LOGO_STYLE_NOTE_KIND } from "./logo-input";
import { buildNamingRunInput, NAMING_KIND } from "./naming";
import { admitGeneration, findGeneration, type GenerationRunRow, type startGenerationSchema } from "./runs";
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
  if (run.status === "queued" && run.workflow_run_id === null) {
    try {
      await start(workflow, [run.id]);
    } catch {
      throw new WorkflowStartError();
    }
  }
  return { run, reused: existing !== null };
}

/** Starts the workflow of a run its step's route already admitted. A second start of
 * the same run loses the claim and ends without touching it. */
export async function startAdmittedRun(kind: string, runId: string): Promise<void> {
  const workflow = Object.hasOwn(workflows, kind) ? workflows[kind]! : null;
  if (!workflow) throw new ApiError("generation_unavailable");
  try {
    await start(workflow, [runId]);
  } catch {
    throw new WorkflowStartError();
  }
}
