import { getAuthenticatedContext } from '@/server/auth/context';
import { ApiError, privateJson } from '@/server/http/errors';
import { logoErrorResponse } from '@/server/http/logo-errors';
import { assertMutationOrigin, readJson } from '@/server/http/request';
import { logoUuidSchema, LOGO_MUTATION_MAX_BYTES } from '@/domain/logo-vector';
import { applyLogoVectorProposalInputSchema } from '@/features/logo-vector/model/proposal-materialization';
import { parseLogoInput } from '@/server/data/logo-transaction';
import { readLogoVectorProposalApplication } from '@/server/data/logo-vector-proposal-application';
import { resolveLogoRequestServices } from '@/server/runtime/logo-request-services';
export const dynamic = 'force-dynamic';
type Context = {params:Promise<{projectId:string;proposalId:string}>};
async function ids(context:Context) { const p=await context.params;return {projectId:parseLogoInput(logoUuidSchema,p.projectId),proposalId:parseLogoInput(logoUuidSchema,p.proposalId)}; }
/** Read-only eligibility and any immutable association, never a retry. */
export async function GET(request:Request,context:Context) {
 try {
  const auth=await getAuthenticatedContext(),{projectId,proposalId}=await ids(context);
  if(new URL(request.url).search)throw new ApiError('invalid_input');
  return privateJson(await readLogoVectorProposalApplication(auth,projectId,proposalId,request.signal));
 } catch(error){return logoErrorResponse(error);}
}
export async function POST(request:Request,context:Context) {
 try {
  const auth=await getAuthenticatedContext();assertMutationOrigin(request);
  const {projectId,proposalId}=await ids(context);
  if(new URL(request.url).search)throw new ApiError('invalid_input');
  const input=await readJson(request,applyLogoVectorProposalInputSchema,LOGO_MUTATION_MAX_BYTES);
  if(input.proposalId!==proposalId)throw new ApiError('invalid_input');
  const services=await resolveLogoRequestServices(auth,projectId,request.signal);
  return privateJson(await services.workspace.applyLogoVectorProposal(auth,projectId,input,request.signal));
 } catch(error){return logoErrorResponse(error);}
}
