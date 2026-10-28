import "server-only";
import { z } from "zod";
import {
  applyStrategyJobSchema, applyStrategyJobResponseSchema, enqueueStrategyJobSchema,
  strategyAvailabilitySchema, strategyJobSchema, strategyJobResultSchema, strategyJobSummarySchema, strategyJobApplicationSchema,
  strategyOperationSchema, strategyOverviewResponseSchema, subscriptionPolicyIdentitySchema,
  type StrategyJob, type StrategyJobApplication,
} from "@/domain/strategy-jobs";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { apiTextDispatchMessageSchema } from "@/domain/api-text-dispatch";
import { publishApiTextDispatch } from "../api-text/publication";
import { getApiTextPublicationOrigin, isLocalPollingRuntime } from "../api-text/config";
import { getApiTextWorkerReadiness } from "../api-text/readiness";
import { isSharedWorkerRuntime } from "../shared-account/routing";

// PostgREST aliases project only the immutable contract metadata, rather than
// loading every frozen context/history when listing account jobs.
const jobColumns = "id,owner_id,project_id,operation,input_revision,input_version:input->version,input_spend_control:input->>spendControl,input_policy_identity:input->>policyIdentity,state,progress,billing_mode,policy_identity,reserved_cost_microusd,actual_cost_microusd,cancel_requested_at,error_code,created_at,finished_at";
const stepSchema = z.object({
  job_id: z.uuid(), owner_id: z.uuid(), project_id: z.uuid(), step_key: z.string().min(1).max(200),
  state: z.literal("succeeded"), output: strategyJobResultSchema,
});
const applicationRowSchema = z.object({
  job_id: z.uuid(), owner_id: z.uuid(), project_id: z.uuid(), step_key: z.string().min(1).max(200),
  input_revision: z.number().int().positive(), applied_revision: z.number().int().positive(), applied_at: z.string(),
});

type DiagnosticStage = "database" | "stored_value" | "apply_read" | "apply_rpc" | "apply_response" | "apply_binding";

function localDiagnostic(stage: DiagnosticStage, details: {
  codeType?: string; code?: string; status?: number | null; issueCodes?: string[];
} = {}): void {
  if (process.env.FLUID_RUNTIME === "local" && !process.env.VERCEL) {
    // Only bounded classifications: never include messages, values, paths, IDs, or headers.
    console.warn("[fluid:strategy]", { stage, ...details });
  }
}

function databaseError(error: { code?: unknown; message?: unknown } | null, stage: DiagnosticStage = "database", status?: unknown): void {
  if (!error) return;
  if (error.code === "42501" && error.message === "account_required") throw new ApiError("unauthenticated");
  if (error.code === "P0002" || error.code === "PGRST116") throw new ApiError("not_found");
  if (error.code === "23505" || error.code === "40001" || error.code === "PT409") throw new ApiError("conflict");
  if (typeof error.code === "string" && ["23514", "23502", "22023"].includes(error.code)) throw new ApiError("invalid_input");
  localDiagnostic(stage, {
    codeType: error.code === null ? "null" : typeof error.code,
    code: typeof error.code === "string" && /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(error.code) ? error.code : "unrecognized",
    status: typeof status === "number" && Number.isInteger(status) && (status === 0 || (status >= 100 && status <= 599)) ? status : null,
  });
  throw new ApiError("integration_unavailable");
}

function parseStored<T>(schema: z.ZodType<T>, value: unknown, stage: DiagnosticStage = "stored_value"): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    localDiagnostic(stage, { issueCodes: [...new Set(parsed.error.issues.map(issue => issue.code))].slice(0, 8) });
    throw new ApiError("integration_unavailable");
  }
  return parsed.data;
}

function resourceId(id: string) {
  if (!z.uuid().safeParse(id).success) throw new ApiError("not_found");
  return id;
}

