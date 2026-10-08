import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createLogoJobStore } from '../../worker/logo-job-store';
import { createLogoVectorProposalHandler } from '../../worker/handlers/logo-vector-proposals';
import { createLogoVectorProposalProvider } from '@/features/logo-vector/server/proposal-provider';
import { proposalHostFixture } from './logo-vector-proposal-host-fixture';
import { proposalId } from '../features/logo-vector/proposal-fixtures';
const result = () => ({ version: 1 as const, kind: 'logo_vector_proposal' as const, preparedId: proposalId(45), providerResponseReceiptId: proposalId(44) });
describe('narrow typed vector proposal completion', () => {
 it.each(['succeeded', 'failed', 'needs_reconciliation'] as const)('retains typed %s output through the exact step', async status => {
  const f = proposalHostFixture(), store = createLogoJobStore(f.connection);
  const outcome = { status, costMicrousd: 68, providerRequestId: 'synthetic_request', result: result(), ...(status === 'failed' ? { code: 'invalid_output' } : status === 'needs_reconciliation' ? { code: 'provider_evidence_incomplete' } : {}) };
  await store.completeStep(f.job, 'propose-vector-edit', outcome as never);
  expect(f.state.completions[0]).toMatchObject({ 3: status === 'needs_reconciliation' ? 'ambiguous' : status, 4: 68 });
 });
 it('retains bounded unpublished evidence when observation acknowledgement is lost', async () => {
  const f = proposalHostFixture(); f.ports.recordResponse = async () => { throw Error('Lost acknowledgement'); };
  const provider = createLogoVectorProposalProvider({ configuration: f.configuration, transport: f.transport })!;
  const handler = createLogoVectorProposalHandler({ ...f.ports, provider }), outcome = await handler.steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal });
  expect(outcome).toMatchObject({ status: 'needs_reconciliation', costMicrousd: 68, result: { kind: 'logo_vector_proposal_unpublished' } });
  await createLogoJobStore(f.connection).completeStep(f.job, 'propose-vector-edit', outcome);
  expect(JSON.parse(f.state.completions[0]![5] as string)).toMatchObject({ result: { observation: { billing: { confirmedMicrousd: 68 } }, result: { retainedOutput: { truncated: false } } } });
 });
 it.each([
  { status: 'failed', code: 'not_dispatched', costMicrousd: 0, providerRequestId: null },
  { status: 'needs_reconciliation', code: 'provider_outcome_unknown', costMicrousd: 0, providerRequestId: null },
 ])('preserves exact no-dispatch/bare uncertainty outcomes %#', async outcome => {
  const f = proposalHostFixture(); await createLogoJobStore(f.connection).completeStep(f.job, 'propose-vector-edit', outcome as never); expect(f.state.completions).toHaveLength(1);
 });
 it.each([
  { status: 'succeeded', result: { publicationId: proposalId(45) } },
  { status: 'succeeded', result: { ...result(), extra: true } },
  { status: 'failed', code: 'arbitrary', result: result() },
  { status: 'failed', code: 'not_dispatched', result: result() },
  { status: 'failed', code: 'invalid_output' },
  { status: 'needs_reconciliation', code: 'provider_evidence_incomplete', result: { publicationId: proposalId(45) } },
  { status: 'needs_reconciliation', code: 'provider_outcome_unknown' },
 ])('rejects malformed or untyped proposal evidence before SQL %#', async fields => {
  const f = proposalHostFixture(); await expect(createLogoJobStore(f.connection).completeStep(f.job, 'propose-vector-edit', { costMicrousd: 68, providerRequestId: 'synthetic_request', ...fields } as never)).rejects.toThrow(); expect(f.query).not.toHaveBeenCalled();
 });
 it('does not broaden step or operation authorization', async () => {
  const f = proposalHostFixture(), outcome = { status: 'failed' as const, code: 'invalid_output', costMicrousd: 68, providerRequestId: 'synthetic_request', result: result() };
  for (const [operation, key] of [['identity.logo_concept', 'propose-vector-edit'], ['strategy.reformulate', 'propose-vector-edit'], ['identity.logo_vector_propose', 'prepare-export']]) await expect(createLogoJobStore(f.connection).completeStep({ ...f.job, operation: operation! }, key!, outcome)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
 });
 it('rejects foreign claims from the restricted logo RPC before a handler can receive them', async () => {
  const f = proposalHostFixture(); Object.assign(f.row, { operation: 'strategy.reformulate' });
  await expect(createLogoJobStore(f.connection).claim('fixture', 60)).rejects.toThrow();
 });
 it('does not accept a fabricated cost-rewrite reason for in-budget unpublished evidence', async () => {
  const f = proposalHostFixture(); f.ports.recordResponse = async () => { throw Error('Synthetic lost acknowledgement'); };
  const provider = createLogoVectorProposalProvider({ configuration: f.configuration, transport: f.transport })!;
  const outcome = await createLogoVectorProposalHandler({ ...f.ports, provider }).steps(f.job)[0]!.execute({ job: f.job, signal: new AbortController().signal });
  await expect(createLogoJobStore(f.connection).completeStep(f.job, 'propose-vector-edit', { ...outcome, code: 'provider_cost_exceeded' } as never)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
 });

});
