import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CookieOptions } from "@supabase/ssr";

vi.mock("server-only", () => ({}));
const next = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: next.cookies }));
import { clearAuthProviderCache, getEnabledAuthProviders } from "../../src/server/auth/providers";
import { POST as start } from "../../src/app/api/auth/oauth/[provider]/route";
import { GET as callback } from "../../src/app/auth/callback/route";

// Real pinned @supabase/ssr + auth-js with a synthetic cookie jar and transport, as in
// auth-transition.test.ts. Nothing reaches Supabase, Google, Apple or OpenAI.
const origin = "https://embel.example";
const supabase = "https://fixture.supabase.co";
const secretKey = "sb_secret_local_fixture_0000";
const storageKey = "sb-fixture-auth-token";
const user = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  aud: "authenticated",
  role: "authenticated",
  email: "provider-fixture@example.invalid",
  email_confirmed_at: "2026-11-25T10:00:00Z",
  is_anonymous: false,
  created_at: "2026-11-25T10:00:00Z",
  app_metadata: { provider: "google", providers: ["google"] },
  user_metadata: {},
};
type Cookie = { name: string; value: string; options: CookieOptions };
let jar: Map<string, Cookie>;
let settings: unknown;
let settingsStatus: number;
let settingsReads: number;
let customProvider: { status: number; body: unknown };
let customReads: { apikey: string | null; authorization: string | null }[];
let exchanges: { code: string; verifier: string }[];
let confirmed: boolean;
let exchangeReply: Response | Error | null;
let signedInUser: typeof user & Record<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  clearAuthProviderCache();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", supabase);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_local_fixture");
  vi.stubEnv("EMBEL_ENGINE_SUPABASE_SECRET_KEY", "");
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("NODE_ENV", "production");
  jar = new Map();
  settings = { external: { google: true, apple: false, email: true, github: true }, disable_signup: false };
  settingsStatus = 200;
  settingsReads = 0;
  customProvider = { status: 404, body: { code: "custom_provider_not_found" } };
  customReads = [];
  exchanges = [];
  confirmed = true;
  exchangeReply = null;
  signedInUser = user;
  next.cookies.mockImplementation(async () => ({
    getAll: () => [...jar.values()].map(({ name, value }) => ({ name, value })),
    set: (name: string, value: string, options: CookieOptions) => {
      if (options.maxAge === 0) jar.delete(name);
      else jar.set(name, { name, value, options });
    },
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== supabase) throw new Error("Unexpected synthetic request");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      if (url.pathname === "/auth/v1/settings" && (init?.method ?? "GET") === "GET") {
        settingsReads++;
        expect(headers.get("apikey")).toBe("sb_publishable_local_fixture");
        expect(init?.cache).toBe("no-store");
        if (settings instanceof Error) throw settings;
        return typeof settings === "string"
          ? new Response(settings, { status: settingsStatus })
          : Response.json(settings, { status: settingsStatus });
      }
      if (url.pathname === "/auth/v1/admin/custom-providers/custom:chatgpt" && (init?.method ?? "GET") === "GET") {
        customReads.push({ apikey: headers.get("apikey"), authorization: headers.get("authorization") });
        return Response.json(customProvider.body, { status: customProvider.status });
      }
      if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
        const body = JSON.parse(String(init?.body));
        exchanges.push({ code: body.auth_code, verifier: body.code_verifier });
        if (exchangeReply instanceof Error) throw exchangeReply;
        if (exchangeReply) return exchangeReply;
        return Response.json({
          access_token: "synthetic-access-fixture",
          refresh_token: "synthetic-refresh-fixture",
          token_type: "bearer",
          expires_in: 3600,
          user: { ...signedInUser, email_confirmed_at: confirmed ? signedInUser.email_confirmed_at : undefined },
        });
      }
      throw new Error("Unexpected synthetic auth endpoint");
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function startRequest(provider: string, body: string | null = "next=%2Fbrands", headers: Record<string, string> = {}) {
  return start(
    new Request(`${origin}/api/auth/oauth/${provider}`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded", ...headers },
      ...(body === null ? {} : { body }),
    }),
    { params: Promise.resolve({ provider }) },
  );
}
const failed = `${origin}/sign-in?provider=failed`;
const code = "c".repeat(32);

