import type { JobDatabase } from "../postgres-store";
import type { SharedSlotLease, SharedExecution } from "../shared-pool/contracts";
import type { SharedPendingExecution } from "../shared-pool/contracts";

export type SharedLaneResult = Readonly<{ disposition: "ack" | "retry"; state: string }>;
export interface SharedLaneEngine {
  run(message?: unknown, signal?: AbortSignal): Promise<SharedLaneResult>;
  recover?(pending:readonly SharedPendingExecution[],signal?:AbortSignal):Promise<SharedLaneResult>;
  renewReadiness?():Promise<void>;
  close(): Promise<void>;
}
export type SharedLaneBase = Readonly<{
  database: JobDatabase;
  slot: () => SharedSlotLease | null;
  deploymentId: string;
  workerId: string;
  provider: Readonly<{ apiKey: string; model: string; modelVerificationReceipt: string }>;
}>;
export type SharedGatewayEnvelope = Readonly<{ execution: SharedExecution | null; result: unknown }>;
