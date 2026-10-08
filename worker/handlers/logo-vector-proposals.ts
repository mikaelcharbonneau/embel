import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { stepOutcomeSchema, type ClaimedJob, type StepOutcome } from '../../src/domain/jobs';
import { logoVectorProposalJobInputSchema, logoVectorProposalProviderObservationSchema, type LogoVectorProposalProviderObservation } from '../../src/domain/logo-vector-proposal-jobs';
import { logoVectorProposalObservedResultSchema, logoVectorProposalRetainedOutputSchema, logoVectorProposalPreparedReceiptSchema, logoVectorProposalProviderReceiptSchema, logoVectorProposalProviderResultSchema, logoVectorProposalResolvedInputSchema, logoVectorProposalStepOutputSchema, logoVectorProposalUnpublishedOutputSchema, type LogoVectorProposalObservedResult, type LogoVectorProposalWorkerPorts } from '../../src/domain/logo-vector-proposal-evidence';
import { validateLogoVectorProposal } from '../../src/features/logo-vector/model/proposal';
import { retainLogoVectorProposalOutput, unknownLogoVectorProposalObservation, type LogoVectorProposalProvider } from '../../src/features/logo-vector/server/proposal-provider';
import type { JobHandler } from '../runner';

export type LogoVectorProposalHandlerDependencies = LogoVectorProposalWorkerPorts & { provider: LogoVectorProposalProvider };
const active = (signal: AbortSignal) => signal.throwIfAborted();
const nondispatch = (): StepOutcome => ({ status: 'failed', code: 'not_dispatched', costMicrousd: 0, providerRequestId: null });
function checkRetainedHash(result: LogoVectorProposalObservedResult): void {
 if (!result.retainedOutput.truncated && createHash('sha256').update(Buffer.from(result.retainedOutput.data, 'base64')).digest('hex') !== result.retainedOutput.sha256) throw new Error('Retained output hash changed.');
}

/** One durable text step. Ports are injected contracts, not a database/storage
 * implementation. Recording/staging observed expense never uses AbortSignal. */
