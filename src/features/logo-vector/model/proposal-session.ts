import { z } from "zod";
import { logoCostQuoteSchema, logoGenerationIntentSchema, logoRequestStateSchema } from "@/domain/logo-jobs";
import { logoVectorProposalRecordSchema } from "@/domain/logo-vector-proposal-jobs";
import { logoScopeShape, logoUuidSchema, logoIdentifierSchema } from "@/domain/logo-vector";
import { applyLogoVectorProposalInputSchema } from "./proposal-materialization";
import { canonicalIdentityInput } from "@/features/identity-directions/model/font-check-binding";
const same = (a: unknown, b: unknown) => canonicalIdentityInput(a) === canonicalIdentityInput(b);

/** A read of the original request is never proof that no late admission exists. */
export const logoVectorProposalRequestStateSchema = z.strictObject({ ...logoScopeShape, input: logoGenerationIntentSchema,
  state: logoRequestStateSchema, proposal: logoVectorProposalRecordSchema.nullable() }).superRefine((v, ctx) => {
  const issue = () => ctx.addIssue({ code: "custom", message: "Proposal recovery must retain the exact owned paid request and result." });
  if (v.state.status !== "not_found" && v.state.requestKey !== v.input.requestKey) issue();
  const receipt = v.state.status === "not_found" ? null : v.state.receipt;
  if (receipt && (!("jobIds" in receipt) || receipt.ownerId !== v.ownerId || receipt.projectId !== v.projectId || receipt.operation !== "identity.logo_vector_propose" || receipt.jobIds.length !== 1)) issue();
  const p = v.proposal;
  const policy = p?.providerReceipt?.observation.textPolicy;
  if (policy && (policy.version === 2 ? "acceptedMaxCostMicrousd" in v.input : !("acceptedMaxCostMicrousd" in v.input) || v.input.acceptedMaxCostMicrousd < policy.maximumCostMicrousd)) issue();
  if (v.state.status !== "not_found" && v.state.outputs.length) issue();
  if (p && (!receipt || !("jobIds" in receipt) || p.ownerId !== v.ownerId || p.projectId !== v.projectId || p.requestKey !== v.input.requestKey || p.quoteId !== v.input.quoteId
    || !same(p.expected, v.input.expected) || p.jobId !== receipt.jobIds[0])) issue();
});
export type LogoVectorProposalRequestState = z.infer<typeof logoVectorProposalRequestStateSchema>;
export const logoVectorProposalRequestCloseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_admitted"), ...logoScopeShape, input: logoGenerationIntentSchema }),
  z.strictObject({ status: z.literal("admitted"), request: logoVectorProposalRequestStateSchema }).refine(v => v.request.state.status !== "not_found" && Boolean(v.request.state.receipt && "jobIds" in v.request.state.receipt), "Admitted closure requires the actual saved request."),
]);
export type LogoVectorProposalRequestClose = z.infer<typeof logoVectorProposalRequestCloseSchema>;
export const logoVectorProposalRequestPageSchema = z.strictObject({ ...logoScopeShape, items: z.array(logoVectorProposalRequestStateSchema).max(10), nextCursor: logoUuidSchema.nullable() })
  .refine(v => v.items.every(item => item.ownerId === v.ownerId && item.projectId === v.projectId) && new Set(v.items.map(item => item.input.requestKey)).size === v.items.length
    && (v.nextCursor === null || v.items.length > 0 && v.items.at(-1)!.input.requestKey === v.nextCursor), "Pending requests must retain unique owned keys and an exact continuation.");
export type LogoVectorProposalRequestPage = z.infer<typeof logoVectorProposalRequestPageSchema>;

export const logoVectorProposalSessionSchema = z.strictObject({
  baseVectorRevisionId: logoUuidSchema, instruction: z.string().max(4000), targetComponentIds: z.array(logoIdentifierSchema).min(1).max(64).refine(v => new Set(v).size === v.length), dirty: z.boolean(),
  pendingGeneration: z.strictObject({ quote: logoCostQuoteSchema, input: logoGenerationIntentSchema }).nullable(),
  pendingApplication: applyLogoVectorProposalInputSchema.nullable(), selectedProposalId: logoUuidSchema.nullable(),
}).superRefine((v, ctx) => {
  const pending = v.pendingGeneration;
  if (pending && (pending.quote.request.operation !== "propose_vector_edit" || pending.quote.request.baseVectorRevisionId !== v.baseVectorRevisionId
    || pending.quote.id !== pending.input.quoteId || !same(pending.quote.expected, pending.input.expected)
    || ("spendControl" in pending.quote ? "acceptedMaxCostMicrousd" in pending.input : !("acceptedMaxCostMicrousd" in pending.input) || pending.input.acceptedMaxCostMicrousd < pending.quote.maxCostMicrousd))) ctx.addIssue({ code: "custom", message: "Retain the exact proposal quote and accepted legacy or uncapped contract." });
  if (v.pendingApplication && (v.pendingApplication.baseVectorRevisionId !== v.baseVectorRevisionId || v.pendingApplication.proposalId !== v.selectedProposalId)) ctx.addIssue({ code: "custom", message: "Application must retain its exact selected proposal and vector." });
});
export type LogoVectorProposalSession = z.infer<typeof logoVectorProposalSessionSchema>;
export const proposalSessionUnsaved = (v: LogoVectorProposalSession | null) => Boolean(v && (v.dirty || v.pendingGeneration || v.pendingApplication));
