import 'server-only';
import { logoVectorProposalRequestSchema } from '@/domain/logo-vector-proposals';
import { logoVectorProposalRecordSchema, logoVectorProposalPageSchema, type LogoVectorProposalRecord, type LogoVectorProposalPage } from '@/domain/logo-vector-proposal-jobs';
import { logoPageQuerySchema } from '@/domain/logo-workspace';
import type { LogoCostQuote } from '@/domain/logo-jobs';
import type { AuthenticatedContext } from '../auth/context';
import { ApiError } from '../http/errors';
import { logoOwner, logoId, parseLogoInput, parseLogoStored, logoDatabaseError } from './logo-transaction';
import { validateLogoVectorProposal } from '@/features/logo-vector/model/proposal';

const active = (signal?: AbortSignal) => { if (signal?.aborted) throw new ApiError('integration_unavailable'); };
function scope(owner: string, project: string, value: { ownerId: string; projectId: string }) {
 if (value.ownerId !== owner || value.projectId !== project) throw new ApiError('not_found');
}
/** Owned recovery only. No provider, credential discovery, asset access or mutable candidate authority. */
export function createLogoVectorProposalService() {
 async function rpc(auth: AuthenticatedContext, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  logoOwner(auth); active(signal);
  try {
   const request = auth.client.rpc(name, args), response = await (signal ? request.abortSignal(signal) : request);
   if (response.error) throw logoDatabaseError(response.error);
   active(signal); return response.data;
  } catch (error) { throw logoDatabaseError(error); }
 }
 async function quoteLogoVectorProposal(auth: AuthenticatedContext, projectId: string, request: unknown, signal?: AbortSignal): Promise<LogoCostQuote> {
  logoOwner(auth); logoId(projectId); parseLogoInput(logoVectorProposalRequestSchema, request); active(signal);
  // The real quote producer is composed in request-scoped logo services. This
  // standalone read service has no trusted quote connection or verified byte readers.
  throw new ApiError('integration_unavailable');
 }
 async function readLogoVectorProposal(auth: AuthenticatedContext, projectId: string, proposalId: string, signal?: AbortSignal): Promise<LogoVectorProposalRecord> {
  const owner = logoOwner(auth); projectId = logoId(projectId); proposalId = logoId(proposalId);
  const result = parseLogoStored(logoVectorProposalRecordSchema, await rpc(auth, 'read_logo_vector_proposal', { p_project_id: projectId, p_proposal_id: proposalId }, signal));
  scope(owner, projectId, result); if (result.id !== proposalId) throw new ApiError('not_found');
  if (result.payload !== null) {
   try { validateLogoVectorProposal(result.payload, result.context); } catch { throw new ApiError('integration_unavailable'); }
  }
  return result;
 }
 async function listLogoVectorProposals(auth: AuthenticatedContext, projectId: string, query: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<LogoVectorProposalPage> {
  const owner = logoOwner(auth); projectId = logoId(projectId); const parsed = parseLogoInput(logoPageQuerySchema, query);
  const page = parseLogoStored(logoVectorProposalPageSchema, await rpc(auth, 'list_logo_vector_proposals', { p_project_id: projectId, p_query: parsed }, signal));
  scope(owner, projectId, page); if (page.items.length > parsed.limit) throw new ApiError('integration_unavailable'); return page;
 }
 return { quoteLogoVectorProposal, readLogoVectorProposal, listLogoVectorProposals };
}
export const { quoteLogoVectorProposal, readLogoVectorProposal, listLogoVectorProposals } = createLogoVectorProposalService();
