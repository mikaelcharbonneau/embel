import { assertAffordableStep, stepOutcomeSchema, type ClaimedJob, type JobStatus, type StepOutcome } from "../src/domain/jobs";

export interface JobStore {
  claim(workerId: string, leaseSeconds: number): Promise<ClaimedJob | null>;
  registerPlan(job: ClaimedJob, manifest: readonly PlannedStep[]): Promise<void>;
  heartbeat(job: ClaimedJob, leaseSeconds: number): Promise<{ cancelled: boolean }>;
  beginStep(job: ClaimedJob, stepKey: string, maximumCostMicrousd: number): Promise<"started" | "already_succeeded">;
  completeStep(job: ClaimedJob, stepKey: string, outcome: StepOutcome): Promise<void>;
  finish(job: ClaimedJob, state: "succeeded" | "failed" | "partial" | "cancelled"): Promise<void>;
}

export type PlannedStep = { key: string; maximumCostMicrousd: number };
export type JobStep = {
  key: string;
  maximumCostMicrousd: number;
  timeoutMs?: number;
  execute: (input: { job: ClaimedJob; signal: AbortSignal }) => Promise<StepOutcome>;
};
export type JobHandler = { steps: (job: ClaimedJob) => readonly JobStep[] };
export type HandlerRegistry = ReadonlyMap<string, JobHandler>;

/** This marker is safe only before any provider request is dispatched. */
export class NotDispatchedError extends Error {}
export class PlanConflictError extends Error {
  constructor(readonly hasSuccessfulSteps: boolean) { super("Saved plan differs from handler"); }
}

