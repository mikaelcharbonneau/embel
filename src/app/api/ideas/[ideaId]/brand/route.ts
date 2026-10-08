import { z } from "zod";
import { createIdeaBrandInputSchema, IDEA_MUTATION_MAX_BYTES } from "@/domain/ideas";
import { getAuthenticatedContext } from "@/server/auth/context";
import { createIdeaBrand } from "@/server/data/ideas";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ ideaId: string }> }) {
  try {
    assertMutationOrigin(request);
    const input = await readJson(request, createIdeaBrandInputSchema, IDEA_MUTATION_MAX_BYTES);
    const auth = await getAuthenticatedContext();
    const id = z.uuid().safeParse((await context.params).ideaId);
    if (!id.success) throw new ApiError("not_found");
    return privateJson(await createIdeaBrand(auth, id.data, input));
  } catch (error) { return errorResponse(error); }
}
