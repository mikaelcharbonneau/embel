import { reviewVisualDirectionSchema, VISUAL_DIRECTION_MAX_BYTES } from "@/domain/visual-direction";
import { getAuthenticatedContext } from "@/server/auth/context";
import { getVisualDirection, saveVisualDirection } from "@/server/data/visual-direction";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ projectId: string }> };
function exactRoute(request: Request) { if (new URL(request.url).search) throw new ApiError("invalid_input"); }
export async function GET(request: Request, context: Context) {
  try {
    exactRoute(request);
    return privateJson(await getVisualDirection(await getAuthenticatedContext(), (await context.params).projectId));
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    assertMutationOrigin(request); exactRoute(request);
    const input = await readJson(request, reviewVisualDirectionSchema, VISUAL_DIRECTION_MAX_BYTES);
    return privateJson(await saveVisualDirection(await getAuthenticatedContext(), (await context.params).projectId, input));
  } catch (error) { return errorResponse(error); }
}
