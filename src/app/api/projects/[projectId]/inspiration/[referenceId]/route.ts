import { inspirationMutationSchema } from "@/domain/inspiration";
import { getAuthenticatedContext } from "@/server/auth/context";
import { setProjectInspiration } from "@/server/data/inspiration";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string; referenceId: string }> },
) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext(),
      { projectId, referenceId } = await context.params;
    return privateJson(
      await setProjectInspiration(
        auth,
        projectId,
        referenceId,
        await readJson(request, inspirationMutationSchema, 4096),
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
