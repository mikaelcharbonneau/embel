import { IDENTITY_MUTATION_MAX_BYTES,selectIdentitySystemSchema } from "@/domain/project-identity";
import { getAuthenticatedContext } from "@/server/auth/context";
import { selectIdentitySystem } from "@/server/data/identity";
import { errorResponse,privateJson } from "@/server/http/errors";
import { assertMutationOrigin,readJson } from "@/server/http/request";
export async function POST(request:Request,context:{params:Promise<{projectId:string}>}){
 try{assertMutationOrigin(request);const auth=await getAuthenticatedContext();const {projectId}=await context.params;return privateJson(await selectIdentitySystem(auth,projectId,await readJson(request,selectIdentitySystemSchema,IDENTITY_MUTATION_MAX_BYTES),request.signal));}
 catch(error){return errorResponse(error);}
}
