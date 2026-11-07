import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Pool, type ClientBase } from "pg";
vi.mock("server-only", () => ({}));
vi.mock("../../src/server/ai/chatgpt-strategy", () => ({ runChatGPTStrategy: vi.fn() }));
import { createLocalChatGPTRuntime, createSubscriptionHandlers, LOCAL_WORKER_ORIGIN, readLocalRuntimeConfiguration, SubscriptionJobStore } from "../../worker/local-chatgpt";
import { runChatGPTStrategy } from "../../src/server/ai/chatgpt-strategy";
import type { ChatGPTTransport } from "../../src/server/ai/chatgpt-transport";
import type { LocalChatGPTSessionManager } from "../../src/server/local-chatgpt/session";
import { LocalChatGPTError } from "../../src/server/local-chatgpt/oauth";
import type { SignInFailure } from "../../src/server/local-chatgpt/sign-in-diagnostics";
import { DEFAULT_SUBSCRIPTION_LIMITS, strategyOperationSchema, type ChatGPTStrategyPolicy, type ChatGPTStrategyResult } from "../../src/domain/strategy-jobs";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { chatGPTNamingJobInputSchema, type ChatGPTNamingPolicy } from "../../src/domain/naming-jobs";
import { namingStrategyBasis, namingStrategyKey } from "../../src/domain/project-naming";
import type { ClaimedJob } from "../../src/domain/jobs";

// Synthetic process, account, database and provider fixtures. No credentials or
// listeners are created and no real network request is made by these tests.
const ownerId = "5d01417c-342d-4d02-8211-c5fec00e3749";
const otherOwner = "8d01417c-342d-4d02-8211-c5fec00e3749";
const registrationId = "a".repeat(64);
const token = "synthetic_ephemeral_capability_" + "b".repeat(32);
const configuration = { bridgeToken: token, connectionApproved: true };
const policy: ChatGPTStrategyPolicy = { version: 1, billingMode: "chatgpt_subscription", handlerVersion: "strategy-chatgpt-v1", registrationId, model: "fixture-model", limits: DEFAULT_SUBSCRIPTION_LIMITS };
const namingPolicy: ChatGPTNamingPolicy = { ...policy, handlerVersion: "naming-chatgpt-v1", limits: { ...DEFAULT_SUBSCRIPTION_LIMITS, maxObservedWebSearchCalls: 0 } };
// The subscription runtime admits the five operations its SQL knows; the guided slogan is shared-worker only.
const subscriptionOperations = strategyOperationSchema.options.filter(operation => operation !== "strategy.slogan");
function policies() { return [...subscriptionOperations.map(operation => ({ operation, policy })), { operation: "naming.generate" as const, policy: namingPolicy }]; }
function bindings() { return policies().map(entry => ({ ...entry, owner_id: ownerId, registration_id: registrationId, enabled: true })); }
const registration = { registrationId, email: "fixture@example.invalid", planUsageEnabled: true };
function request(action: string, input: unknown = {}, overrides: { owner?: string; headers?: Record<string, string>; method?: string; body?: string } = {}) {
  return new Request(`${LOCAL_WORKER_ORIGIN}/bridge/${action}`, { method: overrides.method ?? "POST",
    headers: { Host: "127.0.0.1:3107", "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...overrides.headers },
    body: overrides.body ?? JSON.stringify({ ownerId: overrides.owner ?? ownerId, input }),
  });
}
function fixture(onReadinessFailure?: (event: unknown) => void, onSignInFailure?: (event: SignInFailure) => void) {
  const calls: string[] = [];
  let bindingRows: unknown[] = [];
  let queuedJob: ClaimedJob | null = null, activeJob: ClaimedJob | null = null;
  const query = vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    calls.push(sql);
    if (sql.includes("get_subscription_runtime_bindings")) return { rows: bindingRows as Record<string, unknown>[] };
    if (sql.includes("configure_subscription_runtime")) {
      const selected = JSON.parse(values[1] as string);
      const entries = Array.isArray(selected) ? selected : subscriptionOperations.map(operation => ({ operation, policy: selected }));
      bindingRows = entries.map(entry => ({ owner_id: values[0], registration_id: entry.policy.registrationId, ...entry, enabled: true }));
      return { rows: [{ configured: true }] };
    }
    if (sql.includes("report_subscription_worker_ready")) return { rows: [{ ready: true }] };
    if (sql.includes("disable_subscription_runtime")) { bindingRows = []; return { rows: [] }; }
    if (sql.includes("expire_job_leases")) return { rows: [{ count: 0 }] };
    if (sql.includes("append_subscription_partial")) return { rows: [{ saved: true }] };
    if (sql.includes("claim_subscription_job")) { activeJob = queuedJob; queuedJob = null; return { rows: activeJob ? [jobRow(activeJob)] : [] }; }
    if (sql.includes("heartbeat_job")) return { rows: activeJob ? [jobRow(activeJob)] : [] };
    return { rows: [] };
  });
  const manager: LocalChatGPTSessionManager = {
    listRegistrations: vi.fn(async owner => owner === ownerId ? [registration] : []),
    beginSignIn: vi.fn(async () => ({ authorizationUrl: "https://auth.openai.com/api/accounts/authorize?synthetic=1", expiresAt: 2000000000000 })),
    completeSignIn: vi.fn(async () => ({ ownerId, registration })),
    getInferenceCredential: vi.fn(async () => ({ registrationId, subject: "synthetic-subject", clientId: "synthetic-client", accessToken: "synthetic-not-a-real-token", expiresAt: 2000000000000, scopes: ["chatgpt.tokens.use.direct", "resource.invoke"] })),
    signOut: vi.fn(async () => { calls.push("sign-out-tokens"); return { registration: { ...registration, planUsageEnabled: false }, remoteRevocationConfirmed: true }; }),
  };
  const transport: ChatGPTTransport = { listModels: vi.fn(async () => ({ accountId: registrationId, models: [{ slug: "fixture-model", displayName: "Synthetic fixture model" }] })), streamResponse: vi.fn() };
  const database = { query } as unknown as Pick<Pool, "query">;
  const runtime = createLocalChatGPTRuntime({ configuration, database, manager, transport: () => transport, onReadinessFailure, onSignInFailure });
  return { runtime, manager, transport, database, query, calls, setBindings(rows: unknown[]) { bindingRows = rows; }, setClaim(value: ClaimedJob) { queuedJob = value; } };
}
function jobRow(current: ClaimedJob): Record<string, unknown> {
  return { id: current.id, owner_id: current.ownerId, project_id: current.projectId, operation: current.operation, input: current.input,
    input_revision: current.inputRevision, lease_token: current.leaseToken, state: current.status, reserved_cost_microusd: current.reservedCostMicrousd, actual_cost_microusd: current.actualCostMicrousd };
}
function job(): ClaimedJob {
  return { id: "4d01417c-342d-4d02-8211-c5fec00e3749", ownerId, projectId: "6d01417c-342d-4d02-8211-c5fec00e3749", operation: "strategy.reformulate", inputRevision: 1,
    leaseToken: "7d01417c-342d-4d02-8211-c5fec00e3749", status: "running", reservedCostMicrousd: 0, actualCostMicrousd: 0,
    input: { version: 1, billingMode: "chatgpt_subscription", context: contextSnapshotSchema.parse({ description: "Synthetic workshop fixture" }), policy } };
}
function namingJob(): ClaimedJob {
  const current = job(), context = contextSnapshotSchema.parse({ description: "Synthetic naming runtime fixture" });
  return { ...current, operation: "naming.generate", input: structuredClone(chatGPTNamingJobInputSchema.parse({ version: 1, billingMode: "chatgpt_subscription", context, policy: namingPolicy,
    batch: { id: "3d01417c-342d-4d02-8211-c5fec00e3749", ownerId, projectId: current.projectId, jobId: current.id, contextRevision: current.inputRevision,
      strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), preferencesVersion: 1,
      preferences: { version: 1, creativeLocale: "en-US", notes: "", minimumGraphemes: null, maximumGraphemes: null }, favoritesSnapshot: [],
      acceptedPolicyIdentity: "c".repeat(64), targetCount: 100, sequence: 1, createdAt: "2026-10-04T10:00:00Z" }, exclusionSnapshot: [], exclusionKeys: [] })) };
}
const result: ChatGPTStrategyResult = { version: 1, provider: "openai", billingMode: "chatgpt_subscription", model: "fixture-model", operation: "strategy.reformulate",
  responseId: "resp_fixture", requestId: "req_fixture", generatedAt: "2026-10-03T00:00:00Z", usage: null,
  proposal: { message: "Synthetic result", activity: "Workshop", offering: "Classes", knownAudience: "", questions: [] } };
