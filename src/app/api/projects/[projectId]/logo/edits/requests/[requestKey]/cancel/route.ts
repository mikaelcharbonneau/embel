import { getAuthenticatedContext } from "@/server/auth/context";
import { ApiError, privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { parseLogoInput } from "@/server/data/logo-transaction";
import { logoUuidSchema, LOGO_MUTATION_MAX_BYTES } from "@/domain/logo-vector";
import { logoVectorEditCommandSchema } from "@/features/logo-vector/model/cancellation";
import { cancelLogoVectorEdit } from "@/features/logo-vector/server/cancellation";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ projectId: string; requestKey: string }> }) {
  try {
    const auth = await getAuthenticatedContext(); assertMutationOrigin(request);
    const params = await context.params, projectId = parseLogoInput(logoUuidSchema, params.projectId), requestKey = parseLogoInput(logoUuidSchema, params.requestKey);
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    const command = await readJson(request, logoVectorEditCommandSchema, LOGO_MUTATION_MAX_BYTES);
    if (command.body.requestKey !== requestKey) throw new ApiError("invalid_input");
    return privateJson(await cancelLogoVectorEdit(auth, projectId, command, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
