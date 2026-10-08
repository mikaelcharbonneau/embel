import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT, type JWTPayload } from "jose";

vi.mock("server-only", () => ({}));
const auth = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: auth }));
import { localBridgeConfiguration, proxyLocalChatGPT } from "@/server/local-chatgpt/bridge";
import { createAuthorizationAttempt, createOpenAIOAuthClient, LocalChatGPTError, OPENAI_AUTHORIZE_URL, OPENAI_DISCOVERY_URL, OPENAI_ISSUER, OPENAI_JWKS_URL, OPENAI_RESOURCE, OPENAI_REVOCATION_URL, OPENAI_TOKEN_URL, PLAN_USAGE_SCOPE, readAuthorizationCallback, validateLoopbackCallback } from "@/server/local-chatgpt/oauth";
import { credentialRecordSchema, registrationIdFor, type ChatGPTCredentialStore, type CredentialRecord } from "@/server/local-chatgpt/credentials";
import { createLocalChatGPTSessionManager } from "@/server/local-chatgpt/session";
import { createChatGPTTransport, type ChatGPTResponseRequest } from "@/server/ai/chatgpt-transport";
import { ApiError } from "@/server/http/errors";
import { getApplicationOrigin, shouldUseSecureSessionCookies as secureSessionCookies } from "@/server/config";
import { chatGPTStrategyJobInputSchema, enqueueStrategyJobSchema, strategyAvailabilitySchema, strategyJobResultSchema } from "@/domain/strategy-jobs";
import { asRole, asSubscriptionWorker, claim, createTestDatabase, enqueue, OWNER_A, OWNER_B, resetFixture, seedProject, type TestDatabase } from "../database/local-supabase";

// Every credential, identity and provider response here is synthetic and local to this test process.
const ownerA = "aaaaaaaa-1111-4111-8111-111111111111";
const ownerB = "bbbbbbbb-1111-4111-8111-111111111111";
const origin = "http://127.0.0.1:3106";
const bridgeCapability = "synthetic_bridge_capability_".padEnd(43, "x");
const browserSessionId = "synthetic_browser_session_".padEnd(43, "x");
const hostId = "urn:uuid:cccccccc-1111-4111-8111-111111111111";
const clientId = "oaiapp_synthetic_client";
const subject = "synthetic-chatgpt-subject";
const now = Date.parse("2026-10-03T12:00:00Z");
const seconds = Math.floor(now / 1000);
const status = { connectionAllowed: false, registrations: [], selectedRegistrationId: null, model: null, workerReady: false, images: { status: "unavailable", reason: "spending_limit_required" } };
const fetcher = vi.fn<typeof fetch>();

