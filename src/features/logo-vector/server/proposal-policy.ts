import 'server-only';
import { z } from 'zod';
import { LOGO_VECTOR_PROPOSE_OPERATION, logoVectorProposalTextPolicySchema } from '../../../domain/logo-vector-proposal-jobs';

/** Versioned local request contract. Any prompt/mode/accounting change requires
 * a new adapter identity and requalification; this is not live model approval. */
export const LOGO_VECTOR_PROPOSAL_REQUEST_MODE = 'json_object' as const;
export const LOGO_VECTOR_PROPOSAL_HANDLER_VERSION = 'logo-vector-propose-v1' as const;
export const LOGO_VECTOR_PROPOSAL_ADAPTER_VERSION = 'logo-vector-propose-api-v1' as const;
/** Existing calculateStrategyCost changes rates above this observed input size.
 * This new standard-only card never estimates that unqualified price. */
export const LOGO_VECTOR_PROPOSAL_STANDARD_RATE_INPUT_LIMIT = 272_000;
export const logoVectorProposalConfigurationSchema = z.strictObject({
 operation: z.literal(LOGO_VECTOR_PROPOSE_OPERATION), paidCallsApproved: z.literal(true),
 textPolicy: logoVectorProposalTextPolicySchema,
});
export type LogoVectorProposalConfiguration = z.infer<typeof logoVectorProposalConfigurationSchema>;

/** No environment lookup, inherited text/image policy, default route or I/O. */
export function resolveLogoVectorProposalConfiguration(raw: unknown): LogoVectorProposalConfiguration | null {
 const result = logoVectorProposalConfigurationSchema.safeParse(raw);
 return result.success ? Object.freeze({ ...result.data, textPolicy: Object.freeze(result.data.textPolicy) }) : null;
}
