import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { logoVectorProposalResolvedInputSchema, type LogoVectorProposalWorkerPorts } from '@/domain/logo-vector-proposal-evidence';
import { logoVectorProposalTextPolicySchema } from '@/domain/logo-vector-proposal-jobs';
import { buildLogoVectorProposalContext } from '@/features/logo-vector/server/proposal-context';
import { proposalFixture, proposalId, proposed } from '../features/logo-vector/proposal-fixtures';
import { proposalPolicy } from './logo-vector-proposal-fixtures';
import type { ClaimedJob } from '@/domain/jobs';
import type { OpenAIResponsesTransport } from '@/server/ai/openai-transport';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function providerFixture() {
 const source = proposalFixture(true); source.targetComponentIds = ['synthetic-symbol'];
 const context = buildLogoVectorProposalContext(source), textPolicy = logoVectorProposalTextPolicySchema.parse(proposalPolicy());
 const input = { version: 2, ownerId: context.ownerId, projectId: context.projectId, operation: 'identity.logo_vector_propose', requestKey: proposalId(40), quoteId: proposalId(41), policyIdentity: 'a'.repeat(64), handlerVersion: 'logo-vector-propose-v1', inputHash: 'b'.repeat(64), contextHash: 'c'.repeat(64), baseVectorRevisionId: context.baseVectorRevisionId, instruction: 'Rotate the selected symbol by ten degrees.', targetComponentIds: context.targetComponentIds, textPolicy };
 const resolved = logoVectorProposalResolvedInputSchema.parse({ input, context });
 const job: ClaimedJob = { id: proposalId(42), ownerId: context.ownerId, projectId: context.projectId, operation: input.operation, input: resolved.input, inputRevision: 1, leaseToken: proposalId(43), status: 'running', reservedCostMicrousd: textPolicy.maximumCostMicrousd, actualCostMicrousd: 0 };
 const payload = proposed({ kind: 'rotation', componentId: 'synthetic-symbol', degrees: 10 });
 const response = () => ({ body: { id: 'resp_synthetic', model: textPolicy.model, service_tier: 'default', status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 } } }, requestId: 'synthetic_request' });
 const transport = { countInputTokens: vi.fn<OpenAIResponsesTransport['countInputTokens']>(async () => 10), createResponse: vi.fn<OpenAIResponsesTransport['createResponse']>(async () => response()) };
 const ports: LogoVectorProposalWorkerPorts = {
  loadInput: vi.fn<LogoVectorProposalWorkerPorts['loadInput']>(async () => structuredClone(resolved)), assertReady: vi.fn<LogoVectorProposalWorkerPorts['assertReady']>(async () => {}),
  recordResponse: vi.fn<LogoVectorProposalWorkerPorts['recordResponse']>(async (claim, observation) => ({ id: proposalId(44), ownerId: claim.ownerId, projectId: claim.projectId, jobId: claim.id, leaseToken: claim.leaseToken, observation: structuredClone(observation) })),
  stageProposal: vi.fn<LogoVectorProposalWorkerPorts['stageProposal']>(async (claim, _result, receipt) => ({ version: 1, kind: 'logo_vector_proposal_prepared', id: proposalId(45), ownerId: claim.ownerId, projectId: claim.projectId, jobId: claim.id, leaseToken: claim.leaseToken, quoteId: resolved.input.quoteId, inputHash: resolved.input.inputHash, contextHash: resolved.input.contextHash, providerResponseReceiptId: receipt.id })),
 };
 const configuration = { operation: 'identity.logo_vector_propose' as const, paidCallsApproved: true as const, textPolicy };
 return { context, textPolicy, resolved, job, payload, response, transport, ports, configuration };
}
