import { z } from "zod";
import { getAuthenticatedContext } from "@/server/auth/context";
import { retryStrategyJobDelivery } from "@/server/data/strategy-jobs";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string; jobId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    assertExpectedAccount(request, auth.userId);
    await readJson(request, z.strictObject({}), 128);
    const { projectId, jobId } = await context.params;
    return privateJson({ job: await retryStrategyJobDelivery(auth, projectId, jobId) }, 202);
  } catch (error) { return errorResponse(error); }
}
