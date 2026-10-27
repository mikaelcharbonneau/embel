import { getAuthenticatedContext } from "@/server/auth/context";
import { getIdentityBatch } from "@/server/data/identity-jobs";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ projectId: string; batchId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    const { projectId, batchId } = await context.params, batch = await getIdentityBatch(auth, projectId, batchId);
    if (!batch) throw new ApiError("not_found");
    return privateJson(batch);
  } catch (error) { return errorResponse(error); }
}
