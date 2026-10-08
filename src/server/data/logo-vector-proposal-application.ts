import 'server-only';
import { logoVectorProposalApplicationSchema, type LogoVectorProposalApplication } from '@/features/logo-vector/model/proposal-materialization';
import type { AuthenticatedContext } from '../auth/context';
import { logoOwner, logoId, parseLogoStored, logoDatabaseError } from './logo-transaction';
import { ApiError } from '../http/errors';

/** Owned read projection, separate from the immutable historical proposal. The
 * database checks the authoritative prepared/provider/job/accounting bindings. */
export async function readLogoVectorProposalApplication(auth: AuthenticatedContext, projectId: string, proposalId: string, signal?: AbortSignal): Promise<LogoVectorProposalApplication> {
 const owner = logoOwner(auth); projectId = logoId(projectId); proposalId = logoId(proposalId);
 const active = () => { if (signal?.aborted) throw new ApiError('integration_unavailable'); };
 active();
 try {
  const pending = auth.client.rpc('read_logo_vector_proposal_application', {p_project_id:projectId,p_proposal_id:proposalId});
  const response = await (signal ? pending.abortSignal(signal) : pending); active();
  if (response.error) throw logoDatabaseError(response.error);
  const application = parseLogoStored(logoVectorProposalApplicationSchema, response.data), proposal = application.proposal;
  if (proposal.ownerId !== owner || proposal.projectId !== projectId || proposal.id !== proposalId || logoOwner(auth) !== owner) throw new ApiError('not_found');
  return application;
 } catch (error) { throw logoDatabaseError(error); }
}
