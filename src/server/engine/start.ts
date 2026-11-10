import "server-only";
import type { z } from "zod";
import { start } from "workflow/api";
import { namingGeneration } from "@/workflows/naming";
import { probeGeneration } from "@/workflows/probe";
import { strategyGeneration } from "@/workflows/strategy";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { buildNamingRunInput, NAMING_KIND } from "./naming";
import { admitGeneration, findGeneration, type GenerationRunRow, type startGenerationSchema } from "./runs";
import { buildStrategyRunInput, STRATEGY_OPERATIONS } from "./strategy";

type InputBuilder = (auth: AuthenticatedContext, projectId: string, input: unknown) => Promise<Record<string, unknown>>;

/** Every kind the engine runs, and the workflow that runs it (docs/generation-engine.md). */
const workflows: Readonly<Record<string, (runId: string) => Promise<unknown>>> = {
  "engine.probe": probeGeneration,
  ...Object.fromEntries(STRATEGY_OPERATIONS.map(operation => [operation, strategyGeneration])),
  [NAMING_KIND]: namingGeneration,
};
/** Kinds whose input the server freezes from the person's own saved data. The browser only
 * names what to answer: the project revision for Strategy; the kind of request, the saved
 * versions and the seed names for Naming. */
const inputs: Readonly<Record<string, InputBuilder>> = {
  ...Object.fromEntries(STRATEGY_OPERATIONS.map(operation =>
    [operation, (auth, projectId, input) => buildStrategyRunInput(auth, projectId, operation, input)] satisfies [string, InputBuilder])),
  [NAMING_KIND]: buildNamingRunInput,
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
export async function startGeneration(auth: AuthenticatedContext, projectId: string, request: z.infer<typeof startGenerationSchema>): Promise<{ run: GenerationRunRow; reused: boolean }> {
  const workflow = Object.hasOwn(workflows, request.kind) ? workflows[request.kind]! : null;
  if (!workflow) throw new ApiError("generation_unavailable");
  const build = Object.hasOwn(inputs, request.kind) ? inputs[request.kind]! : null;
  const existing = build ? await findGeneration(auth, projectId, request.idempotencyKey) : null;
  const admission = build ? { ...request, input: existing ? {} : await build(auth, projectId, request.input ?? {}) } : request;
  const run = await admitGeneration(auth, projectId, admission);
  if (run.status === "queued" && run.workflow_run_id === null) {
    try { await start(workflow, [run.id]); }
    catch { throw new WorkflowStartError(); }
  }
  return { run, reused: existing !== null };
}
