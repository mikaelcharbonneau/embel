import { getAuthenticatedContext } from "@/server/auth/context";
import { cancelStrategyJob, getStrategyJob } from "@/server/data/strategy-jobs";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin } from "@/server/http/request";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string; jobId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId, jobId } = await context.params;
    return privateJson({ job: await getStrategyJob(auth, projectId, jobId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const { projectId, jobId } = await context.params;
    return privateJson({ job: await cancelStrategyJob(auth, projectId, jobId) });
  } catch (error) {
    return errorResponse(error);
  }
}
