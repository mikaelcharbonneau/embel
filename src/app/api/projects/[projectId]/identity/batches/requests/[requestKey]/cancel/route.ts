import { getAuthenticatedContext } from "@/server/auth/context";
import { closeIdentityBatchRequest } from "@/server/data/identity-jobs";
import { identityGenerationIntentSchema, IDENTITY_JOB_MUTATION_MAX_BYTES } from "@/domain/identity-jobs";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ projectId: string; requestKey: string }> }) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    const params = await context.params,
      input = await readJson(request, identityGenerationIntentSchema, IDENTITY_JOB_MUTATION_MAX_BYTES);
    if (!("version" in input) || input.version !== 2 || input.idempotencyKey !== params.requestKey)
      throw new ApiError("invalid_input");
    return privateJson(await closeIdentityBatchRequest(auth, params.projectId, input));
  } catch (error) {
    return errorResponse(error);
  }
}