function ownSummary(auth: AuthenticatedContext, projectId: string, value: unknown) {
  const raw = parseStored(z.record(z.string(), z.unknown()), value);
  if (raw.billing_mode !== undefined && raw.billing_mode !== "openai_api" && raw.billing_mode !== "chatgpt_subscription") throw new ApiError("integration_unavailable");
  const mode = raw.billing_mode ?? raw.billingMode;
  const uncapped = z.object({ input_version: z.literal(3), input_spend_control: z.literal("uncapped"), input_policy_identity: subscriptionPolicyIdentitySchema }).safeParse(raw);
  if (raw.input_version === 3 && !uncapped.success) throw new ApiError("integration_unavailable");
  const job = parseStored(strategyJobSummarySchema, mode === "chatgpt_subscription" ? { ...raw, billingMode: mode, policyIdentity: raw.policy_identity ?? raw.policyIdentity }
    : uncapped.success ? { ...raw, billingMode: "openai_api", spendControl: "uncapped", policyIdentity: uncapped.data.input_policy_identity } : raw);
  if (job.owner_id !== auth.userId || job.project_id !== projectId) throw new ApiError("not_found");
  return job;
}

export async function getStrategyAvailability(auth: AuthenticatedContext, projectId?: string) {
  if (projectId !== undefined) resourceId(projectId);
  const local = isLocalPollingRuntime();
  const { data, error } = await auth.client.rpc(isSharedWorkerRuntime() ? "get_shared_strategy_availability" : local ? "get_local_strategy_availability" : "get_strategy_availability", { p_project_id: projectId ?? null });
  databaseError(error);
  const availability = parseStored(strategyAvailabilitySchema, data);
  if (local || availability.status !== "available" || availability.operations.every(operation => operation.billingMode === "chatgpt_subscription" || ("spendControl" in operation && operation.spendControl === "uncapped"))) return availability;
  // Caller-specific SQL remains authoritative for policy, eligibility and cost.
  // A configured origin alone does not establish that its protected worker is
  // reachable and qualified. Subscription readiness is independent of this probe.
  const readiness = getApiTextPublicationOrigin() ? await getApiTextWorkerReadiness() : null;
  const operations = availability.operations.filter(operation => operation.billingMode === "chatgpt_subscription" || ("spendControl" in operation && operation.spendControl === "uncapped") || readiness?.operations.some(readyOperation => readyOperation === operation.operation));
  return parseStored(strategyAvailabilitySchema, operations.length
    ? { status: "available", operations }
    : { status: "unavailable", operations: [], reason: "worker_unavailable" });
}

async function withResults(auth: AuthenticatedContext, projectId: string, summaries: z.infer<typeof strategyJobSummarySchema>[]): Promise<StrategyJob[]> {
  if (!summaries.length) return [];
  const ids = new Set(summaries.map(job => job.id));
  const { data, error } = await auth.client.from("job_steps")
    .select("job_id,owner_id,project_id,step_key,state,output")
    .eq("owner_id", auth.userId).eq("project_id", projectId).in("job_id", [...ids]).eq("state", "succeeded")
    .order("created_at", { ascending: true }).limit(400);
  databaseError(error);
  const steps = parseStored(z.array(stepSchema).max(400), data);
  if (steps.some(step => step.owner_id !== auth.userId || step.project_id !== projectId || !ids.has(step.job_id))) {
    throw new ApiError("not_found");
  }
  const applications = new Map<string, StrategyJobApplication>();
  if (steps.length) {
    const applicationResponse = await auth.client.from("strategy_job_applications")
      .select("job_id,owner_id,project_id,step_key,input_revision,applied_revision,applied_at")
      .eq("owner_id", auth.userId).eq("project_id", projectId).in("job_id", [...ids]).limit(400);
    databaseError(applicationResponse.error);
    const rows = parseStored(z.array(applicationRowSchema).max(400), applicationResponse.data);
    for (const row of rows) {
      if (row.owner_id !== auth.userId || row.project_id !== projectId || !ids.has(row.job_id)) throw new ApiError("not_found");
      const key = `${row.job_id}:${row.step_key}`;
      if (applications.has(key) || !steps.some(step => step.job_id === row.job_id && step.step_key === row.step_key)) throw new ApiError("integration_unavailable");
      applications.set(key, parseStored(strategyJobApplicationSchema, {
        jobId: row.job_id, stepKey: row.step_key, inputRevision: row.input_revision,
        appliedRevision: row.applied_revision, appliedAt: row.applied_at,
      }));
    }
  }
  const subscriptionIds = new Set(summaries.filter(job => job.billingMode === "chatgpt_subscription").map(job => job.id));
  const partials = new Map<string, string>();
  if (subscriptionIds.size) {
    const partialResponse = await auth.client.from("subscription_job_partials")
      .select("job_id,owner_id,project_id,partial_text").eq("owner_id", auth.userId).eq("project_id", projectId)
      .in("job_id", [...subscriptionIds]).limit(64);
    databaseError(partialResponse.error);
    const rows = parseStored(z.array(z.object({ job_id: z.uuid(), owner_id: z.uuid(), project_id: z.uuid(), partial_text: z.string().max(1_048_576) })).max(64), partialResponse.data);
    for (const row of rows) {
      if (row.owner_id !== auth.userId || row.project_id !== projectId || !subscriptionIds.has(row.job_id) || partials.has(row.job_id)) throw new ApiError("not_found");
      partials.set(row.job_id, row.partial_text);
    }
  }
  return summaries.map(job => parseStored(strategyJobSchema, {
    ...job, ...(partials.has(job.id) ? { partialText: partials.get(job.id) } : {}), results: steps.filter(step => step.job_id === job.id).map(step => {
      const application = applications.get(`${step.job_id}:${step.step_key}`);
      return { stepKey: step.step_key, output: step.output, ...(application ? { application } : {}) };
    }),
  }));
}

