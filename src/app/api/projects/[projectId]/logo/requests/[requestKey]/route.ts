import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { readLogoRequest } from "@/server/data/logo-requests";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string; requestKey: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId, requestKey } = await context.params;
    return privateJson(await readLogoRequest(auth, projectId, requestKey));
  } catch (error) {
    return logoErrorResponse(error);
  }
}
