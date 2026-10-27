import { z } from 'zod';
import { moneySchema } from './jobs';
import { logoExpectedHeadsSchema } from './logo-workspace';
import { boundedLogoJson, logoHashSchema as hash, logoUuidSchema as uuid, logoScopeShape as scope, logoTimestampSchema as timestamp, logoInputRevisionsSchema, logoIssue, uniqueLogoValues } from './logo-vector';
import { logoVectorProposalContextSchema, logoVectorProposalPayloadSchema, logoVectorProposalRequestSchema } from './logo-vector-proposals';

export const LOGO_VECTOR_PROPOSE_OPERATION = 'identity.logo_vector_propose' as const;
/** Independent operator-supplied policy. Importing this schema enables nothing. */
export const legacyLogoVectorProposalTextPolicySchema = z.strictObject({
 version: z.literal(1), billingMode: z.literal('openai_api'), handlerVersion: z.literal('logo-vector-propose-v1'),
 adapterVersion: z.literal('logo-vector-propose-api-v1'), schemaVersion: z.literal('logo-vector-proposal-v1'),
 model: z.literal('gpt-6.1-sol'), pricingVersion: z.literal('2026-10-03'), serviceTier: z.literal('default'),
 maxInputTokens: z.number().int().min(1).max(32_768), maxOutputTokens: z.number().int().min(1).max(4_096),
 maxInputBytes: z.number().int().min(1024).max(131_072), maxOutputBytes: z.number().int().min(1024).max(32_768),
 maxStreamBytes: z.number().int().min(1024).max(2_097_152), deadlineMs: z.number().int().min(1000).max(240_000),
 maxTools: z.literal(0), inputMicrousdPerMillionTokens: z.literal(2_000_000), cachedInputMicrousdPerMillionTokens: z.literal(100_000),
 cacheWriteMicrousdPerMillionTokens: z.literal(2_500_000), outputMicrousdPerMillionTokens: z.literal(10_000_000), maximumCostMicrousd: moneySchema,
}).superRefine((p, ctx) => {
 const maximum = Number((BigInt(p.maxInputTokens) * 2_500_000n + BigInt(p.maxOutputTokens) * 10_000_000n + 999_999n) / 1_000_000n);
 if (p.maximumCostMicrousd !== maximum) logoIssue(ctx, 'Cost must be independently derived from the worst permitted token rates');
});
export const uncappedLogoVectorProposalTextPolicySchema = z.strictObject({...legacyLogoVectorProposalTextPolicySchema.shape})
 .omit({maximumCostMicrousd:true}).extend({version:z.literal(2),spendControl:z.literal('uncapped'),adapterVersion:z.literal('logo-vector-propose-api-uncapped-v2')});