export async function getStrategyOverview(auth: AuthenticatedContext, projectId: string) {
  resourceId(projectId);
  // This RPC checks project ownership even when no jobs exist.
  const availability = await getStrategyAvailability(auth, projectId);
  const { data, error } = await auth.client.from("jobs").select(jobColumns)
    .eq("owner_id", auth.userId).eq("project_id", projectId).in("operation", strategyOperationSchema.options)
    .order("created_at", { ascending: false }).limit(64);
  databaseError(error);
  const rows = parseStored(z.array(z.unknown()).max(64), data).map(row => ownSummary(auth, projectId, row));
  return parseStored(strategyOverviewResponseSchema, { availability, jobs: await withResults(auth, projectId, await withDelivery(auth, projectId, rows)) });
}

export async function getStrategyJob(auth: AuthenticatedContext, projectId: string, jobId: string, includeDelivery = true) {
  resourceId(projectId); resourceId(jobId);
  const { data, error } = await auth.client.from("jobs").select(jobColumns)
    .eq("id", jobId).eq("owner_id", auth.userId).eq("project_id", projectId).in("operation", strategyOperationSchema.options).maybeSingle();
  databaseError(error);
  if (!data) throw new ApiError("not_found");
  const summary = ownSummary(auth, projectId, data);
  if (summary.id !== jobId) throw new ApiError("not_found");
  return (await withResults(auth, projectId, includeDelivery ? await withDelivery(auth, projectId, [summary]) : [summary]))[0]!;
}

const deliveryRowSchema = z.object({
  job: z.unknown(), dispatchState: z.enum(["published", "dispatch_pending"]),
  canRetryDelivery: z.boolean(), dispatch: apiTextDispatchMessageSchema.nullable(),
});

async function readDeliveries(auth: AuthenticatedContext, projectId: string, jobIds: string[]) {
  const { data, error } = await auth.client.rpc("get_strategy_job_deliveries", { p_project_id: projectId, p_job_ids: jobIds });
  databaseError(error);
  const rows = parseStored(z.array(deliveryRowSchema).max(64), data);
  const seen = new Set<string>();
  return rows.map(row => {
    const job = ownSummary(auth, projectId, row.job);
    if (!jobIds.includes(job.id) || seen.has(job.id) || job.billingMode === "chatgpt_subscription" || job.state !== "queued"
      || (row.canRetryDelivery && (row.dispatchState !== "dispatch_pending" || !row.dispatch || job.cancel_requested_at !== null))
      || (!row.canRetryDelivery && row.dispatch !== null) || (row.dispatch && row.dispatch.jobId !== job.id)) throw new ApiError("integration_unavailable");
    seen.add(job.id);
    return { ...row, job };
  });
}

