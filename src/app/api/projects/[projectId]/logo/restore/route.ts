import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { resolveLogoRequestServices } from "@/server/runtime/logo-request-services";
import { restoreLogoStageInputSchema, LOGO_MUTATION_MAX_BYTES } from "@/domain/logo-workspace";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: {params: Promise<{projectId: string}>}) {
  try {
    const auth = await getAuthenticatedContext();
    assertMutationOrigin(request);
    const { projectId } = await context.params;
    const input = await readJson(request, restoreLogoStageInputSchema, LOGO_MUTATION_MAX_BYTES);
    const services = await resolveLogoRequestServices(auth, projectId, request.signal);
    return privateJson(await services.workspace.restoreLogoStage(auth, projectId, input, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
