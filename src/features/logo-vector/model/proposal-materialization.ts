import { z } from "zod";
import { logoExpectedHeadsSchema, logoManualCommandSchema } from "@/domain/logo-workspace";
import { boundedLogoJson, logoUuidSchema } from "@/domain/logo-vector";

/** Explicit zero-AI application. The client cannot supply an edit or producer evidence. */
const applyLogoVectorProposalInputSchema = boundedLogoJson(
  z.strictObject({
    requestKey: logoUuidSchema,
    expected: logoExpectedHeadsSchema,
    baseVectorRevisionId: logoUuidSchema,
    proposalId: logoUuidSchema,
  }),
);
const applyLogoVectorProposalCommandSchema = boundedLogoJson(
  z.strictObject({ method: z.literal("applyLogoVectorProposal"), body: applyLogoVectorProposalInputSchema }),
);
/** Additive trusted boundary; historical manual/domain contracts stay readable unchanged. */
export const logoTrustedCommandSchema = z.union([logoManualCommandSchema, applyLogoVectorProposalCommandSchema]);
export type LogoTrustedCommand = z.infer<typeof logoTrustedCommandSchema>;
