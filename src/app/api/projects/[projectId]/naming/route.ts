import { getAuthenticatedContext } from "@/server/auth/context";
import { getProjectNaming, readNamingQuery } from "@/server/data/project-naming";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
export async function GET(request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    return privateJson(await getProjectNaming(auth, (await context.params).projectId, readNamingQuery(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
