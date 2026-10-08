import { createIdeaInputSchema, IDEA_MUTATION_MAX_BYTES, listIdeasInputSchema } from "@/domain/ideas";
import { getAuthenticatedContext } from "@/server/auth/context";
import { createIdea, listIdeas } from "@/server/data/ideas";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const auth = await getAuthenticatedContext();
    const params = new URL(request.url).searchParams;
    const keys = ["cursorCreatedAt", "cursorId", "limit", "search", "state"];
    if ([...params.keys()].some(key => !keys.includes(key) || params.getAll(key).length !== 1) ||
        params.has("cursorCreatedAt") !== params.has("cursorId") || (params.has("limit") && !/^\d{1,2}$/.test(params.get("limit")!))) throw new ApiError("invalid_input");
    const parsed = listIdeasInputSchema.safeParse({ ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
      ...(params.has("search") ? { search: params.get("search") } : {}), ...(params.has("state") ? { state: params.get("state") } : {}),
      ...(params.has("cursorId") ? { cursor: { createdAt: params.get("cursorCreatedAt"), id: params.get("cursorId") } } : {}) });
    if (!parsed.success) throw new ApiError("invalid_input");
    return privateJson(await listIdeas(auth, parsed.data));
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    const input = await readJson(request, createIdeaInputSchema, IDEA_MUTATION_MAX_BYTES);
    const auth = await getAuthenticatedContext();
    return privateJson({ idea: await createIdea(auth, input) }, 201);
  } catch (error) { return errorResponse(error); }
}
