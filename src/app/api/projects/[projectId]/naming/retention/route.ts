import { updateNameRetentionSchema } from "@/domain/project-naming";
import { getAuthenticatedContext } from "@/server/auth/context";
import { setNameRetention } from "@/server/data/project-naming";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
export async function PATCH(request: Request, context: RouteContext) {
  try { assertMutationOrigin(request); const auth = await getAuthenticatedContext(); const input = await readJson(request, updateNameRetentionSchema, 2_048);
    return privateJson(await setNameRetention(auth, (await context.params).projectId, input)); }
  catch (error) { return errorResponse(error); }
}