function bridgeRequest(action = "status", options: { method?: string; url?: string; headers?: Record<string, string | undefined>; body?: unknown; rawBody?: string } = {}) {
  const method = options.method ?? (action === "status" ? "GET" : "POST");
  const headers = new Headers({ host: "127.0.0.1:3106", origin, "content-type": "application/json" });
  for (const [name, value] of Object.entries(options.headers ?? {})) if (value !== undefined) headers.set(name, value);
  return new Request(options.url ?? `${origin}/api/local-chatgpt/${action}`, { method,
    headers,
    ...(method === "GET" ? {} : { body: options.rawBody ?? JSON.stringify(options.body ?? {}) }),
  });
}
function attempt(returning = false) {
  return createAuthorizationAttempt({ ownerId: ownerA, browserSessionId, hostId, redirectUri: "http://127.0.0.1:3199/auth/callback", ...(returning ? { registration: { registrationId: "synthetic-registration", clientId, subject } } : {}) }, now);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("FLUID_RUNTIME", "local"); vi.stubEnv("VERCEL", ""); vi.stubEnv("APP_ORIGIN", origin); vi.stubEnv("FLUID_LOCAL_BRIDGE_TOKEN", bridgeCapability);
  vi.stubGlobal("fetch", fetcher); auth.mockResolvedValue({ userId: ownerA });
  fetcher.mockImplementation(async () => Response.json(status));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("independent loopback bridge boundaries", () => {
  it("restricts insecure production cookies to the exact approved local origin", () => {
    const local = { NODE_ENV: "production", FLUID_RUNTIME: "local", APP_ORIGIN: origin };
    expect(secureSessionCookies(local)).toBe(false); expect(getApplicationOrigin(local)).toBe(origin);
    for (const patch of [{ FLUID_RUNTIME: "cloud" }, { VERCEL: "1" }, { APP_ORIGIN: "http://localhost:3106" }, { APP_ORIGIN: "http://127.0.0.1:3107" }, { APP_ORIGIN: "http://127.0.0.1:3106.evil.example" }]) {
      expect(secureSessionCookies({ ...local, ...patch })).toBe(true);
      expect(() => getApplicationOrigin({ ...local, ...patch })).toThrow();
    }
    expect(secureSessionCookies({ NODE_ENV: "production", APP_ORIGIN: "https://fluid.example" })).toBe(true);
  });
  it.each([
    { headers: { host: "localhost:3106" } },
    { headers: { host: "127.0.0.1:3107" } },
    { headers: { origin: "null" } },
    { headers: { origin: "http://localhost:3106" } },
    { headers: { origin: "https://fluid.example" } },
    { headers: { "sec-fetch-site": "cross-site" } },
    { url: "http://127.0.0.1:3106/api/local-chatgpt/status?ownerId=other" },
    { url: "http://evil.example/api/local-chatgpt/status" },
  ])("rejects origin/host ambiguity before private identity access %#", async options => {
    const response = await proxyLocalChatGPT(bridgeRequest("status", options), "status");
    expect(response.status).toBe(403);
    expect(auth).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires Origin on mutations even with a loopback Host and spoofed forwarded headers", async () => {
    const request = bridgeRequest("sign-out", { body: { registrationId: "synthetic-registration" }, headers: { "x-forwarded-host": "127.0.0.1:3106", "x-forwarded-proto": "http" } });
    request.headers.delete("origin");
    expect((await proxyLocalChatGPT(request, "sign-out")).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["__proto__", "constructor", "unknown"])("never turns action names into worker paths: %s", async action => {
    expect((await proxyLocalChatGPT(bridgeRequest(), action)).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not enable local capabilities with a hosted environment or missing capability", () => {
    for (const env of [
      { FLUID_RUNTIME: "local", VERCEL: "1", APP_ORIGIN: origin, FLUID_LOCAL_BRIDGE_TOKEN: bridgeCapability },
      { FLUID_RUNTIME: "local", APP_ORIGIN: "http://localhost:3106", FLUID_LOCAL_BRIDGE_TOKEN: bridgeCapability },
      { FLUID_RUNTIME: "local", APP_ORIGIN: origin, FLUID_LOCAL_BRIDGE_TOKEN: "short" },
      { APP_ORIGIN: origin, FLUID_LOCAL_BRIDGE_TOKEN: bridgeCapability },
    ]) expect(() => localBridgeConfiguration({ NODE_ENV: "test", ...env })).toThrow();
  });

  it("derives each request owner independently and never accepts a supplied identity", async () => {
    auth.mockResolvedValueOnce({ userId: ownerA }).mockResolvedValueOnce({ userId: ownerB });
    await proxyLocalChatGPT(bridgeRequest(), "status");
    await proxyLocalChatGPT(bridgeRequest(), "status");
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string).ownerId)).toEqual([ownerA, ownerB]);
    fetcher.mockClear();
    expect((await proxyLocalChatGPT(bridgeRequest("sign-in", { body: { ownerId: ownerB } }), "sign-in")).status).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not invoke the worker for expired Supabase authentication", async () => {
    auth.mockRejectedValue(new ApiError("unauthenticated"));
    expect((await proxyLocalChatGPT(bridgeRequest(), "status")).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds actual UTF-8 bytes despite a false Content-Length", async () => {
    const response = await proxyLocalChatGPT(bridgeRequest("sign-in", { rawBody: JSON.stringify({ padding: "漢".repeat(1000) }), headers: { "content-length": "1" } }), "sign-in");
    expect(response.status).toBe(413); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { ...status, access_token: "synthetic-secret" },
    { ...status, registrations: [{ registrationId: "one", email: null, planUsageEnabled: false, refreshToken: "synthetic-secret" }] },
    { ...status, images: { status: "ready", apiKey: "synthetic-secret" } },
  ])("rejects secret-bearing or contradictory worker metadata %#", async body => {
    fetcher.mockResolvedValue(Response.json(body));
    const response = await proxyLocalChatGPT(bridgeRequest(), "status");
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("synthetic-secret");
  });

  it.each([400, 401, 429, 500, 503])("redacts upstream errors and does not expose the bridge capability: %s", async code => {
    fetcher.mockResolvedValue(Response.json({ error: `raw-provider-${bridgeCapability}` }, { status: code }));
    const response = await proxyLocalChatGPT(bridgeRequest(), "status");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(bridgeCapability);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounds successful worker output and refuses redirects without retrying another provider", async () => {
    fetcher.mockResolvedValue(new Response("x".repeat(100_001), { headers: { "content-type": "application/json" } }));
    expect((await proxyLocalChatGPT(bridgeRequest(), "status")).status).toBe(503);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3107/bridge/status");
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["id_token_hint", "access_token", "refresh_token", "id_token", "client_secret", "code_verifier"])("keeps %s out of browser-visible authorization URLs", async key => {
    fetcher.mockResolvedValue(Response.json({ authorizationUrl: `${OPENAI_AUTHORIZE_URL}?${key}=synthetic-private-value` }));
    const response = await proxyLocalChatGPT(bridgeRequest("sign-in", { body: {} }), "sign-in");
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("synthetic-private-value");
  });
});

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => { keys = await generateKeyPair("RS256"); });
const discovery = { issuer: OPENAI_ISSUER, authorization_endpoint: OPENAI_AUTHORIZE_URL, token_endpoint: OPENAI_TOKEN_URL, jwks_uri: OPENAI_JWKS_URL, revocation_endpoint: OPENAI_REVOCATION_URL, id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["none"] };
async function signed(claims: JWTPayload) { return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "synthetic-test-key" }).sign(keys.privateKey); }
async function tokenFixture(nonce: string, idPatch: JWTPayload = {}, accessPatch: JWTPayload = {}) {
  const scope = `openid offline_access resource.invoke ${PLAN_USAGE_SCOPE}`;
  return {
    id_token: await signed({ iss: OPENAI_ISSUER, aud: clientId, sub: subject, nonce, iat: seconds, exp: seconds + 3600, ...idPatch }),
    access_token: await signed({ iss: OPENAI_ISSUER, aud: OPENAI_RESOURCE, sub: subject, client_id: clientId, scope, iat: seconds, exp: seconds + 3600, ...accessPatch }),
    refresh_token: "synthetic-refresh-first", token_type: "Bearer", expires_in: 3600, scope,
  };
}
function oauth(body: unknown) {
  const request = vi.fn<typeof fetch>(async input => String(input) === OPENAI_DISCOVERY_URL ? Response.json(discovery) : Response.json(body));
  return { request, client: createOpenAIOAuthClient({ fetch: request, now: () => now, jwks: async () => keys.publicKey }) };
}

