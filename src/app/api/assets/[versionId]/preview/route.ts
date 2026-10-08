import { getAuthenticatedContext } from "@/server/auth/context";
import { getPrivateAssetPreview } from "@/server/data/asset-previews";
import { errorResponse } from "@/server/http/errors";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ versionId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { versionId } = await context.params;
    const preview = await getPrivateAssetPreview(auth, versionId);
    return new Response(preview.bytes, { headers: {
      "Content-Type": preview.mimeType, "Content-Length": String(preview.bytes.byteLength),
      "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
    } });
  } catch (error) { return errorResponse(error); }
}
