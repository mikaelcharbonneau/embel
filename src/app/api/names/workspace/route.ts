import { NAMES_WORKSPACE_MUTATION_MAX_BYTES, saveNamesWorkspaceInputSchema } from "@/domain/names-workspace";
import { getAuthenticatedContext } from "@/server/auth/context";
import { getNamesWorkspace, saveNamesWorkspace } from "@/server/data/names-workspace";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
function noQuery(request: Request) {
  if (new URL(request.url).search) throw new ApiError("invalid_input");
}

export async function GET(request: Request) {
  try {
    const auth = await getAuthenticatedContext();
    noQuery(request);
    return privateJson(await getNamesWorkspace(auth));
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    assertMutationOrigin(request);
    noQuery(request);
    const input = await readJson(request, saveNamesWorkspaceInputSchema, NAMES_WORKSPACE_MUTATION_MAX_BYTES);
    const auth = await getAuthenticatedContext();
    assertExpectedAccount(request, auth.userId);
    return privateJson(await saveNamesWorkspace(auth, input));
  } catch (error) { return errorResponse(error); }
}
