import { getAuthenticatedContext } from "@/server/auth/context";
import { listAccountAssets,readAssetQuery } from "@/server/data/assets";
import { errorResponse,privateJson } from "@/server/http/errors";
export const dynamic="force-dynamic";
export async function GET(request:Request){
  try{const auth=await getAuthenticatedContext();return privateJson(await listAccountAssets(auth,readAssetQuery(request)));}
  catch(error){return errorResponse(error);}
}
