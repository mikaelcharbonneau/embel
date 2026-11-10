import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { readLogoPageQuery } from "@/server/http/logo-query";
import { listLogoConceptBatches } from "@/server/data/logo-workspace";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId } = await context.params;
    return privateJson(await listLogoConceptBatches(auth, projectId, readLogoPageQuery(request)));
  } catch (error) {
    return logoErrorResponse(error);
  }
}
