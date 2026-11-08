import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ createServerClient: vi.fn(), getUser: vi.fn(), cookies: vi.fn() }));
vi.mock("@supabase/ssr", () => ({ createServerClient: doubles.createServerClient }));
vi.mock("next/headers", () => ({ cookies: doubles.cookies }));
import { GET as handle } from "../../src/app/api/session/route";
import { SESSION_STATE_HEADER } from "../../src/components/auth/session-state";

const GET = (headers: HeadersInit = {}) => handle(new Request("http://localhost/api/session", { headers }));

describe("verified account session endpoint", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_local_fixture");
    vi.stubEnv("EMBEL_ACCOUNT_ENROLLMENT_ENABLED", "false");
    doubles.cookies.mockResolvedValue({ getAll: () => [], set: vi.fn() });
    doubles.createServerClient.mockReturnValue({ auth: { getUser: doubles.getUser } });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("returns only the verified user ID and prevents caching", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    doubles.getUser.mockResolvedValue({ data: { user: { id, email: "local-fixture@example.invalid", email_confirmed_at: "2026-10-13T10:00:00Z", user_metadata: { owner: "untrusted" } } }, error: null });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: { id } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(doubles.getUser).toHaveBeenCalledOnce();
  });

  it("returns 401 for signed-out, anonymous, unconfirmed and invalid sessions", async () => {
    for (const result of [
      { data: { user: null }, error: null },
      { data: { user: { id: "anonymous", is_anonymous: true } }, error: null },
      { data: { user: { id: "unconfirmed", is_anonymous: false, email_confirmed_at: null } }, error: null },
      { data: { user: null }, error: { status: 401, message: "private-auth-diagnostic" } },
    ]) {
      doubles.getUser.mockResolvedValue(result);
      const response = await GET();
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("private-auth-diagnostic");
    }
  });

  it("answers the app shell's signed-out check without a 401, and only for a signed-out visitor", async () => {
    for (const result of [
      { data: { user: null }, error: null },
      { data: { user: { id: "anonymous", is_anonymous: true } }, error: null },
      { data: { user: null }, error: { status: 401, message: "private-auth-diagnostic" } },
    ]) {
      doubles.getUser.mockResolvedValue(result);
      const response = await GET({ [SESSION_STATE_HEADER]: "1" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authenticated: false });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    doubles.getUser.mockResolvedValue({ data: { user: null }, error: { status: 503, message: "private-auth-diagnostic" } });
    expect((await GET({ [SESSION_STATE_HEADER]: "1" })).status).toBe(503);
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    doubles.getUser.mockResolvedValue({ data: { user: { id, email_confirmed_at: "2026-10-13T10:00:00Z" } }, error: null });
    expect(await (await GET({ [SESSION_STATE_HEADER]: "1" })).json()).toEqual({ user: { id } });
  });

  it("advertises enrollment recovery only when explicitly enabled, without provisioning during session reads", async () => {
    vi.stubEnv("EMBEL_ACCOUNT_ENROLLMENT_ENABLED", "true");
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    doubles.getUser.mockResolvedValue({ data: { user: { id, email_confirmed_at: "2026-10-13T10:00:00Z" } }, error: null });
    expect(await (await GET()).json()).toEqual({ user: { id }, enrollmentEnabled: true });
    expect(doubles.getUser).toHaveBeenCalledOnce();
  });

  it("keeps shared signup out of the obsolete per-customer provisioning loop", async () => {
    vi.stubEnv("EMBEL_ACCOUNT_ENROLLMENT_ENABLED", "true");
    vi.stubEnv("EMBEL_SHARED_WORKERS_ENABLED", "true");
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    doubles.getUser.mockResolvedValue({ data: { user: { id, email_confirmed_at: "2026-10-13T10:00:00Z" } }, error: null });
    expect(await (await GET()).json()).toEqual({ user: { id } });
    expect(doubles.createServerClient).toHaveBeenCalledOnce();
  });

  it("returns 503 without constructing a client when configuration is absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    expect((await GET()).status).toBe(503);
    expect(doubles.createServerClient).not.toHaveBeenCalled();
  });

  it("distinguishes unavailable Auth from signed-out sessions and redacts diagnostics", async () => {
    for (const error of [{ status: 503 }, { status: 429 }, { name: "AuthRetryableFetchError", status: 0 }]) {
      doubles.getUser.mockResolvedValue({ data: { user: null }, error: { ...error, message: "private-auth-diagnostic" } });
      const response = await GET();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private-auth-diagnostic");
    }
    doubles.getUser.mockRejectedValue(new Error("private-network-diagnostic"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-network-diagnostic");
  });
});
