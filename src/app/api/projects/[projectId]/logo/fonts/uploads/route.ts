import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson } from "@/server/http/errors";
import { logoErrorResponse } from "@/server/http/logo-errors";
import { resolveLogoRequestServices } from "@/server/runtime/logo-request-services";
import { uploadLogoFontInputSchema, LOGO_FONT_UPLOAD_MAX_BYTES } from "@/features/logo-inputs/model/contracts";
import { assertMutationOrigin } from "@/server/http/request";
import { assertNoLogoInputQuery, logoInputId, readLogoInputUpload } from "@/server/http/logo-inputs";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    assertMutationOrigin(request);
    const projectId = logoInputId((await context.params).projectId);
    assertNoLogoInputQuery(request);
    const { input, bytes, mimeType } = await readLogoInputUpload(request, uploadLogoFontInputSchema, { maximum: LOGO_FONT_UPLOAD_MAX_BYTES, minimum: 12, mimeTypes: ["font/ttf", "font/otf"] });
    const services = await resolveLogoRequestServices(auth, projectId, request.signal);
    return privateJson(await services.inputs.uploadLogoFont(auth, projectId, input, bytes, mimeType, request.signal));
  } catch (error) { return logoErrorResponse(error); }
}