describe("getEnabledAuthProviders", () => {
  it("reports only the providers Supabase has switched on, in our order", async () => {
    settings = { external: { apple: true, google: true, github: true } };
    expect(await getEnabledAuthProviders()).toEqual(["google", "apple"]);
    settings = { external: { google: false, apple: true } };
    clearAuthProviderCache();
    expect(await getEnabledAuthProviders()).toEqual(["apple"]);
  });

  it("treats anything but a literal true as off", async () => {
    settings = { external: { google: "true", apple: 1 } };
    expect(await getEnabledAuthProviders()).toEqual([]);
  });

  it("keeps the answer for a minute and shares one read between concurrent callers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const [first, second] = await Promise.all([getEnabledAuthProviders(), getEnabledAuthProviders()]);
    expect(first).toEqual(["google"]);
    expect(second).toEqual(["google"]);
    first.push("apple"); // Callers cannot change the remembered answer.
    expect(await getEnabledAuthProviders()).toEqual(["google"]);
    expect(settingsReads).toBe(1);
    vi.advanceTimersByTime(61_000);
    settings = { external: { google: false } };
    expect(await getEnabledAuthProviders()).toEqual([]);
    expect(settingsReads).toBe(2);
  });

  it.each([
    ["an outage", () => (settingsStatus = 503)],
    ["a network error", () => (settings = new TypeError("fetch failed"))],
    ["a reply that is not JSON", () => (settings = "<html>")],
    ["a reply without the provider list", () => (settings = { external: null })],
    ["a list in the wrong shape", () => (settings = { external: ["google"] })],
    ["an oversized reply", () => (settings = JSON.stringify({ external: { google: true }, pad: "x".repeat(70_000) }))],
  ])("answers nothing after %s, and asks again soon", async (_name, arrange) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    arrange();
    expect(await getEnabledAuthProviders()).toEqual([]);
    settings = { external: { google: true } };
    settingsStatus = 200;
    expect(await getEnabledAuthProviders()).toEqual([]);
    vi.advanceTimersByTime(6_000);
    expect(await getEnabledAuthProviders()).toEqual(["google"]);
  });

  it("answers nothing, without any request, when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(await getEnabledAuthProviders()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hides ChatGPT without the server key, and never sends the publishable key to the admin API", async () => {
    customProvider = { status: 200, body: { identifier: "custom:chatgpt", enabled: true } };
    expect(await getEnabledAuthProviders()).toEqual(["google"]);
    expect(customReads).toEqual([]);
  });

  it("shows ChatGPT only when the project's custom provider exists and is enabled", async () => {
    vi.stubEnv("EMBEL_ENGINE_SUPABASE_SECRET_KEY", secretKey);
    expect(await getEnabledAuthProviders()).toEqual(["google"]);
    expect(customReads).toEqual([{ apikey: secretKey, authorization: `Bearer ${secretKey}` }]);
    for (const [body, expected] of [
      [{ identifier: "custom:chatgpt", enabled: false }, ["google"]],
      [{ identifier: "custom:other", enabled: true }, ["google"]],
      [{ identifier: "custom:chatgpt", enabled: true }, ["google", "chatgpt"]],
    ] as const) {
      clearAuthProviderCache();
      customProvider = { status: 200, body };
      expect(await getEnabledAuthProviders()).toEqual(expected);
    }
  });
});