beforeEach(() => { vi.mocked(runChatGPTStrategy).mockReset(); });

describe("local-only worker bridge boundaries", () => {
  it("requires exact local environment, host configuration and ephemeral capability", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", FLUID_RUNTIME: "local", APP_ORIGIN: "http://127.0.0.1:3106", FLUID_LOCAL_BRIDGE_TOKEN: token };
    expect(readLocalRuntimeConfiguration(env)).toEqual({ bridgeToken: token, connectionApproved: false });
    for (const patch of [{ VERCEL: "1" }, { FLUID_RUNTIME: "remote" }, { APP_ORIGIN: "http://localhost:3106" }, { FLUID_LOCAL_BRIDGE_TOKEN: "short" }]) expect(() => readLocalRuntimeConfiguration({ ...env, ...patch })).toThrow();
  });
  it.each<Record<string, string>>([{ Host: "evil.invalid" }, { Authorization: `Bearer ${token}x` }, { Authorization: `Bearer ${"x".repeat(token.length)}` }, { Origin: "http://127.0.0.1:3106" }, { "Sec-Fetch-Site": "cross-site" }])("rejects untrusted requests before reading credentials (%j)", async headers => {
    const { runtime, manager } = fixture();
    expect((await runtime.handle(request("status", {}, { headers }))).status).toBe(403);
    expect(manager.listRegistrations).not.toHaveBeenCalled();
  });
  it.each(["{", JSON.stringify({ ownerId, input: {}, owner: otherOwner }), JSON.stringify({ ownerId, input: { extra: true } }), JSON.stringify({ ownerId, input: {}, padding: "é".repeat(3000) })])("rejects malformed, extra and oversized bodies", async body => {
    const { runtime, manager } = fixture();
    expect((await runtime.handle(request("status", {}, { body }))).status).toBe(422);
    expect(manager.listRegistrations).not.toHaveBeenCalled();
  });
  it("does not touch a credential store, refresh or DB while approval is false", async () => {
    const fixtureState = fixture();
    const runtime = createLocalChatGPTRuntime({ configuration: { ...configuration, connectionApproved: false }, manager: fixtureState.manager, database: fixtureState.database });
    expect(await (await runtime.handle(request("status"))).json()).toMatchObject({ connectionAllowed: false, registrations: [], workerReady: false });
    for (const action of ["sign-in", "models", "select-model", "sign-out"]) expect((await runtime.handle(request(action, { registrationId }))).status).toBe(503);
    await runtime.refreshReadiness(); await runtime.tick(new AbortController().signal);
    for (const method of Object.values(fixtureState.manager)) expect(method).not.toHaveBeenCalled();
    expect(fixtureState.query).not.toHaveBeenCalled();
  });
  it("missing DB remains an explicit unavailable worker without credential refresh", async () => {
    const { manager } = fixture();
    const runtime = createLocalChatGPTRuntime({ configuration, manager });
    expect(await runtime.status(ownerId)).toMatchObject({ registrations: [registration], workerReady: false, selectedRegistrationId: null });
    expect(manager.getInferenceCredential).not.toHaveBeenCalled();
  });
  it("uses a stable bounded in-memory owner flow ID across explicit retries", async () => {
    const { runtime, manager } = fixture();
    expect((await runtime.handle(request("sign-in"))).status).toBe(200);
    expect((await runtime.handle(request("sign-in"))).status).toBe(200);
    const calls = vi.mocked(manager.beginSignIn).mock.calls;
    expect(calls[0]![0]).toMatchObject({ ownerId, redirectUri: `${LOCAL_WORKER_ORIGIN}/auth/callback` });
    expect(calls[0]![0].browserSessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls[1]![0].browserSessionId).toBe(calls[0]![0].browserSessionId);
  });
  it("callback resolves ownership through manager state and never enables jobs", async () => {
    const onSignInFailure = vi.fn();
    const { runtime, manager, query } = fixture(undefined, onSignInFailure);
    const response = await runtime.handle(new Request(`${LOCAL_WORKER_ORIGIN}/auth/callback?state=fixture&code=synthetic-private-code`, { headers: { Host: "127.0.0.1:3107" } }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3106/settings?chatgpt=connected");
    expect(manager.completeSignIn).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => sql.includes("configure_subscription_runtime"))).toBe(false);
    expect(onSignInFailure).not.toHaveBeenCalled();
    expect(await response.text()).toBe("");
  });
  it.each([false, true])("reports approval failure without completing a session (closed: %s)", async closed => {
    const f = fixture(), observer = vi.fn();
    const runtime = createLocalChatGPTRuntime({ configuration: { ...configuration, connectionApproved: closed },
      manager: f.manager, database: f.database, onSignInFailure: observer });
    if (closed) runtime.close();
    const response = await runtime.handle(new Request(`${LOCAL_WORKER_ORIGIN}/auth/callback?state=synthetic-secret`, { headers: { Host: "127.0.0.1:3107" } }));
    expect(observer.mock.calls).toEqual([[{ phase: "approval", reason: "unavailable" }]]);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3106/settings?chatgpt=error");
    expect(f.manager.completeSignIn).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
    runtime.close();
  });

  it.each([false, true])("forwards the internal manager's precise failure exactly once (observer throws: %s)", async throws => {
    const observer = vi.fn(() => { if (throws) throw new Error("synthetic-secret-observer"); });
    const runtime = createLocalChatGPTRuntime({ configuration, onSignInFailure: observer });
    try {
      // Unknown state is rejected in memory, without opening any credential file or contacting a provider.
      const response = await runtime.handle(new Request(`${LOCAL_WORKER_ORIGIN}/auth/callback?state=synthetic-secret&code=synthetic-secret-code`, { headers: { Host: "127.0.0.1:3107" } }));
      expect(observer.mock.calls).toEqual([[{ phase: "callback_validation", reason: "invalid_callback" }]]);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("http://127.0.0.1:3106/settings?chatgpt=error");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await response.text()).toBe("");
    } finally { runtime.close(); }
  });

  it.each(["known", "unknown", "forged", "getter"])("reports an injected manager's %s error only as a bounded completion category", async kind => {
    const observer = vi.fn(() => { throw new Error("synthetic-secret-observer"); });
    const f = fixture(undefined, observer);
    const readSecret = vi.fn(() => { throw new Error("synthetic-secret-getter"); });
    const error = kind === "known" ? new LocalChatGPTError("invalid_identity")
      : kind === "unknown" ? new Error("synthetic-secret-provider-error")
      : kind === "forged" ? Object.defineProperty(new LocalChatGPTError("invalid_client"), "code", { value: "synthetic-secret-code" })
      : Object.defineProperties(new LocalChatGPTError("invalid_client"), { code: { get: readSecret }, message: { get: readSecret } });
    vi.mocked(f.manager.completeSignIn).mockRejectedValue(error);
    const response = await f.runtime.handle(new Request(`${LOCAL_WORKER_ORIGIN}/auth/callback?state=synthetic-secret-state&code=synthetic-secret-code`, { headers: { Host: "127.0.0.1:3107" } }));
    expect(observer.mock.calls).toEqual([[{ phase: "session_completion", reason: kind === "known" ? "invalid_identity" : "unavailable" }]]);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3106/settings?chatgpt=error");
    expect(await response.text()).toBe("");
    expect(readSecret).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
    expect(f.manager.completeSignIn).toHaveBeenCalledOnce();
  });

  it("reports runtime detach failure after session completion without enabling jobs or retrying", async () => {
    const observer = vi.fn();
    const f = fixture(undefined, observer);
    f.query.mockRejectedValue(Object.assign(new Error("synthetic-secret-db-connection"), { code: "synthetic-secret-db-code" }));
    const response = await f.runtime.handle(new Request(`${LOCAL_WORKER_ORIGIN}/auth/callback?state=synthetic-secret-state&code=synthetic-secret-code`, { headers: { Host: "127.0.0.1:3107" } }));
    expect(observer.mock.calls).toEqual([[{ phase: "runtime_detach", reason: "unavailable" }]]);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3106/settings?chatgpt=error");
    expect(f.manager.completeSignIn).toHaveBeenCalledOnce(); expect(f.query).toHaveBeenCalledOnce();
    expect(f.query.mock.calls[0]![0]).toContain("disable_subscription_runtime");
    expect(f.transport.streamResponse).not.toHaveBeenCalled();
  });

  it("callback errors only redirect to the fixed local error page", async () => {
    const { runtime, manager } = fixture();
    vi.mocked(manager.completeSignIn).mockRejectedValue(new Error("synthetic-private-provider-error"));
    const response = await runtime.handle(new Request(`${LOCAL_WORKER_ORIGIN}/auth/callback?state=secret`, { headers: { Host: "127.0.0.1:3107" } }));
    expect(response.headers.get("location")).toBe("http://127.0.0.1:3106/settings?chatgpt=error");
    expect(await response.text()).not.toContain("secret");
  });
});

