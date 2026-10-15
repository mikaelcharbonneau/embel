import { z } from "zod";
import { projectDeletionInputSchema } from "@/domain/project-deletion";
import { getAuthenticatedContext } from "@/server/auth/context";
import { ProjectDeletionBusyError, setProjectDeleted } from "@/server/data/project-deletion";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ projectId: string }> };

async function mutate(request: Request, context: RouteContext, deleted: boolean) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    assertExpectedAccount(request, auth.userId);
    const id = z.uuid().safeParse((await context.params).projectId);
    if (!id.success) throw new ApiError("not_found");
    const input = await readJson(request, projectDeletionInputSchema, 1024);
    return privateJson({ project: await setProjectDeleted(auth, id.data, input, deleted) });
  } catch (error) {
    if (error instanceof ProjectDeletionBusyError) return privateJson({ error: {
      code: "project_busy", message: "This project still has work in progress or awaiting review. Resolve that work before moving it to Deleted projects.",
    } }, 409);
    return errorResponse(error);
  }
}

/** Reversible removal from the active collection. No content or jobs are deleted. */
export async function POST(request: Request, context: RouteContext) { return mutate(request, context, true); }
/** Removing the deletion marker restores the same project and immutable history. */
export async function DELETE(request: Request, context: RouteContext) { return mutate(request, context, false); }
