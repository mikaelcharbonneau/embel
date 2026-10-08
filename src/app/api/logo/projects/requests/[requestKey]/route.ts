import { getAuthenticatedContext } from "@/server/auth/context";
import { errorResponse, privateJson } from "@/server/http/errors";
import { readLogoProjectCreation } from "@/server/data/logo-workspace";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: {params: Promise<{requestKey: string}>}) {
  try {
    const auth = await getAuthenticatedContext();
    const { requestKey } = await context.params;
    return privateJson(await readLogoProjectCreation(auth, requestKey));
  } catch (error) { return errorResponse(error); }
}
