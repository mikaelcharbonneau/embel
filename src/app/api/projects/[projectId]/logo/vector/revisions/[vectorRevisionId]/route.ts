import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { resolveLogoRequestServices } from "@/server/runtime/logo-request-services";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string; vectorRevisionId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { projectId, vectorRevisionId } = await context.params;
    const services = await resolveLogoRequestServices(auth, projectId, request.signal);
    return privateJson(await services.workspace.readLogoVectorDetail(auth, projectId, vectorRevisionId, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