/** Reads never publish. Missing recovery infrastructure must not hide saved work. */
async function withDelivery(auth: AuthenticatedContext, projectId: string, summaries: z.infer<typeof strategyJobSummarySchema>[]) {
  const candidates = summaries.filter(job => job.state === "queued" && job.billingMode !== "chatgpt_subscription");
  if (!candidates.length || !isSharedWorkerRuntime() && isLocalPollingRuntime()) return summaries;
  let rows: Awaited<ReturnType<typeof readDeliveries>>;
  try { rows = await readDeliveries(auth, projectId, candidates.map(job => job.id)); }
  catch (error) {
    if (error instanceof ApiError && error.code === "integration_unavailable") return summaries;
    throw error;
  }
  return summaries.map(job => {
    const delivery = rows.find(row => row.job.id === job.id);
    if (!delivery || delivery.job.operation !== job.operation || delivery.job.input_revision !== job.input_revision) return job;
    return { ...job, dispatchState: delivery.dispatchState, canRetryDelivery: delivery.canRetryDelivery };
  });
}

/** Explicit initial delivery retry only: no enqueue, redrive, claim or provider retry. */
export async function retryStrategyJobDelivery(auth: AuthenticatedContext, projectId: string, jobId: string) {
  resourceId(projectId); resourceId(jobId);
  if (!isSharedWorkerRuntime() && isLocalPollingRuntime()) throw new ApiError("conflict");
  const rows = await readDeliveries(auth, projectId, [jobId]);
  const delivery = rows[0];
  if (!delivery || !delivery.canRetryDelivery || !delivery.dispatch) throw new ApiError("conflict");
  // The shared worker owns its same-project durable outbox publisher. The
  // existing pending row is retried without an HTTP dispatch or a new job.
  if (isSharedWorkerRuntime()) return getStrategyJob(auth, projectId, jobId);
  let dispatchState: "published" | "dispatch_pending" | "already_processing" = "dispatch_pending";
  try { dispatchState = (await publishApiTextDispatch(delivery.dispatch)).state; }
  catch { /* An uncertain acknowledgement never creates a replacement request. */ }
  // The worker re-reads the canonical descriptor and applies its existing claim,
  // cancellation and publication-generation fences, including concurrent changes.
  const current = await getStrategyJob(auth, projectId, jobId);
  if (current.billingMode !== "chatgpt_subscription" && current.dispatchState === "published") dispatchState = "published";
  return parseStored(strategyJobSchema, current.state === "queued"
    ? { ...current, dispatchState, canRetryDelivery: dispatchState === "dispatch_pending" && current.billingMode !== "chatgpt_subscription" && current.canRetryDelivery === true }
    : current);
}

