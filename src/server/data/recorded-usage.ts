import "server-only";
import { z } from "zod";
import {
  RECORDED_USAGE_LIMIT,
  recordedTokensSchema,
  recordedUsageOperationSchema,
  recordedUsageSchema,
} from "@/domain/recorded-usage";
import { strategyUsageSchema, subscriptionUsageSchema } from "@/domain/strategy-jobs";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { getNamingUsage } from "./naming-generation";

const jobSchema = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  project_id: z.uuid(),
  operation: recordedUsageOperationSchema,
  billing_mode: z.enum(["openai_api", "chatgpt_subscription"]),
  state: z.literal("succeeded"),
  finished_at: z.iso.datetime({ offset: true }),
});
const stepSchema = z.object({
  job_id: z.uuid(),
  owner_id: z.uuid(),
  project_id: z.uuid(),
  state: z.literal("succeeded"),
  receipt_operation: recordedUsageOperationSchema.nullable(),
  usage: z.unknown().optional(),
});
function verified<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("integration_unavailable");
  return parsed.data;
}
function recordedTokens(value: unknown) {
  const subscription = subscriptionUsageSchema.safeParse(value);
  if (subscription.success) return recordedTokensSchema.parse(subscription.data);
  const api = strategyUsageSchema.safeParse(value);
  if (!api.success) return null;
  // API-mode receipts record input and output separately; together they are the
  // request total (cached input is already part of input).
  const totalTokens = api.data.inputTokens + api.data.outputTokens;
  return {
    inputTokens: api.data.inputTokens,
    outputTokens: api.data.outputTokens,
    totalTokens: Number.isSafeInteger(totalTokens) ? totalTokens : null,
  };
}

/** Existing user-scoped RLS reads; JSON projection avoids fetching result content. */
export async function listRecordedUsage(auth: AuthenticatedContext) {
  const reply = await auth.client
    .from("jobs")
    .select("id,owner_id,project_id,operation,billing_mode,state,finished_at")
    .eq("owner_id", auth.userId)
    .eq("state", "succeeded")
    .in("operation", [...recordedUsageOperationSchema.options[0].options, "naming.generate"])
    .order("finished_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(RECORDED_USAGE_LIMIT);
  if (reply.error) throw new ApiError("integration_unavailable");
  const jobs = verified(z.array(jobSchema).max(RECORDED_USAGE_LIMIT), reply.data);
  if (jobs.some((job) => job.owner_id !== auth.userId) || new Set(jobs.map((job) => job.id)).size !== jobs.length)
    throw new ApiError("integration_unavailable");
  const tokens = new Map<string, ReturnType<typeof recordedTokens>>();
  // A naming run records each saved round's provider usage; SQL sums them per job.
  const namingJobs = jobs.filter((job) => job.operation === "naming.generate" && job.billing_mode === "openai_api");
  for (const usage of await getNamingUsage(
    auth,
    namingJobs.map((job) => job.id),
  )) {
    const totalTokens = usage.inputTokens + usage.outputTokens;
    tokens.set(usage.jobId, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens === totalTokens ? totalTokens : null,
    });
  }
  const legacyJobs = jobs.filter((job) => !namingJobs.includes(job));
  if (legacyJobs.length) {
    const stepReply = await auth.client
      .from("job_steps")
      .select("job_id,owner_id,project_id,state,receipt_operation:output->>operation,usage:output->usage")
      .eq("owner_id", auth.userId)
      .eq("state", "succeeded")
      .in(
        "job_id",
        legacyJobs.map((job) => job.id),
      )
      .limit(RECORDED_USAGE_LIMIT + 1);
    if (stepReply.error) throw new ApiError("integration_unavailable");
    const steps = verified(z.array(stepSchema).max(RECORDED_USAGE_LIMIT), stepReply.data);
    for (const step of steps) {
      const job = jobs.find((job) => job.id === step.job_id);
      if (
        !job ||
        step.owner_id !== auth.userId ||
        step.project_id !== job.project_id ||
        (step.receipt_operation !== null && step.receipt_operation !== job.operation) ||
        tokens.has(step.job_id)
      )
        throw new ApiError("integration_unavailable");
      tokens.set(step.job_id, step.receipt_operation === null ? null : recordedTokens(step.usage));
    }
  }
  const entries = [
    ...jobs.map((job) => ({
      id: job.id,
      operation: job.operation,
      completedAt: job.finished_at,
      tokens: tokens.get(job.id) ?? null,
    })),
    ...(await engineNamingUsage(auth)),
    // A stable sort: entries finished at the same moment keep their database order.
  ]
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
    .slice(0, RECORDED_USAGE_LIMIT);
  return verified(recordedUsageSchema, { ownerId: auth.userId, limit: RECORDED_USAGE_LIMIT, entries });
}

const engineRunSchema = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  kind: z.literal("naming.generate"),
  status: z.literal("succeeded"),
  finished_at: z.iso.datetime({ offset: true }),
});
const engineOutputSchema = z.object({ run_id: z.uuid(), owner_id: z.uuid(), usage: z.unknown().optional() });
const outputTokensSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
/** Naming runs on the generation engine: token counts recorded on each saved reply
 * (generation_outputs), summed per run. Costs stay there and are never shown. */
async function engineNamingUsage(auth: AuthenticatedContext) {
  const reply = await auth.client
    .from("generation_runs")
    .select("id,owner_id,kind,status,finished_at")
    .eq("owner_id", auth.userId)
    .eq("kind", "naming.generate")
    .eq("status", "succeeded")
    .order("finished_at", { ascending: false })
    .limit(RECORDED_USAGE_LIMIT);
  if (reply.error) throw new ApiError("integration_unavailable");
  const runs = verified(z.array(engineRunSchema).max(RECORDED_USAGE_LIMIT), reply.data);
  if (runs.some((run) => run.owner_id !== auth.userId)) throw new ApiError("integration_unavailable");
  if (!runs.length) return [];
  const outputs = await auth.client
    .from("generation_outputs")
    .select("run_id,owner_id,usage:output->usage")
    .eq("owner_id", auth.userId)
    .in(
      "run_id",
      runs.map((run) => run.id),
    )
    .limit(RECORDED_USAGE_LIMIT * 10);
  if (outputs.error) throw new ApiError("integration_unavailable");
  const rows = verified(z.array(engineOutputSchema).max(RECORDED_USAGE_LIMIT * 10), outputs.data);
  if (rows.some((row) => row.owner_id !== auth.userId || !runs.some((run) => run.id === row.run_id)))
    throw new ApiError("integration_unavailable");
  return runs.map((run) => {
    const recorded = rows
      .filter((row) => row.run_id === run.id)
      .flatMap((row) => {
        const usage = outputTokensSchema.safeParse(row.usage);
        return usage.success ? [usage.data] : [];
      });
    const inputTokens = recorded.reduce((sum, usage) => sum + usage.inputTokens, 0),
      outputTokens = recorded.reduce((sum, usage) => sum + usage.outputTokens, 0);
    const totalTokens = inputTokens + outputTokens;
    return {
      id: run.id,
      operation: run.kind,
      completedAt: run.finished_at,
      tokens: recorded.length && Number.isSafeInteger(totalTokens) ? { inputTokens, outputTokens, totalTokens } : null,
    };
  });
}
