import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { resolveLogoRequestServices } from "@/server/runtime/logo-request-services";
import { importCatalogLogoFontInputSchema, LOGO_INPUT_METADATA_MAX_BYTES } from "@/features/logo-inputs/model/contracts";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { assertNoLogoInputQuery, logoInputId } from "@/server/http/logo-inputs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    assertMutationOrigin(request);
    const projectId = logoInputId((await context.params).projectId);
    assertNoLogoInputQuery(request);
    const input = await readJson(request, importCatalogLogoFontInputSchema, LOGO_INPUT_METADATA_MAX_BYTES);
    const services = await resolveLogoRequestServices(auth, projectId, request.signal);
    return privateJson(await services.inputs.importCatalogLogoFont(auth, projectId, input, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
