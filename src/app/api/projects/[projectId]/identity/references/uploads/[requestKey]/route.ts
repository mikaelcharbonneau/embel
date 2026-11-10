import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson, errorResponse } from "@/server/http/errors";
import { assertNoLogoInputQuery, logoInputId } from "@/server/http/logo-inputs";
import { resolveLogoRequestServices } from "@/server/runtime/logo-request-services";
import { identityReferenceUploadRecord } from "@/server/data/identity-reference-uploads";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ projectId: string; requestKey: string }> }) {
  try {
    const auth = await getAuthenticatedContext(),
      params = await context.params;
    const projectId = logoInputId(params.projectId),
      key = logoInputId(params.requestKey);
    assertNoLogoInputQuery(request);
    const entry = await identityReferenceUploadRecord(auth, projectId, key);
    if (entry) return privateJson({ status: "registered", entry });
    const services = await resolveLogoRequestServices(auth, projectId, request.signal);
    return privateJson({
      status: "upload",
      upload: await services.inputs.readLogoInputRequest(auth, projectId, key, request.signal),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
