import { z } from 'zod';
import { logoHashSchema } from '../src/domain/logo-vector';
import { moneySchema } from '../src/domain/jobs';
import { logoVectorProposalTextPolicySchema } from '../src/domain/logo-vector-proposal-jobs';
import type { LogoVectorProposalCapability } from './logo-vector/proposal-runtime-adapter';

/** Exact operation-specific descriptor; no storage or subscription authority. */
export const logoVectorProposalCapabilitySchema = z.strictObject({
 operation: z.literal('identity.logo_vector_propose'), policyIdentity: logoHashSchema,
 handlerVersion: z.literal('logo-vector-propose-v1'), provider: z.literal('openai'), model: z.literal('gpt-6.1-sol'),
 engine: z.null(), maxCostMicrousd: moneySchema, textPolicy: logoVectorProposalTextPolicySchema,
}).refine(value => value.maxCostMicrousd === value.textPolicy.maximumCostMicrousd, 'Proposal capability must match the independent text policy');

export function qualifiedLogoVectorProposalCapability(raw: unknown): LogoVectorProposalCapability | null {
 const parsed = logoVectorProposalCapabilitySchema.safeParse(raw);
 return parsed.success ? Object.freeze({ ...parsed.data, textPolicy: Object.freeze(parsed.data.textPolicy) }) : null;
}
