import { z } from "zod";
import { getAuthenticatedContext } from "@/server/auth/context";
import { getStandalonePromotionSnapshot } from "@/server/data/home-lifecycle";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
 try {
  const projectId = z.uuid().safeParse((await context.params).projectId); if (!projectId.success) throw new ApiError("not_found");
  const auth = await getAuthenticatedContext();
  return privateJson(await getStandalonePromotionSnapshot(auth, projectId.data));
 } catch (error) { return errorResponse(error); }
}
