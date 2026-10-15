import { screeningCheckInputSchema } from "@/domain/project-screening";
import { getAuthenticatedContext } from "@/server/auth/context";
import { checkProjectScreening } from "@/server/data/project-screening";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertMutationOrigin(request); if (new URL(request.url).search) throw new ApiError("invalid_input");
    const body = await readJson(request, screeningCheckInputSchema, 8192);
    return privateJson(await checkProjectScreening(await getAuthenticatedContext(), (await context.params).projectId, body, request.signal));
  } catch (error) { return errorResponse(error); }
}
