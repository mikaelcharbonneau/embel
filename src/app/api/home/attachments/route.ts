import { getAuthenticatedContext } from "@/server/auth/context";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertExpectedAccount } from "@/server/http/account-fence";
export const dynamic = "force-dynamic";
import { stageHomeAttachmentInputSchema } from "@/domain/attachments";
import { getHomeAttachmentCapability, stageHomeAttachment } from "@/server/home-attachments";
import { assertMutationOrigin } from "@/server/http/request";
export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    assertExpectedAccount(request, auth.userId);
    const policy = await getHomeAttachmentCapability(auth);
    if (!policy) throw new ApiError("integration_unavailable");
    let name: string;
    const encoded = request.headers.get("x-fluid-attachment-name");
    if (!encoded || encoded.length > 3060) throw new ApiError("invalid_input");
    try {
      name = decodeURIComponent(encoded);
    } catch {
      throw new ApiError("invalid_input");
    }
    const parsed = stageHomeAttachmentInputSchema.safeParse({
      requestKey: request.headers.get("x-fluid-request-key"),
      contentHash: request.headers.get("x-fluid-content-hash"),
      mimeType: request.headers.get("content-type"),
      name,
    });
    if (!parsed.success || !policy.allowedMimeTypes.includes(parsed.data.mimeType)) throw new ApiError("invalid_input");
    const limit = Math.min(policy.maxFileBytes, 10_485_760);
    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new ApiError("body_too_large");
    if (!request.body || request.signal.aborted) throw new ApiError("invalid_input");
    const reader = request.body.getReader();
    // One bounded allocation regardless of how the transport splits its chunks.
    const buffer = new Uint8Array(limit);
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    request.signal.addEventListener("abort", abort, { once: true });
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (request.signal.aborted) throw new ApiError("integration_unavailable");
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > limit) {
          await reader.cancel();
          throw new ApiError("body_too_large");
        }
        buffer.set(chunk.value, length - chunk.value.byteLength);
      }
    } finally {
      request.signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
    if (!length) throw new ApiError("invalid_input");
    const bytes = buffer.subarray(0, length);
    const attachment = await stageHomeAttachment(auth, parsed.data, bytes, request.signal);
    return privateJson({ requestKey: parsed.data.requestKey, attachment });
  } catch (error) {
    return errorResponse(error);
  }
}
