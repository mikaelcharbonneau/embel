import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
import { attachIdeaToProject } from "@/server/data/home-lifecycle";
import { attachIdeaToProjectInputSchema } from "@/domain/idea-project-attachment";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export async function POST(request: Request, context: { params: Promise<{ ideaId: string }> }) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const input = await readJson(request, attachIdeaToProjectInputSchema, 32_768);
    return privateJson(await attachIdeaToProject(auth, (await context.params).ideaId, input));
  } catch (error) { return errorResponse(error); }
}
