import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
import { readStandalonePromotionRequest } from "@/server/data/home-lifecycle";
export async function GET(_request: Request, context: { params: Promise<{ requestKey: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    return privateJson(await readStandalonePromotionRequest(auth, (await context.params).requestKey));
  } catch (error) { return errorResponse(error); }
}
