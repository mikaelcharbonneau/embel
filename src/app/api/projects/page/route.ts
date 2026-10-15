import { listProjectPageSchema } from "@/domain/project-pages";
import { getAuthenticatedContext } from "@/server/auth/context";
import { listProjectPage } from "@/server/data/project-pages";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const auth = await getAuthenticatedContext();
    const params = new URL(request.url).searchParams;
    const keys = ["state", "limit", "cursorCreatedAt", "cursorId"];
    if ([...params.keys()].some(key => !keys.includes(key) || params.getAll(key).length !== 1) ||
        params.has("cursorCreatedAt") !== params.has("cursorId") || (params.has("limit") && !/^\d{1,3}$/.test(params.get("limit")!))) throw new ApiError("invalid_input");
    const parsed = listProjectPageSchema.safeParse({ ...(params.has("state") ? { state: params.get("state") } : {}), ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
      ...(params.has("cursorId") ? { cursor: { createdAt: params.get("cursorCreatedAt"), id: params.get("cursorId") } } : {}),
    });
    if (!parsed.success) throw new ApiError("invalid_input");
    return privateJson(await listProjectPage(auth, parsed.data));
  } catch (error) { return errorResponse(error); }
}
