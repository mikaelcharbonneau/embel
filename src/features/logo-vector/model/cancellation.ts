import { z } from "zod";
import { saveLogoEditInputSchema, logoMutationReceiptSchema } from "../../../domain/logo-workspace";
import { boundedLogoJson, logoScopeShape, logoUuidSchema, logoIssue } from "../../../domain/logo-vector";
import { canonicalIdentityInput } from "../../identity-directions/model/font-check-binding";

/** Vector-edit-only contract. Generic manual request states remain unchanged. */
export const logoVectorEditCommandSchema = boundedLogoJson(z.strictObject({ method: z.literal("saveLogoEdit"), body: saveLogoEditInputSchema }));
export type LogoVectorEditCommand = z.infer<typeof logoVectorEditCommandSchema>;
const proof = { ...logoScopeShape, requestKey: logoUuidSchema, command: logoVectorEditCommandSchema };
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
      receipt.revision.stage === "refinements" && (receipt.revision.payload.vectorRevisionId === null || receipt.revision.payload.sourceRequestKey !== state.requestKey)) {
      logoIssue(ctx, "The immutable success must belong to this exact vector edit");
    }
  }
});
export type LogoVectorEditRequestState = z.infer<typeof logoVectorEditRequestStateSchema>;
/** Structural equality includes every command field, without key-order dependence. */
export function sameLogoVectorEditCommand(a: unknown, b: unknown): boolean {
  const left = logoVectorEditCommandSchema.safeParse(a), right = logoVectorEditCommandSchema.safeParse(b);
  return left.success && right.success && canonicalIdentityInput(left.data) === canonicalIdentityInput(right.data);
}
