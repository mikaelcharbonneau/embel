import { z } from "zod";
import { NAMING_LEASE_SECONDS, namingClaimSchema, namingGenerationPolicySchema, type NamingGenerationPolicy } from "../../src/domain/naming-generation";
import { createNamingGenerationProvider, type NamingGenerationProvider } from "../../src/server/ai/naming-generation-provider";
import { runNamingGeneration, type NamingGenerationTiming } from "../naming-generation";
import { sharedPendingExecutionSchema, type SharedPendingExecution } from "../shared-pool/contracts";
import type { SharedLaneBase, SharedLaneEngine, SharedLaneResult } from "./contracts";
import { createSharedLaneGateway } from "./gateway";

const unavailable = () => Error("shared_naming_authority_unavailable");
const SETTLED = new Set(["idle", "succeeded", "failed", "cancelled"]);
const MAX_RECOVERIES = 3;
const recoveredSchema = z.object({ action: z.literal("closed") });

/** Naming generation, one SQL-selected run per slot turn. A run always settles:
 * provider and database failures become a returned state, never a stuck drain.
 * Only a refused slot authority or a claim that does not match it throws. */
export function createSharedNamingLaneEngine(options: SharedLaneBase & { policy: NamingGenerationPolicy },
  dependencies: { provider?: NamingGenerationProvider; timing?: Partial<NamingGenerationTiming> } = {}): SharedLaneEngine {
  const policy = namingGenerationPolicySchema.parse(options.policy);
  if (policy.model !== options.provider.model || !options.provider.apiKey || !options.provider.modelVerificationReceipt) throw unavailable();
  const provider = dependencies.provider ?? createNamingGenerationProvider({ apiKey: options.provider.apiKey });
  const stop = new AbortController();
  let active: Promise<unknown> | null = null, closed = false;
  const scoped = (signal?: AbortSignal) => AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]);
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const running = work(); active = running;
    try { return await running; } finally { active = null; }
  }
  return Object.freeze({
    async run(message?: unknown, signal?: AbortSignal): Promise<SharedLaneResult> {
      if (message !== undefined) throw unavailable();
      if (closed || active || signal?.aborted) return { disposition: "retry", state: "stopping" };
      const combined = scoped(signal), gateway = createSharedLaneGateway({ ...options, lane: "naming", signal: combined });
      try {
        const state = await exclusive(async () => {
          if (await gateway.invoke("qualify", { policy }) !== true) throw unavailable();
          // Jobs whose worker stopped are settled or requeued before the next claim.
          z.number().int().min(0).max(20).parse(await gateway.invoke("expire", {}));
          const raw = await gateway.invoke("claim", { workerId: options.workerId, leaseSeconds: NAMING_LEASE_SECONDS });
          if (raw === null) return "idle";
          const claim = namingClaimSchema.parse(raw), execution = gateway.execution();
          gateway.assertJob(claim.job.id, claim.job.lease_token, claim.job.owner_id, claim.job.project_id);
          if (!execution || execution.operation !== "naming.generate" || claim.input.policyIdentity !== execution.policyIdentity || policy.model !== options.provider.model
            || claim.run.jobId !== claim.job.id || claim.run.runId !== claim.input.runId) throw unavailable();
          return runNamingGeneration({ gateway, claim, provider, policy, signal: combined, ...(dependencies.timing ? { timing: dependencies.timing } : {}) });
        });
        return { disposition: SETTLED.has(state) ? "ack" : "retry", state };
      } finally { await gateway.drain(); }
    },
    /** Applies the expiry rules now to executions left over after a takeover. One
     * failed recovery is counted and the rest continue. Another deployment's
     * executions are left to `expire`, because the gateway only accepts this one. */
    async recover(pending: readonly SharedPendingExecution[], signal?: AbortSignal): Promise<SharedLaneResult> {
      if (closed || active || signal?.aborted) return { disposition: "retry", state: "stopping" };
      const rows = z.array(sharedPendingExecutionSchema).max(25).parse(pending), combined = scoped(signal);
      return exclusive(async () => {
        let recovered = 0, failed = 0;
        for (const row of rows) {
          if (combined.aborted || recovered + failed >= MAX_RECOVERIES) break;
          const execution = row.execution;
          if (execution.lane !== "naming" || execution.operation !== "naming.generate" || execution.deploymentId !== options.deploymentId) continue;
          try {
            const gateway = createSharedLaneGateway({ ...options, lane: "naming", signal: combined, observationExecution: execution });
            try { recoveredSchema.parse(await gateway.invoke("recover", {}, true)); recovered++; }
            finally { await gateway.drain(); }
          } catch { failed++; }
        }
        return { disposition: failed ? "retry" : "ack", state: failed ? "recover_failed" : recovered ? "recovered" : "idle" } as const;
      });
    },
    async close() { closed = true; stop.abort(); await active?.then(() => undefined, () => undefined); },
  });
}