describe("POST /api/auth/oauth/[provider]", () => {
  it("sends the browser to this project's Supabase with PKCE and stores only the verifier", async () => {
    const response = await startRequest("google", "next=%2F");
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const target = new URL(response.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(`${supabase}/auth/v1/authorize`);
    expect(target.searchParams.get("provider")).toBe("google");
    expect(target.searchParams.get("code_challenge_method")).toBe("s256");
    expect(target.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const redirectTo = new URL(target.searchParams.get("redirect_to")!);
    expect(redirectTo.origin + redirectTo.pathname).toBe(`${origin}/auth/callback`);
    // Nothing but the flow id is added, so the address still matches the Supabase redirect allow-list.
    expect([...redirectTo.searchParams.keys()]).toEqual(["sb_flow_id"]);
    const flowId = redirectTo.searchParams.get("sb_flow_id")!;
    expect(jar.get(`embel-provider-flow-${flowId}`)).toMatchObject({
      value: "/",
      options: { httpOnly: true, secure: true, sameSite: "lax", path: "/auth/callback", maxAge: 600 },
    });
    expect(jar.has(`${storageKey}-flow-${flowId}-code-verifier`)).toBe(true);
    expect(jar.has(storageKey)).toBe(false);
    for (const cookie of jar.values())
      expect(cookie.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax" });
  });

  it.each([
    ["no body", null],
    ["an empty body", ""],
    ["another site", "next=https%3A%2F%2Fevil.example"],
    ["a protocol-relative address", "next=%2F%2Fevil.example"],
    ["another page", "next=%2Faccount"],
    ["two values", "next=%2F&next=%2F"],
  ])("lands on /brands when the form carries %s", async (_name, body) => {
    expect((await startRequest("google", body)).status).toBe(303);
    const stored = [...jar.values()].filter((cookie) => cookie.name.startsWith("embel-provider-flow-"));
    expect(stored.map((cookie) => cookie.value)).toEqual(["/brands"]);
  });

  it("uses the custom Supabase provider for ChatGPT once it is enabled", async () => {
    vi.stubEnv("EMBEL_ENGINE_SUPABASE_SECRET_KEY", secretKey);
    customProvider = { status: 200, body: { identifier: "custom:chatgpt", enabled: true } };
    const target = new URL((await startRequest("chatgpt")).headers.get("location")!);
    expect(target.origin).toBe(supabase);
    expect(target.searchParams.get("provider")).toBe("custom:chatgpt");
  });

  it.each([
    ["a provider that is switched off", "apple", {}],
    ["ChatGPT while it is not set up", "chatgpt", {}],
    ["a provider we do not offer", "github", {}],
    ["a Supabase identifier instead of ours", "custom:chatgpt", {}],
    ["another origin", "google", { origin: "https://evil.example" }],
    ["a cross-site request", "google", { "sec-fetch-site": "cross-site" }],
  ])("refuses %s with a redirect to the sign-in page and no cookie", async (_name, provider, headers) => {
    const response = await startRequest(provider, "next=%2F", headers);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(failed);
    expect(jar.size).toBe(0);
  });

  it("refuses everything while the provider list cannot be read", async () => {
    settingsStatus = 503;
    expect((await startRequest("google")).headers.get("location")).toBe(failed);
    expect(jar.size).toBe(0);
  });

  it("refuses a body larger than the one small field it expects", async () => {
    expect((await startRequest("google", `next=${"a".repeat(2000)}`)).headers.get("location")).toBe(failed);
    expect(jar.size).toBe(0);
  });
});

describe("GET /auth/callback after a provider sign-in", () => {
  async function begin(destination: "/" | "/brands") {
    const response = await startRequest("google", new URLSearchParams({ next: destination }).toString());
    const target = new URL(response.headers.get("location")!);
    return {
      redirectTo: target.searchParams.get("redirect_to")!,
      challenge: target.searchParams.get("code_challenge")!,
    };
  }

  it.each(["/", "/brands"] as const)("exchanges the code with this browser's verifier and lands on %s", async (to) => {
    const { redirectTo, challenge } = await begin(to);
    const response = await callback(new Request(`${redirectTo}&code=${code}`));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}${to}#`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.code).toBe(code);
    expect(createHash("sha256").update(exchanges[0]!.verifier).digest("base64url")).toBe(challenge);
    expect(jar.get(storageKey)?.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect([...jar.keys()].some((name) => name.includes("-flow-"))).toBe(false); // Verifier and destination are spent.
  });

  it("reports a refused or cancelled provider sign-in without repeating what the provider said", async () => {
    const { redirectTo } = await begin("/brands");
    const before = [...jar.entries()].filter(([name]) => !name.startsWith("embel-provider-flow-"));
    const response = await callback(
      new Request(`${redirectTo}&error=access_denied&error_code=provider_secret&error_description=private+detail`),
    );
    expect(response.headers.get("location")).toBe(`${failed}#`);
    expect(exchanges).toHaveLength(0);
    expect([...jar.entries()]).toEqual(before);
  });

  it.each([
    ["a missing code", ""],
    ["a malformed code", "&code=short"],
    ["two codes", `&code=${code}&code=${code}`],
  ])("fails on %s without calling Supabase", async (_name, query) => {
    const { redirectTo } = await begin("/brands");
    expect((await callback(new Request(`${redirectTo}${query}`))).headers.get("location")).toBe(`${failed}#`);
    expect(exchanges).toHaveLength(0);
    expect(jar.has(storageKey)).toBe(false);
  });

  it("fails in a browser that did not start the sign-in, and sets no session", async () => {
    const { redirectTo } = await begin("/brands");
    jar.clear();
    // That browser has no cookie for the flow, so it gets the email-link wording of the same failure.
    const response = await callback(new Request(`${redirectTo}&code=${code}`));
    expect(response.headers.get("location")).toBe(`${origin}/sign-in?confirmation=failed#`);
    expect(exchanges).toHaveLength(0);
    expect(jar.size).toBe(0);
  });

  it.each([
    [
      "Supabase refuses the code",
      () => (exchangeReply = Response.json({ code: "flow_state_expired" }, { status: 400 })),
    ],
    ["Supabase cannot be reached", () => (exchangeReply = new TypeError("fetch failed"))],
  ])("fails and sets no session when %s", async (_name, arrange) => {
    const { redirectTo } = await begin("/");
    arrange();
    expect((await callback(new Request(`${redirectTo}&code=${code}`))).headers.get("location")).toBe(`${failed}#`);
    expect(jar.has(storageKey)).toBe(false);
  });

  it("signs in an Apple user with no name and a private relay address", async () => {
    signedInUser = {
      ...user,
      email: "abc123xyz@privaterelay.appleid.com",
      app_metadata: { provider: "apple", providers: ["apple"] },
      user_metadata: { email: "abc123xyz@privaterelay.appleid.com", email_verified: true },
    };
    settings = { external: { apple: true } };
    const target = new URL((await startRequest("apple", "next=%2F")).headers.get("location")!);
    expect(target.searchParams.get("provider")).toBe("apple");
    const response = await callback(new Request(`${target.searchParams.get("redirect_to")}&code=${code}`));
    expect(response.headers.get("location")).toBe(`${origin}/#`);
    expect(jar.has(storageKey)).toBe(true);
  });

  it("sets no session when the provider's email is not confirmed", async () => {
    const { redirectTo } = await begin("/brands");
    confirmed = false;
    expect((await callback(new Request(`${redirectTo}&code=${code}`))).headers.get("location")).toBe(`${failed}#`);
    expect(exchanges).toHaveLength(1);
    expect(jar.has(storageKey)).toBe(false);
  });

  it.each(["next=https%3A%2F%2Fevil.example", "next=%2F%2Fevil.example", "next=%2Faccount", "next=%2F"])(
    "ignores %s in the address",
    async (query) => {
      const { redirectTo } = await begin("/brands");
      const response = await callback(new Request(`${redirectTo}&${query}&code=${code}`));
      expect(response.headers.get("location")).toBe(`${origin}/brands#`);
      // Without the start route's cookie the same address is an email link, whatever it claims.
      const emailLink = await callback(new Request(`${origin}/auth/callback?${query}&error=access_denied`));
      expect(emailLink.headers.get("location")).toBe(`${origin}/sign-in?confirmation=failed#`);
    },
  );

  it("treats a tampered destination cookie as an email link", async () => {
    const { redirectTo } = await begin("/brands");
    const name = [...jar.keys()].find((key) => key.startsWith("embel-provider-flow-"))!;
    jar.set(name, { ...jar.get(name)!, value: "https://evil.example" });
    const response = await callback(new Request(`${redirectTo}&code=${code}`));
    expect(response.headers.get("location")).toBe(`${origin}/sign-in?confirmation=complete#`);
  });

  it("keeps two sign-ins started in the same browser apart", async () => {
    const first = await begin("/");
    const second = await begin("/brands");
    expect((await callback(new Request(`${first.redirectTo}&code=${code}`))).headers.get("location")).toBe(
      `${origin}/#`,
    );
    expect((await callback(new Request(`${second.redirectTo}&code=${code}`))).headers.get("location")).toBe(
      `${origin}/brands#`,
    );
  });
});
