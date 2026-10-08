import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { productionLogoInputService } from "@/server/data/logo-inputs";
import { assertNoLogoInputQuery, logoInputId } from "@/server/http/logo-inputs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string; requestKey: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const params = await context.params;
    const projectId = logoInputId(params.projectId), requestKey = logoInputId(params.requestKey);
    assertNoLogoInputQuery(request);
    return privateJson(await productionLogoInputService.readLogoInputRequest(auth, projectId, requestKey, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
