import { z } from "zod";
import { logoTimestampSchema, logoUuidSchema } from "./logo-vector";

/** Ephemeral UI hints only. Never store in workspace/history/receipt JSON. */
export const LOGO_CAPABILITIES_MAX_AGE_MS = 30_000;
const status = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unavailable") }),
  z.strictObject({ status: z.literal("available"), expiresAt: logoTimestampSchema }),
]);
export const logoCapabilitiesSchema = z
  .strictObject({
    ownerId: logoUuidSchema,
    projectId: logoUuidSchema,
    observedAt: logoTimestampSchema,
    operations: z.strictObject({
      "identity.logo_concept": status,
      "identity.logo_refine": status,
      "identity.logo_vectorize": status,
      "identity.logo_directions": status,
      "identity.logo_export": status,
      // Historical five-operation responses remain readable; only exact current readiness may enable this lane.
      "identity.logo_vector_propose": status.optional(),
      // Liked-upload style notes; earlier responses without it remain readable.
      "identity.logo_style_note": status.optional(),
    }),
  })
  .superRefine((value, context) => {
    const observed = Date.parse(value.observedAt);
    for (const [operation, readiness] of Object.entries(value.operations)) {
      if (!readiness || readiness.status !== "available") continue;
      const lifetime = Date.parse(readiness.expiresAt) - observed;
      if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > LOGO_CAPABILITIES_MAX_AGE_MS) {
        context.addIssue({
          code: "custom",
          path: ["operations", operation, "expiresAt"],
          message: "Readiness must expire within the observed thirty-second window.",
        });
      }
    }
  });
export type LogoCapabilities = z.infer<typeof logoCapabilitiesSchema>;
