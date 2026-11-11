import "server-only";
import { z } from "zod";
import {
  strategyAvailabilitySchema,
  strategyJobSchema,
  strategyJobResultSchema,
  strategyJobSummarySchema,
  strategyOverviewResponseSchema,
  policyIdentitySchema,
  type StrategyJob,
} from "@/domain/strategy-jobs";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { assertOwnedProject, engineStrategyAvailability, strategyEngineEnabled } from "../engine/strategy";

// Strategy runs on the generation engine (docs/generation-engine.md). This module reads
// the Strategy step's availability and the project's earlier requests from the old job
// system, which still display. New requests start, poll and stop through /generations.

// JSON-path SELECT still requires access to the whole input column. This
// owner-scoped facade exposes only public summaries and three contract fields.
async function readJobSummaries(auth: AuthenticatedContext, projectId: string, jobId: string | null) {
  const { data, error } = await auth.client.rpc("get_strategy_job_summaries", {
    p_project_id: projectId,
    p_job_id: jobId,
  });
  databaseError(error);
  const rows = parseStored(z.array(z.unknown()).max(jobId === null ? 64 : 1), data);
  return rows.flatMap((row) => ownSummary(auth, projectId, row) ?? []);
}
const stepSchema = z.object({
  job_id: z.uuid(),
  owner_id: z.uuid(),
  project_id: z.uuid(),
  step_key: z.string().min(1).max(200),
  state: z.literal("succeeded"),
  output: strategyJobResultSchema,
});

function databaseError(error: { code?: unknown; message?: unknown } | null): void {
  if (!error) return;
  if (error.code === "42501" && error.message === "account_required") throw new ApiError("unauthenticated");
  if (error.code === "P0002" || error.code === "PGRST116") throw new ApiError("not_found");
  if (error.code === "23505" || error.code === "40001" || error.code === "PT409") throw new ApiError("conflict");
  if (typeof error.code === "string" && ["23514", "23502", "22023"].includes(error.code))
    throw new ApiError("invalid_input");
  throw new ApiError("integration_unavailable");
}

function parseStored<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("integration_unavailable");
  return parsed.data;
}

function resourceId(id: string) {
  if (!z.uuid().safeParse(id).success) throw new ApiError("not_found");
  return id;
}

/**
 * Old requests carry their billing mode and contract fields. Requests made in the retired
 * ChatGPT-plan mode (production still holds a few) have no engine equivalent and are
 * skipped; every other row must parse or the read fails.
 */
function ownSummary(auth: AuthenticatedContext, projectId: string, value: unknown) {
  const raw = parseStored(z.record(z.string(), z.unknown()), value);
  if (raw.billing_mode === "chatgpt_subscription") return null;
  if (raw.billing_mode !== undefined && raw.billing_mode !== "openai_api")
    throw new ApiError("integration_unavailable");
  const uncapped = z
    .object({
      input_version: z.literal(3),
      input_spend_control: z.literal("uncapped"),
      input_policy_identity: policyIdentitySchema,
    })
    .safeParse(raw);
  if (raw.input_version === 3 && !uncapped.success) throw new ApiError("integration_unavailable");
  const job = parseStored(
    strategyJobSummarySchema,
    uncapped.success
      ? {
          ...raw,
          billingMode: "openai_api",
          spendControl: "uncapped",
          policyIdentity: uncapped.data.input_policy_identity,
        }
      : raw,
  );
  if (job.owner_id !== auth.userId || job.project_id !== projectId) throw new ApiError("not_found");
  return job;
}

/**
 * Strategy is offered only while every Strategy kind is enabled on the generation engine.
 * Turning a kind off is a stop switch: the step shows as unavailable, nothing falls back.
 */
export async function getStrategyAvailability(auth: AuthenticatedContext, projectId?: string, engine?: boolean) {
  if (projectId !== undefined) resourceId(projectId);
  if (engine ?? (await strategyEngineEnabled(auth))) {
    if (projectId !== undefined) await assertOwnedProject(auth, projectId);
    return engineStrategyAvailability();
  }
  if (projectId !== undefined) await assertOwnedProject(auth, projectId);
  return parseStored(strategyAvailabilitySchema, {
    status: "unavailable",
    operations: [],
    reason: "generation_unavailable",
  });
}

async function withResults(
  auth: AuthenticatedContext,
  projectId: string,
  summaries: z.infer<typeof strategyJobSummarySchema>[],
): Promise<StrategyJob[]> {
  if (!summaries.length) return [];
  const ids = new Set(summaries.map((job) => job.id));
  const { data, error } = await auth.client
    .from("job_steps")
    .select("job_id,owner_id,project_id,step_key,state,output")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .in("job_id", [...ids])
    .eq("state", "succeeded")
    .order("created_at", { ascending: true })
    .limit(400);
  databaseError(error);
  const steps = parseStored(z.array(stepSchema).max(400), data);
  if (steps.some((step) => step.owner_id !== auth.userId || step.project_id !== projectId || !ids.has(step.job_id))) {
    throw new ApiError("not_found");
  }
  return summaries.map((job) =>
    parseStored(strategyJobSchema, {
      ...job,
      results: steps
        .filter((step) => step.job_id === job.id)
        .map((step) => ({ stepKey: step.step_key, output: step.output })),
    }),
  );
}

/** The step's availability and the project's earlier old-system requests with their results.
 * `engine: true` tells the screen to read and start runs through /generations. */
export async function getStrategyOverview(auth: AuthenticatedContext, projectId: string) {
  resourceId(projectId);
  const availability = await getStrategyAvailability(auth, projectId);
  const rows = await readJobSummaries(auth, projectId, null);
  return parseStored(strategyOverviewResponseSchema, {
    engine: true,
    availability,
    jobs: await withResults(auth, projectId, rows),
  });
}

export async function getStrategyJob(auth: AuthenticatedContext, projectId: string, jobId: string) {
  resourceId(projectId);
  resourceId(jobId);
  const [summary] = await readJobSummaries(auth, projectId, jobId);
  if (!summary || summary.id !== jobId) throw new ApiError("not_found");
  return (await withResults(auth, projectId, [summary]))[0]!;
}

/** Stops an old-system request that never finished, so it no longer holds the step. */
export async function cancelStrategyJob(auth: AuthenticatedContext, projectId: string, jobId: string) {
  // Verify the path's project binding before invoking the existing owner-scoped cancel RPC.
  await getStrategyJob(auth, projectId, jobId);
  const { error } = await auth.client.rpc("request_job_cancel", { p_job_id: jobId });
  databaseError(error);
  return getStrategyJob(auth, projectId, jobId);
}
