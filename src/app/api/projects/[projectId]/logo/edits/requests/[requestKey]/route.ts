import { getAuthenticatedContext } from "@/server/auth/context";
import { ApiError, privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { parseLogoInput } from "@/server/data/logo-transaction";
import { logoUuidSchema } from "@/domain/logo-vector";
import { readLogoVectorEditRequest } from "@/features/logo-vector/server/cancellation";
export const dynamic = "force-dynamic";
/** Single-key cancellation/success proof only. This read never cancels or retries. */
export async function GET(request: Request, context: { params: Promise<{ projectId: string; requestKey: string }> }) {
  try {
    const auth = await getAuthenticatedContext(), params = await context.params;
    const projectId = parseLogoInput(logoUuidSchema, params.projectId), requestKey = parseLogoInput(logoUuidSchema, params.requestKey);
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    return privateJson(await readLogoVectorEditRequest(auth, projectId, requestKey, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
