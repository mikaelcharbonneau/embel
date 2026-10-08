import { getAuthenticatedContext } from "@/server/auth/context";
import { ApiError, privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { logoVectorHistoryQuerySchema } from "@/features/logo-vector/model/history";
import { listLogoVectorHistory } from "@/features/logo-vector/server/history";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const search = new URL(request.url).search;
    if (search.length > 4096) throw new ApiError("invalid_input");
    const params = new URLSearchParams(search);
    if ([...params.keys()].some(key => !["cursor", "limit"].includes(key) || params.getAll(key).length !== 1)) throw new ApiError("invalid_input");
    const input: Record<string, unknown> = Object.fromEntries(params);
    if (params.has("limit")) { if (!/^\d+$/.test(params.get("limit")!)) throw new ApiError("invalid_input"); input.limit = Number(params.get("limit")); }
    const parsed = logoVectorHistoryQuerySchema.safeParse(input);
    if (!parsed.success) throw new ApiError("invalid_input");
    return privateJson(await listLogoVectorHistory(auth, (await context.params).projectId, parsed.data, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
