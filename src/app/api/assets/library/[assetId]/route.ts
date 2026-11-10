import { getAuthenticatedContext } from "@/server/auth/context";
import { getAssetDetail, readAssetQuery } from "@/server/data/assets";
import { errorResponse, privateJson } from "@/server/http/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) {
  try {
    const auth = await getAuthenticatedContext();
    const { assetId } = await context.params;
    return privateJson(await getAssetDetail(auth, assetId, readAssetQuery(request, "detail")));
  } catch (error) {
    return errorResponse(error);
  }
}
