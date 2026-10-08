import { productionLogoInputService } from "@/server/data/logo-inputs";
import { logoPageQuerySchema } from "@/domain/logo-workspace";
import { logoInputId, readLogoInputQuery } from "@/server/http/logo-inputs";
import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { saveLogoReferences } from "@/server/data/logo-workspace";
import { saveLogoReferencesInputSchema, LOGO_MUTATION_MAX_BYTES } from "@/domain/logo-workspace";
import { assertMutationOrigin, readJson } from "@/server/http/request";

export const dynamic = "force-dynamic";
export async function PUT(request: Request, context: {params: Promise<{projectId: string}>}) {
  try {
    const auth = await getAuthenticatedContext();
    assertMutationOrigin(request);
    const { projectId } = await context.params;
    const input = await readJson(request, saveLogoReferencesInputSchema, LOGO_MUTATION_MAX_BYTES);
    return privateJson(await saveLogoReferences(auth, projectId, input));
  } catch (error) { return logoErrorResponse(error); }
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const projectId = logoInputId((await context.params).projectId);
    const query = readLogoInputQuery(request, logoPageQuerySchema);
    return privateJson(await productionLogoInputService.listLogoReferences(auth, projectId, query, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
