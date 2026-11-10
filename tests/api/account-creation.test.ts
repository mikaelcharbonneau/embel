import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ create: vi.fn(), signUp: vi.fn(), resend: vi.fn(), exchange: vi.fn(), signOut: vi.fn(), commit: vi.fn() }));
vi.mock("../../src/server/auth/client", () => ({ createAuthTransitionClient: doubles.create }));
import { POST as signUp } from "../../src/app/api/auth/sign-up/route";
import { POST as resend } from "../../src/app/api/auth/resend-confirmation/route";
import { GET as callback } from "../../src/app/auth/callback/route";

// Inert fixtures only; every provider method and network call is intercepted.
const origin = "https://fluid.example";
const credentials = { email: "creation-fixture@example.invalid", password: "  synthetic account password  " };
const user = { id: "aaaaaaaa-1111-4111-8111-111111111111", email: credentials.email, email_confirmed_at: "2026-10-13T10:00:00Z", is_anonymous: false };
const session = { user, access_token: "inert-access-fixture", refresh_token: "inert-refresh-fixture" };
const pending = { authenticated: false, confirmationRequired: true };
const actions = [
  { name: "sign-up", handler: signUp, body: credentials, limit: 8192, call: doubles.signUp },
  { name: "resend-confirmation", handler: resend, body: { email: credentials.email }, limit: 4096, call: doubles.resend },
];
function request(name = "sign-up", body: unknown = credentials, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/auth/${name}`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function confirmationRequest(query = "code=aaaaaaaa-1111-4111-8111-111111111111&sb_flow_id=fixture_flow_123") {
  return new Request(`https://untrusted-host.invalid/auth/callback?${query}`, { headers: { host: "untrusted-host.invalid", "x-forwarded-host": "untrusted-forward.invalid" } });
}
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  doubles.create.mockResolvedValue({ client: { auth: { signUp: doubles.signUp, resend: doubles.resend, exchangeCodeForSession: doubles.exchange, signOut: doubles.signOut } }, commitCookies: doubles.commit });
  doubles.signUp.mockResolvedValue({ data: { user: { ...user, email_confirmed_at: undefined }, session: null }, error: null });
  doubles.resend.mockResolvedValue({ data: { user: null, session: null }, error: null });
  doubles.exchange.mockResolvedValue({ data: { user, session }, error: null });
  doubles.signOut.mockResolvedValue({ error: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("account creation boundaries", () => {
  it.each(actions)("$name rejects missing, cross-site, malformed and forged origins before Auth", async action => {
    const invalidOrigins: Record<string, string>[] = [{ origin: "" }, { origin: "null" }, { origin: "https://fluid.example.evil.invalid" }, { origin, "sec-fetch-site": "cross-site" }];
    for (const headers of invalidOrigins) {
      const response = await action.handler(request(action.name, action.body, headers));
      expect(response.status).toBe(403);
      privateResponse(response);
    }
    expect(doubles.create).not.toHaveBeenCalled();
  });
  it.each(actions)("$name rejects declared and streamed oversize input, unsupported content and extra fields", async action => {
    expect((await action.handler(request(action.name, action.body, { "content-length": String(action.limit + 1) }))).status).toBe(413);
    for (const length of [undefined, "1"]) {
      const req = new Request(`${origin}/api/auth/${action.name}`, { method: "POST", headers: { origin, "content-type": "application/json", ...(length ? { "content-length": length } : {}) }, body: JSON.stringify(action.body) + " ".repeat(action.limit) });
      expect((await action.handler(req)).status).toBe(413);
    }
    expect((await action.handler(request(action.name, action.body, { "content-type": "text/plain" }))).status).toBe(422);
    for (const extra of [{ redirectTo: "https://evil.invalid" }, { ownerId: user.id }, { options: { data: { role: "admin" } } }, { type: "recovery" }]) {
      expect((await action.handler(request(action.name, { ...action.body, ...extra }))).status).toBe(422);
    }
    expect(doubles.create).not.toHaveBeenCalled();
  });
  it.each(["", "short", "x".repeat(1025)])("rejects an out-of-policy password without a provider call", async password => {
    expect((await signUp(request("sign-up", { ...credentials, password }))).status).toBe(422);
    expect(doubles.create).not.toHaveBeenCalled();
  });
  it("uses the trusted production origin, preserves password whitespace and returns no user or tokens", async () => {
    vi.stubEnv("VERCEL", "1"); vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("VERCEL_URL", "deployment-fixture.vercel.app");
    const req = request("sign-up", { ...credentials, email: ` ${credentials.email} ` }, { host: "host-forgery.invalid", "x-forwarded-host": "forward-forgery.invalid" });
    const response = await signUp(req);
    expect(await response.json()).toEqual(pending);
    expect(doubles.signUp).toHaveBeenCalledExactlyOnceWith({ ...credentials, options: { emailRedirectTo: `${origin}/auth/callback` } });
    expect(doubles.create).toHaveBeenCalledExactlyOnceWith(req.signal);
    expect(doubles.commit).toHaveBeenCalledOnce();
    privateResponse(response);
  });
  it("makes a new signup, an obfuscated duplicate and a duplicate provider denial indistinguishable", async () => {
    const first = await signUp(request());
    for (const result of [
      { data: { user: { ...user, identities: [] }, session: null }, error: null },
      ...["user_already_exists", "email_exists"].map(code => ({ data: { user: null, session: null }, error: { status: 422, code, message: credentials.email } })),
    ]) {
      doubles.signUp.mockResolvedValueOnce(result);
      const response = await signUp(request());
      expect(response.status).toBe(first.status);
      expect(await response.json()).toEqual(pending);
      privateResponse(response);
    }
  });
  it.each(actions)("$name maps provider rate limits/outages and sanitizes all returned diagnostics", async action => {
    for (const [error, status] of [
      [{ status: 429 }, 429], [{ status: 429, code: "email_exists" }, 429], [{ status: 500 }, 503], [{ status: 0 }, 503], [{ name: "AuthRetryableFetchError" }, 503], [{ status: 422, code: "weak_password" }, 422],
      [{ status: 400, code: "email_address_not_authorized" }, 503], [{ status: 400, code: "signup_disabled" }, 503], [{ status: 400, code: "email_provider_disabled" }, 503],
    ] as const) {
      action.call.mockResolvedValueOnce({ data: { user: null, session: null }, error: { ...error, message: `private ${credentials.password} ${session.access_token}` } });
      const response = await action.handler(request(action.name, action.body));
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(text).not.toContain(credentials.password);
      expect(text).not.toContain(session.access_token);
      expect(text).not.toContain("private");
      privateResponse(response);
    }
    action.call.mockRejectedValueOnce(new Error(`private ${credentials.email}`));
    const response = await action.handler(request(action.name, action.body));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(credentials.email);
    expect(doubles.commit).not.toHaveBeenCalled();
  });
  it("accepts an immediate session only when both provider identities match and are email-confirmed", async () => {
    doubles.signUp.mockResolvedValueOnce({ data: { user, session }, error: null });
    const response = await signUp(request());
    expect(await response.json()).toEqual({ authenticated: true });
    expect(doubles.commit).toHaveBeenCalledOnce();
  });
  it.each([
    { user: { ...user, email_confirmed_at: undefined }, session },
    { user, session: { ...session, user: { ...user, email_confirmed_at: undefined } } },
    { user, session: { ...session, user: { ...user, id: "different-owner" } } },
    { user: { ...user, is_anonymous: true }, session },
    { user: null, session },
  ])("never commits unconfirmed, anonymous or contradictory session cookies", async data => {
    doubles.signUp.mockResolvedValueOnce({ data, error: null });
    doubles.signOut.mockRejectedValueOnce(new Error("private cleanup outage"));
    expect((await signUp(request())).status).toBe(422);
    expect(doubles.commit).not.toHaveBeenCalled();
  });
  it("resends only signup confirmation to the configured callback, with an enumeration-safe response", async () => {
    for (const error of [null, { status: 400, code: "user_not_found" }, { status: 400, code: "email_exists" }]) {
      doubles.resend.mockResolvedValueOnce({ error });
      const response = await resend(request("resend-confirmation", { email: ` ${credentials.email} ` }));
      expect(await response.json()).toEqual(pending);
    }
    expect(doubles.resend).toHaveBeenCalledWith({ type: "signup", email: credentials.email, options: { emailRedirectTo: `${origin}/auth/callback` } });
    expect(doubles.commit).toHaveBeenCalledOnce();
  });
});

describe("email confirmation callback", () => {
  it.each(["", "&sb_flow_id=fixture_flow_123"])("exchanges PKCE with optional flow ID %s and strips all input from the fixed redirect", async flow => {
    const code = "aaaaaaaa-1111-4111-8111-111111111111";
    const response = await callback(confirmationRequest(`code=${code}${flow}&next=https://evil.invalid&redirectTo=//evil.invalid`));
    expect(doubles.exchange).toHaveBeenCalledExactlyOnceWith(code, flow ? { flowId: "fixture_flow_123" } : undefined);
    expect(doubles.commit).toHaveBeenCalledOnce();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/sign-in?confirmation=complete#`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    privateResponse(response);
  });
  it.each(["", "code=short", "code=" + "x".repeat(1025), "code=aaaaaaaa-1111-4111-8111-111111111111&code=bbbbbbbb-1111-4111-8111-111111111111", "code=aaaaaaaa-1111-4111-8111-111111111111&sb_flow_id=bad", "code=aaaaaaaa-1111-4111-8111-111111111111&sb_flow_id=valid123&sb_flow_id=valid456", "error_description=private", "code=aaaaaaaa-1111-4111-8111-111111111111&error=private"])("rejects malformed/error callback %s without touching cookies", async query => {
    const response = await callback(confirmationRequest(query));
    expect(response.headers.get("location")).toBe(`${origin}/sign-in?confirmation=failed#`);
    expect(doubles.create).not.toHaveBeenCalled();
    privateResponse(response);
  });
  it("sanitizes expired/replayed/foreign-browser codes and transport failures without committing cookies", async () => {
    for (const result of [
      { data: { user: null, session: null }, error: { message: "private code expired" } },
      { data: { user: { ...user, email_confirmed_at: undefined }, session }, error: null },
      { data: { user, session: { ...session, user: { ...user, id: "foreign" } } }, error: null },
    ]) {
      doubles.exchange.mockResolvedValueOnce(result);
      const response = await callback(confirmationRequest());
      expect(response.headers.get("location")).toBe(`${origin}/sign-in?confirmation=failed#`);
      expect(await response.text()).toBe("");
    }
    doubles.exchange.mockRejectedValueOnce(new Error("private provider diagnostic"));
    expect((await callback(confirmationRequest())).headers.get("location")).toBe(`${origin}/sign-in?confirmation=failed#`);
    expect(doubles.commit).not.toHaveBeenCalled();
  });
  it("fails closed when the configured origin is unavailable instead of trusting Host", async () => {
    vi.stubEnv("APP_ORIGIN", "");
    const response = await callback(confirmationRequest());
    expect(response.status).toBe(503);
    expect(response.headers.has("location")).toBe(false);
    expect(doubles.create).not.toHaveBeenCalled();
  });
});
