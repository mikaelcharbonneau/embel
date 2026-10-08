import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
import { getStandalonePromotionSource } from "@/server/data/home-lifecycle";
export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    return privateJson(await getStandalonePromotionSource(auth, (await context.params).projectId));
  } catch (error) { return errorResponse(error); }
}
