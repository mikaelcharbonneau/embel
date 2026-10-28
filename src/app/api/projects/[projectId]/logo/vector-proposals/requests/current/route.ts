import { z } from 'zod';
import { getAuthenticatedContext } from '@/server/auth/context';
import { listPendingLogoVectorProposalRequests } from '@/server/data/logo-vector-proposals';
import { logoId } from '@/server/data/logo-transaction';
import { ApiError, privateJson } from '@/server/http/errors';
import { logoErrorResponse } from '@/server/http/logo-errors';
export const dynamic='force-dynamic';
export const runtime='nodejs';
/** Read-only bounded discovery of server-owned original requests after reload.
 * Omitting a request from a page never certifies non-admission or closure. */
export async function GET(request:Request,context:{params:Promise<{projectId:string}>}){
 try{
  const auth=await getAuthenticatedContext(),projectId=logoId((await context.params).projectId),params=new URL(request.url).searchParams;
  for(const key of params.keys())if(!['cursor','limit'].includes(key)||params.getAll(key).length!==1)throw new ApiError('invalid_input');
  const cursor=params.get('cursor'),limit=params.get('limit');
  if(cursor!==null&&!z.uuid().safeParse(cursor).success||limit!==null&&!/^(?:[1-9]|10)$/.test(limit))throw new ApiError('invalid_input');
  return privateJson(await listPendingLogoVectorProposalRequests(auth,projectId,{...(cursor!==null?{cursor}:{}),...(limit!==null?{limit:Number(limit)}:{})},request.signal));
 }catch(error){return logoErrorResponse(error);}
}
