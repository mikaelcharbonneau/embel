import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { logoVectorProposalRequestSchema } from '@/domain/logo-vector-proposals';
import { logoGenerationIntentSchema, type LogoGenerationIntent } from '@/domain/logo-jobs';
import { logoVectorProposalRequestStateSchema, logoVectorProposalRequestCloseSchema, logoVectorProposalRequestPageSchema, type LogoVectorProposalRequestState, type LogoVectorProposalRequestClose, type LogoVectorProposalRequestPage } from '@/features/logo-vector/model/proposal-session';
import { logoVectorProposalRecordSchema, logoVectorProposalPageSchema, type LogoVectorProposalRecord, type LogoVectorProposalPage } from '@/domain/logo-vector-proposal-jobs';
import { logoPageQuerySchema } from '@/domain/logo-workspace';
import type { LogoCostQuote } from '@/domain/logo-jobs';
import type { AuthenticatedContext } from '../auth/context';
import { ApiError } from '../http/errors';
import { logoOwner, logoId, parseLogoInput, parseLogoStored, logoDatabaseError } from './logo-transaction';
import { validateLogoVectorProposal } from '@/features/logo-vector/model/proposal';

const active = (signal?: AbortSignal) => { if (signal?.aborted) throw new ApiError('integration_unavailable'); };
export class LogoVectorProposalClosureUncertainError extends ApiError {
 readonly recovery: { projectId: string; input: LogoGenerationIntent };
 constructor(projectId: string, input: LogoGenerationIntent) { super('integration_unavailable'); this.name='LogoVectorProposalClosureUncertainError'; this.recovery={projectId,input:structuredClone(input)}; }
}
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
 function validateRequest(owner: string, projectId: string, input: LogoGenerationIntent, result: LogoVectorProposalRequestState) {
  if(result.ownerId!==owner||result.projectId!==projectId)throw new ApiError('integration_unavailable');
  if(!isDeepStrictEqual(result.input,input))throw new ApiError('integration_unavailable');
  if(result.proposal?.payload!==null&&result.proposal?.payload!==undefined){
   try{validateLogoVectorProposal(result.proposal.payload,result.proposal.context);}catch{throw new ApiError('integration_unavailable');}
  }
 }
 async function readLogoVectorProposalRequest(auth:AuthenticatedContext,projectId:string,raw:unknown,signal?:AbortSignal):Promise<LogoVectorProposalRequestState>{
  const owner=logoOwner(auth);projectId=logoId(projectId);const input=parseLogoInput(logoGenerationIntentSchema,raw);
  const result=parseLogoStored(logoVectorProposalRequestStateSchema,await rpc(auth,'read_logo_vector_proposal_request',{p_project_id:projectId,p_input:input},signal));
  active(signal);if(logoOwner(auth)!==owner)throw new ApiError('unauthenticated');validateRequest(owner,projectId,input,result);return result;
 }
 /** Only the serialized SQL close may certify non-admission. A failed/missing
  * lookup never authorizes discarding this original intent or changing its key. */
 async function closeLogoVectorProposalRequest(auth:AuthenticatedContext,projectId:string,raw:unknown,signal?:AbortSignal):Promise<LogoVectorProposalRequestClose>{
  const owner=logoOwner(auth);projectId=logoId(projectId);const input=parseLogoInput(logoGenerationIntentSchema,raw);active(signal);
  try{
   const result=parseLogoStored(logoVectorProposalRequestCloseSchema,await rpc(auth,'close_logo_vector_proposal_request',{p_project_id:projectId,p_input:input},signal));
   active(signal);if(logoOwner(auth)!==owner)throw new ApiError('unauthenticated');
   if(result.status==='admitted')validateRequest(owner,projectId,input,result.request);
   else{if(result.ownerId!==owner||result.projectId!==projectId||!isDeepStrictEqual(result.input,input))throw new ApiError('integration_unavailable');}
   return result;
  }catch(error){const mapped=logoDatabaseError(error);if(mapped.code!=='integration_unavailable')throw mapped;throw new LogoVectorProposalClosureUncertainError(projectId,input);}
 }
 async function listPendingLogoVectorProposalRequests(auth:AuthenticatedContext,projectId:string,query:{cursor?:string;limit?:number}={},signal?:AbortSignal):Promise<LogoVectorProposalRequestPage>{
  const owner=logoOwner(auth);projectId=logoId(projectId);
  const parsed=parseLogoInput(z.strictObject({cursor:z.uuid().optional(),limit:z.number().int().min(1).max(10).default(10)}),query);
  const cursor=parsed.cursor?logoId(parsed.cursor):null;
  const page=parseLogoStored(logoVectorProposalRequestPageSchema,await rpc(auth,'list_pending_logo_vector_proposal_requests',{p_project_id:projectId,p_cursor:cursor,p_limit:parsed.limit},signal));
  active(signal);if(logoOwner(auth)!==owner)throw new ApiError('unauthenticated');
  if(page.ownerId!==owner||page.projectId!==projectId||page.items.length>parsed.limit||new Set(page.items.map(item=>item.input.requestKey)).size!==page.items.length
    ||page.nextCursor!==null&&(!page.items.length||page.nextCursor!==page.items.at(-1)!.input.requestKey||page.nextCursor===cursor))throw new ApiError('integration_unavailable');
  for(const item of page.items)validateRequest(owner,projectId,item.input,item);
  return page;
 }
 return { quoteLogoVectorProposal, readLogoVectorProposal, listLogoVectorProposals, readLogoVectorProposalRequest, closeLogoVectorProposalRequest, listPendingLogoVectorProposalRequests };
}
export const { quoteLogoVectorProposal, readLogoVectorProposal, listLogoVectorProposals, readLogoVectorProposalRequest, closeLogoVectorProposalRequest, listPendingLogoVectorProposalRequests } = createLogoVectorProposalService();
