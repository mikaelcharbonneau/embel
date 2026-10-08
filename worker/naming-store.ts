import type { Pool } from "pg";
import type { JobStore } from "./runner";

/** Narrow completion override; claim, replay and lease behavior stay with base. */
export function createNamingJobStore(base: JobStore, database: Pick<Pool, "query">): JobStore {
  return {
    claim: (workerId, leaseSeconds) => base.claim(workerId, leaseSeconds),
    registerPlan: (job, manifest) => base.registerPlan(job, manifest),
    heartbeat: (job, leaseSeconds) => base.heartbeat(job, leaseSeconds),
    beginStep: (job, stepKey, maximumCostMicrousd) => base.beginStep(job, stepKey, maximumCostMicrousd),
    finish: (job, state) => base.finish(job, state),
    async completeStep(job, stepKey, outcome) {
      if (job.operation !== "naming.generate") return base.completeStep(job, stepKey, outcome);
      const state = outcome.status === "needs_reconciliation" ? "ambiguous" : outcome.status;
      const output = outcome.status === "succeeded" ? outcome.result : { error: outcome.code, ...("result" in outcome ? { result: outcome.result } : {}) };
      await database.query("select * from public.complete_naming_job_step($1, $2, $3, $4, $5, $6, $7)",
        [job.id, job.leaseToken, stepKey, state, outcome.costMicrousd, JSON.stringify(output), outcome.providerRequestId]);
    },
  };
}
