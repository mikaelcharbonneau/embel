import { getAuthenticatedContext } from "@/server/auth/context";
import { getIdentityReferences, readIdentityReferenceQuery } from "@/server/data/identity-references";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext(),
      { projectId } = await context.params;
    return privateJson(await getIdentityReferences(auth, projectId, readIdentityReferenceQuery(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
