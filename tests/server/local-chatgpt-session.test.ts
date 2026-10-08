import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createOpenAIOAuthClient, LocalChatGPTError, OPENAI_TOKEN_URL, type LocalChatGPTErrorCode } from "../../src/server/local-chatgpt/oauth";
import { createLocalChatGPTSessionManager } from "../../src/server/local-chatgpt/session";
import { reportSignInFailure, type SignInFailure } from "../../src/server/local-chatgpt/sign-in-diagnostics";
import { createOAuthFixture, LOCAL_BROWSER, LOCAL_CALLBACK, LOCAL_CLIENT, LOCAL_OTHER_OWNER, LOCAL_OWNER, LOCAL_SUBJECT, localRecord, MemoryCredentialFixture } from "./local-chatgpt-fixtures";

describe("local ChatGPT owner-bound sessions (no live OAuth)", () => {
  let fixture: Awaited<ReturnType<typeof createOAuthFixture>>;
  let store: MemoryCredentialFixture;
  let manager: ReturnType<typeof createLocalChatGPTSessionManager>;
  let invalidated: (ownerId: string, registrationId: string) => void;
  let oauth: ReturnType<typeof createOpenAIOAuthClient>;
  let onSignInFailure: ReturnType<typeof vi.fn<(failure: SignInFailure) => void>>;
  beforeAll(async () => { fixture = await createOAuthFixture(); });
  beforeEach(() => {
    fixture.time.now = Date.parse("2026-10-04T00:00:00Z");
    fixture.fetcher.mockClear();
    fixture.setRevokeHandler(async () => new Response(null, { status: 200 }));
    store = new MemoryCredentialFixture();
    invalidated = vi.fn();
    oauth = createOpenAIOAuthClient({ fetch: fixture.fetcher, now: () => fixture.time.now });
    onSignInFailure = vi.fn();
    manager = createLocalChatGPTSessionManager({ store, oauth, onSignInFailure, now: () => fixture.time.now, onSessionInvalidated: invalidated, revocationBackoff: async () => {} });
  });
  async function start(input: { ownerId?: string; browserSessionId?: string; registrationId?: string } = {}) {
    const flow = await manager.beginSignIn({ ownerId: input.ownerId ?? LOCAL_OWNER, browserSessionId: input.browserSessionId ?? LOCAL_BROWSER, redirectUri: LOCAL_CALLBACK, registrationId: input.registrationId });
    const url = new URL(flow.authorizationUrl);
    return { url, callback: `${LOCAL_CALLBACK}?state=${url.searchParams.get("state")}&code=local-fixture-code&client_id=${LOCAL_CLIENT}` };
  }
  async function connect() {
    const flow = await start();
    fixture.setTokenHandler(async () => Response.json(await fixture.tokens({ nonce: flow.url.searchParams.get("nonce")! })));
    return manager.completeSignIn({ callbackUrl: flow.callback });
  }

  it("keeps constructors inert and stores only a signed identity under its original Fluid owner", async () => {
    expect(store.writes).toBe(0); expect(store.hostReads).toBe(0); expect(fixture.fetcher).not.toHaveBeenCalled();
    const connected = await connect();
    expect(connected.ownerId).toBe(LOCAL_OWNER);
    expect(Object.keys(connected.registration).sort()).toEqual(["email", "planUsageEnabled", "registrationId"]);
    expect(connected.registration.planUsageEnabled).toBe(true);
    expect(await manager.listRegistrations(LOCAL_OTHER_OWNER)).toEqual([]);
    await expect(manager.getInferenceCredential(LOCAL_OTHER_OWNER, connected.registration.registrationId)).rejects.toMatchObject({ code: "registration_not_found" });
    await expect(manager.beginSignIn({ ownerId: LOCAL_OTHER_OWNER, browserSessionId: LOCAL_BROWSER, redirectUri: LOCAL_CALLBACK, registrationId: connected.registration.registrationId })).rejects.toMatchObject({ code: "registration_not_found" });
    await expect(manager.signOut(LOCAL_OTHER_OWNER, connected.registration.registrationId)).rejects.toMatchObject({ code: "registration_not_found" });
    expect(await manager.listRegistrations(LOCAL_OWNER)).toEqual([connected.registration]);
    expect(onSignInFailure).not.toHaveBeenCalled();
  });

  it("consumes callbacks once and never replaces a stored session with a wrong returned identity", async () => {
    const connected = await connect();
    const before = structuredClone(store.records);
    const flow = await start({ registrationId: connected.registration.registrationId });
    expect(flow.url.searchParams.get("client_id")).toBe(LOCAL_CLIENT);
    expect(flow.url.searchParams.has("agent_name_hint")).toBe(false);
    expect(flow.url.searchParams.has("id_token_hint")).toBe(false);
    const retainedTokens = store.records.get(connected.registration.registrationId)!.tokens!;
    for (const token of [retainedTokens.idToken, retainedTokens.accessToken, retainedTokens.refreshToken]) {
      expect(token).toBeTruthy();
      expect(flow.url.href).not.toContain(token);
      expect([...flow.url.searchParams.values()]).not.toContain(token);
    }
    fixture.setTokenHandler(async () => Response.json(await fixture.tokens({ nonce: flow.url.searchParams.get("nonce")!, subject: "wrong-fixture-subject" })));
    await expect(manager.completeSignIn({ callbackUrl: flow.callback })).rejects.toMatchObject({ code: "invalid_identity" });
    await expect(manager.completeSignIn({ callbackUrl: flow.callback })).rejects.toMatchObject({ code: "invalid_callback" });
    expect(store.records).toEqual(before);
  });

  it("does not exchange denied, expired or ambiguous callbacks", async () => {
    let flow = await start();
    await expect(manager.completeSignIn({ callbackUrl: `${LOCAL_CALLBACK}?state=${flow.url.searchParams.get("state")}&error=access_denied` })).rejects.toMatchObject({ code: "access_denied" });
    flow = await start();
    fixture.time.now += 10 * 60_000;
    await expect(manager.completeSignIn({ callbackUrl: flow.callback })).rejects.toMatchObject({ code: "invalid_callback" });
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url) === OPENAI_TOKEN_URL)).toBe(false);
    expect(store.writes).toBe(0);
  });

  it("reports malformed callbacks before exchange without retaining callback content", async () => {
    const callbackUrl = "synthetic-secret-callback-state-code-token-email";
    const exchange = vi.spyOn(oauth, "exchange");
    await expect(manager.completeSignIn({ callbackUrl })).rejects.toMatchObject({ code: "invalid_callback" });
    expect(onSignInFailure.mock.calls).toEqual([[{ phase: "callback_validation", reason: "invalid_callback" }]]);
    expect(exchange).not.toHaveBeenCalled(); expect(store.writes).toBe(0);
  });

  it.each(["access_denied", "expired", "ambiguous"])("reports %s once as callback validation without exchanging", async kind => {
    const flow = await start();
    const callback = new URL(flow.callback);
    if (kind === "access_denied") { callback.searchParams.delete("code"); callback.searchParams.set("error", "access_denied"); }
    if (kind === "expired") fixture.time.now += 10 * 60_000;
    if (kind === "ambiguous") callback.searchParams.append("state", "synthetic-secret-state");
    const exchange = vi.spyOn(oauth, "exchange");
    const reason = kind === "access_denied" ? "access_denied" : "invalid_callback";
    await expect(manager.completeSignIn({ callbackUrl: callback.href })).rejects.toMatchObject({ code: reason });
    expect(onSignInFailure.mock.calls).toEqual([[{ phase: "callback_validation", reason }]]);
    expect(exchange).not.toHaveBeenCalled(); expect(store.writes).toBe(0);
  });

  it.each([true, false])("reports exchange failure once, preserves the original error and consumes the callback (known: %s)", async known => {
    const flow = await start();
    const error = known ? new LocalChatGPTError("invalid_token_response") : new Error("synthetic-secret-provider-response");
    const exchange = vi.spyOn(oauth, "exchange").mockRejectedValue(error);
    await expect(manager.completeSignIn({ callbackUrl: flow.callback })).rejects.toBe(error);
    expect(onSignInFailure.mock.calls).toEqual([[{ phase: "oauth_exchange", reason: known ? "invalid_token_response" : "unavailable" }]]);
    await expect(manager.completeSignIn({ callbackUrl: flow.callback })).rejects.toMatchObject({ code: "invalid_callback" });
    expect(onSignInFailure.mock.calls[1]).toEqual([{ phase: "callback_validation", reason: "invalid_callback" }]);
    expect(exchange).toHaveBeenCalledOnce(); expect(store.writes).toBe(0);
  });

  it("reports session record validation after exchange without persisting invalid tokens", async () => {
    const flow = await start(), record = localRecord();
    vi.spyOn(oauth, "exchange").mockResolvedValue({
      identity: { issuer: record.issuer, subject: record.subject, clientId: record.clientId, email: record.email },
      tokens: { ...record.tokens!, accessToken: "synthetic invalid secret token" },
    });
    await expect(manager.completeSignIn({ callbackUrl: flow.callback })).rejects.toMatchObject({ code: "invalid_token_response" });
    expect(onSignInFailure.mock.calls).toEqual([[{ phase: "session_validation", reason: "invalid_token_response" }]]);
    expect(store.writes).toBe(0); expect(invalidated).not.toHaveBeenCalled();
  });

  it.each(["lock", "write"])("reports %s persistence failures with no session replacement", async failure => {
    const connected = await connect(), before = structuredClone(store.records);
    const flow = await start({ registrationId: connected.registration.registrationId });
    fixture.setTokenHandler(async () => Response.json(await fixture.tokens({ nonce: flow.url.searchParams.get("nonce")! })));
    const error = new LocalChatGPTError(failure === "lock" ? "credential_store_busy" : "credential_store_unavailable");
    vi.spyOn(store, failure === "lock" ? "withLock" : "write").mockRejectedValue(error);
    await expect(manager.completeSignIn({ callbackUrl: flow.callback })).rejects.toBe(error);
    expect(onSignInFailure.mock.calls).toEqual([[{ phase: "session_persistence", reason: error.code }]]);
    expect(store.records).toEqual(before);
  });

  it("never invokes secret-bearing error getters or lets an observer replace a persistence failure", async () => {
    const flow = await start();
    fixture.setTokenHandler(async () => Response.json(await fixture.tokens({ nonce: flow.url.searchParams.get("nonce")! })));
    const readSecret = vi.fn(() => { throw new Error("synthetic-secret-getter"); });
    const error = Object.defineProperties(new LocalChatGPTError("invalid_client"), { code: { get: readSecret }, message: { get: readSecret } });
    vi.spyOn(store, "write").mockRejectedValue(error);
    onSignInFailure.mockImplementation(() => { throw new Error("synthetic-secret-observer"); });
    await expect(manager.completeSignIn({ callbackUrl: flow.callback })).rejects.toBe(error);
    expect(onSignInFailure.mock.calls).toEqual([[{ phase: "session_persistence", reason: "unavailable" }]]);
    expect(readSecret).not.toHaveBeenCalled(); expect(store.writes).toBe(0); expect(invalidated).not.toHaveBeenCalled();
  });

  it("retains an issued client only transiently after invalid_grant for a manual same-browser retry", async () => {
    const flow = await start();
    fixture.setTokenHandler(async () => Response.json({ error: "invalid_grant", error_description: "local-fixture-private-detail" }, { status: 400 }));
    await expect(manager.completeSignIn({ callbackUrl: flow.callback })).rejects.toMatchObject({ code: "sign_in_required" });
    expect(store.writes).toBe(0);
    expect((await start()).url.searchParams.get("client_id")).toBe(LOCAL_CLIENT);
    expect((await start({ browserSessionId: "separate_browser_fixture_012345678901234" })).url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    fixture.time.now += 10 * 60_000 + 1;
    expect((await start()).url.searchParams.get("client_id")).toBe("dynamic_agent_client");
  });

  it("serializes a rotating refresh and atomically replaces the latest token set once", async () => {
    const connected = await connect();
    const id = connected.registration.registrationId;
    fixture.time.now += 3_550_000;
    let refreshCalls = 0;
    fixture.setTokenHandler(async form => {
      refreshCalls++;
      expect(Object.fromEntries(form)).toEqual({ grant_type: "refresh_token", client_id: LOCAL_CLIENT, refresh_token: "local-fixture-refresh-original", resource: "https://api.openai.com/v1" });
      return Response.json(await fixture.tokens({ refreshToken: "local-fixture-refresh-rotated" }));
    });
    const results = await Promise.all(Array.from({ length: 15 }, () => manager.getInferenceCredential(LOCAL_OWNER, id)));
    expect(refreshCalls).toBe(1);
    expect(results.every(value => value.registrationId === id && value.subject === LOCAL_SUBJECT && value.accessToken === results[0]!.accessToken)).toBe(true);
    expect(store.records.get(id)?.tokens?.refreshToken).toBe("local-fixture-refresh-rotated");
    expect(store.writes).toBe(2);
  });

  it("respects earliest refresh and distinguishes transient failure from unusable credentials", async () => {
    const connected = await connect();
    const id = connected.registration.registrationId;
    const original = store.records.get(id)!;
    store.records.set(id, { ...original, tokens: { ...original.tokens!, earliestRefreshAt: fixture.time.now + 3_590_000 } });
    fixture.time.now += 3_550_000;
    let refreshCalls = 0;
    fixture.setTokenHandler(async () => { refreshCalls++; return Response.json({ error: "temporarily_unavailable" }, { status: 503 }); });
    expect((await manager.getInferenceCredential(LOCAL_OWNER, id)).registrationId).toBe(id);
    expect(refreshCalls).toBe(0);
    fixture.time.now += 50_000;
    await expect(manager.getInferenceCredential(LOCAL_OWNER, id)).rejects.toMatchObject({ code: "session_unavailable" });
    expect(store.records.get(id)?.tokens?.refreshToken).toBe("local-fixture-refresh-original");
    fixture.setTokenHandler(async () => Response.json({ error: "refresh_token_reused" }, { status: 400 }));
    await expect(manager.getInferenceCredential(LOCAL_OWNER, id)).rejects.toMatchObject({ code: "sign_in_required" });
    expect(store.records.get(id)?.tokens).toBeNull();
    expect(store.records.get(id)?.clientId).toBe(LOCAL_CLIENT);
  });

  it("blocks inference when direct permission is absent without converting to API billing", async () => {
    const flow = await start();
    fixture.setTokenHandler(async () => Response.json({ id_token: await fixture.jwt({ sub: LOCAL_SUBJECT, nonce: flow.url.searchParams.get("nonce") }), scope: "openid profile email" }));
    const connected = await manager.completeSignIn({ callbackUrl: flow.callback });
    expect(connected.registration.planUsageEnabled).toBe(false);
    await expect(manager.getInferenceCredential(LOCAL_OWNER, connected.registration.registrationId)).rejects.toMatchObject({ code: "plan_permission_required" });
  });

  it("revokes the selected registration, clears all tokens and retains its issued-client mapping", async () => {
    const connected = await connect();
    const id = connected.registration.registrationId;
    const disconnected = await manager.signOut(LOCAL_OWNER, id);
    expect(disconnected.remoteRevocationConfirmed).toBe(true);
    expect(disconnected.registration.planUsageEnabled).toBe(false);
    expect(store.records.get(id)?.tokens).toBeNull();
    expect(store.records.get(id)?.clientId).toBe(LOCAL_CLIENT);
    const flow = await start({ registrationId: id });
    expect(flow.url.searchParams.get("client_id")).toBe(LOCAL_CLIENT);
    expect(flow.url.searchParams.has("id_token_hint")).toBe(false);
    expect(invalidated).toHaveBeenCalledWith(LOCAL_OWNER, id);
  });

  it("reports unconfirmed remote revocation after bounded retry while clearing local secrets", async () => {
    const connected = await connect();
    let revocations = 0;
    fixture.setRevokeHandler(async () => { revocations++; return new Response(null, { status: 503 }); });
    const disconnected = await manager.signOut(LOCAL_OWNER, connected.registration.registrationId);
    expect(revocations).toBe(2);
    expect(disconnected.remoteRevocationConfirmed).toBe(false);
    expect(store.records.get(connected.registration.registrationId)?.tokens).toBeNull();
  });

  it.each([true, false])("fences late OAuth after sign-out when the existing registration is explicit=%s", async explicitRegistration => {
    const connected = await connect();
    const id = connected.registration.registrationId;
    const flow = await start(explicitRegistration ? { registrationId: id } : {});
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    fixture.setTokenHandler(async () => { started(); await barrier; return Response.json(await fixture.tokens({ nonce: flow.url.searchParams.get("nonce")! })); });
    const completing = manager.completeSignIn({ callbackUrl: flow.callback });
    const asserted = expect(completing).rejects.toMatchObject({ code: "sign_in_required" });
    await startedPromise;
    await manager.signOut(LOCAL_OWNER, id);
    release();
    await asserted;
    expect(store.records.get(id)?.tokens).toBeNull();
  });

  it("fences an in-flight refresh on sign-out and revokes the latest rotated token", async () => {
    const connected = await connect();
    const id = connected.registration.registrationId;
    fixture.time.now += 3_550_000;
    let release!: () => void, started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    fixture.setTokenHandler(async () => { started(); await barrier; return Response.json(await fixture.tokens({ refreshToken: "local-new-refresh-after-race" })); });
    const credential = manager.getInferenceCredential(LOCAL_OWNER, id);
    const asserted = expect(credential).rejects.toMatchObject({ code: "sign_in_required" });
    await startedPromise;
    const signingOut = manager.signOut(LOCAL_OWNER, id);
    await Promise.resolve();
    release();
    await asserted;
    expect((await signingOut).remoteRevocationConfirmed).toBe(true);
    const revokeCall = fixture.fetcher.mock.calls.find(([url]) => String(url).endsWith("/oauth/revoke"));
    expect(new URLSearchParams(String(revokeCall?.[1]?.body)).get("token")).toBe("local-new-refresh-after-race");
    expect(store.records.get(id)?.tokens).toBeNull();
  });

  it("bounds pending sign-ins even while discovery is delayed", async () => {
    const oauth = createOpenAIOAuthClient({ fetch: fixture.fetcher, now: () => fixture.time.now });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    manager = createLocalChatGPTSessionManager({ store, now: () => fixture.time.now, oauth: { ...oauth, authorizationUrl: async (...args) => { await barrier; return oauth.authorizationUrl(...args); } } });
    const pending = Array.from({ length: 32 }, (_, index) => start({ browserSessionId: `independent_browser_fixture_${String(index).padStart(10, "0")}` }));
    await Promise.resolve(); await Promise.resolve();
    await expect(start({ browserSessionId: "independent_browser_fixture_exceeds_limit" })).rejects.toMatchObject({ code: "authorization_pending_limit" });
    release();
    expect(await Promise.all(pending)).toHaveLength(32);
  });

  it("still clears credentials if a runtime invalidation observer fails", async () => {
    manager = createLocalChatGPTSessionManager({ store, now: () => fixture.time.now, oauth: createOpenAIOAuthClient({ fetch: fixture.fetcher, now: () => fixture.time.now }), onSessionInvalidated: () => { throw new Error("local-observer-fixture-failure"); } });
    const connected = await connect();
    await manager.signOut(LOCAL_OWNER, connected.registration.registrationId);
    expect(store.records.get(connected.registration.registrationId)?.tokens).toBeNull();
  });
});


