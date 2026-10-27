import { z } from "zod";

export const enrollmentCapabilities = ["home_attachments", "identity_transactions", "strategy", "naming", "logo"] as const;
export const enrollmentCapabilitySchema = z.enum(enrollmentCapabilities);
export type EnrollmentCapability = z.infer<typeof enrollmentCapabilitySchema>;
export const enrollmentStatusSchema = z.strictObject({
  ownerId: z.uuid(), generation: z.number().int().positive(), status: z.enum(["pending", "ready", "unavailable"]),
  capabilities: z.strictObject({ home_attachments: z.boolean(), identity_transactions: z.boolean(), strategy: z.boolean(), naming: z.boolean(), logo: z.boolean() }),
  updatedAt: z.iso.datetime({ offset: true }),
}).refine(value => value.status !== "ready" || enrollmentCapabilities.every(capability => value.capabilities[capability]), "Ready requires every capability");
export type EnrollmentStatus = z.infer<typeof enrollmentStatusSchema>;
export const ensureAccountEnrollmentSchema = z.strictObject({});
export const accountEnrollmentResponseSchema = z.strictObject({ enrollment: enrollmentStatusSchema.nullable() });
