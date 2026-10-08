import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { readLogoCurrentVectorRevisionId } from "@/server/data/logo-workspace";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId } = await context.params;
    const vectorRevisionId = await readLogoCurrentVectorRevisionId(auth, projectId);
    return privateJson({ ownerId: auth.userId, projectId, vectorRevisionId });
  } catch (error) { return logoErrorResponse(error); }
}