describe("independent OAuth callback and identity validation", () => {
  it("uses fresh state, nonce and S256 PKCE per owner-bound attempt", async () => {
    const first = attempt(), second = attempt();
    expect(first.ownerId).toBe(ownerA); expect(first.browserSessionId).toBe(browserSessionId);
    expect(first.state).not.toBe(second.state); expect(first.nonce).not.toBe(second.nonce); expect(first.codeVerifier).not.toBe(second.codeVerifier);
    const { client } = oauth({});
    const url = new URL(await client.authorizationUrl(first));
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(first.codeVerifier).digest("base64url"));
    expect(url.searchParams.has("code_verifier")).toBe(false);
    expect(url.searchParams.get("redirect_uri")).toBe(first.redirectUri);
  });

  it.each(["http://localhost:3199/auth/callback", "https://127.0.0.1:3199/auth/callback", "http://127.0.0.1:3199/callback", "http://user:pass@127.0.0.1:3199/auth/callback", "http://127.0.0.1:3199/auth/callback?next=evil", "http://127.0.0.1:3199/auth/callback#fragment"])("rejects an altered loopback callback configuration: %s", uri => {
    expect(() => validateLoopbackCallback(uri)).toThrow();
  });

  it("rejects wrong state, expired attempts and duplicate callback fields before code exchange", () => {
    const value = attempt();
    const base = `${value.redirectUri}?state=${value.state}&code=synthetic-code&client_id=${clientId}`;
    expect(readAuthorizationCallback(value, base, now)).toEqual({ code: "synthetic-code", clientId });
    for (const url of [base.replace(value.state, "wrong-state"), `${base}&state=${value.state}`, `${base}&code=second`, `${base}&client_id=other`, base.replace(":3199/", ":3200/"), `${base}#fragment`]) expect(() => readAuthorizationCallback(value, url, now)).toThrow();
    expect(() => readAuthorizationCallback(value, base, value.expiresAt)).toThrow();
    expect(() => readAuthorizationCallback(value, base.replace(clientId, "dynamic_agent_client"), now)).toThrow();
  });

  it("preserves the selected issued client and handles denial before a supplied code", () => {
    const value = attempt(true);
    expect(readAuthorizationCallback(value, `${value.redirectUri}?state=${value.state}&code=synthetic-code`, now).clientId).toBe(clientId);
    expect(() => readAuthorizationCallback(value, `${value.redirectUri}?state=${value.state}&code=synthetic-code&client_id=different-client`, now)).toThrow();
    expect(() => readAuthorizationCallback(value, `${value.redirectUri}?state=${value.state}&code=synthetic-code&error=access_denied`, now)).toThrow("access_denied");
  });

  it.each([
    { nonce: "wrong-nonce" }, { iss: "https://wrong.example" }, { aud: "different-client" },
    { exp: seconds - 30, iat: seconds - 3600 }, { iat: seconds + 60 },
    { aud: [clientId, "other"], azp: "other" },
  ])("rejects a signed but wrong identity claim %#", async patch => {
    const value = attempt();
    const { client } = oauth(await tokenFixture(value.nonce, patch));
    await expect(client.exchange(value, { code: "synthetic-code", clientId })).rejects.toMatchObject({ code: "invalid_identity" });
  });

  it.each([{ client_id: "different-client" }, { sub: "different-subject" }, { aud: clientId }, { scope: "openid resource.invoke" }])("rejects access tokens detached from the validated identity and granted scope %#", async patch => {
    const value = attempt();
    const { client } = oauth(await tokenFixture(value.nonce, {}, patch));
    await expect(client.exchange(value, { code: "synthetic-code", clientId })).rejects.toMatchObject({ code: "invalid_identity" });
  });

  it("never replaces a returning registration with another ChatGPT subject", async () => {
    const value = attempt(true);
    const { client } = oauth(await tokenFixture(value.nonce, { sub: "different-subject" }));
    await expect(client.exchange(value, { code: "synthetic-code", clientId })).rejects.toMatchObject({ code: "invalid_identity" });
  });

  it("uses granted token scopes, retaining identity-only access without inventing plan permission", async () => {
    const value = attempt();
    const fixture = await tokenFixture(value.nonce);
    const { client } = oauth({ id_token: fixture.id_token, scope: "openid profile email" });
    const result = await client.exchange(value, { code: "synthetic-code", clientId });
    expect(result.tokens.scopes).not.toContain(PLAN_USAGE_SCOPE);
    expect(result.tokens.accessToken).toBeNull(); expect(result.tokens.refreshToken).toBeNull();
  });

  it("refreshes using the issued client and rotates returned refresh credentials", async () => {
    const value = attempt();
    const initial = oauth(await tokenFixture(value.nonce));
    const saved = await initial.client.exchange(value, { code: "synthetic-code", clientId });
    const rotated = { ...await tokenFixture(value.nonce), refresh_token: "synthetic-refresh-rotated" };
    const next = oauth(rotated);
    const tokens = await next.client.refresh(saved.identity, saved.tokens);
    expect(tokens.refreshToken).toBe("synthetic-refresh-rotated");
    const form = next.request.mock.calls.find(([url]) => String(url) === OPENAI_TOKEN_URL)?.[1]?.body as URLSearchParams;
    expect(form.get("grant_type")).toBe("refresh_token"); expect(form.get("client_id")).toBe(clientId);
    expect(form.get("refresh_token")).toBe("synthetic-refresh-first");
    expect(form.has("client_secret")).toBe(false);
  });

  it("rejects a renewal that omits the replacement refresh token", async () => {
    const value = attempt();
    const initial = oauth(await tokenFixture(value.nonce));
    const saved = await initial.client.exchange(value, { code: "synthetic-code", clientId });
    const tokens = await tokenFixture(value.nonce);
    const missing: Partial<typeof tokens> = { ...tokens };
    delete missing.refresh_token;
    await expect(oauth(missing).client.refresh(saved.identity, saved.tokens)).rejects.toMatchObject({ code: "invalid_token_response" });
  });

  it("fails closed on discovery endpoint changes rather than following another token host", async () => {
    const requests = vi.fn<typeof fetch>(async () => Response.json({ ...discovery, token_endpoint: "https://evil.example/token" }));
    const client = createOpenAIOAuthClient({ fetch: requests, now: () => now, jwks: async () => keys.publicKey });
    await expect(client.authorizationUrl(attempt())).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(requests).toHaveBeenCalledTimes(1);
    expect(requests.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function recordFor(ownerId = ownerA): CredentialRecord {
  const identity = { ownerId, issuer: OPENAI_ISSUER, clientId, subject };
  return credentialRecordSchema.parse({ version: 1, ...identity, registrationId: registrationIdFor(identity), hostId, email: "synthetic@example.test", updatedAt: now,
    tokens: { accessToken: "synthetic-original-access", refreshToken: "synthetic-original-refresh", idToken: "synthetic-original-id", scopes: ["openid", "offline_access", "resource.invoke", PLAN_USAGE_SCOPE], expiresAt: now + 3600000, earliestRefreshAt: null, receivedAt: now },
  });
}
function sessionFixture(records = [recordFor()]) {
  const data = new Map(records.map(record => [record.registrationId, structuredClone(record)]));
  const tails = new Map<string, Promise<unknown>>();
  const store: ChatGPTCredentialStore = {
    getHostId: vi.fn(async () => hostId),
    list: vi.fn(async ownerId => structuredClone([...data.values()].filter(record => record.ownerId === ownerId))),
    read: vi.fn(async (ownerId, registrationId) => { const record = data.get(registrationId); return record && record.ownerId === ownerId ? structuredClone(record) : null; }),
    write: vi.fn(async record => { data.set(record.registrationId, structuredClone(credentialRecordSchema.parse(record))); }),
    withLock: async <T>(id: string, action: () => Promise<T>) => {
      const next = (tails.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
      tails.set(id, next); return next;
    },
  };
  const { client } = oauth({});
  const authorizationUrl = vi.spyOn(client, "authorizationUrl").mockImplementation(async value => `${OPENAI_AUTHORIZE_URL}?state=${value.state}`);
  const exchange = vi.spyOn(client, "exchange").mockResolvedValue({ identity: { issuer: OPENAI_ISSUER, clientId, subject, email: "synthetic@example.test" }, tokens: recordFor().tokens! });
  const refresh = vi.spyOn(client, "refresh").mockResolvedValue({ ...recordFor().tokens!, accessToken: "synthetic-rotated-access", refreshToken: "synthetic-rotated-refresh" });
  const revoke = vi.spyOn(client, "revoke").mockResolvedValue("confirmed");
  const validate = vi.spyOn(client, "validateAccessToken").mockResolvedValue(now + 3600000);
  const invalidated = vi.fn();
  const manager = createLocalChatGPTSessionManager({ store, oauth: client, now: () => now, onSessionInvalidated: invalidated, revocationBackoff: async () => {} });
  const begin = (ownerId = ownerA, registrationId: string | undefined = records.find(record => record.ownerId === ownerId)?.registrationId) => manager.beginSignIn({ ownerId, browserSessionId, redirectUri: "http://127.0.0.1:3199/auth/callback", ...(registrationId ? { registrationId } : {}) });
  const callback = (url: string) => `http://127.0.0.1:3199/auth/callback?state=${new URL(url).searchParams.get("state")}&code=synthetic-code&client_id=${clientId}`;
  return { manager, store, data, authorizationUrl, exchange, refresh, revoke, validate, invalidated, begin, callback };
}

describe("independent owner sessions, rotating credentials and cancellation", () => {
  it("binds the same ChatGPT subject to different Supabase registrations and redacts summaries", async () => {
    const a = recordFor(), b = recordFor(ownerB);
    expect(a.registrationId).not.toBe(b.registrationId);
    const f = sessionFixture([a, b]);
    expect(await f.manager.listRegistrations(ownerA)).toEqual([{ registrationId: a.registrationId, email: a.email, planUsageEnabled: true }]);
    await expect(f.manager.getInferenceCredential(ownerB, a.registrationId)).rejects.toMatchObject({ code: "registration_not_found" });
    await expect(f.manager.signOut(ownerB, a.registrationId)).rejects.toMatchObject({ code: "registration_not_found" });
    await expect(f.begin(ownerB, a.registrationId)).rejects.toMatchObject({ code: "registration_not_found" });
    expect(f.revoke).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.manager.listRegistrations(ownerA))).not.toContain("synthetic-original");
  });

  it("rejects a store returning another owner's otherwise-valid registration", async () => {
    const a = recordFor(), f = sessionFixture();
    vi.mocked(f.store.read).mockResolvedValue(a);
    vi.mocked(f.store.list).mockResolvedValue([a]);
    await expect(f.manager.getInferenceCredential(ownerB, a.registrationId)).rejects.toMatchObject({ code: "registration_not_found" });
    await expect(f.manager.listRegistrations(ownerB)).rejects.toMatchObject({ code: "credential_store_unavailable" });
    expect(f.validate).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled();
  });

  it("consumes callback state once and derives its owner from the original attempt", async () => {
    const f = sessionFixture([]), start = await f.begin(ownerB);
    const url = f.callback(start.authorizationUrl);
    const done = await f.manager.completeSignIn({ callbackUrl: url });
    expect(done.ownerId).toBe(ownerB); expect(done.registration.registrationId).toBe(recordFor(ownerB).registrationId);
    expect([...f.data.values()].map(record => record.ownerId)).toEqual([ownerB]);
    await expect(f.manager.completeSignIn({ callbackUrl: url })).rejects.toMatchObject({ code: "invalid_callback" });
    expect(f.exchange).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent refresh and persists all replacement fields before publishing", async () => {
    const record = recordFor(); record.tokens!.expiresAt = now + 1000;
    const f = sessionFixture([record]), entered = deferred<void>(), release = deferred<void>();
    f.refresh.mockImplementation(async () => { entered.resolve(); await release.promise; return { ...record.tokens!, accessToken: "synthetic-rotated-access", refreshToken: "synthetic-rotated-refresh", idToken: "synthetic-rotated-id", expiresAt: now + 3600000 }; });
    const first = f.manager.getInferenceCredential(ownerA, record.registrationId), second = f.manager.getInferenceCredential(ownerA, record.registrationId);
    await entered.promise; expect(f.refresh).toHaveBeenCalledTimes(1); release.resolve();
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.accessToken)).toEqual(["synthetic-rotated-access", "synthetic-rotated-access"]);
    expect(f.data.get(record.registrationId)?.tokens).toMatchObject({ accessToken: "synthetic-rotated-access", refreshToken: "synthetic-rotated-refresh", idToken: "synthetic-rotated-id" });
    expect(f.store.write).toHaveBeenCalledTimes(1);
  });

  it("never publishes a rotated credential if its atomic persistence fails", async () => {
    const record = recordFor(); record.tokens!.expiresAt = now + 1000;
    const f = sessionFixture([record]);
    vi.mocked(f.store.write).mockRejectedValue(new LocalChatGPTError("credential_store_unavailable"));
    await expect(f.manager.getInferenceCredential(ownerA, record.registrationId)).rejects.toMatchObject({ code: "credential_store_unavailable" });
    expect(f.validate).not.toHaveBeenCalled(); expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.data.get(record.registrationId)?.tokens?.accessToken).toBe("synthetic-original-access");
  });

  it("honors the earliest refresh floor without using an expired credential", async () => {
    const record = recordFor(); record.tokens!.expiresAt = now - 1; record.tokens!.earliestRefreshAt = now + 10000;
    const f = sessionFixture([record]);
    await expect(f.manager.getInferenceCredential(ownerA, record.registrationId)).rejects.toMatchObject({ code: "session_unavailable" });
    expect(f.refresh).not.toHaveBeenCalled(); expect(f.validate).not.toHaveBeenCalled();
  });

  it("clears invalid-grant credentials while retaining only registration identity", async () => {
    const record = recordFor(); record.tokens!.expiresAt = now + 1000;
    const f = sessionFixture([record]); f.refresh.mockRejectedValue(new LocalChatGPTError("sign_in_required"));
    await expect(f.manager.getInferenceCredential(ownerA, record.registrationId)).rejects.toMatchObject({ code: "sign_in_required" });
    expect(f.data.get(record.registrationId)).toEqual({ ...record, tokens: null });
    expect(f.invalidated).toHaveBeenCalledWith(ownerA, record.registrationId);
  });

  it("clears local credentials after bounded unconfirmed revocation without claiming remote success", async () => {
    const record = recordFor(), f = sessionFixture(); f.revoke.mockResolvedValue("retryable");
    expect(await f.manager.signOut(ownerA, record.registrationId)).toMatchObject({ registration: { planUsageEnabled: false }, remoteRevocationConfirmed: false });
    expect(f.revoke).toHaveBeenCalledTimes(2); expect(f.data.get(record.registrationId)?.tokens).toBeNull();
    await expect(f.manager.getInferenceCredential(ownerA, record.registrationId)).rejects.toMatchObject({ code: "sign_in_required" });
  });

  it("does not resurrect a returning registration when code exchange completes after sign-out", async () => {
    const record = recordFor(), f = sessionFixture(), entered = deferred<void>(), release = deferred<void>();
    f.exchange.mockImplementation(async () => { entered.resolve(); await release.promise; return { identity: { issuer: OPENAI_ISSUER, clientId, subject, email: record.email }, tokens: record.tokens! }; });
    const start = await f.begin(), complete = f.manager.completeSignIn({ callbackUrl: f.callback(start.authorizationUrl) });
    const rejected = expect(complete).rejects.toMatchObject({ code: "sign_in_required" });
    await entered.promise; await f.manager.signOut(ownerA, record.registrationId); release.resolve(); await rejected;
    expect(f.data.get(record.registrationId)?.tokens).toBeNull();
  });

  it("does not resurrect a signed-out identity when an initially unbound sign-in resolves to it", async () => {
    const record = recordFor(), f = sessionFixture(), entered = deferred<void>(), release = deferred<void>();
    f.exchange.mockImplementation(async () => { entered.resolve(); await release.promise; return { identity: { issuer: OPENAI_ISSUER, clientId, subject, email: record.email }, tokens: record.tokens! }; });
    const start = await f.manager.beginSignIn({ ownerId: ownerA, browserSessionId, redirectUri: "http://127.0.0.1:3199/auth/callback" });
    const complete = f.manager.completeSignIn({ callbackUrl: f.callback(start.authorizationUrl) });
    const rejected = expect(complete).rejects.toMatchObject({ code: "sign_in_required" });
    await entered.promise; await f.manager.signOut(ownerA, record.registrationId); release.resolve(); await rejected;
    expect(f.data.get(record.registrationId)?.tokens).toBeNull();
  });
});