export function createLogoVectorProposalHandler(deps: LogoVectorProposalHandlerDependencies): JobHandler {
 return { steps(raw) {
  const job = structuredClone(raw), input = logoVectorProposalJobInputSchema.parse(job.input);
  if (job.operation !== input.operation || job.ownerId !== input.ownerId || job.projectId !== input.projectId || job.reservedCostMicrousd !== input.textPolicy.maximumCostMicrousd || job.actualCostMicrousd !== 0 || job.status !== 'running') throw new Error('Invalid exact proposal job binding.');
  // A repeated invocation of this planned step joins its original attempt. The
  // durable begin-step/recovery boundary remains authoritative across processes.
  let pending: Promise<StepOutcome> | undefined;
  async function execute(claimed: ClaimedJob, signal: AbortSignal): Promise<StepOutcome> {
   let resolved;
   try {
    active(signal); if (!isDeepStrictEqual(job, claimed)) throw new Error('Claim changed.');
    resolved = logoVectorProposalResolvedInputSchema.parse(await deps.loadInput(structuredClone(job), signal)); active(signal);
    if (!isDeepStrictEqual(resolved.input, input)) throw new Error('Frozen job input changed.');
    await deps.assertReady(structuredClone(job), signal); active(signal);
   } catch { return nondispatch(); }
   let observation: LogoVectorProposalProviderObservation = unknownLogoVectorProposalObservation(input.textPolicy);
   let result: LogoVectorProposalObservedResult = { status: 'incomplete', payload: null, reason: 'provider_outcome_unknown', retainedOutput: retainLogoVectorProposalOutput('') };
   try {
    const rawResult = await deps.provider.propose(resolved.context, input.instruction, input.textPolicy, signal, {
     job: structuredClone(job), beforeDispatch: async current => {
      active(signal); if (!isDeepStrictEqual(current, job) || !isDeepStrictEqual(claimed, job)) throw new Error('Dispatch claim changed.');
      await deps.assertReady(structuredClone(job), signal); active(signal);
      if (!isDeepStrictEqual(current, job) || !isDeepStrictEqual(claimed, job)) throw new Error('Dispatch claim changed.');
     },
    });
    // Capture individually valid expense before validating the complete output,
    // so a malformed producer result cannot erase an already known charge.
    if (rawResult?.kind === 'observed') {
     const parsedObservation = logoVectorProposalProviderObservationSchema.safeParse(rawResult.observation);
     if (parsedObservation.success && isDeepStrictEqual(parsedObservation.data.textPolicy, input.textPolicy)) observation = parsedObservation.data;
     const parsedResult = logoVectorProposalObservedResultSchema.safeParse(rawResult.result);
     if (parsedResult.success) result = parsedResult.data;
     else {
      const retained = logoVectorProposalRetainedOutputSchema.safeParse(rawResult.result?.retainedOutput);
      if (retained.success) result = { ...result, retainedOutput: retained.data };
     }
    }
    const produced = logoVectorProposalProviderResultSchema.parse(rawResult);
    if (produced.kind === 'not_dispatched') return nondispatch();
    if (!isDeepStrictEqual(produced.observation.textPolicy, input.textPolicy)) throw new Error('Observed policy changed.');
    observation = produced.observation; result = produced.result; checkRetainedHash(result);
    if (result.status === 'valid') {
     validateLogoVectorProposal(result.payload, resolved.context);
     if (observation.model !== input.textPolicy.model || observation.serviceTier !== input.textPolicy.serviceTier || observation.toolCalls !== 0) throw new Error('Untrusted successful output.');
    }
   } catch {
    // No inference retry. Invalid paid intent remains reconciliation-only. Keep
    // any observed bytes/expense already captured above.
    result = { status: 'incomplete', payload: null, reason: 'provider_outcome_unknown', retainedOutput: result.retainedOutput };
   }
   const common = { costMicrousd: observation.billing.status === 'recorded' ? observation.billing.confirmedMicrousd : 0, providerRequestId: observation.providerRequestId };
   const unpublished = (reason: 'provider_evidence_unconfirmed' | 'publication_unconfirmed'): StepOutcome => ({ status: 'needs_reconciliation', code: reason, ...common,
    result: logoVectorProposalUnpublishedOutputSchema.parse({ version: 1, kind: 'logo_vector_proposal_unpublished', reason, observation, result }) });
   let receipt;
   try {
    receipt = logoVectorProposalProviderReceiptSchema.parse(await deps.recordResponse(structuredClone(job), structuredClone(observation)));
    if (receipt.ownerId !== job.ownerId || receipt.projectId !== job.projectId || receipt.jobId !== job.id || receipt.leaseToken !== job.leaseToken || !isDeepStrictEqual(receipt.observation, observation)) throw new Error('Observed receipt changed.');
   } catch { return unpublished('provider_evidence_unconfirmed'); }
   let output;
   try {
    const prepared = logoVectorProposalPreparedReceiptSchema.parse(await deps.stageProposal(structuredClone(job), structuredClone(result), structuredClone(receipt)));
    if (prepared.ownerId !== job.ownerId || prepared.projectId !== job.projectId || prepared.jobId !== job.id || prepared.leaseToken !== job.leaseToken || prepared.quoteId !== input.quoteId || prepared.inputHash !== input.inputHash || prepared.contextHash !== input.contextHash || prepared.providerResponseReceiptId !== receipt.id) throw new Error('Prepared receipt changed.');
    output = logoVectorProposalStepOutputSchema.parse({ version: 1, kind: 'logo_vector_proposal', preparedId: prepared.id, providerResponseReceiptId: receipt.id });
   } catch { return unpublished('publication_unconfirmed'); }
   const usage = observation.usage;
   if (!observation.responseComplete || !observation.responseId || !observation.responseHash || observation.billing.status === 'unknown' || !usage || usage.inputTokens > input.textPolicy.maxInputTokens || usage.outputTokens > input.textPolicy.maxOutputTokens || common.costMicrousd > input.textPolicy.maximumCostMicrousd || result.status === 'incomplete')
    return { status: 'needs_reconciliation', code: 'provider_evidence_incomplete', result: output, ...common };
   if (result.status !== 'valid') return { status: 'failed', code: result.reason, result: output, ...common };
   return { status: 'succeeded', result: output, ...common };
  }
  return [{ key: 'propose-vector-edit', maximumCostMicrousd: input.textPolicy.maximumCostMicrousd, timeoutMs: input.textPolicy.deadlineMs,
   execute({ job: current, signal }) {
    if (!isDeepStrictEqual(current, job)) return Promise.resolve(nondispatch());
    pending ??= execute(current, signal).then(value => stepOutcomeSchema.parse(value));
    return pending;
   },
  }];
 } };
}
