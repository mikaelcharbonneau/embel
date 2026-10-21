import { apiTextDeploymentSchema, apiTextDispatchMessageSchema } from "../src/domain/api-text-dispatch";
import { isHostedStrategyPolicy, type OpenAIStrategyConfiguration } from "../src/server/ai/config";
import { createOpenAIResponsesTransport, type OpenAIResponsesTransport } from "../src/server/ai/openai-transport";
import type { JobDatabase } from "./postgres-store";
import { ApiTextJobStore, expireApiTextJob, readApiTextDispatch } from "./api-text-store";
import { createApiTextReadiness } from "./handlers/openai-readiness";
import { createOpenAIStrategyHandlers } from "./handlers/openai-strategy";
import { runOneJob } from "./runner";
import { apiTextDispatchDatabase } from "./api-text-multi-account";
import { backgroundControl, runBackgroundApiTextDelivery } from "./api-text-background-runtime";

import { diagnose, diagnosticErrorClass, observeStage, type DiagnosticSink } from "./hosting/diagnostics";
import { OperationDeadlineError } from "./hosting/timing";
import { observeDeliveryHandlers, observeDeliveryStore, observeProviderTransport } from "./hosting/delivery-diagnostics";


export const API_TEXT_DATABASE_TIMEOUT_MS = 5_000;
export const API_TEXT_HANDLER_TIMEOUT_MS = 270_000;
const STOP_WORK_MS = 250_000;
const terminalStates = new Set(["succeeded", "failed", "partial", "cancelled", "needs_reconciliation"]);
export type ApiTextDeliveryResult = { disposition: "ack" | "retry"; state: string };

/** One delivery, one existing admitted job. This entrypoint never admits, enables or retries a paid step. */
export async function runApiTextDelivery(options: {
  message: unknown; database: JobDatabase; configuration: OpenAIStrategyConfiguration | null;
  deploymentId: string; signal?: AbortSignal; transport?: OpenAIResponsesTransport; multiAccount?: boolean; backgroundRecovery?: boolean; diagnostics?: DiagnosticSink;
}): Promise<ApiTextDeliveryResult> {
  const parsed = apiTextDispatchMessageSchema.safeParse(options.message);
  if (!parsed.success) return { disposition: "ack", state: "invalid_message" };
  const message = parsed.data;
  const sourceDatabase = options.multiAccount ? apiTextDispatchDatabase(options.database, message) : options.database;
  if (!apiTextDeploymentSchema.safeParse(options.deploymentId).success || message.deploymentId !== options.deploymentId) {
    return { disposition: "ack", state: "deployment_mismatch" };
  }
  if (options.signal?.aborted) return { disposition: "retry", state: "stopping" };
  const configured = options.configuration;
  if (!configured) return { disposition: "retry", state: "runtime_unavailable" };
  const policies = new Map([...configured.policies].filter(([operation, policy]) => isHostedStrategyPolicy(operation, policy)));
  if (!policies.size) return { disposition: "retry", state: "runtime_unavailable" };
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  const stopTimer = setTimeout(stop, STOP_WORK_MS);
  const deadline = Date.now() + API_TEXT_HANDLER_TIMEOUT_MS;
  let closed = false; let databaseFailed = false;
  const bindDatabase = (source: JobDatabase): JobDatabase => ({ async query(sql, values) {
    if (closed || Date.now() >= deadline) { databaseFailed = true; throw new OperationDeadlineError("Database deadline exceeded"); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([source.query(sql, values), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OperationDeadlineError("Database unavailable")), Math.min(API_TEXT_DATABASE_TIMEOUT_MS, deadline - Date.now()));
      })]);
    } catch (error) { databaseFailed = true; throw error; }
    finally { clearTimeout(timer); }
  } });
  const database = bindDatabase(sourceDatabase);
  const backgroundDatabase = bindDatabase(options.database);
  const started = Date.now();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const execute = async (): Promise<ApiTextDeliveryResult> => {
      const descriptor = await observeStage("descriptor_read", "database", () => readApiTextDispatch(database, message.jobId), options.diagnostics);
      if (!descriptor) return { disposition: "ack", state: "not_found" };
      if (descriptor.jobId !== message.jobId || descriptor.policyIdentity !== message.policyIdentity ||
          descriptor.deploymentId !== options.deploymentId || descriptor.dispatchIdentity !== message.dispatchIdentity) {
        return { disposition: "ack", state: "dispatch_mismatch" };
      }
      if (terminalStates.has(descriptor.state)) return { disposition: "ack", state: descriptor.state };
      if (options.backgroundRecovery && options.multiAccount && await backgroundControl(backgroundDatabase, message, "profile") === true) {
        return runBackgroundApiTextDelivery({ database: backgroundDatabase, scopedDatabase: database, message,
          configuration: { ...configured, policies }, transport: options.transport ?? createOpenAIResponsesTransport({ apiKey: configured.apiKey }), signal: controller.signal });
      }
      const expiry = await observeStage("expiry", "database", () => expireApiTextJob(database, message.jobId), options.diagnostics);
      if (expiry.disposition === "terminal" && terminalStates.has(expiry.state)) return { disposition: "ack", state: expiry.state };
      if (expiry.disposition === "not_found") return { disposition: "ack", state: "not_found" };
      if (expiry.disposition !== "available") return { disposition: "retry", state: expiry.state };
      if (controller.signal.aborted) return { disposition: "retry", state: "stopping" };
      if (!policies.has(descriptor.operation)) return { disposition: "retry", state: "runtime_unavailable" };
      const store = new ApiTextJobStore(database, message, options.deploymentId, descriptor.operation);
      const assertPolicyReady = createApiTextReadiness(database, options.deploymentId);
      const transport = observeProviderTransport(options.transport ?? createOpenAIResponsesTransport({ apiKey: configured.apiKey }), options.diagnostics);
      const handlers = observeDeliveryHandlers(createOpenAIStrategyHandlers({ ...configured, policies }, transport,
        (...args) => observeStage("policy_check", "database", () => assertPolicyReady(...args), options.diagnostics),
        (job, key) => observeStage("dispatch_authorize", "database", () => store.authorizeDispatch(job, key), options.diagnostics)), options.diagnostics);
      const state = await runOneJob({ store: observeDeliveryStore(store, options.diagnostics), handlers, workerId: `api-text-${crypto.randomUUID()}`,
        leaseSeconds: 120, heartbeatMs: 20_000, abortGraceMs: 5_000, signal: controller.signal });
      if (terminalStates.has(state)) return { disposition: "ack", state };
      const claim = store.lastClaim;
      if (state === "idle" && claim?.disposition === "terminal" && terminalStates.has(claim.state)) return { disposition: "ack", state: claim.state };
      if (state === "idle" && claim?.disposition === "not_found") return { disposition: "ack", state: "not_found" };
      return { disposition: "retry", state: state === "idle" ? claim?.state ?? "stopping" : state };
    };
    return await Promise.race([execute(), new Promise<ApiTextDeliveryResult>(resolve => {
      deadlineTimer = setTimeout(() => { closed = true; controller.abort(); resolve({ disposition: "retry", state: "handler_timeout" }); }, API_TEXT_HANDLER_TIMEOUT_MS);
    })]);
  } catch (error) {
    diagnose("delivery", "error", started, diagnosticErrorClass(error, databaseFailed ? "database" : "handler"), options.diagnostics);
    // The database owns any uncertain write/lease outcome. Never repair by resetting it.
    return { disposition: "retry", state: databaseFailed ? "database_unavailable" : "handler_unavailable" };
  } finally {
    closed = true;
    clearTimeout(stopTimer); clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", stop);
  }
}
