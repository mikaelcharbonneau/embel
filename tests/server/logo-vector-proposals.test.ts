import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { operationSchema, resolveModelRoute } from '@/domain/providers';
import { logoDispatchReceiptSchema, logoQuoteRequestSchema } from '@/domain/logo-jobs';
import { proposalHeads, proposalId, proposed } from '../features/logo-vector/proposal-fixtures';

const request = { operation: 'propose_vector_edit', expected: proposalHeads, baseVectorRevisionId: proposalId(5), instruction: 'Rotate the symbol', targetComponentIds: ['synthetic-symbol'] };
describe('disabled vector proposal operation recognition', () => {
 it('recognizes the separate operation without enabling legacy model routing', () => {
  expect(operationSchema.safeParse('identity.logo_vector_propose').success).toBe(true);
  expect(resolveModelRoute('identity.logo_vector_propose' as never, { paidCallsApproved: true, credentialsPresent: true, verifiedModelIds: ['gpt-6.1-sol'], textModels: { 'strategy.reformulate': 'gpt-6.1-sol' } })).toEqual({ status: 'blocked', reason: 'pipeline_not_implemented' });
 });
 it('admits only the strict one-request discriminator without client evidence', () => {
  expect(logoQuoteRequestSchema.safeParse(request).success).toBe(true);
  for (const extra of [{ context: {} }, { locks: [] }, { model: 'gpt-6.1-sol' }, { ownerId: proposalId(1) }]) expect(logoQuoteRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
 });
 it('recognizes an exact original-key proposal receipt without image outputs', () => {
  expect(logoDispatchReceiptSchema.safeParse({ ownerId: proposalId(1), projectId: proposalId(2), requestKey: proposalId(3), operation: 'identity.logo_vector_propose', batchId: null, jobIds: [proposalId(4)], inputHash: 'a'.repeat(64) }).success).toBe(true);
 });
});

import { createLogoVectorProposalService } from '@/server/data/logo-vector-proposals';
import { logoVectorProposalTextPolicySchema, logoVectorProposalProviderObservationSchema, logoVectorProposalRecordSchema, logoVectorProposalUsageCost } from '@/domain/logo-vector-proposal-jobs';
import type { AuthenticatedContext } from '@/server/auth/context';
import { proposalPolicy, proposalObservation, proposalRecord } from './logo-vector-proposal-fixtures';
const auth = (rpc: (...args: unknown[]) => unknown) => ({ userId: proposalId(1), client: { rpc } }) as unknown as AuthenticatedContext;
describe('independent text policy and immutable evidence contracts', () => {
 it('derives the maximum including the highest cache-write rate', () => {
  expect(logoVectorProposalTextPolicySchema.parse(proposalPolicy()).maximumCostMicrousd).toBe(122880);
  for (const wrong of [{ maximumCostMicrousd: 106496 }, { maxTools: 1 }, { handlerVersion: 'strategy-openai-v1' }, { model: 'other' }, { pricingVersion: 'unqualified' }]) expect(logoVectorProposalTextPolicySchema.safeParse({ ...proposalPolicy(), ...wrong }).success).toBe(false);
  expect(logoVectorProposalUsageCost({ inputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 3 })).toBe(34);
 });
 it('retains unknown usage without inventing a free charge', () => {
  expect(logoVectorProposalProviderObservationSchema.safeParse({ ...proposalObservation(), usage: null, billing: { status: 'unknown', confirmedMicrousd: null } }).success).toBe(true);
  expect(logoVectorProposalProviderObservationSchema.safeParse({ ...proposalObservation(), usage: null, billing: { status: 'recorded', confirmedMicrousd: 0 } }).success).toBe(false);
  expect(logoVectorProposalProviderObservationSchema.safeParse({ ...proposalObservation(), model: 'wrong' }).success).toBe(false);
  expect(logoVectorProposalProviderObservationSchema.safeParse({ ...proposalObservation(), model: 'wrong', billing: { status: 'unknown', confirmedMicrousd: null } }).success).toBe(true);
 });
 it('retains unsupported answers and keeps every proposal non-materialized', () => {
  const result = proposalRecord(); expect(logoVectorProposalRecordSchema.safeParse(result).success).toBe(true);
  expect(logoVectorProposalRecordSchema.safeParse({ ...result, payload: { version: 1, status: 'unsupported', code: 'multiple_changes', explanation: 'Only one change can be proposed.' } }).success).toBe(true);
  expect(logoVectorProposalRecordSchema.safeParse({ ...result, materialization: 'available' }).success).toBe(false);
 });
 it('rejects a succeeded record whose actual usage exceeds its frozen budget', () => {
  const result = proposalRecord(), observation = { ...proposalObservation(), usage: { inputTokens: 32769, cachedInputTokens: 0, cacheWriteInputTokens: 32769, outputTokens: 4096 }, billing: { status: 'recorded', confirmedMicrousd: 122883 } };
  expect(logoVectorProposalRecordSchema.safeParse({ ...result, actualCostMicrousd: 122883, providerReceipt: { ...result.providerReceipt, observation } }).success).toBe(false);
 });
 it('keeps missing-receipt or unknown-billing results pending instead of success', () => {
  const result = proposalRecord();
  expect(logoVectorProposalRecordSchema.safeParse({ ...result, providerReceipt: null }).success).toBe(false);
  expect(logoVectorProposalRecordSchema.safeParse({ ...result, providerReceipt: null, state: 'needs_reconciliation', reason: 'provider_outcome_unknown', actualCostMicrousd: 0 }).success).toBe(true);
 });
});
describe('read-only owned proposal DAL', () => {
 it('the default quote producer is unavailable before any RPC', async () => {
  const rpc = vi.fn(); await expect(createLogoVectorProposalService().quoteLogoVectorProposal(auth(rpc), proposalId(2), request)).rejects.toMatchObject({ code: 'integration_unavailable' }); expect(rpc).not.toHaveBeenCalled();
 });
 it('returns a valid provisional owned record without assets or inference', async () => {
  const result = proposalRecord(), rpc = vi.fn(async () => ({ data: result, error: null }));
  expect(await createLogoVectorProposalService().readLogoVectorProposal(auth(rpc), result.projectId, result.id)).toEqual(result);
  expect(rpc).toHaveBeenCalledExactlyOnceWith('read_logo_vector_proposal', { p_project_id: result.projectId, p_proposal_id: result.id });
 });
 it('rejects foreign detail, different requested IDs, malformed commands and cancelled reads', async () => {
  const result = proposalRecord();
  for (const changed of [{ ...result, ownerId: proposalId(99), context: { ...result.context, ownerId: proposalId(99) }, providerReceipt: { ...result.providerReceipt, ownerId: proposalId(99) } }, { ...result, id: proposalId(98) }, { ...result, payload: proposed({ kind: 'rotation', componentId: 'synthetic-symbol', degrees: 0 }) }]) {
   const rpc = vi.fn(async () => ({ data: changed, error: null })); await expect(createLogoVectorProposalService().readLogoVectorProposal(auth(rpc), result.projectId, result.id)).rejects.toBeDefined(); expect(rpc).toHaveBeenCalledOnce();
  }
  const controller = new AbortController(); controller.abort(); const rpc = vi.fn();
  await expect(createLogoVectorProposalService().readLogoVectorProposal(auth(rpc), result.projectId, result.id, controller.signal)).rejects.toMatchObject({ code: 'integration_unavailable' }); expect(rpc).not.toHaveBeenCalled();
 });
 it('bounds discovery, rejects extra query keys and never retries failed reads', async () => {
  const rpc = vi.fn(async () => { throw Error('read interrupted'); }), service = createLogoVectorProposalService();
  await expect(service.listLogoVectorProposals(auth(rpc), proposalId(2), { limit: 51 })).rejects.toMatchObject({ code: 'invalid_input' }); expect(rpc).not.toHaveBeenCalled();
  await expect(service.listLogoVectorProposals(auth(rpc), proposalId(2))).rejects.toMatchObject({ code: 'integration_unavailable' }); expect(rpc).toHaveBeenCalledOnce();
 });
});

import { logoCostQuoteSchema } from '@/domain/logo-jobs';
it('a text quote cannot inherit image or subscription policy identity', () => {
 const quote = { id: proposalId(71), ownerId: proposalId(1), projectId: proposalId(2), request, inputHash: 'a'.repeat(64), expected: request.expected, policyIdentity: 'b'.repeat(64), handlerVersion: 'logo-vector-propose-v1', provider: 'openai', model: 'gpt-6.1-sol', engine: null, estimatedCostMicrousd: 122880, maxCostMicrousd: 122880, externalProviderCostMicrousd: 122880, expiresAt: '2026-10-08T12:00:00Z', conceptPlan: null, targetSlotIds: [] };
 expect(logoCostQuoteSchema.safeParse(quote).success).toBe(false);
 expect(logoCostQuoteSchema.safeParse({ ...quote, textPolicy: proposalPolicy() }).success).toBe(true);
 for (const wrong of [{ handlerVersion: 'logo-image-v1' }, { maxCostMicrousd: 122881 }, { externalProviderCostMicrousd: 0 }, { model: 'other' }]) expect(logoCostQuoteSchema.safeParse({ ...quote, textPolicy: proposalPolicy(), ...wrong }).success).toBe(false);
});
it('retained uncertain evidence still binds known charges and exact provider provenance', () => {
 const result = proposalRecord();
 expect(logoVectorProposalRecordSchema.safeParse({ ...result, state: 'needs_reconciliation', reason: 'publication_unknown', actualCostMicrousd: 0 }).success).toBe(false);
 expect(logoVectorProposalRecordSchema.safeParse({ ...result, providerReceipt: { ...result.providerReceipt, jobId: proposalId(90) } }).success).toBe(false);
});

import { logoCapabilitiesSchema } from '@/domain/logo-capabilities';
it('the integrated optional sixth capability preserves history and bounds available advertisements', () => {
 const unavailable = { status: 'unavailable' }, operations = { 'identity.logo_concept': unavailable, 'identity.logo_refine': unavailable, 'identity.logo_vectorize': unavailable, 'identity.logo_directions': unavailable, 'identity.logo_export': unavailable };
 const value = { ownerId: proposalId(1), projectId: proposalId(2), observedAt: '2026-10-08T00:00:00Z', operations };
 expect(logoCapabilitiesSchema.parse(value)).toEqual(value);
 for (const expiresAt of ['2026-10-08T00:00:10Z', '2026-10-08T00:00:30Z']) expect(logoCapabilitiesSchema.safeParse({ ...value, operations: { ...operations, 'identity.logo_vector_propose': { status: 'available', expiresAt } } }).success).toBe(true);
 for (const sixth of [
  { status: 'available' }, { status: 'available', expiresAt: null }, { status: 'available', expiresAt: 'invalid' },
  { status: 'available', expiresAt: '2026-10-08T00:00:00Z' }, { status: 'available', expiresAt: '2026-10-07T23:59:59Z' },
  { status: 'available', expiresAt: '2026-10-08T00:00:30.001Z' },
  { status: 'available', expiresAt: '2026-10-08T00:00:10Z', policy: {} },
  { status: 'unavailable', expiresAt: '2026-10-08T00:00:10Z' }, { status: 'enabled' },
 ]) expect(logoCapabilitiesSchema.safeParse({ ...value, operations: { ...operations, 'identity.logo_vector_propose': sixth } }).success).toBe(false);
 expect(logoCapabilitiesSchema.safeParse({ ...value, operations: { ...operations, 'identity.logo_vector_propose': unavailable } }).success).toBe(true);
});

import { logoVectorProposalJobInputSchema } from '@/domain/logo-vector-proposal-jobs';
it('leased proposal job input keeps the exact request text and component ID restrictions', () => {
 const input = { version: 2, ownerId: proposalId(1), projectId: proposalId(2), operation: 'identity.logo_vector_propose', requestKey: proposalId(81), quoteId: proposalId(82), policyIdentity: 'a'.repeat(64), handlerVersion: 'logo-vector-propose-v1', inputHash: 'b'.repeat(64), baseVectorRevisionId: proposalId(5), contextHash: 'c'.repeat(64), instruction: 'Rotate the symbol', targetComponentIds: ['synthetic-symbol'], textPolicy: proposalPolicy() };
 expect(logoVectorProposalJobInputSchema.safeParse(input).success).toBe(true);
 for (const wrong of [{ instruction: '   ' }, { targetComponentIds: ['bad id'] }, { targetComponentIds: ['synthetic-symbol', 'synthetic-symbol'] }, { instruction: 'x'.repeat(4001) }]) expect(logoVectorProposalJobInputSchema.safeParse({ ...input, ...wrong }).success).toBe(false);
});
