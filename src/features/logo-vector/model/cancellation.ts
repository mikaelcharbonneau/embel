import { z } from "zod";
import { applyLogoVectorProposalCommandSchema } from "./proposal-materialization";
import { saveLogoEditInputSchema, logoMutationReceiptSchema } from "../../../domain/logo-workspace";
import { boundedLogoJson, logoScopeShape, logoUuidSchema, logoIssue } from "../../../domain/logo-vector";
import { canonicalIdentityInput } from "../../identity-directions/model/font-check-binding";

/** Manual saves and explicit zero-AI proposal application share the same cancellation fence. */
export const logoVectorEditCommandSchema = boundedLogoJson(z.strictObject({ method: z.literal("saveLogoEdit"), body: saveLogoEditInputSchema }));
export type LogoVectorEditCommand = z.infer<typeof logoVectorEditCommandSchema>;
export const logoVectorCancellableCommandSchema = boundedLogoJson(z.union([logoVectorEditCommandSchema, applyLogoVectorProposalCommandSchema]));
export type LogoVectorCancellableCommand = z.infer<typeof logoVectorCancellableCommandSchema>;
const proof = { ...logoScopeShape, requestKey: logoUuidSchema, command: logoVectorCancellableCommandSchema };
export const logoVectorEditRequestStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({ status: z.literal("cancelled"), ...proof }),
  z.strictObject({ status: z.literal("succeeded"), ...proof, receipt: logoMutationReceiptSchema }),
]).superRefine((state, ctx) => {
  if (state.status === "not_found") return;
  if (state.requestKey !== state.command.body.requestKey) logoIssue(ctx, "Cancellation proof must bind the exact request key");
  if (state.status === "succeeded") {
    const receipt = state.receipt, expected = state.command.body.expected;
    if (receipt.ownerId !== state.ownerId || receipt.projectId !== state.projectId || receipt.requestKey !== state.requestKey ||
      receipt.revision.stage !== "refinements" || receipt.revision.revision !== expected.stageRevisions.refinements + 1 ||
      receipt.workspace.heads.workspaceRevision !== expected.workspaceRevision + 1 ||
      receipt.revision.stage === "refinements" && (receipt.revision.payload.vectorRevisionId === null || receipt.revision.payload.sourceRequestKey !== state.requestKey || state.command.method === "applyLogoVectorProposal" && receipt.revision.payload.approvalId !== null)) {
      logoIssue(ctx, "The immutable success must belong to this exact vector edit");
    }
  }
});
export type LogoVectorEditRequestState = z.infer<typeof logoVectorEditRequestStateSchema>;
/** Structural equality includes every command field, without key-order dependence. */
export function sameLogoVectorEditCommand(a: unknown, b: unknown): boolean {
  const left = logoVectorCancellableCommandSchema.safeParse(a), right = logoVectorCancellableCommandSchema.safeParse(b);
  return left.success && right.success && canonicalIdentityInput(left.data) === canonicalIdentityInput(right.data);
}
