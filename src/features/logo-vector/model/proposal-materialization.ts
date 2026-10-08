import { z } from 'zod';
import { logoExpectedHeadsSchema, logoManualCommandSchema } from '@/domain/logo-workspace';
import { logoVectorProposalRecordSchema } from '@/domain/logo-vector-proposal-jobs';
import { boundedLogoJson, logoUuidSchema, logoScopeShape, logoTimestampSchema, logoIssue } from '@/domain/logo-vector';

/** Explicit zero-AI application. The client cannot supply an edit or producer evidence. */
export const applyLogoVectorProposalInputSchema = boundedLogoJson(z.strictObject({
 requestKey: logoUuidSchema, expected: logoExpectedHeadsSchema, baseVectorRevisionId: logoUuidSchema, proposalId: logoUuidSchema,
}));
export type ApplyLogoVectorProposalInput = z.infer<typeof applyLogoVectorProposalInputSchema>;
export const applyLogoVectorProposalCommandSchema = boundedLogoJson(z.strictObject({ method: z.literal('applyLogoVectorProposal'), body: applyLogoVectorProposalInputSchema }));
export type ApplyLogoVectorProposalCommand = z.infer<typeof applyLogoVectorProposalCommandSchema>;
/** Additive trusted boundary; historical manual/domain contracts stay readable unchanged. */
export const logoTrustedCommandSchema = z.union([logoManualCommandSchema, applyLogoVectorProposalCommandSchema]);
export type LogoTrustedCommand = z.infer<typeof logoTrustedCommandSchema>;
export const logoVectorProposalMaterializationSchema = z.strictObject({
 version: z.literal(1), ...logoScopeShape, proposalId: logoUuidSchema, requestKey: logoUuidSchema,
 vectorRevisionId: logoUuidSchema, revisionId: logoUuidSchema, createdAt: logoTimestampSchema,
});
export type LogoVectorProposalMaterialization = z.infer<typeof logoVectorProposalMaterializationSchema>;
/** Read-only current eligibility is independently recomputed by SQL. It never rewrites the retained result. */
export const logoVectorProposalApplicationSchema = boundedLogoJson(z.strictObject({
 proposal: logoVectorProposalRecordSchema, preparedId: logoUuidSchema.nullable(), providerResponseReceiptId: logoUuidSchema.nullable(),
 materialization: logoVectorProposalMaterializationSchema.nullable(), eligible: z.boolean(),
}).superRefine((value, ctx) => {
 const p = value.proposal, m = value.materialization;
 if (m && (m.ownerId !== p.ownerId || m.projectId !== p.projectId || m.proposalId !== p.id)) logoIssue(ctx, 'Materialization must bind the exact owned proposal');
 if (value.eligible && (m !== null || value.preparedId !== p.id || value.providerResponseReceiptId !== p.providerReceipt?.id ||
  p.state !== 'succeeded' || p.payload?.status !== 'proposed' || p.providerReceipt?.observation.billing.status !== 'recorded')) logoIssue(ctx, 'Applicable output needs original prepared and settled provider evidence');
}), 163_840);
export type LogoVectorProposalApplication = z.infer<typeof logoVectorProposalApplicationSchema>;
