import { getAuthenticatedContext } from "@/server/auth/context";
import { cancelNamingBatch, getNamingBatch } from "@/server/data/project-naming";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin } from "@/server/http/request";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string; batchId: string }> };
export async function GET(_request: Request, context: RouteContext) {
  try { const auth = await getAuthenticatedContext(); const params = await context.params; return privateJson(await getNamingBatch(auth, params.projectId, params.batchId)); }
  catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request, context: RouteContext) {
  try { assertMutationOrigin(request); const auth = await getAuthenticatedContext(); const params = await context.params; return privateJson(await cancelNamingBatch(auth, params.projectId, params.batchId)); }
  catch (error) { return errorResponse(error); }
}