describe("allowlisted sign-in failure diagnostics", () => {
  it.each<LocalChatGPTErrorCode>([
    "invalid_configuration", "invalid_callback", "access_denied", "invalid_identity", "invalid_token_response",
    "sign_in_required", "plan_permission_required", "session_unavailable", "invalid_client", "registration_not_found",
    "credential_store_unavailable", "credential_store_busy", "authorization_pending_limit",
  ])("accepts only the static category %s on a LocalChatGPTError", reason => {
    const observer = vi.fn();
    reportSignInFailure("oauth_exchange", new LocalChatGPTError(reason), observer);
    expect(observer.mock.calls).toEqual([[{ phase: "oauth_exchange", reason }]]);
  });

  it("maps forged, unknown, getter-bearing and proxy errors to unavailable without reading secret fields", () => {
    const readSecret = vi.fn(() => { throw new Error("synthetic-secret-getter"); });
    const localError = () => new LocalChatGPTError("invalid_client");
    const errors: unknown[] = [
      new Error("synthetic-secret-error-message"), "synthetic-secret-string", undefined, null,
      { code: "invalid_client", message: "synthetic-secret-message", callbackUrl: "synthetic-secret-url", ownerId: "synthetic-secret-owner" },
      Object.defineProperty(localError(), "code", { value: "synthetic-secret-unknown-code" }),
      Object.defineProperty(localError(), "code", { value: { toString: readSecret } }),
      Object.defineProperties(localError(), { code: { get: readSecret }, message: { get: readSecret } }),
      new Proxy(localError(), { getPrototypeOf: readSecret }),
      new Proxy(localError(), { getOwnPropertyDescriptor: readSecret }),
    ];
    for (const error of errors) {
      const observer = vi.fn();
      reportSignInFailure("oauth_exchange", error, observer);
      expect(observer.mock.calls).toEqual([[{ phase: "oauth_exchange", reason: "unavailable" }]]);
    }
    // The two hostile proxy traps may throw; property getters and coercions are never invoked.
    expect(readSecret).toHaveBeenCalledTimes(2);
  });
});
