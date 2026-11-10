import { start } from "workflow/api";
import type { AuthenticatedContext } from "@/server/auth/context";
import { getAuthenticatedContext } from "@/server/auth/context";
import { STRATEGY_OPERATIONS, buildStrategyRunInput } from "@/server/engine/strategy";
import { admitGeneration, findGeneration, listGenerations, publicRun, startGenerationSchema } from "@/server/engine/runs";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { probeGeneration } from "@/workflows/probe";
import { strategyGeneration } from "@/workflows/strategy";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
type InputBuilder = (auth: AuthenticatedContext, projectId: string, kind: string, input: unknown) => Promise<Record<string, unknown>>;

/** Every kind the engine runs, and the workflow that runs it (docs/generation-engine.md). */
const workflows: Readonly<Record<string, (runId: string) => Promise<unknown>>> = {
  "engine.probe": probeGeneration,
  ...Object.fromEntries(STRATEGY_OPERATIONS.map(operation => [operation, strategyGeneration])),
};
/** Kinds whose input the server freezes from the person's own saved data. The browser
 * only names what to answer, e.g. the project revision for Strategy. */
const inputs: Readonly<Record<string, InputBuilder>> = Object.fromEntries(STRATEGY_OPERATIONS.map(operation =>
  [operation, (auth, projectId, _kind, input) => buildStrategyRunInput(auth, projectId, operation, input)] satisfies [string, InputBuilder]));

export async function GET(request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    const params = new URL(request.url).searchParams;
    const filter = { kind: params.get("kind") ?? undefined, step: params.get("step") ?? undefined };
    return privateJson({ runs: await listGenerations(auth, (await context.params).projectId, filter) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const body = await readJson(request, startGenerationSchema, 32_768);
    const workflow = Object.hasOwn(workflows, body.kind) ? workflows[body.kind] : null;
    if (!workflow) throw new ApiError("generation_unavailable");
    const { projectId } = await context.params;
    const build = Object.hasOwn(inputs, body.kind) ? inputs[body.kind]! : null;
    // A replay returns its run as admitted; its input is never rebuilt from newer data.
    const admission = build
      ? { ...body, input: await findGeneration(auth, projectId, body.idempotencyKey) ? {} : await build(auth, projectId, body.kind, body.input ?? {}) }
      : body;
    const run = await admitGeneration(auth, projectId, admission);
    // A replay finds the same run. Its workflow starts once it has a claim; a second
    // start before that loses the claim and ends without touching the run.
    if (run.status === "queued" && run.workflow_run_id === null) {
      try { await start(workflow, [run.id]); }
      catch { throw new ApiError("generation_unavailable"); }
    }
    return privateJson({ run: publicRun(run) }, 202);
  } catch (error) { return errorResponse(error); }
}
