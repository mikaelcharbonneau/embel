import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ transition: vi.fn(), signIn: vi.fn(), signUp: vi.fn(), reset: vi.fn(), resend: vi.fn(), signOut: vi.fn(), commit: vi.fn() }));
vi.mock("../../src/server/auth/client", () => ({ createAuthTransitionClient: doubles.transition }));
import { POST as signIn } from "../../src/app/api/auth/sign-in/route";
import { POST as signUp } from "../../src/app/api/auth/sign-up/route";
import { POST as passwordReset } from "../../src/app/api/auth/password-reset/route";
import { POST as resend } from "../../src/app/api/auth/resend-confirmation/route";

// Inert fixtures; the Auth client is mocked and no network is used.
const origin = "https://captcha.example";
const email = "captcha-fixture@example.invalid";
const password = "inert fixture password";
const longPassword = "a long enough password";
const token = "inert-turnstile-token";
const user = { id: "aaaaaaaa-1111-4111-8111-111111111111", is_anonymous: false, email, email_confirmed_at: "2026-10-13T10:00:00Z" };
const captchaError = { name: "AuthApiError", status: 400, code: "captcha_failed", message: "captcha verification process failed" };
const redirect = `${origin}/auth/callback`;

const call = (handler: typeof signIn, action: string, body: unknown) => handler(new Request(`${origin}/api/auth/${action}`, {
  method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", origin);
  doubles.transition.mockResolvedValue({
    client: { auth: { signInWithPassword: doubles.signIn, signUp: doubles.signUp, resetPasswordForEmail: doubles.reset, resend: doubles.resend, signOut: doubles.signOut } },
    commitCookies: doubles.commit,
  });
  doubles.signIn.mockResolvedValue({ data: { user, session: { user } }, error: null });
  doubles.signUp.mockResolvedValue({ data: { user: { ...user, email_confirmed_at: null }, session: null }, error: null });
  doubles.reset.mockResolvedValue({ data: {}, error: null });
  doubles.resend.mockResolvedValue({ data: {}, error: null });
  doubles.signOut.mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("Turnstile token forwarding", () => {
  it("passes the token to Supabase as options.captchaToken on every form", async () => {
    expect((await call(signIn, "sign-in", { email, password, captchaToken: token })).status).toBe(200);
    expect(doubles.signIn).toHaveBeenCalledExactlyOnceWith({ email, password, options: { captchaToken: token } });

    expect((await call(signUp, "sign-up", { email, password: longPassword, captchaToken: token })).status).toBe(200);
    expect(doubles.signUp).toHaveBeenCalledExactlyOnceWith({ email, password: longPassword, options: { emailRedirectTo: redirect, captchaToken: token } });

    expect((await call(passwordReset, "password-reset", { email, captchaToken: token })).status).toBe(200);
    expect(doubles.reset).toHaveBeenCalledExactlyOnceWith(email, { redirectTo: redirect, captchaToken: token });

    expect((await call(resend, "resend-confirmation", { email, captchaToken: token })).status).toBe(200);
    expect(doubles.resend).toHaveBeenCalledExactlyOnceWith({ type: "signup", email, options: { emailRedirectTo: redirect, captchaToken: token } });
  });

  it("changes nothing when no token is sent (site key unset)", async () => {
    await call(signIn, "sign-in", { email, password });
    expect(doubles.signIn).toHaveBeenCalledExactlyOnceWith({ email, password });
    await call(signUp, "sign-up", { email, password: longPassword });
    expect(doubles.signUp).toHaveBeenCalledExactlyOnceWith({ email, password: longPassword, options: { emailRedirectTo: redirect } });
    await call(passwordReset, "password-reset", { email });
    expect(doubles.reset).toHaveBeenCalledExactlyOnceWith(email, { redirectTo: redirect });
    await call(resend, "resend-confirmation", { email });
    expect(doubles.resend).toHaveBeenCalledExactlyOnceWith({ type: "signup", email, options: { emailRedirectTo: redirect } });
  });

  it("rejects an empty or oversized token before reaching Supabase", async () => {
    for (const captchaToken of ["", "x".repeat(2049), 5]) {
      expect((await call(signIn, "sign-in", { email, password, captchaToken })).status).toBe(422);
    }
    expect(doubles.signIn).not.toHaveBeenCalled();
  });
});

describe("captcha failure mapping", () => {
  it.each([
    ["sign-in", signIn, { email, password }, "signIn"],
    ["sign-up", signUp, { email, password: longPassword }, "signUp"],
    ["password-reset", passwordReset, { email }, "reset"],
    ["resend-confirmation", resend, { email }, "resend"],
  ] as const)("%s returns a clear 400 captcha_failed without provider text", async (action, handler, body, double) => {
    doubles[double].mockResolvedValue({ data: { user: null, session: null }, error: captchaError });
    const response = await call(handler, action, body);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("captcha_failed");
    expect(text).not.toContain("verification process");
    expect(doubles.commit).not.toHaveBeenCalled();
  });

  it("keeps the enumeration-safe answers for unknown and existing accounts", async () => {
    doubles.reset.mockResolvedValue({ data: {}, error: { status: 400, code: "user_not_found" } });
    const reset = await call(passwordReset, "password-reset", { email, captchaToken: token });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ requested: true });
    doubles.signUp.mockResolvedValue({ data: {}, error: { status: 422, code: "user_already_exists" } });
    const duplicate = await call(signUp, "sign-up", { email, password: longPassword, captchaToken: token });
    expect(await duplicate.json()).toEqual({ authenticated: false, confirmationRequired: true });
  });
});
