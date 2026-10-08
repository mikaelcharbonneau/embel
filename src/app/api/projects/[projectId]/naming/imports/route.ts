import { importProjectNameSchema } from "@/domain/project-naming";
import { getAuthenticatedContext } from "@/server/auth/context";
import { importLocalName } from "@/server/data/project-naming";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
export async function POST(request: Request, context: RouteContext) {
  try { assertMutationOrigin(request); const auth = await getAuthenticatedContext(); const input = await readJson(request, importProjectNameSchema, 32_768);
    return privateJson(await importLocalName(auth, (await context.params).projectId, input)); }
  catch (error) { return errorResponse(error); }
}
