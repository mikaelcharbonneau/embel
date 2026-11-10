import { getAuthenticatedContext } from "@/server/auth/context";
import { getStrategyOverview } from "@/server/data/strategy-jobs";
import { errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };

/** Availability and earlier requests. New Strategy requests start through /generations. */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    return privateJson(await getStrategyOverview(auth, (await context.params).projectId));
  } catch (error) { return errorResponse(error); }
}
