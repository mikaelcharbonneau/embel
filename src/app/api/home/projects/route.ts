import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertExpectedAccount } from "@/server/http/account-fence";
export const dynamic = "force-dynamic";
import { attachedProjectDraftInputSchema } from "@/domain/attachments";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { saveAttachedProjectDraft } from "@/server/home-attachments";
export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    assertExpectedAccount(request, auth.userId);
    const input = await readJson(request, attachedProjectDraftInputSchema, 32_768);
    return privateJson(await saveAttachedProjectDraft(auth, input, request.signal));
  } catch (error) { return errorResponse(error); }
}
