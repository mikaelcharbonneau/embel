import { getAuthenticatedContext } from "@/server/auth/context";
import { getNamingFeed, readNamingFeedQuery } from "@/server/data/naming-generation";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
export async function GET(request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    const query = readNamingFeedQuery(request);
    return privateJson({ feed: await getNamingFeed(auth, (await context.params).projectId, query.cursor, query.limit) });
  } catch (error) { return errorResponse(error); }
}
