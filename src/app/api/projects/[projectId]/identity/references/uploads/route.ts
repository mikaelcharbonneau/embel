import { getAuthenticatedContext } from "@/server/auth/context";
import { privateJson, errorResponse, ApiError } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { assertNoLogoInputQuery, logoInputId, readLogoInputUpload } from "@/server/http/logo-inputs";
import { resolveLogoRequestServices } from "@/server/runtime/logo-request-services";
import { identityReferenceUploadSchema } from "@/domain/identity-reference-uploads";
import { LOGO_REFERENCE_UPLOAD_MAX_BYTES } from "@/features/logo-inputs/model/contracts";
import {
  identityReferenceUploadRecord,
  prepareIdentityReferenceUpload,
} from "@/server/data/identity-reference-uploads";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const projectId = logoInputId((await context.params).projectId);
    assertNoLogoInputQuery(request);
    let input;
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const upload = await readLogoInputUpload(request, identityReferenceUploadSchema, {
        maximum: LOGO_REFERENCE_UPLOAD_MAX_BYTES,
        minimum: 1,
        mimeTypes: ["image/png", "image/jpeg", "image/webp"],
      });
      input = upload.input;
      await prepareIdentityReferenceUpload(auth, projectId, input.upload, upload.bytes, upload.mimeType);
      if (request.signal.aborted) throw new ApiError("integration_unavailable");
      const services = await resolveLogoRequestServices(auth, projectId, request.signal);
      await services.inputs.uploadLogoReference(
        auth,
        projectId,
        input.upload,
        upload.bytes,
        upload.mimeType,
        request.signal,
      );
    } else {
      input = await readJson(request, identityReferenceUploadSchema, 32_768);
    }
    if (request.signal.aborted) throw new ApiError("integration_unavailable");
    return privateJson(
      await identityReferenceUploadRecord(auth, projectId, input.upload.requestKey, input.metadata),
      201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
