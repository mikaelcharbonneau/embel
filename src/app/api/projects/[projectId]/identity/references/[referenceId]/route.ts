import { setReferenceReactionSchema } from "@/domain/identity-references";
import { getAuthenticatedContext } from "@/server/auth/context";
import { setReferenceReaction } from "@/server/data/identity-references";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; referenceId: string }> }) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext(), { projectId, referenceId } = await context.params;
    return privateJson(await setReferenceReaction(auth, projectId, referenceId, await readJson(request, setReferenceReactionSchema, 32_768)));
  } catch (error) { return errorResponse(error); }
}
