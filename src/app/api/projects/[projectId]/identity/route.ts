import { getAuthenticatedContext } from "@/server/auth/context";
import { getProjectIdentity, readIdentityQuery } from "@/server/data/identity";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId } = await context.params;
    return privateJson(await getProjectIdentity(auth, projectId, readIdentityQuery(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
