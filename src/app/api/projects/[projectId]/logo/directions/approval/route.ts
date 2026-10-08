import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { approveIdentityDirectionInputSchema, LOGO_MUTATION_MAX_BYTES } from "@/domain/logo-workspace";
import { resolveLogoRequestServices } from "@/server/runtime/logo-request-services";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    assertMutationOrigin(request);
    const { projectId } = await context.params;
    const input = await readJson(request, approveIdentityDirectionInputSchema, LOGO_MUTATION_MAX_BYTES);
    const services = await resolveLogoRequestServices(auth, projectId, request.signal);
    return privateJson(await services.workspace.approveIdentityDirection(auth, projectId, input, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
