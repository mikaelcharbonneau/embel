import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { localChatGPTStatusSchema, localModelSelectionSchema, localRegistrationSelectionSchema, localSignInSchema, type LocalChatGPTStatus } from "../src/domain/local-chatgpt";
import { chatGPTStrategyJobInputSchema, chatGPTStrategyPolicySchema, DEFAULT_SUBSCRIPTION_LIMITS, strategyOperationSchema, type ChatGPTStrategyJobInput, type ChatGPTStrategyPolicy, type StrategyOperation } from "../src/domain/strategy-jobs";
import { chatGPTNamingJobInputSchema, chatGPTNamingPolicySchema, namingOperationSchema, type ChatGPTNamingPolicy } from "../src/domain/naming-jobs";
import type { ClaimedJob } from "../src/domain/jobs";
import { CHATGPT_STREAM_LIMITS, createChatGPTTransport, type ChatGPTTransport } from "../src/server/ai/chatgpt-transport";
import { runChatGPTStrategy } from "../src/server/ai/chatgpt-strategy";
import { FileChatGPTCredentialStore } from "../src/server/local-chatgpt/credentials";
import { createLocalChatGPTSessionManager, type LocalChatGPTSessionManager } from "../src/server/local-chatgpt/session";
import { reportSignInFailure, type SignInFailure } from "../src/server/local-chatgpt/sign-in-diagnostics";
import { FileVerifiedChatGPTModelStore } from "../src/server/local-chatgpt/verified-models";
import { parseClaimedJob, PostgresJobStore } from "./postgres-store";
import { runOneJob, type HandlerRegistry, type JobHandler } from "./runner";
import { createNamingSubscriptionHandlers } from "./handlers/chatgpt-naming";
import { createNamingJobStore } from "./naming-store";
import { expireStandaloneNamesLeases, reportStandaloneNamesReady, runOneStandaloneNamesJob } from "./standalone-names";

export const LOCAL_WEB_ORIGIN = "http://127.0.0.1:3106";
export const LOCAL_WORKER_ORIGIN = "http://127.0.0.1:3107";
const MAX_BRIDGE_BYTES = 4096;
type Database = Pick<Pool, "query">;
const strategyOperationPolicySchema = z.strictObject({ operation: strategyOperationSchema, policy: chatGPTStrategyPolicySchema });
const namingOperationPolicySchema = z.strictObject({ operation: namingOperationSchema, policy: chatGPTNamingPolicySchema });
const operationPolicySchema = z.union([strategyOperationPolicySchema, namingOperationPolicySchema]);
const bindingFields = { owner_id: z.uuid(), registration_id: z.string().regex(/^[a-f0-9]{64}$/), enabled: z.boolean() };
const bindingSchema = z.union([strategyOperationPolicySchema.extend(bindingFields), namingOperationPolicySchema.extend(bindingFields)])
  .refine(row => row.registration_id === row.policy.registrationId, "Subscription registration binding mismatch");
type Binding = z.infer<typeof bindingSchema>;
type OperationPolicy = z.infer<typeof operationPolicySchema>;
type SubscriptionPolicy = ChatGPTStrategyPolicy | ChatGPTNamingPolicy;
type SubscriptionOperation = OperationPolicy["operation"];
type Selection = { ownerId: string; registrationId: string; model: string; policies: OperationPolicy[] };
const registrationKey = (ownerId: string, registrationId: string) => `${ownerId}:${registrationId}`;

export function readLocalRuntimeConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (env.FLUID_RUNTIME !== "local" || env.VERCEL || env.APP_ORIGIN !== LOCAL_WEB_ORIGIN || !/^[A-Za-z0-9_-]{43,128}$/.test(env.FLUID_LOCAL_BRIDGE_TOKEN ?? "")) throw new Error("Local runtime configuration unavailable");
  return { bridgeToken: env.FLUID_LOCAL_BRIDGE_TOKEN!, connectionApproved: env.FLUID_LOCAL_CONNECTION_APPROVED === "true" };
}

