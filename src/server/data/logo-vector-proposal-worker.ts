import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ClaimedJob } from '@/domain/jobs';
import { logoVectorProposalJobInputSchema, logoVectorProposalProviderObservationSchema, logoVectorProposalProviderReceiptSchema } from '@/domain/logo-vector-proposal-jobs';
import { logoVectorProposalResolvedInputSchema, logoVectorProposalObservedResultSchema, logoVectorProposalPreparedReceiptSchema, logoVectorProposalProviderResultSchema, type LogoVectorProposalWorkerPorts } from '@/domain/logo-vector-proposal-evidence';
import { validateLogoVectorProposal } from '@/features/logo-vector/model/proposal';
import { ApiError } from '../http/errors';
import { logoId, parseLogoInput, parseLogoStored } from './logo-transaction';
import { readLeasedLogoRecord, type LogoWorkerConnection } from './logo-jobs';

function active(signal: AbortSignal) {
 if (signal.aborted) throw new ApiError('integration_unavailable');
}
function claimedInput(job: ClaimedJob) {
 logoId(job.id); logoId(job.leaseToken); logoId(job.ownerId); logoId(job.projectId);
 const input = parseLogoStored(logoVectorProposalJobInputSchema, job.input);
 if (job.operation !== input.operation || job.ownerId !== input.ownerId || job.projectId !== input.projectId) throw new ApiError('not_found');
 return input;
}

/** Admission-only ports. SQL checks the actual restricted principal, original
 * lease and immutable quote, including PostgreSQL's exact context hash. There
 * is deliberately no JS reserialization hash or asset-store capability here.
 * This factory exposes only admission reads; observation is composed below. */
export function createLogoVectorProposalAdmissionPorts(connection: LogoWorkerConnection): Pick<LogoVectorProposalWorkerPorts, 'loadInput' | 'assertReady'> {
 return {
  async loadInput(job, signal) {
   active(signal); const input = claimedInput(job);
   const result = parseLogoStored(logoVectorProposalResolvedInputSchema, await readLeasedLogoRecord(connection, job, 'vector_proposal_inputs'));
   active(signal);
   if (!isDeepStrictEqual(result.input, input)) throw new ApiError('not_found');
   return result;
  },
  async assertReady(job, signal) {
   active(signal); claimedInput(job);
   const ready = parseLogoStored(z.boolean(), await readLeasedLogoRecord(connection, job, 'runtime_readiness'));
   active(signal);
   if (!ready) throw new ApiError('integration_unavailable');
  },
 };
}

/** Retain an already observed response using original dispatch authority. This
 * deliberately has no AbortSignal or current-readiness prerequisite. SQL checks
 * current principal binding, immutable original authority and exact once-only
 * accounting even after lease expiry. This factory exposes observation only. */
export function createLogoVectorProposalObservationPorts(connection: LogoWorkerConnection): Pick<LogoVectorProposalWorkerPorts, 'loadInput' | 'assertReady' | 'recordResponse'> {
 return {
  ...createLogoVectorProposalAdmissionPorts(connection),
  async recordResponse(job, observation) {
   const input = claimedInput(job), parsed = parseLogoInput(logoVectorProposalProviderObservationSchema, observation);
   if (!isDeepStrictEqual(parsed.textPolicy, input.textPolicy)) throw new ApiError('not_found');
   const result = await connection.query<{ value: unknown }>('select public.record_logo_provider_response($1,$2,$3) value', [job.id, job.leaseToken, JSON.stringify(parsed)]);
   if (result.rows.length !== 1) throw new ApiError('integration_unavailable');
   const receipt = parseLogoStored(logoVectorProposalProviderReceiptSchema, result.rows[0]!.value);
   if (receipt.ownerId !== job.ownerId || receipt.projectId !== job.projectId || receipt.jobId !== job.id || receipt.leaseToken !== job.leaseToken || !isDeepStrictEqual(receipt.observation, parsed)) throw new ApiError('not_found');
   return receipt;
  },
 };
}

/** Complete disconnected evidence ports. Original-dispatch reads and staging
 * remain authorized after lease loss; they never gain source/font asset access.
 * The accepted validator establishes provisional intent only. */
export function createLogoVectorProposalWorkerPorts(connection: LogoWorkerConnection): LogoVectorProposalWorkerPorts {
 return {
  ...createLogoVectorProposalObservationPorts(connection),
  async stageProposal(job, result, receipt) {
   const input = claimedInput(job), observed = parseLogoInput(logoVectorProposalProviderReceiptSchema, receipt);
   const parsed = parseLogoInput(logoVectorProposalObservedResultSchema, result);
   if (observed.ownerId !== job.ownerId || observed.projectId !== job.projectId || observed.jobId !== job.id || observed.leaseToken !== job.leaseToken || !isDeepStrictEqual(observed.observation.textPolicy, input.textPolicy)) throw new ApiError('not_found');
   parseLogoInput(logoVectorProposalProviderResultSchema, { kind: 'observed', observation: observed.observation, result: parsed });
   if (!parsed.retainedOutput.truncated && createHash('sha256').update(Buffer.from(parsed.retainedOutput.data, 'base64')).digest('hex') !== parsed.retainedOutput.sha256) throw new ApiError('integration_unavailable');
   const resolved = parseLogoStored(logoVectorProposalResolvedInputSchema, await readLeasedLogoRecord(connection, job, 'vector_proposal_evidence_inputs'));
   if (!isDeepStrictEqual(resolved.input, input)) throw new ApiError('not_found');
   if (parsed.status === 'valid') validateLogoVectorProposal(parsed.payload, resolved.context);
   const staged = await connection.query<{ value: unknown }>('select fluid_private.stage_logo_vector_proposal($1,$2,$3,$4) value', [job.id, job.leaseToken, JSON.stringify(parsed), observed.id]);
   if (staged.rows.length !== 1) throw new ApiError('integration_unavailable');
   const prepared = parseLogoStored(logoVectorProposalPreparedReceiptSchema, staged.rows[0]!.value);
   if (prepared.ownerId !== job.ownerId || prepared.projectId !== job.projectId || prepared.jobId !== job.id || prepared.leaseToken !== job.leaseToken || prepared.quoteId !== input.quoteId || prepared.inputHash !== input.inputHash || prepared.contextHash !== input.contextHash || prepared.providerResponseReceiptId !== observed.id) throw new ApiError('not_found');
   return prepared;
  },
 };
}