const streamRequest: ChatGPTResponseRequest = { model: "synthetic-visible-model", instructions: "Synthetic QA", input: [{ role: "user", content: "Synthetic prompt" }] };
function streamFixture(events: unknown[], response?: Response) {
  const session = { accountId: "synthetic-registration", accessToken: "synthetic.subscription.access", expiresAt: now + 3600000, scopes: ["openid", "resource.invoke", PLAN_USAGE_SCOPE] };
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ models: [{ slug: streamRequest.model, display_name: "Synthetic model", visibility: "list" }] }))
    .mockResolvedValueOnce(response ?? new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
  const getSession = vi.fn(async () => ({ ...session }));
  const transport = createChatGPTTransport({ getSession, fetch: request, now: () => now });
  const controller = new AbortController();
  const run = (options: { onTextDelta?: (delta: string) => void | Promise<void> } = {}) => transport.streamResponse(streamRequest, { expectedAccountId: session.accountId, signal: controller.signal, ...options });
  return { session, request, getSession, transport, controller, run };
}
const streamCompletion = { type: "response.completed", response: { id: "synthetic-response", status: "completed", model: streamRequest.model, output: [] } };
describe("independent streamed identity and billing containment", () => {
  it("binds the first delta's response ID even if response.created is absent", async () => {
    const f = streamFixture([{ type: "response.output_text.delta", response_id: "different-response", delta: "Synthetic partial" }, streamCompletion]);
    expect(await f.run()).toMatchObject({ status: "interrupted", failure: { code: "stream_response_mismatch", dispatched: true }, partialText: "Synthetic partial" });
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([500, 502, 504])("keeps an unexplained HTTP %s detail response uncertain after dispatch", async code => {
    const f = streamFixture([], Response.json({ detail: "Synthetic private internal failure" }, { status: code }));
    const result = await f.run();
    expect(result).toMatchObject({ status: "interrupted", failure: { httpStatus: code, dispatched: true } });
    expect(JSON.stringify(result)).not.toContain("Synthetic private"); expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("stops before publishing a second delta after account changes, with no API-key fallback", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-synthetic");
    const f = streamFixture([{ type: "response.output_text.delta", delta: "Accepted partial" }, { type: "response.output_text.delta", delta: "Foreign partial" }, streamCompletion]);
    const onTextDelta = vi.fn(() => { f.getSession.mockResolvedValue({ ...f.session, accountId: "other-registration" }); });
    const result = await f.run({ onTextDelta });
    expect(result).toMatchObject({ status: "interrupted", failure: { code: "account_changed" }, partialText: "Accepted partial" });
    expect(onTextDelta).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain("Foreign partial");
    expect(f.request).toHaveBeenCalledTimes(2);
    for (const [url, init] of f.request.mock.calls) { expect(String(url).startsWith("https://api.openai.com/v1/")).toBe(true); expect(JSON.stringify(init)).not.toContain("sk-synthetic"); }
  });

  it("does not dispatch when token refresh changes the credential during catalog lookup", async () => {
    const f = streamFixture([streamCompletion]);
    f.getSession.mockResolvedValueOnce(f.session).mockResolvedValue({ ...f.session, accessToken: "synthetic.rotated.access" });
    expect(await f.run()).toMatchObject({ status: "unavailable", failure: { code: "account_changed", dispatched: false } });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});

const limits = { maxInputBytes: 131_072, maxOutputBytes: 262_144, deadlineMs: 240_000, maxObservedWebSearchCalls: 2, maxRequestsPerHour: 20, maxQueuedJobs: 3 };
describe("independent subscription billing separation", () => {
  it("requires explicit subscription admission and never accepts an API price with it", () => {
    const input = { operation: "strategy.reformulate", expectedRevision: 1, idempotencyKey: "qa-subscription-request-001", billingMode: "chatgpt_subscription", acceptedPolicyIdentity: "a".repeat(64) };
    expect(enqueueStrategyJobSchema.parse(input)).toEqual(input);
    for (const patch of [{ acceptedMaxCostMicrousd: 0 }, { ownerId: ownerB }, { registrationId: "foreign-registration" }, { model: "caller-selected-model" }]) expect(enqueueStrategyJobSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("does not claim remaining plan quota or monetary bounds in subscription availability", () => {
    const operation = { operation: "strategy.competitors", billingMode: "chatgpt_subscription", policyIdentity: "a".repeat(64), limits };
    expect(strategyAvailabilitySchema.safeParse({ status: "available", operations: [operation] }).success).toBe(true);
    for (const extra of [{ maximumCostMicrousd: 0 }, { remainingPlanTokens: 1000 }]) expect(strategyAvailabilitySchema.safeParse({ status: "available", operations: [{ ...operation, ...extra }] }).success).toBe(false);
  });

  it("rejects forged identity credentials and unsafe limits in immutable job input", () => {
    const input = { version: 1, billingMode: "chatgpt_subscription", context: {}, policy: { version: 1, billingMode: "chatgpt_subscription", handlerVersion: "strategy-chatgpt-v1", registrationId: "synthetic-registration", model: "synthetic-model", limits } };
    expect(chatGPTStrategyJobInputSchema.safeParse(input).success).toBe(true);
    expect(chatGPTStrategyJobInputSchema.safeParse({ ...input, accessToken: "synthetic-secret" }).success).toBe(false);
    expect(chatGPTStrategyJobInputSchema.safeParse({ ...input, policy: { ...input.policy, limits: { ...limits, maxRequestsPerHour: -1 } } }).success).toBe(false);
  });

  it("keeps unknown usage unknown and rejects provider credentials in stored results", () => {
    const result = { version: 1, provider: "openai", billingMode: "chatgpt_subscription", model: "synthetic-model", responseId: "synthetic-response", requestId: null, generatedAt: new Date(now).toISOString(), usage: null, operation: "strategy.positioning", proposal: { message: "Synthetic output", positioning: "A synthetic statement." } };
    expect(strategyJobResultSchema.parse(result)).toEqual(result);
    for (const extra of [{ accessToken: "synthetic-secret" }, { refreshToken: "synthetic-secret" }, { actualCostMicrousd: 0 }]) expect(strategyJobResultSchema.safeParse({ ...result, ...extra }).success).toBe(false);
  });
});

describe("independent subscription PostgreSQL boundaries (local WASM only)", () => {
  let db: TestDatabase;
  let projectA: string, projectB: string;
  const acceptedIdentities = new Map<string, string>();
  const registrationA = "independent-owner-a-registration", registrationB = "independent-owner-b-registration";
  const policy = (registrationId = registrationA) => ({ version: 1, billingMode: "chatgpt_subscription", handlerVersion: "strategy-chatgpt-v1", registrationId, model: "synthetic-model", limits });
  const worker = <T>(action: () => Promise<T>, owner = OWNER_A) => asSubscriptionWorker(db, owner, action);
  beforeAll(async () => { db = await createTestDatabase(); }, 30000);
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { acceptedIdentities.clear(); await resetFixture(db); projectA = (await seedProject(db)).id; projectB = (await seedProject(db, OWNER_B)).id; });
  async function identify(value: unknown) {
    return (await db.query<{ identity: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') as identity", [JSON.stringify(value)])).rows[0]!.identity;
  }
  async function configure(owner = OWNER_A, registration = registrationA, enabled = true) {
    const value = policy(registration);
    await worker(() => db.query("select public.configure_subscription_runtime($1,'strategy.reformulate',$2::jsonb,$3)", [owner, JSON.stringify(value), enabled]), owner);
    await worker(() => db.query("select public.report_subscription_worker_ready($1,$2,'strategy.reformulate',$3::jsonb,60)", [owner, registration, JSON.stringify(value)]), owner);
    acceptedIdentities.set(owner, await identify(value));
  }
  async function submit(owner = OWNER_A, project = projectA, key = "independent-subscription-key", acceptedIdentity = acceptedIdentities.get(owner) ?? "a".repeat(64)) {
    return asRole(db, "authenticated", owner, async () => (await db.query<{ job: { id: string; billingMode: string; policyIdentity: string } }>("select public.enqueue_subscription_strategy_job($1,1,'strategy.reformulate',$2,$3) as job", [project, key, acceptedIdentity])).rows[0]!.job);
  }
  async function take(owner = OWNER_A, registration = registrationA) {
    return worker(async () => (await db.query<{ id: string; owner_id: string; lease_token: string }>("select * from public.claim_subscription_job('independent-worker',$1,$2,60)", [owner, registration])).rows[0], owner);
  }

  it("does not share registrations, claims, private configuration or partials between two owners", async () => {
    await configure(); await configure(OWNER_B, registrationB);
    await expect(configure(OWNER_B, registrationA)).rejects.toMatchObject({ code: "23505" });
    const a = await submit(), b = await submit(OWNER_B, projectB);
    expect(a.id).not.toBe(b.id);
    expect(await take(OWNER_A, registrationB)).toBeUndefined(); expect(await take(OWNER_B, registrationA)).toBeUndefined();
    const claimedA = (await take())!, claimedB = (await take(OWNER_B, registrationB))!;
    expect(claimedA.id).toBe(a.id); expect(claimedB.id).toBe(b.id);
    for (const [owner, job, text] of [[OWNER_A, claimedA, "Private A partial"], [OWNER_B, claimedB, "Private B partial"]] as const) {
      await worker(() => db.query("select public.append_subscription_partial($1,$2,$3)", [job.id, job.lease_token, text]), owner);
      await asRole(db, "authenticated", owner, async () => {
        const rows = await db.query("select job_id,owner_id,partial_text from public.subscription_job_partials");
        expect(rows.rows).toEqual([{ job_id: job.id, owner_id: owner, partial_text: text }]);
        await expect(db.query("select * from fluid_private.subscription_registrations")).rejects.toMatchObject({ code: "42501" });
        await expect(db.query("select * from public.get_subscription_runtime_bindings()")).rejects.toMatchObject({ code: "42501" });
      });
    }
    await asRole(db, "authenticated", OWNER_A, async () => {
      expect((await db.query("select partial_text from public.subscription_job_partials")).rows).toEqual([{ partial_text: "Private A partial" }]);
      await expect(db.query("select public.enqueue_subscription_strategy_job($1,1,'strategy.reformulate','independent-cross-owner-key',$2)", [projectB, acceptedIdentities.get(OWNER_A)])).rejects.toMatchObject({ code: "P0002" });
    });
    await asRole(db, "authenticated", null, async () => {
      expect((await db.query("select * from public.subscription_job_partials")).rows).toEqual([]);
      await expect(db.query("select public.enqueue_subscription_strategy_job($1,1,'strategy.reformulate','independent-no-identity-key',$2)", [projectA, acceptedIdentities.get(OWNER_A)])).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("separates both claim modes while subscription execution needs no USD account or reservation", async () => {
    await configure(); await db.query("delete from public.usage_accounts where owner_id=$1", [OWNER_A]);
    const subscription = await submit(), api = await enqueue(db, projectB, "independent-paid-job-key", 100, OWNER_B);
    expect((await claim(db))?.id).toBe(api.id);
    expect(await claim(db)).toBeUndefined();
    const claimed = (await take())!; expect(claimed.id).toBe(subscription.id);
    await worker(() => db.query("select public.register_job_plan($1,$2,$3::jsonb)", [claimed.id, claimed.lease_token, JSON.stringify([{ key: "respond", maximumCostMicrousd: 0 }])]));
    await worker(() => db.query("select public.begin_job_step($1,$2,'respond','independent-request',0)", [claimed.id, claimed.lease_token]));
    await worker(() => db.query("select public.complete_job_step($1,$2,'respond','failed',0)", [claimed.id, claimed.lease_token]));
    await worker(() => db.query("select public.finish_job($1,$2,'failed')", [claimed.id, claimed.lease_token]));
    expect((await db.query("select * from public.usage_reservations where job_id=$1", [subscription.id])).rows).toEqual([]);
    expect((await db.query("select * from public.usage_accounts where owner_id=$1", [OWNER_A])).rows).toEqual([]);
  });

  it("never lets a cancelled subscription revive through new request keys or API admission", async () => {
    await configure(); const first = await submit();
    await worker(() => db.query("select public.disable_subscription_runtime($1,$2)", [OWNER_A, registrationA]));
    expect((await submit(OWNER_A, projectA, "independent-new-idempotency-key")).id).toBe(first.id);
    expect(await take()).toBeUndefined();
    const original = (await db.query<{ state: string }>("select state from public.jobs where id=$1", [first.id])).rows[0]!;
    expect(original.state).toBe("cancelled");
    await asRole(db, "authenticated", OWNER_A, async () => {
      const availability = (await db.query<{ value: unknown }>("select public.get_strategy_availability(null) as value")).rows[0]!.value;
      expect(availability).toEqual({ status: "unavailable", operations: [], reason: "subscription_unavailable" });
      await expect(db.query("select public.enqueue_strategy_job($1,1,'strategy.reformulate','independent-no-fallback-key',0)", [projectA])).rejects.toMatchObject({ code: "PT409" });
    });
  });

  it("fences cumulative UTF-8 partials by prefix, mode, lease and cancellation", async () => {
    await configure(); await submit(); const job = (await take())!;
    const append = (value: string, lease = job.lease_token) => worker(() => db.query("select public.append_subscription_partial($1,$2,$3)", [job.id, lease, value]));
    await append("漢字"); await append("漢字 retained");
    await expect(append("漢 changed")).rejects.toMatchObject({ code: "40001" });
    await expect(append("漢字 retained" + "漢".repeat(Math.floor(limits.maxOutputBytes / 3)))).rejects.toMatchObject({ code: "22023" });
    // A stale lease is a business conflict, not an engine serialization retry.
    await expect(append("漢字 retained forged", "dddddddd-dddd-4ddd-8ddd-dddddddddddd")).rejects.toMatchObject({ code: "PT409", message: "lease_lost" });
    await enqueue(db, projectB, "independent-mode-crossing", 100, OWNER_B); const api = await claim(db);
    await expect(worker(() => db.query("select public.append_subscription_partial($1,$2,'API partial')", [api.id, api.lease_token]))).rejects.toMatchObject({ code: "42501" });
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.request_job_cancel($1)", [job.id]));
    await expect(append("漢字 retained late")).rejects.toMatchObject({ code: "55000" });
    expect((await db.query("select partial_text from public.subscription_job_partials where job_id=$1", [job.id])).rows).toEqual([{ partial_text: "漢字 retained" }]);
  });

  it("requires exact current policy and fresh readiness again at claim time", async () => {
    await configure(); const original = await submit();
    const changed = { ...policy(), model: "another-visible-model" };
    await worker(() => db.query("select public.configure_subscription_runtime($1,'strategy.reformulate',$2::jsonb,true)", [OWNER_A, JSON.stringify(changed)]));
    const oldHeartbeat = await worker(() => db.query<{ ready: boolean }>("select public.report_subscription_worker_ready($1,$2,'strategy.reformulate',$3::jsonb,60) as ready", [OWNER_A, registrationA, JSON.stringify(policy())]));
    expect(oldHeartbeat.rows[0]!.ready).toBe(false); expect(await take()).toBeUndefined();
    await worker(() => db.query("select public.report_subscription_worker_ready($1,$2,'strategy.reformulate',$3::jsonb,60)", [OWNER_A, registrationA, JSON.stringify(changed)]));
    expect(await take()).toBeUndefined();
    expect((await db.query<{ state: string }>("select state from public.jobs where id=$1", [original.id])).rows[0]!.state).toBe("cancelled");
    await configure();
    await submit(OWNER_A, (await seedProject(db)).id, "independent-expired-readiness");
    await db.query("update fluid_private.subscription_runtime_policy set worker_ready_until=clock_timestamp()-interval '1 second'");
    expect(await take()).toBeUndefined();
  });

  it("rejects stale model-selection consent before enqueue and when replaying a frozen job", async () => {
    await configure(); const acceptedBeforeSwitch = acceptedIdentities.get(OWNER_A)!;
    const changed = { ...policy(), model: "another-visible-model" };
    await worker(() => db.query("select public.configure_subscription_runtime($1,'strategy.reformulate',$2::jsonb,true)", [OWNER_A, JSON.stringify(changed)]));
    await worker(() => db.query("select public.report_subscription_worker_ready($1,$2,'strategy.reformulate',$3::jsonb,60)", [OWNER_A, registrationA, JSON.stringify(changed)]));
    await expect(submit()).rejects.toThrow(/policy_identity_conflict/);
    expect((await db.query("select id from public.jobs")).rows).toEqual([]);
    const acceptedAfterSwitch = await identify(changed);
    const first = await submit(OWNER_A, projectA, "independent-current-policy-key", acceptedAfterSwitch);
    expect(first.policyIdentity).toBe(acceptedAfterSwitch);
    await expect(submit(OWNER_A, projectA, "independent-current-policy-key", acceptedBeforeSwitch)).rejects.toThrow(/policy_identity_conflict/);
    await expect(submit(OWNER_A, projectA, "independent-changed-retry-key", acceptedBeforeSwitch)).rejects.toThrow(/policy_identity_conflict/);
    expect((await submit(OWNER_A, projectA, "independent-current-policy-key", acceptedAfterSwitch)).id).toBe(first.id);
    expect((await db.query("select id from public.jobs")).rows).toHaveLength(1);
  });

  it("does not reset an owner's hourly guard by cancelling or changing registrations", async () => {
    const cap = (registrationId: string) => ({ ...policy(registrationId), limits: { ...limits, maxRequestsPerHour: 1, maxQueuedJobs: 1 } });
    const configureCap = async (registrationId: string) => {
      await worker(() => db.query("select public.configure_subscription_runtime($1,'strategy.reformulate',$2::jsonb,true)", [OWNER_A, JSON.stringify(cap(registrationId))]));
      await worker(() => db.query("select public.report_subscription_worker_ready($1,$2,'strategy.reformulate',$3::jsonb,60)", [OWNER_A, registrationId, JSON.stringify(cap(registrationId))]));
      acceptedIdentities.set(OWNER_A, await identify(cap(registrationId)));
    };
    await configureCap(registrationA); const first = await submit();
    await asRole(db, "authenticated", OWNER_A, () => db.query("select public.request_job_cancel($1)", [first.id]));
    await configureCap("second-owned-registration");
    const anotherProject = (await seedProject(db)).id;
    await expect(submit(OWNER_A, anotherProject, "independent-quota-bypass-key")).rejects.toThrow(/quota_unavailable/);
    const availability = await asRole(db, "authenticated", OWNER_A, () => db.query<{ value: unknown }>("select public.get_strategy_availability(null) as value"));
    expect(availability.rows[0]!.value).toEqual({ status: "unavailable", operations: [], reason: "quota_unavailable" });
    expect((await db.query("select id from public.jobs where owner_id=$1", [OWNER_A])).rows).toHaveLength(1);
  });
});
