import { assertNotBot } from "@/server/http/bot-protection";
import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { logoGenerationIntentSchema } from "@/domain/logo-jobs";
import { LOGO_MUTATION_MAX_BYTES } from "@/domain/logo-workspace";
import { admitLogoOperation, LogoAdmissionRejectedError } from "@/server/data/logo-jobs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let scope: { ownerId: string; projectId: string; requestKey: string; quoteId: string } | null = null;
  try {
    await assertNotBot();
    const auth = await getAuthenticatedContext();
    assertMutationOrigin(request);
    const { projectId } = await context.params;
    const input = await readJson(request, logoGenerationIntentSchema, LOGO_MUTATION_MAX_BYTES);
    scope = { ownerId: auth.userId, projectId, requestKey: input.requestKey, quoteId: input.quoteId };
    return privateJson(await admitLogoOperation(auth, projectId, input));
  } catch (error) {
    if (error instanceof LogoAdmissionRejectedError && scope &&
      error.rejection.ownerId === scope.ownerId && error.rejection.projectId === scope.projectId &&
      error.rejection.requestKey === scope.requestKey && error.rejection.quoteId === scope.quoteId) {
      return privateJson({ error: { code: error.code, message: error.message }, rejection: error.rejection }, error.status);
    }
    return logoErrorResponse(error);
  }
}
