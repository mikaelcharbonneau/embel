import { z } from "zod";
import { jobStatusSchema } from "./jobs";
import { strategyOperationSchema } from "./strategy-jobs";

export const apiTextIdentitySchema = z.string().regex(/^[0-9a-f]{64}$/);
export const apiTextDeploymentSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
/** Durable identifiers only. Queue and publisher payloads never include a prompt or owner. */
export const apiTextDispatchMessageSchema = z.strictObject({
  version: z.literal(1), jobId: z.uuid(), policyIdentity: apiTextIdentitySchema,
  deploymentId: apiTextDeploymentSchema, dispatchIdentity: apiTextIdentitySchema,
});
export type ApiTextDispatchMessage = z.infer<typeof apiTextDispatchMessageSchema>;
export const apiTextDispatchDescriptorSchema = apiTextDispatchMessageSchema.extend({
  operation: strategyOperationSchema, state: jobStatusSchema, retryable: z.boolean(),
  publicationGeneration: z.number().int().nonnegative().max(2_147_483_647),
  publishedMessageId: z.string().min(1).max(300).nullable(), publishedAt: z.string().min(1).max(100).nullable(),
});
export type ApiTextDispatchDescriptor = z.infer<typeof apiTextDispatchDescriptorSchema>;
export function apiTextDispatchMessage(descriptor: ApiTextDispatchDescriptor): ApiTextDispatchMessage {
  const { version, jobId, policyIdentity, deploymentId, dispatchIdentity } = descriptor;
  return { version, jobId, policyIdentity, deploymentId, dispatchIdentity };
}
