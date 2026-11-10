import { getAuthenticatedContext } from "@/server/auth/context";
import { readIdentityBatchRequest } from "@/server/data/identity-jobs";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ projectId: string; requestKey: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    const { projectId, requestKey } = await context.params,
      batch = await readIdentityBatchRequest(auth, projectId, requestKey);
    return privateJson(batch ? { status: "found", batch } : { status: "not_found" });
  } catch (error) {
    return errorResponse(error);
  }
}
