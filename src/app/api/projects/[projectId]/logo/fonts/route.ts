import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { productionLogoInputService } from "@/server/data/logo-inputs";
import { assertNoLogoInputQuery, logoInputId } from "@/server/http/logo-inputs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const projectId = logoInputId((await context.params).projectId);
    assertNoLogoInputQuery(request);
    return privateJson(await productionLogoInputService.listLogoFonts(auth, projectId, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
