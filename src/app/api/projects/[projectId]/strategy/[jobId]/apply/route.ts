import { applyStrategyJobSchema, STRATEGY_JOB_MUTATION_MAX_BYTES } from "@/domain/strategy-jobs";
import { getAuthenticatedContext } from "@/server/auth/context";
import { applyStrategyJob } from "@/server/data/strategy-jobs";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string; jobId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const { projectId, jobId } = await context.params;
    const input = await readJson(request, applyStrategyJobSchema, STRATEGY_JOB_MUTATION_MAX_BYTES);
    return privateJson(await applyStrategyJob(auth, projectId, jobId, input));
  } catch (error) { return errorResponse(error); }
}
