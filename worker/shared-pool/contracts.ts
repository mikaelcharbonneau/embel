import { z } from "zod";

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
export const sharedPendingExecutionSchema=z.strictObject({execution:sharedExecutionSchema,job:z.record(z.string(),z.unknown()),mode:z.enum(["active","observe"])});
export type SharedPendingExecution=z.infer<typeof sharedPendingExecutionSchema>;
export const sharedPendingPageSchema=z.strictObject({version:z.literal(1),items:z.array(sharedPendingExecutionSchema).max(25),nextCursor:z.uuid().nullable()});
export type SharedDeliveryResult=Readonly<{disposition:"ack"|"retry";state:string}>;
/** SQL, not this return value, proves a durable receipt or terminal execution. */
export interface SharedLaneEngine {
 run(message?:unknown,signal?:AbortSignal):Promise<SharedDeliveryResult>;
 recover?(pending:readonly SharedPendingExecution[],signal?:AbortSignal):Promise<SharedDeliveryResult>;
 renewReadiness?():Promise<void>;
 close():Promise<void>;
}
export interface SharedSlotDatabase {query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>;}