function samePolicy(left: SubscriptionPolicy, right: SubscriptionPolicy) {
  const schema = z.union([chatGPTStrategyPolicySchema, chatGPTNamingPolicySchema]);
  return JSON.stringify(schema.parse(left)) === JSON.stringify(schema.parse(right));
}
function supportsPolicy(policy: SubscriptionPolicy) {
  const limits = policy.limits;
  return limits.maxInputBytes <= CHATGPT_STREAM_LIMITS.maxInputBytes && limits.maxOutputBytes <= CHATGPT_STREAM_LIMITS.maxOutputBytes &&
    limits.deadlineMs <= CHATGPT_STREAM_LIMITS.deadlineMs && limits.maxObservedWebSearchCalls <= CHATGPT_STREAM_LIMITS.maxObservedWebSearchCalls;
}

function selections(rows: readonly Binding[]): Map<string, Selection> {
  const owners = new Map<string, Selection>();
  for (const row of rows) {
    if (!row.enabled) continue;
    if (!supportsPolicy(row.policy)) throw new Error("Unsupported subscription policy");
    const entry = operationPolicySchema.parse({ operation: row.operation, policy: row.policy });
    const existing = owners.get(row.owner_id);
    if (existing) {
      if (existing.registrationId !== row.registration_id || existing.model !== row.policy.model || existing.policies.some(value => value.operation === row.operation)) throw new Error("Mixed subscription policy");
      existing.policies.push(entry);
    } else owners.set(row.owner_id, { ownerId: row.owner_id, registrationId: row.registration_id, model: row.policy.model, policies: [entry] });
  }
  const groups = new Map<string, Selection>();
  for (const selection of owners.values()) {
    // Database row order is not part of the selected operation set.
    selection.policies.sort((left, right) => left.operation.localeCompare(right.operation));
    groups.set(registrationKey(selection.ownerId, selection.registrationId), selection);
  }
  return groups;
}
function sameSelection(left: Selection, right: Selection) {
  return left.ownerId === right.ownerId && left.registrationId === right.registrationId && left.model === right.model &&
    left.policies.length === right.policies.length && left.policies.every((entry, index) => {
      const other = right.policies[index];
      return other?.operation === entry.operation && samePolicy(entry.policy, other.policy);
    });
}

function assertHistoryBinding(input: ChatGPTStrategyJobInput, job: ClaimedJob) {
  if (input.assistantHistory.entries.some(entry => entry.ownerId !== job.ownerId || entry.projectId !== job.projectId ||
    entry.inputRevision > job.inputRevision || entry.jobId === job.id)) throw new Error("Subscription history binding mismatch");
}

/** Restrict this process to an explicit owned subscription registration. */
export class SubscriptionJobStore extends PostgresJobStore {
  constructor(private readonly database: Database, private readonly ownerId: string, private readonly registrationId: string, private readonly policies?: readonly OperationPolicy[]) { super(database); }
  override async claim(workerId: string, leaseSeconds: number) {
    const result = await this.database.query("select * from public.claim_subscription_job($1, $2, $3, $4)", [workerId, this.ownerId, this.registrationId, leaseSeconds]);
    if (!result.rows.length) return null;
    if (result.rows.length !== 1) throw new Error("Subscription claim binding mismatch");
    const job = parseClaimedJob(result.rows[0]);
    if (job.ownerId !== this.ownerId || job.reservedCostMicrousd !== 0 || job.actualCostMicrousd !== 0) throw new Error("Subscription claim binding mismatch");
    let policy: SubscriptionPolicy;
    if (job.operation === "naming.generate") {
      const input = chatGPTNamingJobInputSchema.parse(job.input);
      const batch = input.batch;
      if (batch.ownerId !== job.ownerId || batch.projectId !== job.projectId || batch.jobId !== job.id || batch.contextRevision !== job.inputRevision) throw new Error("Subscription claim binding mismatch");
      policy = input.policy;
    } else {
      strategyOperationSchema.parse(job.operation);
      const input = chatGPTStrategyJobInputSchema.parse(job.input);
      assertHistoryBinding(input, job);
      policy = input.policy;
    }
    if (policy.registrationId !== this.registrationId || !supportsPolicy(policy)) throw new Error("Subscription claim binding mismatch");
    if (this.policies) {
      const selected = this.policies.find(entry => entry.operation === job.operation);
      if (!selected || !samePolicy(selected.policy, policy)) throw new Error("Subscription claim binding mismatch");
    }
    return job;
  }
}

