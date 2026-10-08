import { z } from "zod";
import { standalonePromotionSourceSchema } from "@/domain/standalone-promotion";
import { logoUuidSchema, logoRevisionSchema, boundedLogoJson } from "@/domain/logo-vector";
import { domainDraftSchema } from "@/features/domain-workspace/draft";
import { handlesDraftSchema } from "@/features/handles-workspace/account-codec";
import { trademarkAccountDraftSchema } from "@/features/trademark-workspace/account-codec";

/** Closed, manual-only codecs. Provider observations cannot enter this reader. */
export const frozenStandalonePayloadSchema = z.discriminatedUnion("tool", [
 z.strictObject({ tool: z.literal("domains"), data: domainDraftSchema }),
 z.strictObject({ tool: z.literal("handles"), data: handlesDraftSchema }),
 z.strictObject({ tool: z.literal("trademarks"), data: trademarkAccountDraftSchema }),
]);
export const standalonePromotionSnapshotResponseSchema = boundedLogoJson(z.strictObject({
 ownerId: logoUuidSchema, projectId: logoUuidSchema,
 source: standalonePromotionSourceSchema.nullable(),
 snapshot: z.strictObject({ workspaceId: logoUuidSchema, workspaceRevision: logoRevisionSchema, payload: frozenStandalonePayloadSchema }).nullable(),
}).superRefine((value, ctx) => {
 const { source, snapshot } = value;
 if (!source || !snapshot) { if (source !== null || snapshot !== null) ctx.addIssue({ code: "custom", message: "A saved origin requires its immutable snapshot" }); return; }
 if (source.ownerId !== value.ownerId || snapshot.workspaceId !== source.workspaceId || snapshot.workspaceRevision !== source.workspaceRevision || snapshot.payload.tool !== source.selection.tool) ctx.addIssue({ code: "custom", message: "Snapshot must match the exact owned promotion source" });
 if (source.selection.tool === "domains" && snapshot.payload.tool === "domains" && !snapshot.payload.data.candidates.includes(source.selection.domain)) ctx.addIssue({ code: "custom", message: "Selected domain must occur in the frozen draft" });
 if (source.selection.tool === "handles" && snapshot.payload.tool === "handles") {
  const selectedId = source.selection.bundleId;
  if (!snapshot.payload.data.bundles.some(bundle => bundle.id === selectedId)) ctx.addIssue({ code: "custom", message: "Selected handle bundle must occur in the frozen draft" });
 }
 if (snapshot.payload.tool === "trademarks" && !snapshot.payload.data.markName.trim()) ctx.addIssue({ code: "custom", message: "Promoted trademark input requires its saved mark name" });
}), 262_144);
export type StandalonePromotionSnapshotResponse = z.infer<typeof standalonePromotionSnapshotResponseSchema>;
