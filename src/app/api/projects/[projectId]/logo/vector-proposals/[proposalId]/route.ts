import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { readLogoVectorProposal } from "@/server/data/logo-vector-proposals";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string; proposalId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId, proposalId } = await context.params;
    return privateJson(await readLogoVectorProposal(auth, projectId, proposalId, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
