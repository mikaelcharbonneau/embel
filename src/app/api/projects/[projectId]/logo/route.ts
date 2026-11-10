import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { getLogoWorkspace } from "@/server/data/logo-workspace";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId } = await context.params;
    return privateJson(await getLogoWorkspace(auth, projectId));
  } catch (error) {
    return logoErrorResponse(error);
  }
}
