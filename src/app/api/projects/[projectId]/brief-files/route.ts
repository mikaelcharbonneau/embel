import { getAuthenticatedContext } from "@/server/auth/context";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { projectBriefFileViews } from "@/server/engine/brief-files";
import { assertOwnedProject } from "@/server/engine/strategy";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };

/** The files attached to this brand's first prompt, each with what Embel read in it (if read yet). */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId } = await context.params;
    await assertOwnedProject(auth, projectId);
    let files;
    try {
      files = await projectBriefFileViews(auth, projectId);
    } catch {
      throw new ApiError("integration_unavailable");
    }
    return privateJson({ files });
  } catch (error) {
    return errorResponse(error);
  }
}