export async function enqueueStrategyJob(auth: AuthenticatedContext, projectId: string, input: unknown) {
  resourceId(projectId);
  const parsed = enqueueStrategyJobSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_input");
  const { operation, expectedRevision, idempotencyKey } = parsed.data;
  const shared = isSharedWorkerRuntime();
  if (shared && parsed.data.billingMode !== "chatgpt_subscription" && !("spendControl" in parsed.data)) throw new ApiError("invalid_input");
  const local = isLocalPollingRuntime() && parsed.data.billingMode !== "chatgpt_subscription" && !("spendControl" in parsed.data);
  const args = { p_project_id: projectId, p_expected_revision: expectedRevision, p_operation: operation, p_idempotency_key: idempotencyKey };
  const { data, error } = parsed.data.billingMode === "chatgpt_subscription"
    ? await auth.client.rpc("enqueue_subscription_strategy_job", { ...args, p_accepted_policy_identity: parsed.data.acceptedPolicyIdentity })
    : "spendControl" in parsed.data
      ? await auth.client.rpc(shared ? "enqueue_shared_strategy_job" : "enqueue_managed_strategy_job", { ...args, p_accepted_policy_identity: parsed.data.acceptedPolicyIdentity })
      : await auth.client.rpc(local ? "enqueue_local_strategy_job" : "enqueue_strategy_job", { ...args, p_accepted_max_cost_microusd: parsed.data.acceptedMaxCostMicrousd });
  databaseError(error);
  const summary = ownSummary(auth, projectId, data);
  if (summary.operation !== operation || summary.input_revision !== expectedRevision || (summary.billingMode ?? "openai_api") !== (parsed.data.billingMode ?? "openai_api")) throw new ApiError("integration_unavailable");
  if (parsed.data.billingMode === "chatgpt_subscription" && (summary.billingMode !== "chatgpt_subscription" || summary.policyIdentity !== parsed.data.acceptedPolicyIdentity)) throw new ApiError("integration_unavailable");
  if ("spendControl" in parsed.data && (summary.billingMode !== "openai_api" || summary.spendControl !== "uncapped" || summary.policyIdentity !== parsed.data.acceptedPolicyIdentity)) throw new ApiError("integration_unavailable");
  if (!local && parsed.data.billingMode !== "chatgpt_subscription" && summary.billingMode !== "chatgpt_subscription") {
    const terminal = ["succeeded", "failed", "partial", "cancelled", "needs_reconciliation"].includes(summary.state);
    if (!terminal) {
      const raw = parseStored(z.record(z.string(), z.unknown()), data);
      const dispatch = parseStored(apiTextDispatchMessageSchema, raw.dispatch);
      if (dispatch.jobId !== summary.id) throw new ApiError("integration_unavailable");
      let dispatchState: "published" | "dispatch_pending" | "already_processing" = "dispatch_pending";
      try { if (!shared) dispatchState = (await publishApiTextDispatch(dispatch)).state; }
      catch { /* The committed admission and exact idempotency key remain repairable. */ }
      // A publication receipt is distinct from execution. Keep the database job state.
      return (await withResults(auth, projectId, [{ ...summary, dispatchState }]))[0]!;
    }
  }
  // Replays may already have completed results; do not replace them with a fake pending response.
  return (await withResults(auth, projectId, [summary]))[0]!;
}

export async function cancelStrategyJob(auth: AuthenticatedContext, projectId: string, jobId: string) {
  // Verify the path's project binding before invoking the existing owner-scoped cancel RPC.
  await getStrategyJob(auth, projectId, jobId, false);
  const { error } = await auth.client.rpc("request_job_cancel", { p_job_id: jobId });
  databaseError(error);
  return getStrategyJob(auth, projectId, jobId, false);
}

export async function applyStrategyJob(auth: AuthenticatedContext, projectId: string, jobId: string, input: unknown) {
  const parsed = applyStrategyJobSchema.safeParse(input);
  if (!parsed.success) throw new ApiError("invalid_input");
  let job: StrategyJob;
  try {
    job = await getStrategyJob(auth, projectId, jobId, false);
  } catch (error) {
    if (error instanceof ApiError && error.code === "integration_unavailable") localDiagnostic("apply_read");
    throw error;
  }
  if (job.input_revision !== parsed.data.expectedRevision) throw new ApiError("conflict");
  if (!job.results.some(result => result.stepKey === parsed.data.stepKey)) throw new ApiError("not_found");
  const { data, error, status } = await auth.client.rpc("apply_strategy_job_result_v2", {
    p_project_id: projectId, p_job_id: jobId, p_expected_revision: parsed.data.expectedRevision, p_step_key: parsed.data.stepKey,
  });
  databaseError(error, "apply_rpc", status);
  const result = parseStored(applyStrategyJobResponseSchema, data, "apply_response");
  const { project, application } = result;
  if (project.owner_id !== auth.userId || project.id !== projectId || project.current_revision !== parsed.data.expectedRevision + 1) {
    throw new ApiError("not_found");
  }
  if (application.jobId !== jobId || application.stepKey !== parsed.data.stepKey || application.inputRevision !== parsed.data.expectedRevision) {
    localDiagnostic("apply_binding");
    throw new ApiError("integration_unavailable");
  }
  return result;
}
