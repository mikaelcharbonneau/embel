import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
export const dynamic = "force-dynamic";
import { getLogoExport } from "@/server/data/logo-deliverables";
export async function GET(request: Request, context: { params: Promise<{ projectId: string; exportId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId, exportId } = await context.params;
    return privateJson(await getLogoExport(auth, projectId, exportId, request.signal));
  } catch (error) {
    return logoErrorResponse(error);
  }
}
