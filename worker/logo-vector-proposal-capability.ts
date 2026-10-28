import { z } from 'zod';
import { logoHashSchema } from '../src/domain/logo-vector';
import { moneySchema } from '../src/domain/jobs';
import { legacyLogoVectorProposalTextPolicySchema, uncappedLogoVectorProposalTextPolicySchema } from '../src/domain/logo-vector-proposal-jobs';

/** Exact operation-specific descriptor; no storage or subscription authority. */
export const legacyLogoVectorProposalCapabilitySchema = z.strictObject({
 operation: z.literal('identity.logo_vector_propose'), policyIdentity: logoHashSchema,
 handlerVersion: z.literal('logo-vector-propose-v1'), provider: z.literal('openai'), model: z.literal('gpt-6.1-sol'),
 engine: z.null(), maxCostMicrousd: moneySchema, textPolicy: legacyLogoVectorProposalTextPolicySchema,
}).refine(value => value.maxCostMicrousd === value.textPolicy.maximumCostMicrousd, 'Proposal capability must match the independent text policy');
export const uncappedLogoVectorProposalCapabilitySchema=z.strictObject({operation:z.literal('identity.logo_vector_propose'),policyIdentity:logoHashSchema,
 handlerVersion:z.literal('logo-vector-propose-v1'),provider:z.literal('openai'),model:z.literal('gpt-6.1-sol'),engine:z.null(),spendControl:z.literal('uncapped'),textPolicy:uncappedLogoVectorProposalTextPolicySchema});
export const logoVectorProposalCapabilitySchema=z.union([legacyLogoVectorProposalCapabilitySchema,uncappedLogoVectorProposalCapabilitySchema]);
export type LegacyLogoVectorProposalCapability=z.infer<typeof legacyLogoVectorProposalCapabilitySchema>;
export type UncappedLogoVectorProposalCapability=z.infer<typeof uncappedLogoVectorProposalCapabilitySchema>;

export function qualifiedLogoVectorProposalCapability(raw: unknown): Readonly<LegacyLogoVectorProposalCapability> | null {
 const parsed = legacyLogoVectorProposalCapabilitySchema.safeParse(raw);
 return parsed.success ? Object.freeze({ ...parsed.data, textPolicy: Object.freeze(parsed.data.textPolicy) }) : null;
}

export function qualifiedUncappedLogoVectorProposalCapability(raw:unknown):Readonly<UncappedLogoVectorProposalCapability>|null{const parsed=uncappedLogoVectorProposalCapabilitySchema.safeParse(raw);return parsed.success?Object.freeze({...parsed.data,textPolicy:Object.freeze(parsed.data.textPolicy)}):null;}
