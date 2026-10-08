import { vi } from 'vitest';
import type { LogoWorkerConnection } from '@/server/data/logo-jobs';
import { providerFixture } from '../server/logo-vector-proposal-provider-fixtures';
import { proposalId } from '../features/logo-vector/proposal-fixtures';
export const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
export function proposalHostFixture() {
 const f = providerFixture(), events: string[] = [];
 const capability = { operation: 'identity.logo_vector_propose' as const, policyIdentity: f.resolved.input.policyIdentity, handlerVersion: 'logo-vector-propose-v1' as const,
  provider: 'openai' as const, model: 'gpt-6.1-sol' as const, engine: null, maxCostMicrousd: f.textPolicy.maximumCostMicrousd, textPolicy: f.textPolicy };
 const row = { id: f.job.id, owner_id: f.job.ownerId, project_id: f.job.projectId, operation: f.job.operation, input: f.job.input, input_revision: f.job.inputRevision,
  lease_token: f.job.leaseToken, state: f.job.status, reserved_cost_microusd: f.job.reservedCostMicrousd, actual_cost_microusd: 0 };
 const state = { report: true, dispatch: true, claim: true, cancellation: false, completions: [] as unknown[][] };
 const query = vi.fn(async (sql: string, parameters: unknown[] = []): Promise<{ rows: unknown[] }> => {
  events.push(sql);
  if (sql.includes('logo_worker_owner()')) return { rows: [{ owner_id: f.job.ownerId }] };
  if (sql.includes('report_logo_worker_ready')) return { rows: [{ value: state.report }] };
  if (sql.includes('expire_logo_job_leases')) return { rows: [{ value: 0 }] };
  if (sql.includes('claim_logo_job')) { const claim = state.claim; state.claim = false; return { rows: claim ? [row] : [] }; }
  if (sql.includes('heartbeat_logo_job')) return { rows: [{ ...row, state: state.cancellation ? 'cancel_requested' : 'running' }] };
  if (sql.includes('runtime_readiness') || parameters[2] === 'runtime_readiness') return { rows: [{ value: state.dispatch }] };
  if (parameters[2] === 'vector_proposal_inputs' || parameters[2] === 'vector_proposal_evidence_inputs') return { rows: [{ value: structuredClone(f.resolved) }] };
  if (sql.includes('begin_logo_job_step')) return { rows: [{ value: 'started' }] };
  if (sql.includes('record_logo_provider_response')) return { rows: [{ value: await f.ports.recordResponse(f.job, JSON.parse(parameters[2] as string)) }] };
  if (sql.includes('stage_logo_vector_proposal')) return { rows: [{ value: { version: 1, kind: 'logo_vector_proposal_prepared', id: proposalId(45), ownerId: f.job.ownerId, projectId: f.job.projectId, jobId: f.job.id, leaseToken: f.job.leaseToken, quoteId: f.resolved.input.quoteId, inputHash: f.resolved.input.inputHash, contextHash: f.resolved.input.contextHash, providerResponseReceiptId: parameters[3] } }] };
  if (sql.includes('complete_logo_job_step')) state.completions.push(parameters);
  if (sql.includes('complete_logo_job_step') || sql.includes('finish_logo_job') || sql.includes('register_logo_job_plan')) return { rows: [] };
  throw Error('Unexpected synthetic proposal SQL');
 });
 const connection = { query } as LogoWorkerConnection;
 const proposals = { capability, configuration: f.configuration, transport: f.transport };
 return { ...f, capability, row, state, query, connection, events, proposals };
}
