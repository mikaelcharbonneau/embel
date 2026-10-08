import { z } from "zod";
import { PROJECT_MUTATION_MAX_BYTES, expandProjectInputSchema } from "@/domain/project-api";
import { getAuthenticatedContext } from "@/server/auth/context";
import { expandProject } from "@/server/data/projects";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const id = z.uuid().safeParse((await context.params).projectId);
    if (!id.success) throw new ApiError("not_found");
    const input = await readJson(request, expandProjectInputSchema, PROJECT_MUTATION_MAX_BYTES);
    return privateJson({ project: await expandProject(auth, id.data, input) });
  } catch (error) { return errorResponse(error); }
}
