import { z } from "zod";
import { IDEA_MUTATION_MAX_BYTES, updateIdeaInputSchema } from "@/domain/ideas";
import { getAuthenticatedContext } from "@/server/auth/context";
import { getIdea, updateIdea } from "@/server/data/ideas";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ ideaId: string }> };
async function ideaId(context: RouteContext) {
  const parsed = z.uuid().safeParse((await context.params).ideaId);
  if (!parsed.success) throw new ApiError("not_found");
  return parsed.data;
}
export async function GET(_request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    return privateJson({ idea: await getIdea(auth, await ideaId(context)) });
  } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request);
    const input = await readJson(request, updateIdeaInputSchema, IDEA_MUTATION_MAX_BYTES);
    const auth = await getAuthenticatedContext();
    return privateJson({ idea: await updateIdea(auth, await ideaId(context), input) });
  } catch (error) { return errorResponse(error); }
}
