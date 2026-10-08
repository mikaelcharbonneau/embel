import { z } from "zod";
import { PROJECT_MUTATION_MAX_BYTES, updateProjectInputSchema } from "@/domain/project-api";
import { getAuthenticatedContext } from "@/server/auth/context";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { appendProjectRevision, getProject } from "@/server/data/projects";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };

async function getId(context: RouteContext) {
  const parsed = z.uuid().safeParse((await context.params).projectId);
  if (!parsed.success) throw new ApiError("not_found");
  return parsed.data;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    const id = await getId(context);
    return privateJson({ project: await getProject(auth, id) });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const id = await getId(context);
    const input = await readJson(request, updateProjectInputSchema, PROJECT_MUTATION_MAX_BYTES);
    return privateJson({ revision: await appendProjectRevision(auth, { ...input, projectId: id }) });
  } catch (error) { return errorResponse(error); }
}
