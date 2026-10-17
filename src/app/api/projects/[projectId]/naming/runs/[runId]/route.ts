import { getAuthenticatedContext } from "@/server/auth/context";
import { cancelNamingBrainRun, getNamingBrainRun } from "@/server/data/naming-brain";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin } from "@/server/http/request";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string; runId: string }> };
export async function GET(_request: Request, context: RouteContext) {
 try { const auth = await getAuthenticatedContext(); const { projectId, runId } = await context.params; return privateJson({ run: await getNamingBrainRun(auth, projectId, runId) }); }
 catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request, context: RouteContext) {
 try { assertMutationOrigin(request); const auth = await getAuthenticatedContext(); assertExpectedAccount(request, auth.userId);
 const { projectId, runId } = await context.params; return privateJson({ run: await cancelNamingBrainRun(auth, projectId, runId) }); }
 catch (error) { return errorResponse(error); }
}