describe("owned local subscription selection and worker readiness", () => {
  it.each([
    "Connection terminated due to connection timeout",
    "timeout exceeded when trying to connect",
    "timeout expired",
    "Query read timeout",
  ])("classifies installed pg timeout message %s without logging it", async message => {
    const events: unknown[] = [];
    const f = fixture(event => events.push(event));
    f.query.mockRejectedValue(new Error(message));
    await f.runtime.refreshReadiness();
    expect(events).toEqual([{ phase: "bindings", reason: "timeout", elapsedMs: expect.any(Number) }]);
    expect(JSON.stringify(events)).not.toContain(message);
    expect((await f.runtime.status(ownerId)).workerReady).toBe(false);
    expect(f.transport.streamResponse).not.toHaveBeenCalled();
  });
  it("classifies the actual installed pool connection timeout with a socket-free client", async () => {
    class SilentClient extends EventEmitter {
      private complete?: (error: Error) => void;
      connection = { stream: { destroy: () => this.complete?.(new Error("synthetic socket-free termination")) } };
      connect(complete: (error: Error) => void) { this.complete = complete; }
    }
    const events: unknown[] = [];
    const f = fixture();
    const database = new Pool({ Client: SilentClient as unknown as new () => ClientBase, connectionTimeoutMillis: 5 });
    const runtime = createLocalChatGPTRuntime({ configuration, database, manager: f.manager, transport: () => f.transport, onReadinessFailure: event => events.push(event) });
    try {
      await runtime.refreshReadiness();
      expect(events).toEqual([{ phase: "bindings", reason: "timeout", elapsedMs: expect.any(Number) }]);
      expect(f.transport.listModels).not.toHaveBeenCalled();
      expect(f.transport.streamResponse).not.toHaveBeenCalled();
    } finally { runtime.close(); await database.end(); }
  });
  it("reports a redacted bindings timeout and stays fenced until a successful readiness check", async () => {
    const events: unknown[] = [];
    const f = fixture(event => events.push(event));
    f.setBindings(bindings());
    await f.runtime.refreshReadiness();
    const normal = f.query.getMockImplementation()!;
    let unavailable = true;
    f.query.mockImplementation(async (sql, values) => {
      if (unavailable && sql.includes("get_subscription_runtime_bindings")) {
        throw Object.assign(new Error("timeout expired; private credentials and query details"), { code: "ETIMEDOUT", detail: "private" });
      }
      return normal(sql, values);
    });
    await f.runtime.refreshReadiness();
    expect(events).toEqual([{ phase: "bindings", reason: "timeout", elapsedMs: expect.any(Number) }]);
    expect(JSON.stringify(events)).not.toMatch(/private|credentials|query|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    await f.runtime.tick(new AbortController().signal);
    expect(f.calls.some(sql => sql.includes("claim_subscription_job"))).toBe(false);
    unavailable = false;
    expect((await f.runtime.status(ownerId)).workerReady).toBe(false);
    await f.runtime.refreshReadiness();
    expect((await f.runtime.status(ownerId)).workerReady).toBe(true);
    expect(f.transport.streamResponse).not.toHaveBeenCalled();
  });
  it.each(["model_catalog", "readiness_report"] as const)("identifies %s failures without weakening admission", async phase => {
    const events: unknown[] = [];
    const f = fixture(event => events.push(event)); f.setBindings(bindings());
    if (phase === "model_catalog") vi.mocked(f.transport.listModels).mockRejectedValue(new Error("secret provider reply"));
    else {
      const normal = f.query.getMockImplementation()!;
      f.query.mockImplementation(async (sql, values) => sql.includes("report_subscription_worker_ready") ? { rows: [{ ready: "true" }] } : normal(sql, values));
    }
    await f.runtime.refreshReadiness();
    expect(events).toEqual([{ phase, reason: "unavailable", elapsedMs: expect.any(Number) }]);
    expect((await f.runtime.status(ownerId)).workerReady).toBe(false);
    expect(f.transport.streamResponse).not.toHaveBeenCalled();
  });
  it("an observer failure cannot prevent readiness fencing", async () => {
    const f = fixture(() => { throw new Error("synthetic observer failure"); });
    f.setBindings(bindings()); await f.runtime.refreshReadiness();
    f.query.mockRejectedValue(Object.assign(new Error("private connection error"), { code: "ECONNRESET" }));
    await expect(f.runtime.refreshReadiness()).resolves.toBeUndefined();
    expect((await f.runtime.status(ownerId)).workerReady).toBe(false);
    expect(f.transport.streamResponse).not.toHaveBeenCalled();
  });
  it("uses the same owner-scoped supplementary catalog for the dropdown, explicit selection and readiness", async () => {
    const f = fixture();
    const models = ["fixture-omitted-one", "fixture-omitted-two", "fixture-omitted-three"].map(slug => ({ slug, displayName: slug }));
    const verifiedModels = { list: vi.fn(async (owner: string, registration: string) => owner === ownerId && registration === registrationId ? models : []) };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ models: [] }));
    vi.stubGlobal("fetch", fetcher);
    const runtime = createLocalChatGPTRuntime({ configuration, database: f.database, manager: f.manager, verifiedModels });
    try {
      expect(await (await runtime.handle(request("models", { registrationId }))).json()).toEqual({ registrationId, models });
      expect((await runtime.handle(request("models", { registrationId }, { owner: otherOwner }))).status).toBe(404);
      expect((await runtime.handle(request("models", { registrationId: "b".repeat(64) }))).status).toBe(404);
      const response = await runtime.handle(request("select-model", { registrationId, model: models[0]!.slug }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ selectedRegistrationId: registrationId, model: models[0]!.slug, workerReady: true });
      expect(verifiedModels.list.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(verifiedModels.list.mock.calls.every(args => args[0] === ownerId && args[1] === registrationId)).toBe(true);
      expect(fetcher.mock.calls.every(([url]) => url === "https://api.openai.com/v1/models")).toBe(true);
      expect(f.query.mock.calls.filter(([sql]) => sql.includes("report_subscription_worker_ready"))).toHaveLength(6);
    } finally { runtime.close(); vi.unstubAllGlobals(); }
  });

  it("does not discover or select another owner's registration", async () => {
    const { runtime, transport, query } = fixture();
    for (const action of ["models", "select-model", "sign-out"]) expect((await runtime.handle(request(action, { registrationId, ...(action === "select-model" ? { model: "fixture-model" } : {}) }, { owner: otherOwner }))).status).toBe(404);
    expect(transport.listModels).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  });
  it("catalogue success alone never enables a model or claims work", async () => {
    const { runtime, query } = fixture();
    expect(await (await runtime.handle(request("models", { registrationId }))).json()).toEqual({ registrationId, models: [{ slug: "fixture-model", displayName: "Synthetic fixture model" }] });
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects absent or wrong-account models before any policy write", async () => {
    const { runtime, transport, query } = fixture();
    expect((await runtime.handle(request("select-model", { registrationId, model: "missing-model" }))).status).toBe(503);
    vi.mocked(transport.listModels).mockResolvedValue({ accountId: "b".repeat(64), models: [{ slug: "fixture-model", displayName: "Synthetic" }] });
    expect((await runtime.handle(request("select-model", { registrationId, model: "fixture-model" }))).status).toBe(503);
    expect(query).not.toHaveBeenCalled();
  });
  it("atomically configures all six operations only after explicit owned model selection", async () => {
    const { runtime, query } = fixture();
    const response = await runtime.handle(request("select-model", { registrationId, model: "fixture-model" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ selectedRegistrationId: registrationId, model: "fixture-model", workerReady: true, images: { status: "unavailable", reason: "spending_limit_required" } });
    const configurationCalls = query.mock.calls.filter(([sql]) => sql.includes("configure_subscription_runtime"));
    expect(configurationCalls).toHaveLength(1);
    expect(configurationCalls[0]).toEqual(["select public.configure_subscription_runtime($1, $2::jsonb) as configured", [ownerId, JSON.stringify(policies())]]);
    expect(query.mock.calls.filter(([sql]) => sql.includes("report_subscription_worker_ready"))).toHaveLength(6);
    expect(query.mock.calls.some(([sql]) => sql.includes("claim_"))).toBe(false);
    await runtime.tick(new AbortController().signal);
    const expireIndex = query.mock.calls.findIndex(([sql]) => sql.includes("expire_job_leases"));
    const claimIndex = query.mock.calls.findIndex(([sql]) => sql.includes("claim_subscription_job"));
    expect(expireIndex).toBeGreaterThan(-1); expect(claimIndex).toBeGreaterThan(expireIndex);
  });
  it("revokes only after disabling the exact owner/registration SQL binding", async () => {
    const { runtime, calls, query } = fixture();
    expect((await runtime.handle(request("sign-out", { registrationId }))).status).toBe(200);
    expect(query).toHaveBeenCalledWith("select public.disable_subscription_runtime($1, $2)", [ownerId, registrationId]);
    expect(calls.findIndex(call => call.includes("disable_subscription_runtime"))).toBeLessThan(calls.indexOf("sign-out-tokens"));
  });
  it("does not revoke tokens or resume dispatch when disabling SQL fails", async () => {
    const { runtime, query, manager } = fixture();
    query.mockRejectedValue(new Error("synthetic-private-database-error"));
    const response = await runtime.handle(request("sign-out", { registrationId }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-database-error");
    expect(manager.signOut).not.toHaveBeenCalled();
    expect((await runtime.status(ownerId)).workerReady).toBe(false);
  });
  it("logout during model discovery prevents late configuration", async () => {
    const { runtime, transport, query } = fixture();
    let finish!: (value: Awaited<ReturnType<ChatGPTTransport["listModels"]>>) => void;
    vi.mocked(transport.listModels).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = runtime.handle(request("select-model", { registrationId, model: "fixture-model" }));
    await vi.waitFor(() => expect(transport.listModels).toHaveBeenCalled());
    expect((await runtime.handle(request("sign-out", { registrationId }))).status).toBe(200);
    finish({ accountId: registrationId, models: [{ slug: "fixture-model", displayName: "Fixture" }] });
    expect((await pending).status).toBe(503);
    expect(query.mock.calls.some(([sql]) => sql.includes("configure_subscription_runtime"))).toBe(false);
  });
  it("missing migrations and invalid readiness never make the worker available", async () => {
    const { runtime, query, setBindings } = fixture();
    setBindings([{ owner_id: ownerId, registration_id: registrationId, operation: "strategy.reformulate", policy, enabled: true }]);
    query.mockImplementation(async sql => ({ rows: sql.includes("get_subscription_runtime_bindings") ? [{ owner_id: ownerId, registration_id: registrationId, operation: "strategy.reformulate", policy, enabled: true }] : [{ ready: "true" }] }));
    await runtime.refreshReadiness(); expect((await runtime.status(ownerId)).workerReady).toBe(false);
    query.mockRejectedValue(new Error("Missing migration"));
    await runtime.refreshReadiness(); expect((await runtime.status(ownerId)).workerReady).toBe(false);
  });
  it("reads mixed Strategy and Naming policies and reports the exact policy for each operation", async () => {
    const f = fixture(); const rows = bindings();
    rows[0] = { ...rows[0]!, operation: "strategy.reformulate", policy: { ...policy, limits: { ...policy.limits, maxRequestsPerHour: 7 } } };
    f.setBindings(rows.reverse());
    await f.runtime.refreshReadiness();
    expect(await f.runtime.status(ownerId)).toMatchObject({ selectedRegistrationId: registrationId, model: policy.model, workerReady: true });
    const reports = f.query.mock.calls.filter(([sql]) => sql.includes("report_subscription_worker_ready"));
    expect(reports).toHaveLength(6);
    for (const row of rows) expect(reports).toContainEqual([expect.any(String), [ownerId, registrationId, row.operation, JSON.stringify(row.policy), 60]]);
    expect(f.query.mock.calls.some(([sql]) => sql.includes("configure_subscription_runtime"))).toBe(false);
  });
  it("preserves legacy Strategy-only boot without silently enabling an absent Naming policy", async () => {
    const f = fixture(); f.setBindings(bindings().filter(row => row.operation !== "naming.generate"));
    await f.runtime.refreshReadiness();
    expect(await f.runtime.status(ownerId)).toMatchObject({ selectedRegistrationId: registrationId, model: policy.model, workerReady: true });
    expect(f.query.mock.calls.filter(([sql]) => sql.includes("report_subscription_worker_ready"))).toHaveLength(5);
    expect(f.query.mock.calls.some(([sql, values]) => sql.includes("configure_subscription_runtime") || values?.[2] === "naming.generate")).toBe(false);
  });
  it.each(["model", "registration", "policy_registration", "handler", "web", "duplicate"])("fails closed on inconsistent %s bindings without first-row selection", async mismatch => {
    const f = fixture(); const rows: Record<string, unknown>[] = bindings();
    const naming = rows.at(-1)!;
    if (mismatch === "model") naming.policy = { ...namingPolicy, model: "different-model" };
    if (mismatch === "registration") { naming.registration_id = "b".repeat(64); naming.policy = { ...namingPolicy, registrationId: "b".repeat(64) }; }
    if (mismatch === "policy_registration") naming.policy = { ...namingPolicy, registrationId: "b".repeat(64) };
    if (mismatch === "handler") naming.policy = { ...policy, limits: namingPolicy.limits };
    if (mismatch === "web") naming.policy = { ...namingPolicy, limits: policy.limits };
    if (mismatch === "duplicate") rows.push({ ...rows[0]! });
    f.setBindings(rows);
    await f.runtime.refreshReadiness();
    expect(await f.runtime.status(ownerId)).toMatchObject({ selectedRegistrationId: null, model: null, workerReady: false });
    await f.runtime.tick(new AbortController().signal);
    expect(f.query.mock.calls.some(([sql]) => sql.includes("claim_subscription_job"))).toBe(false);
    expect(f.transport.listModels).not.toHaveBeenCalled();
  });
  it("requires an affirmative atomic configuration result before readiness", async () => {
    const f = fixture(); const normalQuery = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values) => sql.includes("configure_subscription_runtime") ? { rows: [{ configured: "true" }] } : normalQuery(sql, values));
    expect((await f.runtime.handle(request("select-model", { registrationId, model: policy.model }))).status).toBe(503);
    expect((await f.runtime.status(ownerId)).workerReady).toBe(false);
    expect(f.query.mock.calls.some(([sql]) => sql.includes("report_subscription_worker_ready"))).toBe(false);
  });
  it.each(["add", "remove", "limits", "model"])("aborts an in-flight session when the complete operation map changes: %s", async change => {
    const f = fixture(); const initial = bindings().filter(row => change !== "add" || row.operation !== "naming.generate");
    f.setBindings(initial); await f.runtime.refreshReadiness(); f.setClaim(job());
    let dispatchedSignal: AbortSignal | undefined;
    let finish!: () => void;
    vi.mocked(runChatGPTStrategy).mockImplementation(async options => { dispatchedSignal = options.signal; await new Promise<void>(resolve => { finish = resolve; }); return { status: "succeeded", result }; });
    const pending = f.runtime.tick(new AbortController().signal);
    try {
      await vi.waitFor(() => expect(dispatchedSignal).toBeDefined());
      let changed = bindings();
      if (change === "remove") changed = changed.filter(row => row.operation !== "naming.generate");
      if (change === "limits") changed[5] = { ...changed[5]!, operation: "naming.generate", policy: { ...namingPolicy, limits: { ...namingPolicy.limits, maxRequestsPerHour: 3 } } };
      if (change === "model") changed[5] = { ...changed[5]!, operation: "naming.generate", policy: { ...namingPolicy, model: "different-model" } };
      f.setBindings(changed);
      expect((await f.runtime.status(ownerId)).workerReady).toBe(false);
      expect(dispatchedSignal!.aborted).toBe(true);
    } finally { finish?.(); await pending; f.runtime.close(); }
    expect(f.query.mock.calls.some(([sql, values]) => sql.includes("complete_job_step") && values?.[3] === "succeeded")).toBe(false);
  });
  it("does not let an obsolete session's readiness failure retire its explicitly selected replacement", async () => {
    const f = fixture(); f.setBindings(bindings()); await f.runtime.refreshReadiness(); f.setClaim(job());
    let finish!: () => void;
    let dispatched = false, lateReadinessRejected = false;
    vi.mocked(runChatGPTStrategy).mockImplementation(async options => {
      dispatched = true; await new Promise<void>(resolve => { finish = resolve; });
      try { await options.beforeDispatch?.(); } catch { lateReadinessRejected = true; }
      return { status: "succeeded", result };
    });
    const pending = f.runtime.tick(new AbortController().signal);
    try {
      await vi.waitFor(() => expect(dispatched).toBe(true));
      const response = await f.runtime.handle(request("select-model", { registrationId, model: policy.model }));
      expect(await response.json()).toMatchObject({ workerReady: true });
      finish(); await pending;
      expect(lateReadinessRejected).toBe(true);
      expect((await f.runtime.status(ownerId)).workerReady).toBe(true);
    } finally { finish?.(); await pending; f.runtime.close(); }
  });
  it.each([false, true])("disables quota only for the current session (replacement: %s)", async replacement => {
    const f = fixture(); f.setBindings(bindings()); await f.runtime.refreshReadiness(); f.setClaim(job());
    let finish!: () => void;
    let dispatched = false;
    vi.mocked(runChatGPTStrategy).mockImplementation(async () => {
      dispatched = true; await new Promise<void>(resolve => { finish = resolve; });
      return { status: "failed", code: "subscription_sharing_usage_limit_exceeded", partialText: "", responseId: null, requestId: null, dispatched: true, recovery: "view_usage" };
    });
    const pending = f.runtime.tick(new AbortController().signal);
    try {
      await vi.waitFor(() => expect(dispatched).toBe(true));
      if (replacement) {
        const response = await f.runtime.handle(request("select-model", { registrationId, model: policy.model }));
        expect(await response.json()).toMatchObject({ workerReady: true });
      }
      finish(); await pending;
      expect(f.query.mock.calls.filter(([sql]) => sql.includes("disable_subscription_runtime"))).toHaveLength(replacement ? 0 : 1);
      expect((await f.runtime.status(ownerId)).workerReady).toBe(replacement);
    } finally { finish?.(); await pending; f.runtime.close(); }
  });
  it("dispatches Naming through its handler and atomic completion store while retaining Strategy", async () => {
    const f = fixture(); f.setBindings(bindings()); await f.runtime.refreshReadiness(); f.setClaim(namingJob());
    const text = JSON.stringify({ candidates: [{ value: "Synthetic Form", rationale: "A synthetic naming association.", caution: null }] });
    vi.mocked(f.transport.streamResponse).mockImplementation(async (_request, options) => {
      await options.beforeDispatch?.(); await options.onTextDelta?.(text);
      return { status: "completed", accountId: registrationId, responseId: "resp_naming", requestId: "req_naming", partialText: text,
        response: { id: "resp_naming", status: "completed", model: policy.model, usage: null, output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }] } };
    });
    await f.runtime.tick(new AbortController().signal);
    expect(f.transport.streamResponse).toHaveBeenCalledOnce();
    const namingCompletion = f.query.mock.calls.find(([sql]) => sql.includes("complete_naming_job_step"));
    expect(namingCompletion?.[1]?.[3]).toBe("succeeded");
    expect(JSON.parse(namingCompletion![1]![5] as string)).toMatchObject({ operation: "naming.generate", accepted: [{ value: "Synthetic Form" }], fulfillment: { status: "partial", acceptedCount: 1, targetCount: 100 } });
    expect(f.query.mock.calls.some(([sql]) => sql.includes("complete_job_step"))).toBe(false);
    vi.mocked(runChatGPTStrategy).mockResolvedValue({ status: "succeeded", result }); f.setClaim(job());
    await f.runtime.tick(new AbortController().signal);
    expect(runChatGPTStrategy).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.some(([sql, values]) => sql.includes("complete_job_step") && values?.[3] === "succeeded")).toBe(true);
  });
});

