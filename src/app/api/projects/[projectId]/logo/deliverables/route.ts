import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
export const dynamic = "force-dynamic";
import { z } from "zod";
import { ApiError } from "@/server/http/errors";
import { getLogoDeliverables } from "@/server/data/logo-deliverables";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const search = new URL(request.url).search;
    if (search.length > 4096) throw new ApiError("invalid_input");
    const params = new URLSearchParams(search);
    if (
      [...params.keys()].some(
        (key) => !["cursor", "requestCursor", "limit"].includes(key) || params.getAll(key).length !== 1,
      )
    )
      throw new ApiError("invalid_input");
    const parsed = z
      .strictObject({
        cursor: z.string().min(1).max(2048).optional(),
        requestCursor: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .safeParse(Object.fromEntries(params));
    if (!parsed.success) throw new ApiError("invalid_input");
    return privateJson(await getLogoDeliverables(auth, (await context.params).projectId, parsed.data, request.signal));
  } catch (error) {
    return logoErrorResponse(error);
  }
}
