import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { productionLogoInputService } from "@/server/data/logo-inputs";
import { logoInputRequestQuerySchema } from "@/features/logo-inputs/model/contracts";
import { logoInputId, readLogoInputQuery } from "@/server/http/logo-inputs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const projectId = logoInputId((await context.params).projectId);
    const query = readLogoInputQuery(request, logoInputRequestQuerySchema);
    return privateJson(await productionLogoInputService.listLogoInputRequests(auth, projectId, query, request.signal));
  } catch (error) {
    return logoErrorResponse(error);
  }
}
