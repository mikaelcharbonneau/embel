// Test-only copies of the retired shared worker's lease, execution and claimed-job shapes.
// Database tests use them to stand in for the old worker when they set up saved data it made.
import { z } from "zod";
import { jobStatusSchema, moneySchema, type ClaimedJob } from "../../src/domain/jobs";

export const sharedLaneSchema=z.enum(["strategy","naming","logo"]);
export type SharedLane=z.infer<typeof sharedLaneSchema>;
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const oid=z.number().int().min(1).max(4_294_967_295);
export const sharedSlotLeaseSchema=z.strictObject({version:z.literal(1),slotId:z.uuid(),instanceId:z.uuid(),lane:sharedLaneSchema,
 generation:positive,leaseToken:z.uuid(),expiresAt:z.iso.datetime({offset:true}),roleName:z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u),roleOid:oid});
export type SharedSlotLease=z.infer<typeof sharedSlotLeaseSchema>;
export const sharedExecutionSchema=z.strictObject({version:z.literal(1),executionId:z.uuid(),executionToken:z.uuid(),slotId:z.uuid(),instanceId:z.uuid(),generation:positive,
 lane:sharedLaneSchema,ownerId:z.uuid(),projectId:z.uuid(),jobId:z.uuid(),leaseToken:z.uuid(),operation:z.string().min(1).max(100),
 policyIdentity:z.string().regex(/^[a-f0-9]{64}$/u),deploymentId:z.string().min(1).max(200)});
export type SharedExecution=z.infer<typeof sharedExecutionSchema>;


const databaseMoney = z.preprocess(value => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value, moneySchema);
const claimedRowSchema = z.object({
  id: z.uuid(), owner_id: z.uuid(), project_id: z.uuid(), operation: z.string().min(1),
  input: z.json(), input_revision: z.number().int().positive(), lease_token: z.uuid(),
  state: jobStatusSchema, reserved_cost_microusd: databaseMoney, actual_cost_microusd: databaseMoney,
});

export function parseClaimedJob(row: unknown): ClaimedJob {
  const data = claimedRowSchema.parse(row);
  return { id: data.id, ownerId: data.owner_id, projectId: data.project_id, operation: data.operation,
    input: data.input, inputRevision: data.input_revision, leaseToken: data.lease_token,
    status: data.state, reservedCostMicrousd: data.reserved_cost_microusd, actualCostMicrousd: data.actual_cost_microusd };
}
