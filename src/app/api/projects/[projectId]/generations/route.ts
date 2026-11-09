import { start } from "workflow/api";
import { getAuthenticatedContext } from "@/server/auth/context";
import { admitGeneration, listGenerations, publicRun, startGenerationSchema } from "@/server/engine/runs";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { probeGeneration } from "@/workflows/probe";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };

/** Every kind the engine runs, and the workflow that runs it (docs/generation-engine.md). */
const workflows = { "engine.probe": probeGeneration } as const;

export async function GET(request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    const kind = new URL(request.url).searchParams.get("kind") ?? undefined;
    return privateJson({ runs: await listGenerations(auth, (await context.params).projectId, kind) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const body = await readJson(request, startGenerationSchema, 32_768);
    const workflow = Object.hasOwn(workflows, body.kind) ? workflows[body.kind as keyof typeof workflows] : null;
    if (!workflow) throw new ApiError("generation_unavailable");
    const run = await admitGeneration(auth, (await context.params).projectId, body);
    // A replay finds the same run. Its workflow starts once it has a claim; a second
    // start before that loses the claim and ends without touching the run.
    if (run.status === "queued" && run.workflow_run_id === null) {
      try { await start(workflow, [run.id]); }
      catch { throw new ApiError("generation_unavailable"); }
    }
    return privateJson({ run: publicRun(run) }, 202);
  } catch (error) { return errorResponse(error); }
}
