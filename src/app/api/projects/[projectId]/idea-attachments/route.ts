import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
import { z } from "zod";
import { ApiError } from "@/server/http/errors";
import { getProjectIdeaAttachments } from "@/server/data/home-lifecycle";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !["cursor", "limit"].includes(key) || params.getAll(key).length !== 1)) throw new ApiError("invalid_input");
    const query = z.strictObject({ cursor: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).optional() }).safeParse(Object.fromEntries(params));
    if (!query.success) throw new ApiError("invalid_input");
    return privateJson(await getProjectIdeaAttachments(auth, (await context.params).projectId, query.data));
  } catch (error) { return errorResponse(error); }
}
