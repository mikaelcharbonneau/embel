import { logoGenerationIntentSchema } from '@/domain/logo-jobs';
import { LOGO_MUTATION_MAX_BYTES } from '@/domain/logo-workspace';
import { getAuthenticatedContext } from '@/server/auth/context';
import { closeLogoVectorProposalRequest } from '@/server/data/logo-vector-proposals';
import { logoId } from '@/server/data/logo-transaction';
import { ApiError, privateJson } from '@/server/http/errors';
import { logoErrorResponse } from '@/server/http/logo-errors';
import { assertMutationOrigin, readJson } from '@/server/http/request';
export const dynamic='force-dynamic';
export const runtime='nodejs';
/** Close the exact original admission intent under SQL's admission lock, or
 * request normal Stop for its actual job. No missing-read inference is used. */
export async function POST(request:Request,context:{params:Promise<{projectId:string;requestKey:string}>}){
 try{
  const auth=await getAuthenticatedContext();assertMutationOrigin(request);
  if(new URL(request.url).search)throw new ApiError('invalid_input');
  const params=await context.params,projectId=logoId(params.projectId),requestKey=logoId(params.requestKey);
  const input=await readJson(request,logoGenerationIntentSchema,LOGO_MUTATION_MAX_BYTES);
  if(input.requestKey!==requestKey)throw new ApiError('invalid_input');
  return privateJson(await closeLogoVectorProposalRequest(auth,projectId,input,request.signal));
 }catch(error){return logoErrorResponse(error);}
}