export function createSubscriptionHandlers(options: {
  ownerId: string; policy: ChatGPTStrategyPolicy; operations: readonly StrategyOperation[]; transport: ChatGPTTransport;
  assertReady: (operation: StrategyOperation, policy: ChatGPTStrategyPolicy) => Promise<void>;
  appendPartial: (jobId: string, leaseToken: string, cumulativeText: string) => Promise<void>;
  onQuotaUnavailable?: () => Promise<void>;
  sessionSignal: AbortSignal;
}): HandlerRegistry {
  return new Map(options.operations.map(operation => [operation, { steps(job) {
    const input = chatGPTStrategyJobInputSchema.parse(job.input);
    if (job.ownerId !== options.ownerId || job.operation !== operation || !samePolicy(input.policy, options.policy) || !supportsPolicy(input.policy) || job.reservedCostMicrousd !== 0) throw new Error("Subscription policy mismatch");
    assertHistoryBinding(input, job);
    // Legacy jobs keep their exact recovery key. v2 binds the complete frozen
    // context/history as well as policy, without changing selected policy limits.
    const fingerprint = createHash("sha256").update(JSON.stringify(input.version === 1 ? input.policy : input)).digest("hex").slice(0, 24);
    return [{ key: `strategy-chatgpt-v${input.version}:${operation}:${fingerprint}`, maximumCostMicrousd: 0, timeoutMs: input.policy.limits.deadlineMs,
      async execute({ job, signal }) {
        const combinedSignal = AbortSignal.any([signal, options.sessionSignal]);
        if (combinedSignal.aborted) return { status: "failed", code: "session_unavailable", costMicrousd: 0, providerRequestId: null };
        try { await options.assertReady(operation, input.policy); }
        catch { return { status: "failed", code: "runtime_policy_unavailable", costMicrousd: 0, providerRequestId: null }; }
        let partialText = ""; let persistedText = ""; let lastFlushAt = 0; let flushFailed = false;
        const flush = async () => {
          if (partialText === persistedText || flushFailed) return;
          try {
            await options.assertReady(operation, input.policy);
            await options.appendPartial(job.id, job.leaseToken, partialText);
            persistedText = partialText; lastFlushAt = Date.now();
          } catch (error) { flushFailed = true; throw error; }
        };
        const { maxInputBytes, maxOutputBytes, deadlineMs, maxObservedWebSearchCalls } = input.policy.limits;
        const outcome = await runChatGPTStrategy({ operation, context: input.context, model: input.policy.model, expectedAccountId: input.policy.registrationId,
          assistantHistory: input.assistantHistory,
          transport: options.transport, signal: combinedSignal, limits: { maxInputBytes, maxOutputBytes, deadlineMs, maxObservedWebSearchCalls },
          beforeDispatch: () => options.assertReady(operation, input.policy),
          onPartial: async delta => {
            if (combinedSignal.aborted) throw new Error("Subscription session unavailable");
            partialText += delta;
            // Preserve the first visible fragment, then batch chatty token events.
            // The adapter bounds total memory and each flush rechecks DB policy.
            if (!persistedText || Date.now() - lastFlushAt >= 350 || Buffer.byteLength(partialText.slice(persistedText.length), "utf8") >= 4096) await flush();
          },
        });
        try { await flush(); } catch { /* Retain the full cumulative text in the fenced terminal outcome. */ }
        if (outcome.status === "succeeded") {
          if (flushFailed || combinedSignal.aborted) return { status: "needs_reconciliation", code: "partial_persistence_unavailable", costMicrousd: 0, providerRequestId: outcome.result.responseId,
            result: { billingMode: "chatgpt_subscription", partialText, recovery: "manual_review" } };
          return { status: "succeeded", result: outcome.result, costMicrousd: 0, providerRequestId: outcome.result.responseId };
        }
        if (outcome.recovery === "view_usage") await options.onQuotaUnavailable?.().catch(() => {});
        const retained = outcome.partialText || partialText;
        const providerRequestId = outcome.responseId ?? outcome.requestId;
        if (outcome.status === "needs_reconciliation" || retained) return { status: "needs_reconciliation", code: outcome.code.slice(0, 100), costMicrousd: 0, providerRequestId,
          result: { billingMode: "chatgpt_subscription", partialText: retained, recovery: outcome.recovery } };
        return { status: "failed", code: outcome.code.slice(0, 100), costMicrousd: 0, providerRequestId };
      },
    }];
  } }]));
}

