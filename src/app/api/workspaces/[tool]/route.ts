import { saveStandaloneWorkspaceInputSchema, STANDALONE_MUTATION_MAX_BYTES, standaloneToolSchema } from "@/domain/standalone-workspaces";
import { getAuthenticatedContext } from "@/server/auth/context";
import { getStandaloneWorkspace, saveStandaloneWorkspace } from "@/server/data/standalone-workspaces";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { assertExpectedAccount } from "@/server/http/account-fence";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ tool: string }> };
async function routeTool(context: Context) {
  const value = standaloneToolSchema.safeParse((await context.params).tool);
  if (!value.success) throw new ApiError("not_found"); return value.data;
}
function noQuery(request: Request) { if (new URL(request.url).search) throw new ApiError("invalid_input"); }
export async function GET(request: Request, context: Context) {
  try { const auth = await getAuthenticatedContext(); noQuery(request); return privateJson(await getStandaloneWorkspace(auth, await routeTool(context))); }
  catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request, context: Context) {
  try {
    assertMutationOrigin(request); noQuery(request);
    const input = await readJson(request, saveStandaloneWorkspaceInputSchema, STANDALONE_MUTATION_MAX_BYTES);
    const auth = await getAuthenticatedContext();
    assertExpectedAccount(request, auth.userId);
    return privateJson(await saveStandaloneWorkspace(auth, await routeTool(context), input));
  } catch (error) { return errorResponse(error); }
}
