import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
export const dynamic = "force-dynamic";
import { LogoExportAdmissionRejectedError } from "@/features/identity-deliverables/server/admission-errors";
import { logoExportIntentSchema, matchesLogoExportRejection, type LogoExportIntent } from "@/domain/logo-deliverables";
import { LOGO_MUTATION_MAX_BYTES } from "@/domain/logo-workspace";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { requestLogoExport } from "@/server/data/logo-deliverables";
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let scope: { ownerId: string; projectId: string; input: LogoExportIntent } | null = null;
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const input = await readJson(request, logoExportIntentSchema, LOGO_MUTATION_MAX_BYTES);
    const projectId = (await context.params).projectId;
    scope = { ownerId: auth.userId, projectId, input };
    return privateJson(await requestLogoExport(auth, projectId, input, request.signal));
  } catch (error) {
    if (error instanceof LogoExportAdmissionRejectedError && scope && matchesLogoExportRejection(error.rejection, scope.ownerId, scope.projectId, scope.input)) {
      return privateJson({ error: { code: error.code, message: error.message }, rejection: error.rejection }, error.status);
    }
    return logoErrorResponse(error);
  }
}
