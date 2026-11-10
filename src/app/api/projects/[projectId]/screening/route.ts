import { screeningRecordInputSchema } from "@/domain/project-screening";
import { getAuthenticatedContext } from "@/server/auth/context";
import { getProjectScreening, readScreeningCursor, recordProjectScreening } from "@/server/data/project-screening";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const cursor = readScreeningCursor(request);
    return privateJson(
      await getProjectScreening(await getAuthenticatedContext(), (await context.params).projectId, cursor),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    assertMutationOrigin(request);
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    const body = await readJson(request, screeningRecordInputSchema, 32768);
    return privateJson(
      await recordProjectScreening(await getAuthenticatedContext(), (await context.params).projectId, body),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
