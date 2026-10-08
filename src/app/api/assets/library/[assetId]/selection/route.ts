import { ASSET_LIBRARY_MUTATION_MAX_BYTES,selectAssetVersionSchema } from "@/domain/asset-library";
import { getAuthenticatedContext } from "@/server/auth/context";
import { selectAssetVersion } from "@/server/data/assets";
import { errorResponse,privateJson } from "@/server/http/errors";
import { assertMutationOrigin,readJson } from "@/server/http/request";
export async function POST(request:Request,context:{params:Promise<{assetId:string}>}){
  try{assertMutationOrigin(request);const auth=await getAuthenticatedContext();const {assetId}=await context.params;return privateJson(await selectAssetVersion(auth,assetId,await readJson(request,selectAssetVersionSchema,ASSET_LIBRARY_MUTATION_MAX_BYTES)));}
  catch(error){return errorResponse(error);}
}
