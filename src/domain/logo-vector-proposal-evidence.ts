import { z } from 'zod';
import { type ClaimedJob, moneySchema } from './jobs';
import { boundedLogoJson, logoHashSchema, logoUuidSchema, logoScopeShape, logoStringSchema, logoIssue } from './logo-vector';
import { logoVectorProposalContextSchema, logoVectorProposalPayloadSchema } from './logo-vector-proposals';
import { logoVectorProposalJobInputSchema, logoVectorProposalProviderObservationSchema, logoVectorProposalProviderReceiptSchema, type LogoVectorProposalProviderObservation, type LogoVectorProposalProviderReceipt } from './logo-vector-proposal-jobs';

export const LOGO_VECTOR_PROPOSAL_RETAINED_BYTES = 32_768;
/** Exact observed output bytes, safely encodable even when UTF-8/JSON is invalid.
 * byteLength/hash refer to all observed output bytes before retention truncation.
 * A truncated prefix never claims the provider's unseen eventual output length.
 * Trusted persistence additionally verifies SHA-256 when complete bytes exist. */
export const logoVectorProposalRetainedOutputSchema = boundedLogoJson(z.strictObject({
 encoding: z.literal('base64'), data: z.string().max(Math.ceil(LOGO_VECTOR_PROPOSAL_RETAINED_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
 sha256: logoHashSchema, byteLength: moneySchema, truncated: z.boolean(),
}).superRefine((value, ctx) => {
 let decoded: string;
 try { decoded = atob(value.data); if (btoa(decoded) !== value.data) throw Error('Noncanonical base64'); }
 catch { logoIssue(ctx, 'Retained output requires canonical base64'); return; }
 if (decoded.length > LOGO_VECTOR_PROPOSAL_RETAINED_BYTES || (value.truncated ? value.byteLength <= decoded.length : value.byteLength !== decoded.length)) logoIssue(ctx, 'Retained output length/truncation must be exact');
}), 48_000);
export type LogoVectorProposalRetainedOutput = z.infer<typeof logoVectorProposalRetainedOutputSchema>;
const invalidReason = z.enum(['provider_refusal', 'invalid_output', 'output_too_large', 'incomplete_output', 'provider_outcome_unknown', 'model_mismatch', 'service_tier_mismatch', 'unexpected_tools']);
export const logoVectorProposalObservedResultSchema = boundedLogoJson(z.discriminatedUnion('status', [
 z.strictObject({ status: z.literal('valid'), payload: logoVectorProposalPayloadSchema, reason: z.null(), retainedOutput: logoVectorProposalRetainedOutputSchema }),
 z.strictObject({ status: z.enum(['invalid', 'incomplete', 'refused']), payload: z.null(), reason: invalidReason, retainedOutput: logoVectorProposalRetainedOutputSchema }),
]).superRefine((value, ctx) => {
 if (value.status !== 'valid') return;
 if (value.retainedOutput.truncated) { logoIssue(ctx, 'Truncated output cannot be validated proposal intent'); return; }
 try {
  const bytes = Uint8Array.from(atob(value.retainedOutput.data), character => character.charCodeAt(0));
  const parsed = logoVectorProposalPayloadSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (JSON.stringify(parsed) !== JSON.stringify(value.payload)) logoIssue(ctx, 'Validated payload must exactly match retained observed JSON');
 } catch { logoIssue(ctx, 'Validated payload requires the complete valid observed JSON'); }
}), 98_304);
export type LogoVectorProposalObservedResult = z.infer<typeof logoVectorProposalObservedResultSchema>;
/** not_dispatched requires positive proof that inference was never invoked.
 * An HTTP/provider refusal or broken response is not that proof. */
export const logoVectorProposalProviderResultSchema = boundedLogoJson(z.discriminatedUnion('kind', [
 z.strictObject({ kind: z.literal('not_dispatched'), reason: logoStringSchema.min(1).max(200) }),
 z.strictObject({ kind: z.literal('observed'), observation: logoVectorProposalProviderObservationSchema, result: logoVectorProposalObservedResultSchema }),
]).superRefine((value, ctx) => {
 if (value.kind === 'observed' && value.result.status === 'valid' && (!value.observation.responseComplete || value.result.retainedOutput.byteLength > value.observation.textPolicy.maxOutputBytes)) logoIssue(ctx, 'Validated intent requires completed response identity and the exact output-byte policy');
}), 131_072);
export type LogoVectorProposalProviderResult = z.infer<typeof logoVectorProposalProviderResultSchema>;
export const logoVectorProposalResolvedInputSchema = boundedLogoJson(z.strictObject({ input: logoVectorProposalJobInputSchema, context: logoVectorProposalContextSchema }).superRefine((v, ctx) => {
 if (v.input.ownerId !== v.context.ownerId || v.input.projectId !== v.context.projectId || v.input.baseVectorRevisionId !== v.context.baseVectorRevisionId || JSON.stringify(v.input.targetComponentIds) !== JSON.stringify(v.context.targetComponentIds)) logoIssue(ctx, 'Leased input and frozen context must bind the same owned source/targets');
}), 98_304);
export type LogoVectorProposalResolvedInput = z.infer<typeof logoVectorProposalResolvedInputSchema>;
/** A prepared-evidence acknowledgment, never committed artwork or applicability. */
export const logoVectorProposalPreparedReceiptSchema = z.strictObject({
 version: z.literal(1), kind: z.literal('logo_vector_proposal_prepared'), id: logoUuidSchema, ...logoScopeShape,
 jobId: logoUuidSchema, leaseToken: logoUuidSchema, quoteId: logoUuidSchema, inputHash: logoHashSchema, contextHash: logoHashSchema,
 providerResponseReceiptId: logoUuidSchema,
});
export type LogoVectorProposalPreparedReceipt = z.infer<typeof logoVectorProposalPreparedReceiptSchema>;
export const logoVectorProposalStepOutputSchema = z.strictObject({ version: z.literal(1), kind: z.literal('logo_vector_proposal'), preparedId: logoUuidSchema, providerResponseReceiptId: logoUuidSchema });
export type LogoVectorProposalStepOutput = z.infer<typeof logoVectorProposalStepOutputSchema>;
/** When persistence acknowledgement is uncertain, retain exact typed evidence;
 * completion must keep this reconciliation-only, never promote it to a candidate. */
export const logoVectorProposalUnpublishedOutputSchema = boundedLogoJson(z.strictObject({
 version: z.literal(1), kind: z.literal('logo_vector_proposal_unpublished'),
 reason: z.enum(['provider_evidence_unconfirmed', 'publication_unconfirmed']),
 observation: logoVectorProposalProviderObservationSchema, result: logoVectorProposalObservedResultSchema,
}), 131_072);
export type LogoVectorProposalUnpublishedOutput = z.infer<typeof logoVectorProposalUnpublishedOutputSchema>;

/** Disconnected port contract. No implementation, DB grant or host registration.
 * Observe/stage intentionally have no AbortSignal: an already observed expense
 * must still be retained after cancellation or stopping admission. Actual lease,
 * ownership and original dispatch authority are checked by the SQL/DAL. */
export interface LogoVectorProposalWorkerPorts {
 loadInput(job: ClaimedJob, signal: AbortSignal): Promise<LogoVectorProposalResolvedInput>;
 assertReady(job: ClaimedJob, signal: AbortSignal): Promise<void>;
 recordResponse(job: ClaimedJob, observation: LogoVectorProposalProviderObservation): Promise<LogoVectorProposalProviderReceipt>;
 stageProposal(job: ClaimedJob, result: LogoVectorProposalObservedResult, receipt: LogoVectorProposalProviderReceipt): Promise<LogoVectorProposalPreparedReceipt>;
}
// Re-export the exact receipt validator so port consumers need no alternate envelope.
export { logoVectorProposalProviderReceiptSchema };
