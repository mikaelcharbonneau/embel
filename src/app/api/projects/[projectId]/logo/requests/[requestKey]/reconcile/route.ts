import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { assertMutationOrigin } from "@/server/http/request";
import { reconcileLogoRequest } from "@/server/data/logo-jobs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ projectId: string; requestKey: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    assertMutationOrigin(request);
    const { projectId, requestKey } = await context.params;
    return privateJson(await reconcileLogoRequest(auth, projectId, requestKey));
  } catch (error) { return logoErrorResponse(error); }
}
