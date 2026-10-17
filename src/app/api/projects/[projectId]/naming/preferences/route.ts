import { assertExpectedAccount } from "@/server/http/account-fence";
import { updateNamingPreferencesSchema } from "@/domain/project-naming";
import { getAuthenticatedContext } from "@/server/auth/context";
import { saveNamingPreferences } from "@/server/data/project-naming";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
export async function PATCH(request: Request, context: RouteContext) {
  try { assertMutationOrigin(request); const auth = await getAuthenticatedContext(); const input = await readJson(request, updateNamingPreferencesSchema, 32_768);
    if (request.headers.has("X-Embel-Account") || input.preferences.version === 2) assertExpectedAccount(request, auth.userId);
    return privateJson(await saveNamingPreferences(auth, (await context.params).projectId, input)); }
  catch (error) { return errorResponse(error); }
}
