import { getAuthenticatedContext } from "@/server/auth/context";
import { getPrivateAssetDownload } from "@/server/data/downloads";
import { errorResponse, privateJson } from "@/server/http/errors";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ versionId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { versionId } = await context.params;
    return privateJson(await getPrivateAssetDownload(auth, versionId));
  } catch (error) {
    return errorResponse(error);
  }
}
