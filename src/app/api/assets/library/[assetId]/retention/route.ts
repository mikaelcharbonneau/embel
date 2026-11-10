import { ASSET_LIBRARY_MUTATION_MAX_BYTES, setAssetRetentionSchema } from "@/domain/asset-library";
import { getAuthenticatedContext } from "@/server/auth/context";
import { setAssetRetention } from "@/server/data/assets";
import { errorResponse, privateJson } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
export async function PATCH(request: Request, context: { params: Promise<{ assetId: string }> }) {
  try {
    assertMutationOrigin(request);
    const auth = await getAuthenticatedContext();
    const { assetId } = await context.params;
    return privateJson(
      await setAssetRetention(
        auth,
        assetId,
        await readJson(request, setAssetRetentionSchema, ASSET_LIBRARY_MUTATION_MAX_BYTES),
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