export const logoVectorProposalTextPolicySchema=z.union([legacyLogoVectorProposalTextPolicySchema,uncappedLogoVectorProposalTextPolicySchema]);
export type LegacyLogoVectorProposalTextPolicy=z.infer<typeof legacyLogoVectorProposalTextPolicySchema>;
export type LogoVectorProposalTextPolicy = z.infer<typeof logoVectorProposalTextPolicySchema>;
/** Zero is bookkeeping for the separately SQL-authorized uncapped contract. */
export function logoVectorProposalReservation(policy:LogoVectorProposalTextPolicy):number{return policy.version===1?policy.maximumCostMicrousd:0;}
export const logoVectorProposalUsageSchema = z.strictObject({ inputTokens: moneySchema, cachedInputTokens: moneySchema, cacheWriteInputTokens: moneySchema, outputTokens: moneySchema }).refine(u => u.cachedInputTokens + u.cacheWriteInputTokens <= u.inputTokens, 'Input token subcounts exceed total');
export type LogoVectorProposalUsage = z.infer<typeof logoVectorProposalUsageSchema>;
export function logoVectorProposalUsageCost(usage: LogoVectorProposalUsage): number {
 const u = logoVectorProposalUsageSchema.parse(usage);
 const total = BigInt(u.inputTokens - u.cachedInputTokens - u.cacheWriteInputTokens) * 2_000_000n + BigInt(u.cachedInputTokens) * 100_000n + BigInt(u.cacheWriteInputTokens) * 2_500_000n + BigInt(u.outputTokens) * 10_000_000n;
 const value = Number((total + 999_999n) / 1_000_000n); return moneySchema.parse(value);
}
const billing = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('unknown'), confirmedMicrousd: z.null() }), z.strictObject({ status: z.literal('recorded'), confirmedMicrousd: moneySchema })]);
export const logoVectorProposalProviderObservationSchema = boundedLogoJson(z.strictObject({
 version: z.literal(1), kind: z.literal('logo_vector_proposal_text'), provider: z.literal('openai'), model: z.string().min(1).max(150).nullable(),
 responseComplete: z.boolean(), toolCalls: moneySchema.nullable(),
 serviceTier: z.string().min(1).max(100).nullable(), responseId: z.string().min(1).max(200).nullable(), providerRequestId: z.string().min(1).max(200).nullable(),
 responseHash: hash.nullable(), observedAt: timestamp, textPolicy: logoVectorProposalTextPolicySchema,
 usage: logoVectorProposalUsageSchema.nullable(), billing,
}).superRefine((o, ctx) => {
 if (o.billing.status === 'recorded' && (o.usage === null || o.toolCalls !== 0 || o.model !== o.textPolicy.model || o.serviceTier !== o.textPolicy.serviceTier || o.billing.confirmedMicrousd !== logoVectorProposalUsageCost(o.usage))) logoIssue(ctx, 'Recorded usage requires exact model, tier and independent price calculation');
}));
export type LogoVectorProposalProviderObservation = z.infer<typeof logoVectorProposalProviderObservationSchema>;
export const logoVectorProposalProviderReceiptSchema = z.strictObject({ id: uuid, ...scope, jobId: uuid, leaseToken: uuid, observation: logoVectorProposalProviderObservationSchema });
export type LogoVectorProposalProviderReceipt = z.infer<typeof logoVectorProposalProviderReceiptSchema>;
const legacyLogoVectorProposalJobInputSchema = z.strictObject({
 version: z.literal(2), ...scope, operation: z.literal(LOGO_VECTOR_PROPOSE_OPERATION), requestKey: uuid, quoteId: uuid,
 policyIdentity: hash, handlerVersion: z.literal('logo-vector-propose-v1'), inputHash: hash, baseVectorRevisionId: uuid, contextHash: hash,
 instruction: logoVectorProposalRequestSchema.shape.instruction, targetComponentIds: logoVectorProposalRequestSchema.shape.targetComponentIds, textPolicy: legacyLogoVectorProposalTextPolicySchema,
});
export const uncappedLogoVectorProposalJobInputSchema=legacyLogoVectorProposalJobInputSchema.extend({version:z.literal(3),billingMode:z.literal('openai_api'),spendControl:z.literal('uncapped'),textPolicy:uncappedLogoVectorProposalTextPolicySchema});
export const logoVectorProposalJobInputSchema=boundedLogoJson(z.union([legacyLogoVectorProposalJobInputSchema,uncappedLogoVectorProposalJobInputSchema]));
export type LogoVectorProposalJobInput = z.infer<typeof logoVectorProposalJobInputSchema>;
export const logoVectorProposalRecordSchema = boundedLogoJson(z.strictObject({
 version: z.literal(1), id: uuid, ...scope, jobId: uuid, requestKey: uuid, quoteId: uuid, baseVectorRevisionId: uuid, contextHash: hash,
 inputRevisions: logoInputRevisionsSchema, expected: logoExpectedHeadsSchema, context: logoVectorProposalContextSchema,
 state: z.enum(['succeeded', 'failed', 'needs_reconciliation']), payload: logoVectorProposalPayloadSchema.nullable(),
 providerReceipt: logoVectorProposalProviderReceiptSchema.nullable(), actualCostMicrousd: moneySchema, reason: z.string().min(1).max(200).nullable(), createdAt: timestamp,
 // No candidate authority exists until Task 3 independently validates exact artwork.
 materialization: z.literal('unavailable'),
}).superRefine((r, ctx) => {
 if (r.context.ownerId !== r.ownerId || r.context.projectId !== r.projectId || r.context.baseVectorRevisionId !== r.baseVectorRevisionId || JSON.stringify(r.context.inputRevisions) !== JSON.stringify(r.inputRevisions)) logoIssue(ctx, 'Frozen context must bind the exact owned base and input revisions');
 const p = r.providerReceipt;
 if (p && (p.ownerId !== r.ownerId || p.projectId !== r.projectId || p.jobId !== r.jobId)) logoIssue(ctx, 'Provider receipt must bind the owned job');
 if (p?.observation.billing.status === 'recorded' && r.actualCostMicrousd !== p.observation.billing.confirmedMicrousd) logoIssue(ctx, 'Retained evidence cannot erase or substitute a known provider charge');
 if (r.state === 'succeeded' && (!r.payload || !p || !p.observation.responseComplete || p.observation.billing.status !== 'recorded' || !p.observation.responseId || !p.observation.responseHash || r.actualCostMicrousd !== p.observation.billing.confirmedMicrousd || r.reason !== null)) logoIssue(ctx, 'Success requires complete retained payload, identity and settled billing');
 if (r.state === 'succeeded' && p && (p.observation.textPolicy.version===1&&r.actualCostMicrousd > p.observation.textPolicy.maximumCostMicrousd || p.observation.usage === null || p.observation.usage.inputTokens > p.observation.textPolicy.maxInputTokens || p.observation.usage.outputTokens > p.observation.textPolicy.maxOutputTokens)) logoIssue(ctx, 'Over-budget or over-limit results remain pending reconciliation');
 if (r.state === 'needs_reconciliation' && r.reason === null) logoIssue(ctx, 'Uncertain results retain their reason');
}), 131_072);
export type LogoVectorProposalRecord = z.infer<typeof logoVectorProposalRecordSchema>;
export const logoVectorProposalPageSchema = boundedLogoJson(z.strictObject({ ...scope, items: z.array(z.strictObject({ id: uuid, jobId: uuid, requestKey: uuid, baseVectorRevisionId: uuid, state: z.enum(['succeeded', 'failed', 'needs_reconciliation']), createdAt: timestamp })).max(50), nextCursor: z.string().min(1).max(2048).nullable() }).refine(p => uniqueLogoValues(p.items.map(r => r.id)) && uniqueLogoValues(p.items.map(r => r.jobId)), 'Proposal summaries must be unique'), 32_768);
export type LogoVectorProposalPage = z.infer<typeof logoVectorProposalPageSchema>;
