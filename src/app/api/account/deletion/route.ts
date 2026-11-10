import { accountDeletionInputSchema, deleteSignedInAccount, getDeletionContext } from "@/server/account/deletion";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
// Rows, files and the Auth user are deleted in this request; a large account takes a while.
export const maxDuration = 300;

/** Permanently deletes the signed-in account. The owner always comes from the
 * verified session; the body only carries the typed email confirmation. */
export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    const input = await readJson(request, accountDeletionInputSchema, 1024);
    const context = await getDeletionContext(request.signal);
    assertExpectedAccount(request, context.user.id);
    await deleteSignedInAccount(context, input.confirmEmail);
    return privateJson({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}
