import { getAuthenticatedContext } from "@/server/auth/context";
import { cancelGeneration } from "@/server/engine/runs";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin } from "@/server/http/request";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string; runId: string }> };

/** Marks the run; its workflow stops before the next paid step and returns the credits. */
export async function POST(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const { projectId, runId } = await context.params;
    return privateJson({ run: await cancelGeneration(auth, projectId, runId) });
  } catch (error) {
    return errorResponse(error);
  }
}