function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
function unavailable() { return json({ error: "integration_unavailable" }, 503); }
function assertCapability(request: Request, token: string) {
  const received = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  return Buffer.byteLength(received) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}
async function bridgeBody(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || request.headers.has("content-encoding")) throw new Error("Invalid body");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_BRIDGE_BYTES) throw new Error("Invalid body");
      chunks.push(item.value);
    }
    return z.strictObject({ ownerId: z.uuid(), input: z.unknown() }).parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Construction has no disk/network side effects. All persistence and credential
 * refresh remains behind the explicit connection approval, including restarts. */
export type ReadinessFailure = {
  phase: "bindings" | "model_catalog" | "readiness_report";
  reason: "timeout" | "connection" | "invalid_response" | "unavailable";
  elapsedMs: number;
};

export function createLocalChatGPTRuntime(options: {
  configuration: ReturnType<typeof readLocalRuntimeConfiguration>; database?: Database;
  manager?: LocalChatGPTSessionManager;
  transport?: (ownerId: string, registrationId: string) => ChatGPTTransport;
  verifiedModels?: Pick<FileVerifiedChatGPTModelStore, "list">;
  onReadinessFailure?: (failure: ReadinessFailure) => void;
  onSignInFailure?: (failure: SignInFailure) => void;
}) {
  const { configuration, database } = options;
  const fences = new Map<string, AbortController>();
  const blocked = new Set<string>();
  const ready = new Map<string, Selection>();
  const ownerGenerations = new Map<string, number>();
  const ownerFlowIds = new Map<string, string>();
  const workerId = `fluid-local-${crypto.randomUUID()}`;
  let closed = false;
  let cycling = false;
  let refreshing: Promise<void> | undefined;
  const requireApproval = () => { if (closed || !configuration.connectionApproved) throw new Error("Connection consent required"); };
  async function observeReadiness<T>(phase: ReadinessFailure["phase"], action: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try { return await action(); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const timeout = code === "ETIMEDOUT" || code === "57014" || error instanceof Error && (error.name === "TimeoutError"
        || /timeout expired|query read timeout/iu.test(error.message)
        || ["Connection terminated due to connection timeout", "timeout exceeded when trying to connect"].includes(error.message));
      const reason: ReadinessFailure["reason"] = timeout ? "timeout"
        : ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(String(code)) ? "connection"
        : error instanceof z.ZodError ? "invalid_response" : "unavailable";
      // Emit only bounded labels and duration. Never pass an error, SQL, owner,
      // registration, model, credential or provider reply to the observer.
      try { options.onReadinessFailure?.({ phase, reason, elapsedMs: Math.round(Math.max(0, performance.now() - started)) }); } catch {}
      throw error;
    }
  }
  function retire(key: string, expectedSignal?: AbortSignal) {
    // Late work from an invalidated session cannot retire its replacement.
    if (expectedSignal && fences.get(key)?.signal !== expectedSignal) return;
    ready.delete(key); fences.get(key)?.abort();
  }
  function reconcileReady(groups: ReadonlyMap<string, Selection>) {
    for (const [key, selected] of ready) {
      const current = groups.get(key);
      if (!current || !sameSelection(selected, current)) retire(key);
    }
  }
  function invalidate(ownerId: string, registrationId: string) {
    const key = registrationKey(ownerId, registrationId);
    ownerGenerations.set(ownerId, (ownerGenerations.get(ownerId) ?? 0) + 1);
    blocked.add(key); retire(key);
  }
  const manager = options.manager ?? createLocalChatGPTSessionManager({ store: new FileChatGPTCredentialStore(), onSessionInvalidated: invalidate, onSignInFailure: options.onSignInFailure });
  const verifiedModels = options.verifiedModels ?? new FileVerifiedChatGPTModelStore();
  const transport = (ownerId: string, registrationId: string, connectionAction = false) => options.transport?.(ownerId, registrationId) ?? createChatGPTTransport({ getSession: async () => {
    requireApproval();
    if (!connectionAction && blocked.has(registrationKey(ownerId, registrationId))) throw new Error("Subscription session unavailable");
    const credential = await manager.getInferenceCredential(ownerId, registrationId);
    return { accountId: credential.registrationId, accessToken: credential.accessToken, expiresAt: credential.expiresAt, scopes: credential.scopes };
  }, getVerifiedModels: async accountId => {
    requireApproval();
    if (accountId !== registrationId) throw new Error("Subscription account changed");
    return verifiedModels.list(ownerId, registrationId);
  } });
  async function bindings(): Promise<Binding[]> {
    if (!database || !configuration.connectionApproved || closed) return [];
    return observeReadiness("bindings", async () => {
      const result = await database.query("select * from public.get_subscription_runtime_bindings()", []);
      return z.array(bindingSchema).max(500).parse(result.rows);
    });
  }
  async function assertReady(ownerId: string, operation: SubscriptionOperation, policy: SubscriptionPolicy) {
    requireApproval();
    operationPolicySchema.parse({ operation, policy });
    if (!database || blocked.has(registrationKey(ownerId, policy.registrationId))) throw new Error("Subscription runtime unavailable");
    await observeReadiness("readiness_report", async () => {
      const result = await database.query("select public.report_subscription_worker_ready($1, $2, $3, $4, $5) as ready", [ownerId, policy.registrationId, operation, JSON.stringify(policy), 60]);
      if (result.rows.length !== 1 || result.rows[0]?.ready !== true) throw new Error("Subscription policy unavailable");
    });
  }
  async function assertSelectionCurrent(selection: Selection, sessionSignal: AbortSignal) {
    const key = registrationKey(selection.ownerId, selection.registrationId);
    try {
      requireApproval();
      if (sessionSignal.aborted || blocked.has(key)) throw new Error("Subscription session unavailable");
      const groups = selections(await bindings());
      reconcileReady(groups);
      const current = groups.get(key);
      if (!current || !sameSelection(selection, current) || sessionSignal.aborted) throw new Error("Subscription selection changed");
    } catch (error) { retire(key, sessionSignal); throw error; }
  }
  async function disable(ownerId: string, registrationId: string) {
    invalidate(ownerId, registrationId);
    if (database) await database.query("select public.disable_subscription_runtime($1, $2)", [ownerId, registrationId]);
  }
  async function status(ownerId: string): Promise<LocalChatGPTStatus> {
    const base = { connectionAllowed: configuration.connectionApproved, registrations: [], selectedRegistrationId: null, model: null, workerReady: false,
      images: { status: "unavailable", reason: "spending_limit_required" } } as const;
    if (!configuration.connectionApproved || closed) return localChatGPTStatusSchema.parse(base);
    const registrations = await manager.listRegistrations(ownerId);
    let selection: Selection | undefined;
    try {
      const groups = selections(await bindings());
      reconcileReady(groups);
      selection = [...groups.values()].find(group => group.ownerId === ownerId);
    } catch { for (const key of ready.keys()) retire(key); }
    const key = selection && registrationKey(ownerId, selection.registrationId);
    return localChatGPTStatusSchema.parse({ ...base, registrations, selectedRegistrationId: selection?.registrationId ?? null, model: selection?.model ?? null,
      workerReady: Boolean(key && selection && ready.has(key) && sameSelection(ready.get(key)!, selection) && !blocked.has(key) && !fences.get(key)?.signal.aborted) });
  }
  async function refreshReadiness() {
    if (refreshing) return refreshing;
    if (!configuration.connectionApproved || !database || closed) return;
    refreshing = (async () => {
      let groups: Map<string, Selection>;
      try {
        groups = selections(await bindings());
        reconcileReady(groups);
      } catch { for (const key of ready.keys()) retire(key); return; }
      for (const [key, selection] of groups) {
        if (blocked.has(key)) continue;
        const initialGeneration = ownerGenerations.get(selection.ownerId) ?? 0;
        try {
          await observeReadiness("model_catalog", async () => {
            const catalog = await transport(selection.ownerId, selection.registrationId).listModels(AbortSignal.timeout(20_000));
            if (catalog.accountId !== selection.registrationId || !catalog.models.some(model => model.slug === selection.model)) throw new Error("Selected model unavailable");
          });
          for (const entry of selection.policies) {
            await assertReady(selection.ownerId, entry.operation, entry.policy);
            if (entry.operation === "naming.generate") await reportStandaloneNamesReady(database, entry.policy);
          }
          const currentGroups = selections(await bindings());
          reconcileReady(currentGroups);
          const current = currentGroups.get(key);
          if (closed || blocked.has(key) || initialGeneration !== (ownerGenerations.get(selection.ownerId) ?? 0) || !current || !sameSelection(current, selection)) throw new Error("Subscription selection changed");
          if (!fences.get(key) || fences.get(key)!.signal.aborted) fences.set(key, new AbortController());
          ready.set(key, selection);
        } catch { retire(key); }
      }
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }
  async function tick(signal: AbortSignal) {
    if (cycling || closed || !configuration.connectionApproved || !database || signal.aborted) return;
    cycling = true;
    try {
      await new PostgresJobStore(database).expireLeases();
      await expireStandaloneNamesLeases(database);
      for (const [key, selection] of ready) {
        if (signal.aborted || closed || blocked.has(key)) break;
        const controller = fences.get(key);
        if (!controller || controller.signal.aborted) continue;
        try { await assertSelectionCurrent(selection, controller.signal); } catch { continue; }
        const selectedGeneration = ownerGenerations.get(selection.ownerId) ?? 0;
        const shared = { ownerId: selection.ownerId, transport: transport(selection.ownerId, selection.registrationId), sessionSignal: controller.signal,
          assertReady: async (operation: SubscriptionOperation, policy: SubscriptionPolicy) => {
            await assertSelectionCurrent(selection, controller.signal);
            const selected = selection.policies.find(entry => entry.operation === operation);
            if (!selected || !samePolicy(selected.policy, policy)) throw new Error("Subscription operation changed");
            try { await assertReady(selection.ownerId, operation, policy); }
            catch (error) { retire(key, controller.signal); throw error; }
            if (controller.signal.aborted) throw new Error("Subscription session unavailable");
          },
          onQuotaUnavailable: async () => {
            const current = ready.get(key);
            if (controller.signal.aborted || fences.get(key) !== controller || selectedGeneration !== (ownerGenerations.get(selection.ownerId) ?? 0) || !current || !sameSelection(current, selection)) return;
            await disable(selection.ownerId, selection.registrationId);
          },
          appendPartial: async (jobId: string, leaseToken: string, text: string) => {
            const result = await database.query("select public.append_subscription_partial($1, $2, $3) as saved", [jobId, leaseToken, text]);
            if (result.rows.length !== 1 || result.rows[0]?.saved !== true) throw new Error("Partial result unavailable");
          },
        };
        const handlers = new Map<string, JobHandler>();
        for (const entry of selection.policies) {
          const operationHandlers = entry.operation === "naming.generate"
            ? createNamingSubscriptionHandlers({ ...shared, policy: entry.policy })
            : createSubscriptionHandlers({ ...shared, policy: entry.policy, operations: [entry.operation] });
          for (const [operation, handler] of operationHandlers) handlers.set(operation, handler);
        }
        const store = createNamingJobStore(new SubscriptionJobStore(database, selection.ownerId, selection.registrationId, selection.policies), database);
        await runOneJob({ store, handlers, workerId, signal: AbortSignal.any([signal, controller.signal]) });
        const standalonePolicy = selection.policies.find((entry): entry is Extract<OperationPolicy, { operation: "naming.generate" }> => entry.operation === "naming.generate");
        if (standalonePolicy) await runOneStandaloneNamesJob({ database, ownerId: selection.ownerId, policy: standalonePolicy.policy,
          transport: shared.transport, signal: AbortSignal.any([signal, controller.signal]),
          assertReady: () => shared.assertReady("naming.generate", standalonePolicy.policy), onQuotaUnavailable: shared.onQuotaUnavailable });
      }
    } finally { cycling = false; }
  }
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== LOCAL_WORKER_ORIGIN || request.headers.get("host") !== "127.0.0.1:3107") return json({ error: "forbidden_origin" }, 403);
    if (url.pathname === "/auth/callback" && request.method === "GET") {
      let result = "error";
      let phase: SignInFailure["phase"] = "approval";
      try {
        requireApproval();
        phase = "session_completion";
        const completed = await manager.completeSignIn({ callbackUrl: url.href });
        phase = "runtime_detach";
        await disable(completed.ownerId, completed.registration.registrationId);
        // A valid connection alone never chooses a model or enables jobs.
        blocked.delete(registrationKey(completed.ownerId, completed.registration.registrationId));
        result = "connected";
      } catch (error) {
        // The internal manager reports its precise failure once. Injected managers
        // have no observer contract, so use the bounded completion fallback.
        if (phase !== "session_completion" || options.manager) reportSignInFailure(phase, error, options.onSignInFailure);
        // Never reflect callback query parameters or provider errors.
      }
      return new Response(null, { status: 303, headers: { Location: `${LOCAL_WEB_ORIGIN}/settings?chatgpt=${result}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }
    if (url.search || request.method !== "POST" || !/^\/bridge\/(status|models|sign-in|select-model|sign-out)$/.test(url.pathname)) return json({ error: "not_found" }, 404);
    if (request.headers.has("origin") || request.headers.get("sec-fetch-site") === "cross-site" || !assertCapability(request, configuration.bridgeToken)) return json({ error: "forbidden_origin" }, 403);
    let body: Awaited<ReturnType<typeof bridgeBody>>;
    try { body = await bridgeBody(request); } catch { return json({ error: "invalid_request" }, 422); }
    const action = url.pathname.slice("/bridge/".length);
    try {
      if (action === "status") { z.strictObject({}).parse(body.input); return json(await status(body.ownerId)); }
      requireApproval();
      if (action === "sign-in") {
        const input = localSignInSchema.parse(body.input);
        // This is an in-memory owner flow ID, not a browser credential. Explicit
        // retries replace this owner's pending flow and preserve OAuth retry binding.
        if (!ownerFlowIds.has(body.ownerId)) {
          if (ownerFlowIds.size >= 100) return unavailable();
          ownerFlowIds.set(body.ownerId, randomBytes(32).toString("base64url"));
        }
        const started = await manager.beginSignIn({ ownerId: body.ownerId, browserSessionId: ownerFlowIds.get(body.ownerId)!, redirectUri: `${LOCAL_WORKER_ORIGIN}/auth/callback`, ...input });
        return json({ authorizationUrl: started.authorizationUrl });
      }
      if (action === "sign-out") {
        const { registrationId } = localRegistrationSelectionSchema.parse(body.input);
        // Confirm ownership before touching a selected runtime or revoking tokens.
        if (!(await manager.listRegistrations(body.ownerId)).some(item => item.registrationId === registrationId)) return json({ error: "not_found" }, 404);
        await disable(body.ownerId, registrationId);
        const result = await manager.signOut(body.ownerId, registrationId);
        return json({ disconnected: true, remoteRevocationConfirmed: result.remoteRevocationConfirmed });
      }
      const input = action === "models" ? localRegistrationSelectionSchema.parse(body.input) : localModelSelectionSchema.parse(body.input);
      const initialGeneration = ownerGenerations.get(body.ownerId) ?? 0;
      if (!(await manager.listRegistrations(body.ownerId)).some(item => item.registrationId === input.registrationId && item.planUsageEnabled)) return json({ error: "not_found" }, 404);
      const key = registrationKey(body.ownerId, input.registrationId);
      // Discovery may inspect a reauthorized connection, but only successful
      // explicit model selection can clear an earlier dispatch fence.
      const catalog = await transport(body.ownerId, input.registrationId, true).listModels(AbortSignal.timeout(20_000));
      if (catalog.accountId !== input.registrationId) throw new Error("Account changed");
      if (action === "models") return json({ registrationId: input.registrationId, models: catalog.models });
      if (!database || !("model" in input) || !catalog.models.some(model => model.slug === input.model)) return unavailable();
      const policy = chatGPTStrategyPolicySchema.parse({ version: 1, billingMode: "chatgpt_subscription", handlerVersion: "strategy-chatgpt-v1", registrationId: input.registrationId, model: input.model, limits: DEFAULT_SUBSCRIPTION_LIMITS });
      const namingPolicy = chatGPTNamingPolicySchema.parse({ ...policy, handlerVersion: "naming-chatgpt-v1", limits: { ...policy.limits, maxObservedWebSearchCalls: 0 } });
      const policies: OperationPolicy[] = [...strategyOperationSchema.options.map(operation => ({ operation, policy })), { operation: "naming.generate", policy: namingPolicy }];
      const existingBindings = await bindings();
      if (initialGeneration !== (ownerGenerations.get(body.ownerId) ?? 0)) throw new Error("Connection changed");
      const registrations = new Set(existingBindings.filter(existing => existing.owner_id === body.ownerId && existing.enabled).map(existing => existing.registration_id));
      registrations.add(input.registrationId);
      for (const registrationId of registrations) invalidate(body.ownerId, registrationId);
      const selectedGeneration = ownerGenerations.get(body.ownerId) ?? 0;
      const configured = await database.query("select public.configure_subscription_runtime($1, $2::jsonb) as configured", [body.ownerId, JSON.stringify(policies)]);
      if (configured.rows.length !== 1 || configured.rows[0]?.configured !== true) throw new Error("Subscription configuration unavailable");
      if (closed || selectedGeneration !== (ownerGenerations.get(body.ownerId) ?? 0)) { await disable(body.ownerId, input.registrationId); throw new Error("Connection changed"); }
      blocked.delete(key);
      await refreshReadiness();
      return json(await status(body.ownerId));
    } catch (error) { return error instanceof z.ZodError ? json({ error: "invalid_request" }, 422) : unavailable(); }
  }
  return { handle, status, refreshReadiness, tick, invalidate,
    close() { closed = true; ready.clear(); ownerFlowIds.clear(); for (const fence of fences.values()) fence.abort(); },
  };
}
