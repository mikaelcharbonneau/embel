import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CookieOptions } from "@supabase/ssr";

vi.mock("server-only", () => ({}));
const next = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: next.cookies }));
import { createAuthTransitionClient } from "../../src/server/auth/client";
import { GET as callback } from "../../src/app/auth/callback/route";
import { POST as signIn } from "../../src/app/api/auth/sign-in/route";
import { POST as requestReset } from "../../src/app/api/auth/password-reset/route";

// Real pinned @supabase/ssr + auth-js, with a synthetic cookie jar and transport.
// No requests reach Supabase, no accounts are created, and no email is sent.
const origin = "https://fluid.example";
const provider = "https://fixture.supabase.co";
const user = { id: "aaaaaaaa-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "sdk-fixture@example.invalid", email_confirmed_at: "2026-10-13T10:00:00Z", is_anonymous: false, created_at: "2026-10-13T10:00:00Z", app_metadata: {}, user_metadata: {} };
type Cookie = { name: string; value: string; options: CookieOptions };
let jar: Map<string, Cookie>;
let flows: { id: string; challenge: string; path: string }[];
let confirmed = true;
let exchanges = 0;
let passwordGrants = 0;
let passwordFailure = false;
let cleanupFailure = false;
const storageKey = "sb-fixture-auth-token";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", provider);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_local_fixture");
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("NODE_ENV", "production");
  jar = new Map(); flows = []; confirmed = true; exchanges = 0;
  passwordGrants = 0; passwordFailure = false; cleanupFailure = false;
  next.cookies.mockImplementation(async () => ({
    getAll: () => [...jar.values()].map(({ name, value }) => ({ name, value })),
    set: (name: string, value: string, options: CookieOptions) => {
      if (options.maxAge === 0) jar.delete(name);
      else jar.set(name, { name, value, options });
    },
  }));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== provider || init?.method !== "POST") throw new Error("Unexpected synthetic auth request");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url.pathname === "/auth/v1/logout") return cleanupFailure
      ? Response.json({ code: "unexpected_failure", message: "Synthetic cleanup failure" }, { status: 503 })
      : Response.json({});
    const body = JSON.parse(String(init.body));
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      passwordGrants++;
      if (passwordFailure) return Response.json({ code: "invalid_credentials", message: "Synthetic credential failure" }, { status: 400 });
      return Response.json({ access_token: `synthetic-password-access-${passwordGrants}`, refresh_token: `synthetic-password-refresh-${passwordGrants}`,
        token_type: "bearer", expires_in: 3600, user: { ...user, email_confirmed_at: confirmed ? user.email_confirmed_at : undefined } });
    }
    if (url.pathname === "/auth/v1/signup" || url.pathname === "/auth/v1/resend" || url.pathname === "/auth/v1/recover") {
      const redirect = new URL(url.searchParams.get("redirect_to")!);
      expect(redirect.origin).toBe(origin);
      expect(redirect.pathname).toBe("/auth/callback");
      const id = redirect.searchParams.get("sb_flow_id")!;
      expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      expect(body.code_challenge_method).toBe("s256");
      expect(body.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      if (url.pathname.endsWith("resend")) expect(body.type).toBe("signup");
      flows.push({ id, challenge: body.code_challenge, path: url.pathname });
      return Response.json(url.pathname.endsWith("signup") ? { ...user, email_confirmed_at: undefined } : {});
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      exchanges++;
      const index = body.auth_code === "a".repeat(32) ? 0 : 1;
      const challenge = createHash("sha256").update(body.code_verifier).digest("base64url");
      if (flows[index]?.challenge !== challenge) return Response.json({ code: "bad_code_verifier", message: "Synthetic mismatched verifier" }, { status: 400 });
      return Response.json({ access_token: "synthetic-access-fixture", refresh_token: "synthetic-refresh-fixture", token_type: "bearer", expires_in: 3600, user: { ...user, email_confirmed_at: confirmed ? user.email_confirmed_at : undefined } });
    }
    throw new Error("Unexpected synthetic auth endpoint");
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function startSignup() {
  const transition = await createAuthTransitionClient();
  const result = await transition.client.auth.signUp({ email: user.email, password: " synthetic password fixture ", options: { emailRedirectTo: `${origin}/auth/callback` } });
  expect(result.error).toBeNull();
  expect(result.data.session).toBeNull();
  return transition;
}
function finish(index: number, flowId = flows[index]!.id) {
  return callback(new Request(`${origin}/auth/callback?code=${index === 0 ? "a".repeat(32) : "b".repeat(32)}&sb_flow_id=${flowId}`));
}
function signInRequest() {
  return new Request(`${origin}/api/auth/sign-in`, { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: " synthetic password fixture " }) });
}

