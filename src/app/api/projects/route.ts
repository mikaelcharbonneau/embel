import { createProjectInputSchema } from "@/domain/projects";
import { PROJECT_MUTATION_MAX_BYTES } from "@/domain/project-api";
import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { createProject, listProjects } from "@/server/data/projects";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await getAuthenticatedContext();
    return privateJson({ projects: await listProjects(auth) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const input = await readJson(request, createProjectInputSchema, PROJECT_MUTATION_MAX_BYTES);
    return privateJson({ project: await createProject(auth, input) }, 201);
  } catch (error) { return errorResponse(error); }
}
