import { saveLogoBriefInputSchema, type LogoMutationReceipt } from "@/domain/logo-workspace";
import { z } from "zod";
import { logoHashSchema, logoUuidSchema } from "@/domain/logo-vector";

/** Same immutable manual command/receipt as a brief save. Initialization has an
 * explicit endpoint and a database-enforced zero-brief precondition. */
export const initializeExistingBrandLogoInputSchema = saveLogoBriefInputSchema;
export type InitializeExistingBrandLogoInput = z.infer<typeof initializeExistingBrandLogoInputSchema>;
export const logoInitializationRejectionSchema = z.strictObject({ status: z.literal("rejected"), ownerId: logoUuidSchema,
  projectId: logoUuidSchema, requestKey: logoUuidSchema, inputHash: logoHashSchema });
export type LogoInitializationRejection = z.infer<typeof logoInitializationRejectionSchema>;
/** Schema order gives client/server one deterministic serialization for proof. */
export const serializeLogoInitialization = (input: InitializeExistingBrandLogoInput): string => JSON.stringify(initializeExistingBrandLogoInputSchema.parse(input));

export function isExistingBrandLogoReceipt(receipt: LogoMutationReceipt, input: InitializeExistingBrandLogoInput): boolean {
  if (input.expected.stageRevisions.brief_references !== 0 || receipt.requestKey !== input.requestKey
    || receipt.revision.stage !== "brief_references" || receipt.revision.revision !== 1 || receipt.revision.parentRevisionId !== null
    || receipt.revision.payload.sourceProjectRevision !== input.expected.projectRevision) return false;
  const expected = input.expected, actual = receipt.workspace.heads;
  if (actual.projectRevision !== expected.projectRevision || actual.referenceRevision !== expected.referenceRevision
    || actual.preferencesRevision !== expected.preferencesRevision || actual.workspaceRevision !== expected.workspaceRevision + 1
    || Object.entries(expected.stageRevisions).some(([stage, revision]) => actual.stageRevisions[stage as keyof typeof expected.stageRevisions] !== revision + (stage === "brief_references" ? 1 : 0))) return false;
  const payload = receipt.revision.payload;
  return payload.name === input.brief.name && payload.activity === input.brief.activity && payload.audience === input.brief.audience
    && payload.personality === input.brief.personality && JSON.stringify(payload.logoTypes) === JSON.stringify(input.brief.logoTypes);
}
