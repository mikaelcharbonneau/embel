import { assertNotBot } from "@/server/http/bot-protection";
import { getAuthenticatedContext } from "@/server/auth/context";
import { listGenerations, publicRun, startGenerationSchema } from "@/server/engine/runs";
import { startGeneration, WorkflowStartError } from "@/server/engine/start";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };

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
    await assertNotBot();
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const body = await readJson(request, startGenerationSchema, 32_768);
    const { run } = await startGeneration(auth, (await context.params).projectId, body);
    return privateJson({ run: publicRun(run) }, 202);
  } catch (error) { return errorResponse(error instanceof WorkflowStartError ? new ApiError("generation_unavailable") : error); }
}
