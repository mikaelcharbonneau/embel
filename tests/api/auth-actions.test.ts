import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ client: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("../../src/server/auth/client", () => ({ createRouteAuthClient: doubles.client }));
import { POST as signIn } from "../../src/app/api/auth/sign-in/route";
import { POST as signOut } from "../../src/app/api/auth/sign-out/route";
import { ApiError } from "../../src/server/http/errors";

// Inert credentials and provider responses. The route client is mocked; no network.
const origin = "https://fluid.example";
const credentials = { email: "qa-fixture@example.invalid", password: "  inert local QA password  " };
const user = { id: "aaaaaaaa-1111-4111-8111-111111111111", is_anonymous: false, email: credentials.email };
const session = { access_token: "inert-access-fixture", refresh_token: "inert-refresh-fixture", user };
const actions = [
  { name: "sign-in", handler: signIn, body: credentials, maxBytes: 8192 },
  { name: "sign-out", handler: signOut, body: {}, maxBytes: 1024 },
] as const;

function request(action = "sign-in", body: unknown = credentials, headers?: Record<string, string>) {
  return new Request(`${origin}/api/auth/${action}`, {
    method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
function expectPrivate(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request in route test"); }));
  doubles.client.mockResolvedValue({ auth: { signInWithPassword: doubles.signIn, signOut: doubles.signOut } });
  doubles.signIn.mockResolvedValue({ data: { user, session }, error: null });
  doubles.signOut.mockResolvedValue({ error: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("sign-in and sign-out HTTP security boundaries", () => {
  it.each(actions)("$name rejects foreign, absent and contradictory origins before body parsing or client creation", async ({ name, handler }) => {
    const invalidOrigins: Record<string, string>[] = [
      { origin: "https://untrusted.example" },
      { origin: "null" },
      { origin: "" },
      { origin, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of invalidOrigins) {
      const response = await handler(new Request(`${origin}/api/auth/${name}`, {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: "not JSON",
      }));
      expect(response.status).toBe(403);
      expectPrivate(response);
    }
    expect(doubles.client).not.toHaveBeenCalled();
    expect(doubles.signIn).not.toHaveBeenCalled();
    expect(doubles.signOut).not.toHaveBeenCalled();
  });

  it.each(actions)("$name checks declared and actual streamed byte limits before creating an Auth client", async ({ name, handler, body, maxBytes }) => {
    const declared = await handler(request(name, body, { "content-length": String(maxBytes + 1) }));
    expect(declared.status).toBe(413);
    // JSON followed by whitespace is valid; the stream is rejected for its byte
    // count even when the caller lies about Content-Length.
    const oversized = `${JSON.stringify(body)}${" ".repeat(maxBytes)}`;
    for (const contentLength of [undefined, "1"]) {
      const response = await handler(new Request(`${origin}/api/auth/${name}`, {
        method: "POST", body: oversized,
        headers: { origin, "content-type": "application/json", ...(contentLength ? { "content-length": contentLength } : {}) },
      }));
      expect(response.status).toBe(413);
      expectPrivate(response);
    }
    expect(doubles.client).not.toHaveBeenCalled();
  });

  it.each(actions)("$name rejects non-JSON and malformed JSON without calling Auth", async ({ name, handler, body }) => {
    expect((await handler(request(name, body, { "content-type": "text/plain" }))).status).toBe(422);
    const malformed = new Request(`${origin}/api/auth/${name}`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: "{",
    });
    expect((await handler(malformed)).status).toBe(422);
    expect(doubles.client).not.toHaveBeenCalled();
  });

  it.each([
    { ...credentials, ownerId: user.id },
    { ...credentials, redirectTo: "https://untrusted.example" },
    { ...credentials, email: "invalid-email" },
    { ...credentials, password: "" },
    { ...credentials, password: "x".repeat(1025) },
    { email: credentials.email },
  ])("rejects invalid or extra sign-in input without submitting credentials", async body => {
    const response = await signIn(request("sign-in", body));
    expect(response.status).toBe(422);
    expect(doubles.client).not.toHaveBeenCalled();
    expect(doubles.signIn).not.toHaveBeenCalled();
  });

  it("trims email, preserves password spaces, forwards cancellation and returns only the authenticated flag", async () => {
    const req = request("sign-in", { ...credentials, email: ` ${credentials.email} ` });
    const response = await signIn(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
    expect(doubles.signIn).toHaveBeenCalledExactlyOnceWith(credentials);
    expect(doubles.client).toHaveBeenCalledExactlyOnceWith(req.signal);
    expect(doubles.signOut).not.toHaveBeenCalled();
    expectPrivate(response);
  });

  it("returns the same generic denial for provider credential/account failures", async () => {
    for (const code of ["invalid_credentials", "user_not_found", "email_not_confirmed", "user_banned"]) {
      doubles.signIn.mockResolvedValueOnce({ data: { user: null, session: null }, error: {
        status: 400, code, message: `private provider detail: ${credentials.email} ${credentials.password}`,
      } });
      const response = await signIn(request());
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "invalid_credentials", message: "The email and password could not be verified." } });
      expectPrivate(response);
    }
  });

  it.each([
    { label: "no session", data: { user, session: null } },
    { label: "no user", data: { user: null, session } },
    { label: "anonymous user", data: { user: { ...user, is_anonymous: true }, session } },
  ])("rejects $label even after provider success and cleans up the local session", async ({ data }) => {
    doubles.signIn.mockResolvedValue({ data, error: null });
    // A cleanup outage must not turn an invalid sign-in into success or leak it.
    doubles.signOut.mockRejectedValueOnce(new Error("private cleanup diagnostic"));
    const response = await signIn(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "invalid_credentials", message: "The email and password could not be verified." } });
    expect(doubles.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expectPrivate(response);
  });

  it.each([
    { provider: { status: 429 }, status: 429, code: "auth_rate_limited" },
    { provider: { status: 500 }, status: 503, code: "integration_unavailable" },
    { provider: { status: 503 }, status: 503, code: "integration_unavailable" },
    { provider: { status: 0 }, status: 503, code: "integration_unavailable" },
    { provider: { name: "AuthRetryableFetchError" }, status: 503, code: "integration_unavailable" },
  ])("maps Auth failure $code/$status safely for both actions", async ({ provider, status, code }) => {
    const error = { ...provider, message: "private provider diagnostic", access_token: session.access_token };
    doubles.signIn.mockResolvedValue({ data: { user: null, session: null }, error });
    doubles.signOut.mockResolvedValue({ error });
    for (const action of actions) {
      const response = await action.handler(request(action.name, action.body));
      expect(response.status).toBe(status);
      const value = await response.json();
      expect(value.error.code).toBe(code);
      expect(value).not.toHaveProperty("authenticated");
      expect(JSON.stringify(value)).not.toContain("private provider diagnostic");
      expect(JSON.stringify(value)).not.toContain(session.access_token);
      expectPrivate(response);
    }
  });

  it.each(actions)("$name redacts rejected transport and setup failures", async ({ name, handler, body }) => {
    const authCall = name === "sign-in" ? doubles.signIn : doubles.signOut;
    authCall.mockRejectedValueOnce(new Error("private transport diagnostic"));
    const response = await handler(request(name, body));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private transport diagnostic");
    expectPrivate(response);
    doubles.client.mockRejectedValueOnce(new ApiError("integration_unavailable"));
    expect((await handler(request(name, body))).status).toBe(503);
  });

  it("signs out only the current session and never returns tokens or user data", async () => {
    const req = request("sign-out", {});
    const response = await signOut(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false });
    expect(doubles.client).toHaveBeenCalledExactlyOnceWith(req.signal);
    expect(doubles.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(doubles.signIn).not.toHaveBeenCalled();
    expectPrivate(response);
  });

  it("refuses client-selected sign-out scope or owner", async () => {
    for (const body of [{ scope: "global" }, { ownerId: user.id }]) {
      expect((await signOut(request("sign-out", body))).status).toBe(422);
    }
    expect(doubles.client).not.toHaveBeenCalled();
    expect(doubles.signOut).not.toHaveBeenCalled();
  });
});
