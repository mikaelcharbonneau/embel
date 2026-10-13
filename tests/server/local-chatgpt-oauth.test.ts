import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createAuthorizationAttempt, createOpenAIOAuthClient, OPENAI_AUTHORIZE_URL, OPENAI_ISSUER, OPENAI_JWKS_URL, OPENAI_RESOURCE, OPENAI_TOKEN_URL, readAuthorizationCallback, validateLoopbackCallback } from "../../src/server/local-chatgpt/oauth";
import { createHash } from "node:crypto";
import { createOAuthFixture, discoveryFixture, LOCAL_BROWSER, LOCAL_CALLBACK, LOCAL_CLIENT, LOCAL_HOST, LOCAL_OWNER, LOCAL_SUBJECT } from "./local-chatgpt-fixtures";

describe("local ChatGPT OAuth security (signed fixtures only)", () => {
  let fixture: Awaited<ReturnType<typeof createOAuthFixture>>;
  beforeAll(async () => { fixture = await createOAuthFixture(); });
  const attempt = () => createAuthorizationAttempt({ ownerId: LOCAL_OWNER, browserSessionId: LOCAL_BROWSER, redirectUri: LOCAL_CALLBACK, hostId: LOCAL_HOST }, fixture.time.now);
  const callback = (state: string, extra = "") => `${LOCAL_CALLBACK}?state=${state}&code=local-fixture-code&client_id=${LOCAL_CLIENT}${extra}`;

  it("uses fresh PKCE, state and nonce, full plan scopes and only a loopback callback", async () => {
    const first = attempt(), second = attempt();
    expect(first.state).not.toBe(second.state);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    const client = createOpenAIOAuthClient({ fetch: fixture.fetcher, now: () => fixture.time.now });
    const url = new URL(await client.authorizationUrl(first));
    expect(url.origin + url.pathname).toBe(OPENAI_AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("Embel");
    expect(url.searchParams.get("ext_agent_host_id")).toBe(LOCAL_HOST);
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(first.codeVerifier).digest("base64url"));
    expect(url.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    expect(url.searchParams.get("resource")).toBe(OPENAI_RESOURCE);
    expect(url.searchParams.get("redirect_uri")).toBe(LOCAL_CALLBACK);
  });

  it.each(["http://localhost:31415/auth/callback", "https://127.0.0.1:31415/auth/callback", "http://0.0.0.0:31415/auth/callback", "http://127.0.0.1:31415/callback", "http://127.0.0.1:31415/auth/callback?next=https://foreign.example"]) ("rejects unsupported callback %s", value => {
    expect(() => validateLoopbackCallback(value)).toThrow(/invalid_configuration/);
  });

  it("rejects duplicate parameters, expired/wrong state, wrong endpoint, missing issued client and client substitution", () => {
    const pending = attempt();
    for (const url of [callback("wrong-state"), callback(pending.state, "&code=second"), callback(pending.state, "&state=other"), callback(pending.state, "&client_id=other"), callback(pending.state).replace(":31415", ":31416"), `${LOCAL_CALLBACK}?state=${pending.state}&code=fixture`]) {
      expect(() => readAuthorizationCallback(pending, url, fixture.time.now)).toThrow(/invalid_callback/);
    }
    expect(() => readAuthorizationCallback(pending, callback(pending.state), pending.expiresAt)).toThrow(/invalid_callback/);
    expect(() => readAuthorizationCallback({ ...pending, clientId: "oaiapp_other_fixture" }, callback(pending.state), fixture.time.now)).toThrow(/invalid_callback/);
    expect(() => readAuthorizationCallback(pending, `${LOCAL_CALLBACK}?state=${pending.state}&error=access_denied`, fixture.time.now)).toThrow(/access_denied/);
    expect(() => readAuthorizationCallback(pending, `${LOCAL_CALLBACK}?state=wrong&error=access_denied`, fixture.time.now)).toThrow(/invalid_callback/);
  });

  it("exchanges only the issued client with its original verifier/URI and validates actual RSA signatures", async () => {
    const pending = attempt();
    fixture.setTokenHandler(async form => {
      expect(Object.fromEntries(form)).toEqual({ grant_type: "authorization_code", client_id: LOCAL_CLIENT, code: "local-fixture-code", code_verifier: pending.codeVerifier, redirect_uri: LOCAL_CALLBACK, resource: OPENAI_RESOURCE });
      return Response.json(await fixture.tokens({ nonce: pending.nonce }));
    });
    const client = createOpenAIOAuthClient({ fetch: fixture.fetcher, now: () => fixture.time.now });
    const validated = await client.exchange(pending, readAuthorizationCallback(pending, callback(pending.state), fixture.time.now));
    expect(validated.identity).toEqual({ issuer: OPENAI_ISSUER, subject: LOCAL_SUBJECT, clientId: LOCAL_CLIENT, email: "local-fixture@example.test" });
    expect(validated.tokens.scopes).toContain("chatgpt.tokens.use.direct");
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url) === OPENAI_JWKS_URL)).toBe(true);
    expect(fixture.fetcher.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });

  it.each(["nonce", "issuer", "audience", "expiry", "subject", "signature", "access_client"])("rejects invalid %s without accepting a token set", async invalid => {
    const pending = { ...attempt(), subject: LOCAL_SUBJECT, clientId: LOCAL_CLIENT };
    const body = await fixture.tokens({ nonce: pending.nonce });
    if (invalid === "nonce") body.id_token = await fixture.jwt({ sub: LOCAL_SUBJECT, nonce: "wrong" });
    if (invalid === "issuer") body.id_token = await fixture.jwt({ sub: LOCAL_SUBJECT, nonce: pending.nonce }, { issuer: "https://foreign.example" });
    if (invalid === "audience") body.id_token = await fixture.jwt({ sub: LOCAL_SUBJECT, nonce: pending.nonce }, { audience: "oaiapp_other_fixture" });
    if (invalid === "expiry") body.id_token = await fixture.jwt({ sub: LOCAL_SUBJECT, nonce: pending.nonce }, { expires: Math.floor(fixture.time.now / 1000) - 60, issued: Math.floor(fixture.time.now / 1000) - 3600 });
    if (invalid === "subject") body.id_token = await fixture.jwt({ sub: "foreign-subject", nonce: pending.nonce });
    if (invalid === "signature") {
      const parts = body.id_token.split(".");
      parts[2] = `${parts[2]!.startsWith("A") ? "B" : "A"}${parts[2]!.slice(1)}`;
      body.id_token = parts.join(".");
    }
    if (invalid === "access_client") body.access_token = await fixture.jwt({ sub: LOCAL_SUBJECT, client_id: "oaiapp_other_fixture", scope: body.scope }, { audience: OPENAI_RESOURCE });
    fixture.setTokenHandler(async () => Response.json(body));
    const client = createOpenAIOAuthClient({ fetch: fixture.fetcher, now: () => fixture.time.now });
    await expect(client.exchange(pending, { code: "fixture", clientId: LOCAL_CLIENT })).rejects.toMatchObject({ code: "invalid_identity" });
  });

  it("retains identity-only sign-in without inventing direct-plan permission", async () => {
    const pending = attempt();
    fixture.setTokenHandler(async () => Response.json({ id_token: await fixture.jwt({ sub: LOCAL_SUBJECT, nonce: pending.nonce }), scope: "openid profile email" }));
    const client = createOpenAIOAuthClient({ fetch: fixture.fetcher, now: () => fixture.time.now });
    const result = await client.exchange(pending, { code: "fixture", clientId: LOCAL_CLIENT });
    expect(result.tokens.accessToken).toBeNull();
    expect(result.tokens.refreshToken).toBeNull();
    expect(result.tokens.scopes).not.toContain("chatgpt.tokens.use.direct");
  });

  it("rejects discovery endpoint substitution and never forwards a code to another host", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...discoveryFixture, token_endpoint: "https://foreign.example/token" }));
    const client = createOpenAIOAuthClient({ fetch: fetcher, now: () => fixture.time.now });
    await expect(client.exchange(attempt(), { code: "local-fixture-code", clientId: LOCAL_CLIENT })).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.some(([url]) => String(url) === OPENAI_TOKEN_URL)).toBe(false);
  });
});
