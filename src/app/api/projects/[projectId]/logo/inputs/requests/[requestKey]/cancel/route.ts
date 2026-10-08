import { getAuthenticatedContext } from "@/server/auth/context";
import { ApiError, privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { productionLogoInputService } from "@/server/data/logo-inputs";
import { logoInputCancellationSchema, LOGO_INPUT_METADATA_MAX_BYTES } from "@/features/logo-inputs/model/contracts";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { assertNoLogoInputQuery, logoInputId } from "@/server/http/logo-inputs";
export const dynamic = "force-dynamic";
/** A cancellation is an explicit, immutable exact-input fence. A read saying
 * not_found never substitutes for this owner-authenticated transaction. */
export async function POST(request: Request, context: { params: Promise<{ projectId: string; requestKey: string }> }) {
  try {
    const auth = await getAuthenticatedContext(); assertMutationOrigin(request);
    const params = await context.params, projectId = logoInputId(params.projectId), requestKey = logoInputId(params.requestKey);
    assertNoLogoInputQuery(request);
    const input = await readJson(request, logoInputCancellationSchema, LOGO_INPUT_METADATA_MAX_BYTES + 4096);
    if (input.input.requestKey !== requestKey) throw new ApiError("invalid_input");
    return privateJson(await productionLogoInputService.cancelLogoInputRequest(auth, projectId, input, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
