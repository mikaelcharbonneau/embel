import { z } from "zod";
import { jobStatusSchema, type ClaimedJob, type StepOutcome } from "../src/domain/jobs";
import { apiTextDispatchDescriptorSchema, type ApiTextDispatchDescriptor, type ApiTextDispatchMessage } from "../src/domain/api-text-dispatch";
import { PostgresJobStore, parseClaimedJob, type JobDatabase } from "./postgres-store";
import type { JobStore, PlannedStep } from "./runner";

const dispositionSchema = z.object({
  disposition: z.enum(["claimed", "available", "busy", "terminal", "unavailable", "not_found"]),
  state: z.union([jobStatusSchema, z.literal("not_found"), z.literal("unavailable")]), job: z.unknown().optional(),
});
export type ApiTextClaimDisposition = z.infer<typeof dispositionSchema>;

/** Never exposes generic claim/expiry. Shared mutations retain their existing lease fences. */
export class ApiTextJobStore implements JobStore {
  private readonly shared: PostgresJobStore;
  lastClaim: ApiTextClaimDisposition | null = null;
  constructor(private readonly database: JobDatabase, private readonly message: ApiTextDispatchMessage,
    private readonly deploymentId: string, private readonly operation: string) {
    this.shared = new PostgresJobStore(database);
  }
  async claim(workerId: string, leaseSeconds: number): Promise<ClaimedJob | null> {
    const response = await this.database.query("select public.claim_api_text_job($1, $2, $3, $4, $5) as result",
      [this.message.jobId, workerId, leaseSeconds, this.message.policyIdentity, this.deploymentId]);
    const result = dispositionSchema.parse(response.rows[0]?.result);
    this.lastClaim = result;
    if (result.disposition !== "claimed") return null;
    z.object({ billing_mode: z.literal("openai_api") }).parse(result.job);
    const job = parseClaimedJob(result.job);
    if (job.id !== this.message.jobId || job.operation !== this.operation || job.status !== "running" || result.state !== "running") {
      throw new Error("Claim binding mismatch");
    }
    return job;
  }
  async authorizeDispatch(job: ClaimedJob, stepKey: string): Promise<void> {
    const result = await this.database.query("select public.authorize_api_text_dispatch($1, $2, $3, $4, $5) as authorized",
      [job.id, job.leaseToken, stepKey, this.message.policyIdentity, this.deploymentId]);
    if (result.rows.length !== 1 || result.rows[0]?.authorized !== true) throw new Error("Dispatch unavailable");
  }
  registerPlan(job: ClaimedJob, manifest: readonly PlannedStep[]) { return this.shared.registerPlan(job, manifest); }
  heartbeat(job: ClaimedJob, leaseSeconds: number) { return this.shared.heartbeat(job, leaseSeconds); }
  beginStep(job: ClaimedJob, key: string, maximum: number) { return this.shared.beginStep(job, key, maximum); }
  completeStep(job: ClaimedJob, key: string, outcome: StepOutcome) { return this.shared.completeStep(job, key, outcome); }
  finish(job: ClaimedJob, state: "succeeded" | "failed" | "partial" | "cancelled") { return this.shared.finish(job, state); }
}

export async function readApiTextDispatch(database: JobDatabase, jobId: string): Promise<ApiTextDispatchDescriptor | null> {
  const result = await database.query("select public.get_api_text_dispatch($1) as dispatch", [jobId]);
  if (result.rows.length !== 1) throw new Error("Dispatch unavailable");
  const raw = result.rows[0]?.dispatch;
  return raw === null ? null : apiTextDispatchDescriptorSchema.parse(raw);
}
export async function expireApiTextJob(database: JobDatabase, jobId: string): Promise<ApiTextClaimDisposition> {
  const result = await database.query("select public.expire_api_text_job($1) as result", [jobId]);
  return dispositionSchema.parse(result.rows[0]?.result);
}
