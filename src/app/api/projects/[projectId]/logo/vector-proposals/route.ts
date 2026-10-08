import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { readLogoPageQuery } from "@/server/http/logo-query";
import { listLogoVectorProposals } from "@/server/data/logo-vector-proposals";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId } = await context.params;
    return privateJson(await listLogoVectorProposals(auth, projectId, readLogoPageQuery(request), request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
