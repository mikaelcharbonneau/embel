import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { readLogoConceptBatch } from "@/server/data/logo-workspace";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: {params: Promise<{projectId: string; batchId: string}>}) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId, batchId } = await context.params;
    return privateJson(await readLogoConceptBatch(auth, projectId, batchId));
  } catch (error) { return logoErrorResponse(error); }
}