describe("subscription job fencing and cumulative partial persistence", () => {
  function handlers() {
    const { transport } = fixture();
    const assertReady = vi.fn(async () => {}), appendPartial = vi.fn(async () => {}), onQuotaUnavailable = vi.fn(async () => {});
    const session = new AbortController();
    const registry = createSubscriptionHandlers({ ownerId, policy, operations: ["strategy.reformulate"], transport, assertReady, appendPartial, onQuotaUnavailable, sessionSignal: session.signal });
    return { registry, assertReady, appendPartial, onQuotaUnavailable, session };
  }
  it("rejects a claimed row belonging to another owner, registration or billing route", async () => {
    const current = job();
    const row = { id: current.id, owner_id: otherOwner, project_id: current.projectId, operation: current.operation, input: current.input, input_revision: 1, lease_token: current.leaseToken, state: "running", reserved_cost_microusd: 0, actual_cost_microusd: 0 };
    const query = vi.fn(async () => ({ rows: [row] }));
    const store = new SubscriptionJobStore({ query } as unknown as Pick<Pool, "query">, ownerId, registrationId);
    await expect(store.claim("synthetic-worker", 120)).rejects.toThrow("binding mismatch");
    expect(query).toHaveBeenCalledWith("select * from public.claim_subscription_job($1, $2, $3, $4)", ["synthetic-worker", ownerId, registrationId, 120]);
  });
  it("accepts a Naming claim only when the frozen batch binds the enclosing row", async () => {
    const current = namingJob();
    const query = vi.fn(async () => ({ rows: [jobRow(current)] }));
    const store = new SubscriptionJobStore({ query } as unknown as Pick<Pool, "query">, ownerId, registrationId);
    expect(await store.claim("synthetic-worker", 120)).toEqual(current);
  });
  it.each(["strategy.reformulate", "naming.generate"])("rejects %s claims whose frozen model differs from the selected operation policy", async operation => {
    const current = operation === "naming.generate" ? namingJob() : job();
    const originalPolicy = operation === "naming.generate" ? namingPolicy : policy;
    current.input = { ...(current.input as object), policy: { ...originalPolicy, model: "unselected-model" } };
    const query = vi.fn(async () => ({ rows: [jobRow(current)] }));
    const store = new SubscriptionJobStore({ query } as unknown as Pick<Pool, "query">, ownerId, registrationId, policies());
    await expect(store.claim("synthetic-worker", 120)).rejects.toThrow(/binding mismatch/i);
  });
  it("rejects an unknown claimed operation even when its input looks like valid Strategy", async () => {
    const current = { ...job(), operation: "identity.generate" };
    const query = vi.fn(async () => ({ rows: [jobRow(current)] }));
    const store = new SubscriptionJobStore({ query } as unknown as Pick<Pool, "query">, ownerId, registrationId);
    await expect(store.claim("synthetic-worker", 120)).rejects.toThrow();
  });
  it("rejects a Naming claim if that operation was never enabled for this session", async () => {
    const query = vi.fn(async () => ({ rows: [jobRow(namingJob())] }));
    const store = new SubscriptionJobStore({ query } as unknown as Pick<Pool, "query">, ownerId, registrationId, policies().filter(entry => entry.operation !== "naming.generate"));
    await expect(store.claim("synthetic-worker", 120)).rejects.toThrow(/binding mismatch/i);
  });
  it("does not select the first of multiple claimed rows", async () => {
    const query = vi.fn(async () => ({ rows: [jobRow(job()), jobRow(namingJob())] }));
    const store = new SubscriptionJobStore({ query } as unknown as Pick<Pool, "query">, ownerId, registrationId);
    await expect(store.claim("synthetic-worker", 120)).rejects.toThrow();
  });
  it.each(["owner", "project", "job", "revision", "operation", "handler", "registration", "reservation", "spend"])("rejects a Naming claim with mismatched %s", async mismatch => {
    const current = namingJob();
    if (mismatch === "owner") current.ownerId = otherOwner;
    if (mismatch === "project") current.projectId = otherOwner;
    if (mismatch === "job") current.id = otherOwner;
    if (mismatch === "revision") current.inputRevision++;
    if (mismatch === "operation") current.operation = "strategy.reformulate";
    if (mismatch === "handler") current.input = { ...(current.input as object), policy };
    if (mismatch === "registration") current.input = { ...(current.input as object), policy: { ...namingPolicy, registrationId: "b".repeat(64) } };
    if (mismatch === "reservation") current.reservedCostMicrousd = 1;
    if (mismatch === "spend") current.actualCostMicrousd = 1;
    const query = vi.fn(async () => ({ rows: [jobRow(current)] }));
    const store = new SubscriptionJobStore({ query } as unknown as Pick<Pool, "query">, ownerId, registrationId);
    await expect(store.claim("synthetic-worker", 120)).rejects.toThrow();
  });
  it("compares immutable queued policy and refuses API jobs without a fallback", () => {
    const { registry } = handlers();
    const current = job();
    const handler = registry.get(current.operation)!;
    expect(() => handler.steps({ ...current, ownerId: otherOwner })).toThrow();
    expect(() => handler.steps({ ...current, reservedCostMicrousd: 10 })).toThrow();
    expect(() => handler.steps({ ...current, input: { ...(current.input as object), billingMode: "openai_api" } })).toThrow();
  });
  function withHistory(): ClaimedJob {
    const current = job();
    return { ...current, input: { ...(current.input as object), version: 2, assistantHistory: { entries: [{
      jobId: "9d01417c-342d-4d02-8211-c5fec00e3749", ownerId, projectId: current.projectId, stepKey: "respond", inputRevision: 1,
      completedAt: "2026-10-03T00:00:00Z", output: result,
    }], truncated: false } } };
  }
  it("passes only the frozen source history and fingerprints its full input while preserving legacy recovery", async () => {
    const { registry } = handlers(); const current = withHistory();
    vi.mocked(runChatGPTStrategy).mockResolvedValue({ status: "succeeded", result });
    const handler = registry.get(current.operation)!;
    const step = handler.steps(current)[0]!;
    await step.execute({ job: current, signal: new AbortController().signal });
    expect(runChatGPTStrategy).toHaveBeenCalledWith(expect.objectContaining({ assistantHistory: (current.input as { assistantHistory: unknown }).assistantHistory, model: policy.model }));
    expect(handler.steps(structuredClone(current))[0]!.key).toBe(step.key);
    const changed = structuredClone(current);
    (changed.input as { assistantHistory: { entries: { output: typeof result }[] } }).assistantHistory.entries[0]!.output.proposal.message = "Changed synthetic question";
    expect(handler.steps(changed)[0]!.key).not.toBe(step.key);
    expect(step.key).toMatch(/^strategy-chatgpt-v2:/);
    expect(handler.steps(job())[0]!.key).toBe(`strategy-chatgpt-v1:strategy.reformulate:${createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 24)}`);
  });
  it.each(["owner", "project", "future", "self"])("rejects %s history provenance before dispatch", mismatch => {
    const { registry } = handlers(); const current = withHistory();
    const entry = (current.input as { assistantHistory: { entries: { jobId: string; ownerId: string; projectId: string; inputRevision: number }[] } }).assistantHistory.entries[0]!;
    if (mismatch === "owner") entry.ownerId = otherOwner;
    if (mismatch === "project") entry.projectId = otherOwner;
    if (mismatch === "future") entry.inputRevision = current.inputRevision + 1;
    if (mismatch === "self") entry.jobId = current.id;
    expect(() => registry.get(current.operation)!.steps(current)).toThrow(/history/i);
    expect(runChatGPTStrategy).not.toHaveBeenCalled();
  });
  it("fresh policy failure prevents provider dispatch", async () => {
    const { registry, assertReady } = handlers(); const current = job();
    assertReady.mockRejectedValue(new Error("Policy disabled"));
    const outcome = await registry.get(current.operation)!.steps(current)[0]!.execute({ job: current, signal: new AbortController().signal });
    expect(outcome).toMatchObject({ status: "failed", code: "runtime_policy_unavailable", costMicrousd: 0 });
    expect(runChatGPTStrategy).not.toHaveBeenCalled();
  });
  it("coalesces hundreds of fragments, flushes terminal text, and uses internal zero cost only", async () => {
    const { registry, assertReady, appendPartial } = handlers(); const current = job();
    vi.mocked(runChatGPTStrategy).mockImplementation(async options => {
      await options.beforeDispatch?.();
      for (let index = 0; index < 500; index++) await options.onPartial?.("x");
      return { status: "succeeded", result };
    });
    const outcome = await registry.get(current.operation)!.steps(current)[0]!.execute({ job: current, signal: new AbortController().signal });
    expect(outcome).toEqual({ status: "succeeded", result, costMicrousd: 0, providerRequestId: "resp_fixture" });
    expect(appendPartial).toHaveBeenCalledTimes(2);
    expect(appendPartial).toHaveBeenLastCalledWith(current.id, current.leaseToken, "x".repeat(500));
    expect(assertReady).toHaveBeenCalledTimes(4); // Start, final pre-dispatch, two durable flushes.
  });
  it("preserves actual partial text and disables the registration after a quota limit", async () => {
    const { registry, appendPartial, onQuotaUnavailable } = handlers(); const current = job();
    vi.mocked(runChatGPTStrategy).mockImplementation(async options => {
      await options.onPartial?.("actual "); await options.onPartial?.("partial");
      return { status: "failed", code: "subscription_sharing_usage_limit_exceeded", partialText: "actual partial", responseId: "resp_fixture", requestId: null, dispatched: true, recovery: "view_usage" };
    });
    const outcome = await registry.get(current.operation)!.steps(current)[0]!.execute({ job: current, signal: new AbortController().signal });
    expect(outcome).toEqual({ status: "failed", code: "subscription_sharing_usage_limit_exceeded", providerRequestId: "resp_fixture", costMicrousd: 0 });
    expect(appendPartial).toHaveBeenLastCalledWith(current.id, current.leaseToken, "actual partial");
    expect(onQuotaUnavailable).toHaveBeenCalledOnce();
  });
  it("persists known terminal failure text even when no streaming deltas arrived", async () => {
    const { registry, appendPartial } = handlers(); const current = job();
    vi.mocked(runChatGPTStrategy).mockResolvedValue({ status: "failed", code: "provider_failed", partialText: "completed item fragment", responseId: "resp_fixture", requestId: null, dispatched: true, recovery: "retry_later" });
    expect(await registry.get(current.operation)!.steps(current)[0]!.execute({ job: current, signal: new AbortController().signal })).toEqual({ status: "failed", code: "provider_failed", providerRequestId: "resp_fixture", costMicrousd: 0 });
    expect(appendPartial).toHaveBeenCalledWith(current.id, current.leaseToken, "completed item fragment");
  });
  it("retains known failure evidence for reconciliation when durable partial persistence fails", async () => {
    const { registry, appendPartial } = handlers(); const current = job();
    appendPartial.mockRejectedValue(new Error("Database unavailable"));
    vi.mocked(runChatGPTStrategy).mockResolvedValue({ status: "failed", code: "provider_failed", partialText: "completed item fragment", responseId: "resp_fixture", requestId: null, dispatched: true, recovery: "retry_later" });
    expect(await registry.get(current.operation)!.steps(current)[0]!.execute({ job: current, signal: new AbortController().signal })).toMatchObject({ status: "needs_reconciliation", code: "provider_failed", result: { partialText: "completed item fragment" } });
  });
  it("retains conflicting streamed and terminal failure text for manual review", async () => {
    const { registry } = handlers(); const current = job();
    vi.mocked(runChatGPTStrategy).mockImplementation(async options => {
      await options.onPartial?.("stream fragment");
      return { status: "failed", code: "provider_failed", partialText: "different terminal fragment", responseId: "resp_fixture", requestId: null, dispatched: true, recovery: "retry_later" };
    });
    expect(await registry.get(current.operation)!.steps(current)[0]!.execute({ job: current, signal: new AbortController().signal })).toMatchObject({ status: "needs_reconciliation", result: { partialText: "different terminal fragment" } });
  });
  it("keeps explicitly uncertain provider outcomes unresolved after successful partial persistence", async () => {
    const { registry, appendPartial } = handlers(); const current = job();
    vi.mocked(runChatGPTStrategy).mockImplementation(async options => {
      await options.onPartial?.("actual partial");
      return { status: "needs_reconciliation", code: "provider_outcome_unknown", partialText: "actual partial", responseId: "resp_fixture", requestId: null, dispatched: true, recovery: "manual_review" };
    });
    expect(await registry.get(current.operation)!.steps(current)[0]!.execute({ job: current, signal: new AbortController().signal })).toMatchObject({ status: "needs_reconciliation", code: "provider_outcome_unknown", result: { partialText: "actual partial" } });
    expect(appendPartial).toHaveBeenCalledWith(current.id, current.leaseToken, "actual partial");
  });
  it("keeps a failed terminal flush as reconciliation rather than fabricated success", async () => {
    const { registry, appendPartial } = handlers(); const current = job();
    appendPartial.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("Database unavailable"));
    vi.mocked(runChatGPTStrategy).mockImplementation(async options => { await options.onPartial?.("first"); await options.onPartial?.(" second"); return { status: "succeeded", result }; });
    expect(await registry.get(current.operation)!.steps(current)[0]!.execute({ job: current, signal: new AbortController().signal })).toMatchObject({ status: "needs_reconciliation", result: { partialText: "first second" } });
  });
  it("session invalidation stops new dispatch immediately", async () => {
    const { registry, session } = handlers(); const current = job();
    session.abort();
    expect(await registry.get(current.operation)!.steps(current)[0]!.execute({ job: current, signal: new AbortController().signal })).toMatchObject({ status: "failed", code: "session_unavailable" });
    expect(runChatGPTStrategy).not.toHaveBeenCalled();
  });
});
