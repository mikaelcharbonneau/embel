import { createHash } from "node:crypto";
import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { LOGO_MUTATION_MAX_BYTES } from "@/domain/logo-workspace";
import {
  initializeExistingBrandLogoInputSchema,
  serializeLogoInitialization,
} from "@/features/logo-creation/model/existing-brand";
import { initializeExistingBrandLogo, LogoInitializationRejectedError } from "@/server/data/existing-brand-logo";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let scope: { ownerId: string; projectId: string; requestKey: string; inputHash: string } | null = null;
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const input = await readJson(request, initializeExistingBrandLogoInputSchema, LOGO_MUTATION_MAX_BYTES);
    const projectId = (await context.params).projectId.toLowerCase();
    scope = {
      ownerId: auth.userId.toLowerCase(),
      projectId,
      requestKey: input.requestKey,
      inputHash: createHash("sha256").update(serializeLogoInitialization(input)).digest("hex"),
    };
    return privateJson(await initializeExistingBrandLogo(auth, projectId, input, request.signal));
  } catch (error) {
    if (
      error instanceof LogoInitializationRejectedError &&
      scope &&
      error.rejection.ownerId === scope.ownerId &&
      error.rejection.projectId === scope.projectId &&
      error.rejection.requestKey === scope.requestKey &&
      error.rejection.inputHash === scope.inputHash
    ) {
      return privateJson(
        { error: { code: error.code, message: error.message }, rejection: error.rejection },
        error.status,
      );
    }
    return logoErrorResponse(error);
  }
}
