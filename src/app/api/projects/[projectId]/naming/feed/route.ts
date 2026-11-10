import { getAuthenticatedContext } from "@/server/auth/context";
import { getNamingEngineFeed } from "@/server/data/naming-engine";
import { readNamingFeedQuery } from "@/server/data/naming-generation";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
/** The names feed: every saved name, the latest run and whether naming.generate is available. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    const query = readNamingFeedQuery(request), projectId = (await context.params).projectId;
    return privateJson({ feed: await getNamingEngineFeed(auth, projectId, query.cursor, query.limit) });
  } catch (error) { return errorResponse(error); }
}
