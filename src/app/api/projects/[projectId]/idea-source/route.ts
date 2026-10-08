import { z } from "zod";
import { getAuthenticatedContext } from "@/server/auth/context";
import { getProjectIdeaSource } from "@/server/data/ideas";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const id = z.uuid().safeParse((await context.params).projectId);
    if (!id.success) throw new ApiError("not_found");
    return privateJson(await getProjectIdeaSource(auth, id.data));
  } catch (error) { return errorResponse(error); }
}
