import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({
  create: vi.fn(),
  reset: vi.fn(),
  exchange: vi.fn(),
  commit: vi.fn(),
  context: vi.fn(),
  claims: vi.fn(),
  update: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("../../src/server/auth/client", () => ({ createAuthTransitionClient: doubles.create }));
vi.mock("../../src/server/auth/context", () => ({ getVerifiedAccountContext: doubles.context }));
import { ApiError } from "../../src/server/http/errors";
import { POST as requestReset } from "../../src/app/api/auth/password-reset/route";
import { POST as savePassword } from "../../src/app/api/auth/password/route";
import { GET as callback } from "../../src/app/auth/callback/route";
import { isRecentRecovery, RECOVERY_WINDOW_SECONDS } from "../../src/server/auth/confirmation";

// Inert fixtures only; every provider method and network call is intercepted.
const origin = "https://fluid.example";
const email = "reset-fixture@example.invalid";
const password = "  synthetic new password  ";
const user = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  email,
  email_confirmed_at: "2026-10-13T10:00:00Z",
  is_anonymous: false,
};
const session = { user, access_token: "inert-access-fixture", refresh_token: "inert-refresh-fixture" };
const now = () => Math.floor(Date.now() / 1000);
const recoveryClaims = (age = 60) => ({
  claims: { sub: user.id, amr: [{ method: "recovery", timestamp: now() - age }] },
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
  doubles.create.mockResolvedValue({
    client: { auth: { resetPasswordForEmail: doubles.reset, exchangeCodeForSession: doubles.exchange } },
    commitCookies: doubles.commit,
  });
  doubles.reset.mockResolvedValue({ data: {}, error: null });
  doubles.exchange.mockResolvedValue({ data: { user, session, redirectType: "recovery" }, error: null });
  doubles.context.mockResolvedValue({
    client: { auth: { getClaims: doubles.claims, updateUser: doubles.update, signOut: doubles.signOut } },
    user,
  });
  doubles.signOut.mockResolvedValue({ error: null });
  doubles.claims.mockResolvedValue({ data: recoveryClaims(), error: null });
  doubles.update.mockResolvedValue({ data: { user }, error: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("password reset request", () => {
  it("rejects forged origins and extra fields before Auth", async () => {
    const forged: Record<string, string>[] = [
      { origin: "" },
      { origin: "https://evil.invalid" },
      { origin, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of forged) {
      expect((await requestReset(post("/api/auth/password-reset", { email }, headers))).status).toBe(403);
    }
    for (const extra of [{ redirectTo: "https://evil.invalid" }, { type: "signup" }]) {
      expect((await requestReset(post("/api/auth/password-reset", { email, ...extra }))).status).toBe(422);
    }
    expect(doubles.create).not.toHaveBeenCalled();
  });
  it("sends the link to the trusted callback and keeps the verifier cookie", async () => {
    const response = await requestReset(
      post("/api/auth/password-reset", { email: ` ${email} ` }, { host: "forged.invalid" }),
    );
    expect(await response.json()).toEqual({ requested: true });
    expect(doubles.reset).toHaveBeenCalledExactlyOnceWith(email, { redirectTo: `${origin}/auth/callback` });
    expect(doubles.commit).toHaveBeenCalledOnce();
    privateResponse(response);
  });
  it("answers the same way whether or not the account exists", async () => {
    const first = await requestReset(post("/api/auth/password-reset", { email }));
    for (const code of ["user_not_found", "email_not_confirmed"]) {
      doubles.reset.mockResolvedValueOnce({ data: {}, error: { status: 400, code, message: email } });
      const response = await requestReset(post("/api/auth/password-reset", { email }));
      expect(response.status).toBe(first.status);
      expect(await response.json()).toEqual({ requested: true });
    }
  });
  it("reports only rate limits and outages, without provider text", async () => {
    for (const [error, status] of [
      [{ status: 429 }, 429],
      [{ status: 400, code: "over_email_send_rate_limit" }, 429],
      [{ status: 500 }, 503],
      [{ name: "AuthRetryableFetchError" }, 503],
      [{ status: 400, code: "unexpected" }, 503],
    ] as const) {
      doubles.reset.mockResolvedValueOnce({ data: {}, error: { ...error, message: `private ${email}` } });
      const response = await requestReset(post("/api/auth/password-reset", { email }));
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(email);
    }
    doubles.reset.mockRejectedValueOnce(new Error("private outage"));
    expect((await requestReset(post("/api/auth/password-reset", { email }))).status).toBe(503);
    expect(doubles.commit).not.toHaveBeenCalled();
  });
});

describe("reset link callback", () => {
  it("sends a recovery exchange to the new-password page and nowhere else", async () => {
    const response = await callback(
      new Request(
        `https://untrusted.invalid/auth/callback?code=aaaaaaaa-1111-4111-8111-111111111111&sb_flow_id=fixture_flow_123&next=https://evil.invalid`,
      ),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/reset-password#`);
    expect(doubles.commit).toHaveBeenCalledOnce();
  });
  it("keeps sign-up confirmations on the sign-in page", async () => {
    doubles.exchange.mockResolvedValueOnce({ data: { user, session, redirectType: null }, error: null });
    const response = await callback(new Request(`${origin}/auth/callback?code=aaaaaaaa-1111-4111-8111-111111111111`));
    expect(response.headers.get("location")).toBe(`${origin}/sign-in?confirmation=complete#`);
  });
});

describe("saving a new password", () => {
  it("rejects forged origins and short passwords before reading the session", async () => {
    expect(
      (await savePassword(post("/api/auth/password", { password }, { origin: "https://evil.invalid" }))).status,
    ).toBe(403);
    for (const short of ["", "short", "x".repeat(1025)]) {
      expect((await savePassword(post("/api/auth/password", { password: short }))).status).toBe(422);
    }
    expect(doubles.context).not.toHaveBeenCalled();
  });
  it("saves the password unchanged for a recent recovery session", async () => {
    const response = await savePassword(post("/api/auth/password", { password }));
    expect(await response.json()).toEqual({ updated: true });
    expect(doubles.update).toHaveBeenCalledExactlyOnceWith({ password });
    expect(doubles.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "others" });
    privateResponse(response);
  });
  it("keeps the saved password when signing out other devices fails", async () => {
    doubles.signOut.mockRejectedValueOnce(new Error("private outage"));
    const response = await savePassword(post("/api/auth/password", { password }));
    expect(await response.json()).toEqual({ updated: true });
  });
  it("refuses signed-out, everyday and expired-recovery sessions", async () => {
    doubles.context.mockRejectedValueOnce(new ApiError("unauthenticated"));
    expect((await savePassword(post("/api/auth/password", { password }))).status).toBe(403);
    for (const claims of [
      { claims: { sub: user.id, amr: [{ method: "password", timestamp: now() }] } },
      recoveryClaims(RECOVERY_WINDOW_SECONDS + 60),
      { claims: { sub: user.id } },
    ]) {
      doubles.claims.mockResolvedValueOnce({ data: claims, error: null });
      const response = await savePassword(post("/api/auth/password", { password }));
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("recovery_required");
    }
    expect(doubles.update).not.toHaveBeenCalled();
    expect(doubles.signOut).not.toHaveBeenCalled();
  });
  it("explains weak and reused passwords without provider text", async () => {
    for (const [error, code] of [
      [{ status: 422, code: "weak_password" }, "weak_password"],
      [{ status: 422, code: "same_password" }, "same_password"],
      [{ status: 500 }, "integration_unavailable"],
    ] as const) {
      doubles.update.mockResolvedValueOnce({
        data: { user: null },
        error: { ...error, message: `private ${password}` },
      });
      const response = await savePassword(post("/api/auth/password", { password }));
      const text = await response.text();
      expect(JSON.parse(text).error.code).toBe(code);
      expect(text).not.toContain("private");
    }
  });
});

describe("recovery window", () => {
  it("accepts only a recovery method inside the window", () => {
    const t = 2_000_000_000;
    expect(isRecentRecovery({ amr: [{ method: "recovery", timestamp: t - 10 }] }, t)).toBe(true);
    expect(
      isRecentRecovery(
        {
          amr: [
            { method: "password", timestamp: t },
            { method: "recovery", timestamp: t - RECOVERY_WINDOW_SECONDS },
          ],
        },
        t,
      ),
    ).toBe(true);
    expect(isRecentRecovery({ amr: [{ method: "recovery", timestamp: t - RECOVERY_WINDOW_SECONDS - 1 }] }, t)).toBe(
      false,
    );
    expect(isRecentRecovery({ amr: [{ method: "recovery", timestamp: t + 3600 }] }, t)).toBe(false);
    expect(isRecentRecovery({ amr: ["recovery"] }, t)).toBe(false);
    expect(isRecentRecovery(null, t)).toBe(false);
  });
});
