import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { assertNoLogoInputQuery, logoInputId } from "@/server/http/logo-inputs";
import { resolveLogoRequestServices } from "@/server/runtime/logo-request-services";
import { createOwnedFontPreview } from "@/features/identity-directions/server/font-preview";
import { FONT_PREVIEW_REQUEST_BYTES, fontPreviewInputSchema } from "@/features/identity-directions/model/font-preview";

export const dynamic = "force-dynamic";
/** POST keeps specimen text out of URLs. This route is read-only. */
export async function POST(request: Request, context: { params: Promise<{ projectId: string; fontVersionId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    assertMutationOrigin(request); assertNoLogoInputQuery(request);
    const params = await context.params, projectId = logoInputId(params.projectId), fontVersionId = logoInputId(params.fontVersionId);
    const input = await readJson(request, fontPreviewInputSchema, FONT_PREVIEW_REQUEST_BYTES);
    request.signal.throwIfAborted();
    const services = await resolveLogoRequestServices(auth, projectId, request.signal);
    const preview = createOwnedFontPreview({ loadRecord: services.workspace.readLogoFontRecord, store: services.assets });
    const result = await preview(auth, projectId, fontVersionId, input, request.signal);
    request.signal.throwIfAborted();
    return privateJson(result);
  } catch (error) { return logoErrorResponse(error); }
}
