import { createHash } from "node:crypto";
import { z } from "zod";
import { jobStatusSchema, moneySchema, type ClaimedJob, type StepOutcome } from "../src/domain/jobs";
import { PlanConflictError, type JobStore, type PlannedStep } from "./runner";

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

export type JobDatabase = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

/** Dedicated worker database role. Never construct in a web route or browser bundle. */
export class PostgresJobStore implements JobStore {
  constructor(private readonly pool: JobDatabase, private readonly options: { localPrototype?: boolean } = {}) {}

  private async readLocalStepMetadata(job: ClaimedJob, stepKey: string | null) {
    // These identifiers are assertions. SQL derives authority from the restricted
    // login's local capability and the immutable admitted-job marker.
    return this.pool.query("select * from public.read_local_strategy_steps($1,$2,$3,$4)",
      [job.id, job.ownerId, job.projectId, stepKey]);
  }

  private async mutate(job: ClaimedJob, action: "heartbeat" | "plan" | "begin" | "complete" | "finish",
    arguments_: unknown[], sql: string, values: unknown[]) {
    if (!this.options.localPrototype) return this.pool.query(sql, values);
    // The shared Naming login receives this Strategy-only gateway rather than
    // generic mutations that could bypass Naming's richer stage validation.
    const result = await this.pool.query("select public.local_strategy_job_action($1,$2,$3) as result",
      [job.id, action, JSON.stringify(arguments_)]);
    if (result.rows.length !== 1) throw new Error("Local Strategy mutation unconfirmed");
    return { rows: [z.record(z.string(), z.unknown()).parse(result.rows[0]?.result)] };
  }

  async claim(workerId: string, leaseSeconds: number) {
    const result = await this.pool.query("select * from public.claim_job($1, $2)", [workerId, leaseSeconds]);
    return result.rows.length ? parseClaimedJob(result.rows[0]) : null;
  }

  async heartbeat(job: ClaimedJob, leaseSeconds: number) {
    const result = await this.mutate(job, "heartbeat", [job.leaseToken, leaseSeconds],
      "select * from public.heartbeat_job($1, $2, $3)", [job.id, job.leaseToken, leaseSeconds]);
    const current = parseClaimedJob(result.rows[0]);
    if (current.ownerId !== job.ownerId || current.projectId !== job.projectId) throw new Error("Lease ownership mismatch");
    return { cancelled: current.status === "cancel_requested" };
  }

  async registerPlan(job: ClaimedJob, manifest: readonly PlannedStep[]) {
    try {
      await this.mutate(job, "plan", [job.leaseToken, manifest],
        "select * from public.register_job_plan($1, $2, $3)", [job.id, job.leaseToken, JSON.stringify(manifest)]);
    } catch (error) {
      if (error instanceof Error && error.message === "plan_conflict") {
        if (this.options.localPrototype) {
          const result = await this.readLocalStepMetadata(job, null);
          throw new PlanConflictError(result.rows.some(row => row.state === "succeeded"));
        }
        const result = await this.pool.query("select exists(select 1 from public.job_steps where job_id=$1 and owner_id=$2 and project_id=$3 and state='succeeded') as has_results", [job.id, job.ownerId, job.projectId]);
        throw new PlanConflictError(z.boolean().parse(result.rows[0]?.has_results));
      }
      throw error;
    }
  }

  async beginStep(job: ClaimedJob, stepKey: string, maximumCostMicrousd: number): Promise<"started" | "already_succeeded"> {
    const requestKey = createHash("sha256").update(`${job.id}:${stepKey}`).digest("hex");
    const existing = this.options.localPrototype ? await this.readLocalStepMetadata(job, stepKey) : await this.pool.query(
      "select state, request_key, reserved_cost_microusd from public.job_steps where job_id = $1 and owner_id = $2 and project_id = $3 and step_key = $4",
      [job.id, job.ownerId, job.projectId, stepKey],
    );
    if (existing.rows.length) {
      const row = existing.rows[0]!;
      if (row.state === "succeeded" && row.request_key === requestKey && databaseMoney.parse(row.reserved_cost_microusd) === maximumCostMicrousd) return "already_succeeded";
      throw new Error("Step requires reconciliation or explicit retry");
    }
    await this.mutate(job, "begin", [job.leaseToken, stepKey, requestKey, maximumCostMicrousd],
      "select * from public.begin_job_step($1, $2, $3, $4, $5)", [job.id, job.leaseToken, stepKey, requestKey, maximumCostMicrousd]);
    return "started";
  }

  async completeStep(job: ClaimedJob, stepKey: string, outcome: StepOutcome) {
    const state = outcome.status === "needs_reconciliation" ? "ambiguous" : outcome.status;
    const output = outcome.status === "succeeded" ? outcome.result : { error: outcome.code, ...("result" in outcome ? { result: outcome.result } : {}) };
    await this.mutate(job, "complete", [job.leaseToken, stepKey, state, outcome.costMicrousd, output, outcome.providerRequestId],
      "select * from public.complete_job_step($1, $2, $3, $4, $5, $6, $7)",
      [job.id, job.leaseToken, stepKey, state, outcome.costMicrousd, JSON.stringify(output), outcome.providerRequestId]);
  }

  async finish(job: ClaimedJob, state: "succeeded" | "failed" | "partial" | "cancelled") {
    const code = state === "failed" || state === "partial" ? "operation_incomplete" : null;
    await this.mutate(job, "finish", [job.leaseToken, state, code],
      "select * from public.finish_job($1, $2, $3, $4)", [job.id, job.leaseToken, state, code]);
  }

  async expireLeases(): Promise<number> {
    const result = await this.pool.query("select public.expire_job_leases() as count");
    return z.number().int().nonnegative().parse(result.rows[0]?.count);
  }
}
