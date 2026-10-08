import { IDENTITY_JOB_MUTATION_MAX_BYTES, identityGenerationIntentSchema } from "@/domain/identity-jobs";
import { getAuthenticatedContext } from "@/server/auth/context";
import { enqueueIdentityBatch } from "@/server/data/identity-jobs";
import { errorResponse } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const input = await readJson(request, identityGenerationIntentSchema, IDENTITY_JOB_MUTATION_MAX_BYTES);
    return await enqueueIdentityBatch(auth, (await context.params).projectId, input);
  } catch (error) { return errorResponse(error); }
}