/** Stop owning a request that outlives its deadline or ignores cancellation. */
async function executeBounded(step: JobStep, job: ClaimedJob, controller: AbortController, abortGraceMs: number): Promise<StepOutcome> {
  if (controller.signal.aborted) throw new NotDispatchedError("Aborted before dispatch");
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let abortGrace: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const bound = new Promise<never>((_, reject) => {
    onAbort = () => {
      abortGrace = setTimeout(() => reject(new Error("Provider did not settle after cancellation")), abortGraceMs);
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    deadline = setTimeout(() => {
      controller.abort();
      reject(new Error("Provider deadline exceeded"));
    }, step.timeoutMs ?? 300_000);
  });
  try {
    // Promise.race observes late rejections, but only its first settled outcome is published.
    return await Promise.race([step.execute({ job, signal: controller.signal }), bound]);
  } finally {
    clearTimeout(deadline);
    clearTimeout(abortGrace);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

export async function runOneJob(options: {
  store: JobStore; handlers: HandlerRegistry; workerId: string;
  leaseSeconds?: number; heartbeatMs?: number; abortGraceMs?: number; signal?: AbortSignal;
}): Promise<"idle" | "lease_lost" | JobStatus> {
  const { store, handlers } = options;
  const leaseSeconds = options.leaseSeconds ?? 120;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const abortGraceMs = options.abortGraceMs ?? 5_000;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 300 || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= leaseSeconds * 500) throw new Error("Invalid lease timing");
  if (!Number.isSafeInteger(abortGraceMs) || abortGraceMs < 0 || abortGraceMs > 30_000) throw new Error("Invalid abort grace");
  // A process without real handlers must never consume and fail live jobs.
  if (!handlers.size || options.signal?.aborted) return "idle";
  const job = await store.claim(options.workerId, leaseSeconds);
  if (!job) return "idle";
  const handler = handlers.get(job.operation);
  if (!handler) {
    try { await store.finish(job, "failed"); }
    catch { return "lease_lost"; }
    return "failed";
  }
  let steps: readonly JobStep[];
  try {
    steps = handler.steps(job);
    if (!steps.length || steps.length > 1_000 || new Set(steps.map(step => step.key)).size !== steps.length) throw new Error("Invalid step plan");
    let plannedCost = 0;
    for (const step of steps) {
      if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(step.key)) throw new Error("Invalid step key");
      assertAffordableStep(job.reservedCostMicrousd, step.maximumCostMicrousd);
      plannedCost += step.maximumCostMicrousd;
      assertAffordableStep(job.reservedCostMicrousd, plannedCost);
      if (step.timeoutMs !== undefined && (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 3_600_000)) throw new Error("Invalid provider deadline");
    }
  } catch {
    try { await store.finish(job, "failed"); }
    catch { return "lease_lost"; }
    return "failed";
  }
  try {
    await store.registerPlan(job, steps.map(({ key, maximumCostMicrousd }) => ({ key, maximumCostMicrousd })));
  } catch (error) {
    if (!(error instanceof PlanConflictError)) return "lease_lost";
    const final = error.hasSuccessfulSteps ? "partial" : "failed";
    try { await store.finish(job, final); }
    catch { return "lease_lost"; }
    return final;
  }

  const controller = new AbortController();
  let leaseLost = false;
  let cancelled = false;
  let stopping = false;
  let heartbeatRunning: Promise<void> | undefined;
  const stop = () => { stopping = true; controller.abort(); };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();

  const heartbeat = async () => {
    try {
      const state = await store.heartbeat(job, leaseSeconds);
      if (state.cancelled) { cancelled = true; controller.abort(); }
    } catch {
      leaseLost = true;
      controller.abort();
    }
  };
  const timer = setInterval(() => {
    if (!heartbeatRunning) heartbeatRunning = heartbeat().finally(() => { heartbeatRunning = undefined; });
  }, heartbeatMs);
  timer.unref();

  let successful = 0;
  let spent = job.actualCostMicrousd;
  let final: "succeeded" | "failed" | "partial" | "cancelled" | "needs_reconciliation" = "succeeded";
  try {
    for (const step of steps) {
      await heartbeatRunning;
      await heartbeat();
      if (leaseLost) return "lease_lost";
      if (cancelled) { final = "cancelled"; break; }
      if (stopping) { final = successful ? "partial" : "failed"; break; }
      // Persist the boundary before making any request that could be billed.
      let begun: "started" | "already_succeeded";
      try { begun = await store.beginStep(job, step.key, step.maximumCostMicrousd); }
      catch { return "lease_lost"; }
      if (begun === "already_succeeded") { successful += 1; continue; }

      let outcome: StepOutcome;
      try {
        try { assertAffordableStep(job.reservedCostMicrousd - spent, step.maximumCostMicrousd); }
        catch { throw new NotDispatchedError("Cost cap exceeded"); }
        outcome = stepOutcomeSchema.parse(await executeBounded(step, job, controller, abortGraceMs));
        // Keep known spend even if a provider violates the bound; reconcile the overage.
        if (outcome.costMicrousd > step.maximumCostMicrousd || spent + outcome.costMicrousd > job.reservedCostMicrousd) {
          outcome = { status: "needs_reconciliation", code: "provider_cost_exceeded", costMicrousd: outcome.costMicrousd, providerRequestId: outcome.providerRequestId,
            ...("result" in outcome ? { result: outcome.result } : {}) };
        }
      } catch (error) {
        outcome = error instanceof NotDispatchedError
          ? { status: "failed", code: "not_dispatched", costMicrousd: 0, providerRequestId: null }
          : { status: "needs_reconciliation", code: "provider_outcome_unknown", costMicrousd: 0, providerRequestId: null };
      }
      await heartbeatRunning;
      if (leaseLost) return "lease_lost";
      try { await store.completeStep(job, step.key, outcome); }
      catch { return "lease_lost"; } // database may be unavailable; lease recovery owns reconciliation
      spent += outcome.costMicrousd;
      // Ambiguous completion atomically invalidates the lease in the database.
      if (outcome.status === "needs_reconciliation") return "needs_reconciliation";
      if (outcome.status === "failed") { final = successful ? "partial" : "failed"; break; }
      successful += 1;
    }
    await heartbeatRunning;
    if (leaseLost) return "lease_lost";
    // Cancellation after a completed result preserves that result, but prevents another step.
    if (cancelled) final = "cancelled";
    try { await store.finish(job, final); }
    catch { return "lease_lost"; }
    return final;
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener("abort", stop);
    await heartbeatRunning;
  }
}