describe("pinned SSR password sign-in transition", () => {
  it("commits a confirmed session with secure HttpOnly cookies", async () => {
    const response = await signIn(signInRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
    expect(passwordGrants).toBe(1);
    expect(jar.has(storageKey)).toBe(true);
    for (const cookie of jar.values()) expect(cookie.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  });

  it("preserves the prior cookie jar after an unconfirmed result even when cleanup fails", async () => {
    expect((await signIn(signInRequest())).status).toBe(200);
    const before = [...jar.entries()];
    confirmed = false; cleanupFailure = true;
    const response = await signIn(signInRequest());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "invalid_credentials", message: "The email and password could not be verified." } });
    expect(passwordGrants).toBe(2);
    expect([...jar.entries()]).toEqual(before);
  });

  it("preserves an existing confirmed session after a failed password request", async () => {
    expect((await signIn(signInRequest())).status).toBe(200);
    const before = [...jar.entries()]; passwordFailure = true;
    expect((await signIn(signInRequest())).status).toBe(401);
    expect([...jar.entries()]).toEqual(before);
  });
});

describe("pinned SSR PKCE compatibility", () => {
  it("stages signup verifiers until commit and writes only secure HttpOnly cookies", async () => {
    const transition = await startSignup();
    expect(jar.size).toBe(0);
    transition.commitCookies();
    expect(jar.has(`${storageKey}-flow-${flows[0]!.id}-code-verifier`)).toBe(true);
    expect(jar.has(`${storageKey}-flows-code-verifier`)).toBe(true);
    expect(jar.has(storageKey)).toBe(false);
    for (const cookie of jar.values()) expect(cookie.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  });
  it("exchanges an older email with its own verifier while a newer signup remains pending", async () => {
    (await startSignup()).commitCookies();
    (await startSignup()).commitCookies();
    expect(flows[0]!.id).not.toBe(flows[1]!.id);
    const response = await finish(0);
    expect(response.headers.get("location")).toBe(`${origin}/sign-in?confirmation=complete#`);
    expect(exchanges).toBe(1);
    expect(jar.has(`${storageKey}-flow-${flows[0]!.id}-code-verifier`)).toBe(false);
    expect(jar.has(`${storageKey}-flow-${flows[1]!.id}-code-verifier`)).toBe(true);
    expect(jar.get(storageKey)?.options).toMatchObject({ httpOnly: true, secure: true });
    const sessionBeforeReplay = jar.get(storageKey)?.value;
    expect((await finish(0)).headers.get("location")).toBe(`${origin}/sign-in?confirmation=failed#`);
    expect(exchanges).toBe(1); // Missing flow verifier fails before provider exchange.
    expect(jar.get(storageKey)?.value).toBe(sessionBeforeReplay);
  });
  it("supports resend PKCE using a fresh per-flow verifier", async () => {
    (await startSignup()).commitCookies();
    const transition = await createAuthTransitionClient();
    const result = await transition.client.auth.resend({ type: "signup", email: user.email, options: { emailRedirectTo: `${origin}/auth/callback` } });
    expect(result.error).toBeNull();
    transition.commitCookies();
    expect(flows[1]!.path).toBe("/auth/v1/resend");
    expect((await finish(1)).headers.get("location")).toBe(`${origin}/sign-in?confirmation=complete#`);
    expect(jar.has(storageKey)).toBe(true);
  });
  it("marks a password reset flow so the callback opens the new-password page", async () => {
    const response = await requestReset(new Request(`${origin}/api/auth/password-reset`, { method: "POST",
      headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: user.email }) }));
    expect(await response.json()).toEqual({ requested: true });
    expect(flows[0]!.path).toBe("/auth/v1/recover");
    expect(jar.has(`${storageKey}-flow-${flows[0]!.id}-code-verifier`)).toBe(true);
    expect((await finish(0)).headers.get("location")).toBe(`${origin}/reset-password#`);
    expect(jar.has(storageKey)).toBe(true);
  });
  it("rejects a callback from another browser without sending a mismatched verifier or mutating cookies", async () => {
    (await startSignup()).commitCookies();
    const before = [...jar.entries()];
    expect((await finish(0, "foreign_browser_flow")).headers.get("location")).toBe(`${origin}/sign-in?confirmation=failed#`);
    expect(exchanges).toBe(0);
    expect([...jar.entries()]).toEqual(before);
  });
  it("discards all staged session writes after an unconfirmed provider response", async () => {
    (await startSignup()).commitCookies();
    const before = [...jar.entries()];
    confirmed = false;
    expect((await finish(0)).headers.get("location")).toBe(`${origin}/sign-in?confirmation=failed#`);
    expect(exchanges).toBe(1);
    expect(jar.has(storageKey)).toBe(false);
    expect([...jar.entries()]).toEqual(before);
  });
});
