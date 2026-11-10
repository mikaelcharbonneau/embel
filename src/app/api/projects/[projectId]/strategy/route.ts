import { assertNotBot } from "@/server/http/bot-protection";
import { enqueueStrategyJobSchema, STRATEGY_JOB_MUTATION_MAX_BYTES } from "@/domain/strategy-jobs";
import { getAuthenticatedContext } from "@/server/auth/context";
import { enqueueStrategyJob, getStrategyOverview } from "@/server/data/strategy-jobs";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    return privateJson(await getStrategyOverview(auth, (await context.params).projectId));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    await assertNotBot();
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const input = await readJson(request, enqueueStrategyJobSchema, STRATEGY_JOB_MUTATION_MAX_BYTES);
    return privateJson({ job: await enqueueStrategyJob(auth, (await context.params).projectId, input) }, 202);
  } catch (error) { return errorResponse(error); }
}
