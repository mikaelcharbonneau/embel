import { z } from "zod";
import { projectDeletionInputSchema, projectStopDeletionInputSchema } from "@/domain/project-deletion";
import { getAuthenticatedContext } from "@/server/auth/context";
import { getProjectDeletion, ProjectDeletionRetryError, setProjectDeleted } from "@/server/data/project-deletion";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };
async function projectId(context: RouteContext) {
  const id = z.uuid().safeParse((await context.params).projectId);
  if (!id.success) throw new ApiError("not_found");
  return id.data;
}
async function mutate(request: Request, context: RouteContext, deleted: boolean) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    assertExpectedAccount(request, auth.userId);
    const id = await projectId(context);
    const input = await readJson(request, deleted ? projectStopDeletionInputSchema : projectDeletionInputSchema, 1024);
    const project = await setProjectDeleted(auth, id, input, deleted);
    return privateJson({ project }, deleted && project.deletion_state !== "deleted" ? 202 : 200);
  } catch (error) {
    if (error instanceof ProjectDeletionRetryError) return privateJson({ error: {
      code: "project_deletion_retry", message: "This project is saving or finishing work. Retry the same deletion request shortly.",
    } }, 409);
    return errorResponse(error);
  }
}
/** One confirmation durably requests cancellation and reversible deletion. */
export async function POST(request: Request, context: RouteContext) { return mutate(request, context, true); }
/** Withdrawal/Restore never restarts a cancelled job. */
export async function DELETE(request: Request, context: RouteContext) { return mutate(request, context, false); }
/** Read-only derived completion keeps polling independent of worker deployment. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const auth = await getAuthenticatedContext();
    assertExpectedAccount(request, auth.userId);
    return privateJson({ project: await getProjectDeletion(auth, await projectId(context)) });
  } catch (error) { return errorResponse(error); }
}
