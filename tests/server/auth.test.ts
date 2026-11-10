import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  createServerClient: vi.fn(),
  cookies: vi.fn(),
  setCookie: vi.fn(),
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.createServerClient }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
import { getAuthenticatedContext } from "../../src/server/auth/context";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_local_fixture");
  mocks.cookies.mockResolvedValue({ getAll: () => [], set: mocks.setCookie });
  mocks.createServerClient.mockImplementation(() => ({ auth: { getUser: mocks.getUser } }));
});
afterEach(() => vi.unstubAllEnvs());

describe("request-scoped authenticated server context", () => {
  it("gets verified users on every request and creates isolated clients", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "owner-a", is_anonymous: false, email_confirmed_at: "2026-10-13T10:00:00Z" } },
      error: null,
    });
    const first = await getAuthenticatedContext();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "owner-b", is_anonymous: false, email_confirmed_at: "2026-10-13T10:00:00Z" } },
      error: null,
    });
    const second = await getAuthenticatedContext();
    expect(first.userId).toBe("owner-a");
    expect(second.userId).toBe("owner-b");
    expect(first.client).not.toBe(second.client);
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
    const options = mocks.createServerClient.mock.calls[0]?.[2];
    options.cookies.setAll([{ name: "session", value: "local_fixture", options: { httpOnly: true } }]);
    expect(mocks.setCookie).toHaveBeenCalledWith("session", "local_fixture", { httpOnly: true });
  });

  it.each([undefined, null, ""])(
    "rejects a provider-validated existing session without email confirmation (%s)",
    (emailConfirmed) => {
      mocks.getUser.mockResolvedValue({
        data: { user: { id: "owner-a", is_anonymous: false, email_confirmed_at: emailConfirmed } },
        error: null,
      });
      return expect(getAuthenticatedContext()).rejects.toMatchObject({ code: "unauthenticated" });
    },
  );

  it.each([{ status: 429 }, { status: 503 }, { name: "AuthRetryableFetchError" }])(
    "preserves unavailable semantics for retryable Auth failure %j",
    (error) => {
      mocks.getUser.mockResolvedValue({ data: { user: null }, error });
      return expect(getAuthenticatedContext()).rejects.toMatchObject({ code: "integration_unavailable" });
    },
  );

  it("preserves unavailable semantics for a rejected identity check", () => {
    mocks.getUser.mockRejectedValue(new Error("private transport detail"));
    return expect(getAuthenticatedContext()).rejects.toMatchObject({ code: "integration_unavailable" });
  });

  it("rejects missing, invalid and anonymous sessions without using cookie claims as identity", async () => {
    for (const result of [
      { data: { user: null }, error: null },
      { data: { user: { id: "unverified" } }, error: new Error("bad token") },
      { data: { user: { id: "anonymous", is_anonymous: true } }, error: null },
    ]) {
      mocks.getUser.mockResolvedValue(result);
      await expect(getAuthenticatedContext()).rejects.toMatchObject({ code: "unauthenticated" });
    }
  });

  it("does not create an auth client when the integration is absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    await expect(getAuthenticatedContext()).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });
});
