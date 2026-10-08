import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: doubles.cookies }));
import { getAuthenticatedContext } from "../../src/server/auth/context";

// The installed Supabase SSR/Auth SDKs are real. Fetch is always replaced with
// local responses; these unsigned fixtures cannot authenticate to any provider.
const url = "https://qa-sdk-fixture.invalid";
const cookieName = "sb-qa-sdk-fixture-auth-token";
const ownerA = "aaaaaaaa-1111-4111-8111-111111111111";
const ownerB = "bbbbbbbb-1111-4111-8111-111111111111";
const user = (id: string) => ({ id, aud: "authenticated", is_anonymous: false, app_metadata: {}, user_metadata: {}, created_at: "2026-10-02T00:00:00Z" });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(id: string, expiresAt: number) {
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: id, exp: expiresAt, aud: "authenticated", role: "authenticated" })}.unsigned-local-qa-fixture`;
}
function session(id: string, expiresAt = Math.floor(Date.now() / 1000) + 3600) {
  return { access_token: token(id, expiresAt), refresh_token: "inert-local-qa-refresh-placeholder", expires_at: expiresAt, expires_in: 3600, token_type: "bearer", user: user(id) };
}
function cookieStore(value?: ReturnType<typeof session>) {
  const entries = new Map(value ? [[cookieName, `base64-${encode(value)}`]] : []);
  const set = vi.fn((name: string, data: string) => { if (data) entries.set(name, data); else entries.delete(name); });
  return { getAll: () => [...entries].map(([name, data]) => ({ name, value: data })), set, entries };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", url);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_inert_local_qa_fixture");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected local transport request"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("real SSR SDK with isolated synthetic Auth transport (not hosted validation)", () => {
  it("rejects a missing cookie without contacting any Auth transport", async () => {
    doubles.cookies.mockResolvedValue(cookieStore());
    const transport = vi.mocked(fetch);
    await expect(getAuthenticatedContext()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("ignores a forged cookie user and authorizes from the Auth response", async () => {
    const stored = session(ownerA);
    stored.user = { ...user(ownerB), user_metadata: { owner_id: ownerB } };
    const cookies = cookieStore(stored);
    doubles.cookies.mockResolvedValue(cookies);
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${url}/auth/v1/user`);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${stored.access_token}`);
      return json(user(ownerA));
    });
    vi.stubGlobal("fetch", transport);
    expect((await getAuthenticatedContext()).userId).toBe(ownerA);
    expect(transport).toHaveBeenCalledOnce();
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it("keeps separate requests' cookie tokens and verified identities isolated", async () => {
    const a = session(ownerA), b = session(ownerB);
    doubles.cookies.mockResolvedValueOnce(cookieStore(a)).mockResolvedValueOnce(cookieStore(b));
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${url}/auth/v1/user`);
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === `Bearer ${a.access_token}`) return json(user(ownerA));
      if (authorization === `Bearer ${b.access_token}`) return json(user(ownerB));
      throw new Error("Unexpected local request identity");
    });
    vi.stubGlobal("fetch", transport);
    const [first, second] = await Promise.all([getAuthenticatedContext(), getAuthenticatedContext()]);
    expect(first.userId).toBe(ownerA);
    expect(second.userId).toBe(ownerB);
    expect(first.client).not.toBe(second.client);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(["test", "production"])("passes refreshed HttpOnly SDK cookies to the current response store in %s", async environment => {
    vi.stubEnv("NODE_ENV", environment);
    const expired = session(ownerA, Math.floor(Date.now() / 1000) - 120);
    const refreshed = { ...session(ownerA), refresh_token: "inert-local-qa-rotated-placeholder" };
    const cookies = cookieStore(expired);
    doubles.cookies.mockResolvedValue(cookies);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(String(input));
      expect(target.origin).toBe(url);
      calls.push(target.pathname);
      if (target.pathname === "/auth/v1/token") {
        expect(init?.method).toBe("POST");
        expect(target.searchParams.get("grant_type")).toBe("refresh_token");
        expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: expired.refresh_token });
        return json(refreshed);
      }
      expect(target.pathname).toBe("/auth/v1/user");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${refreshed.access_token}`);
      return json(user(ownerA));
    }));
    expect((await getAuthenticatedContext()).userId).toBe(ownerA);
    expect(calls).toContain("/auth/v1/token");
    expect(calls).toContain("/auth/v1/user");
    expect(cookies.set).toHaveBeenCalled();
    expect(cookies.set).toHaveBeenCalledWith(cookieName, expect.any(String), expect.objectContaining({
      httpOnly: true, secure: environment === "production", sameSite: "lax", path: "/",
    }));
    const encoded = cookies.entries.get(cookieName);
    expect(encoded?.startsWith("base64-")).toBe(true);
    const saved = JSON.parse(Buffer.from(encoded!.slice(7), "base64url").toString());
    expect(saved.access_token).toBe(refreshed.access_token);
    expect(saved.refresh_token).toBe(refreshed.refresh_token);
  });
});
