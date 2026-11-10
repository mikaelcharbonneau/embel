import { getAuthenticatedContext } from "@/server/auth/context";
import { getIdentitySystem } from "@/server/data/identity";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; systemVersionId: string }> },
) {
  try {
    const auth = await getAuthenticatedContext();
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    const { projectId, systemVersionId } = await context.params;
    return privateJson(await getIdentitySystem(auth, projectId, systemVersionId));
  } catch (error) {
    return errorResponse(error);
  }
}
