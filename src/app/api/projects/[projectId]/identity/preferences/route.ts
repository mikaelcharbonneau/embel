import { IDENTITY_MUTATION_MAX_BYTES,updateIdentityPreferencesSchema } from "@/domain/project-identity";
import { getAuthenticatedContext } from "@/server/auth/context";
import { setIdentityPreferences } from "@/server/data/identity";
import { errorResponse,privateJson } from "@/server/http/errors";
import { assertMutationOrigin,readJson } from "@/server/http/request";
export async function PATCH(request:Request,context:{params:Promise<{projectId:string}>}){
 try{assertMutationOrigin(request);const auth=await getAuthenticatedContext();const {projectId}=await context.params;return privateJson(await setIdentityPreferences(auth,projectId,await readJson(request,updateIdentityPreferencesSchema,IDENTITY_MUTATION_MAX_BYTES)));}
 catch(error){return errorResponse(error);}
}
