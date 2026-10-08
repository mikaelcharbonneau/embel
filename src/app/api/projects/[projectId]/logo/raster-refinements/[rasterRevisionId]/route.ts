import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { readLogoRasterRefinement } from "@/server/data/logo-workspace";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ projectId: string; rasterRevisionId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId, rasterRevisionId } = await context.params;
    return privateJson(await readLogoRasterRefinement(auth, projectId, rasterRevisionId));
  } catch (error) { return logoErrorResponse(error); }
}
