import { getAuthenticatedContext } from "@/server/auth/context";
import { getNamingEngineFeed } from "@/server/data/naming-engine";
import { getNamingFeed, readNamingFeedQuery } from "@/server/data/naming-generation";
import { namingEngineEnabled } from "@/server/engine/naming";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
/** The names feed: from the generation engine while naming.generate is enabled, otherwise the old path. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    const query = readNamingFeedQuery(request), projectId = (await context.params).projectId;
    const read = await namingEngineEnabled(auth) ? getNamingEngineFeed : getNamingFeed;
    return privateJson({ feed: await read(auth, projectId, query.cursor, query.limit) });
  } catch (error) { return errorResponse(error); }
}
