import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { getIdentityDirections } from "@/server/data/logo-workspace";
import { readLogoPageQuery } from "@/server/http/logo-query";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId } = await context.params;
    const query = readLogoPageQuery(request);
    return privateJson(await getIdentityDirections(auth, projectId, query));
  } catch (error) {
    return logoErrorResponse(error);
  }
}
