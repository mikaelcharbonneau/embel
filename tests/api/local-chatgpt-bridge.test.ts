import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const auth = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: auth }));
import { proxyLocalChatGPT } from "../../src/server/local-chatgpt/bridge";
import { getApplicationOrigin, shouldUseSecureSessionCookies } from "../../src/server/config";
import { ApiError } from "../../src/server/http/errors";
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const origin = "http://127.0.0.1:3106";
const status = { connectionAllowed: false, registrations: [], selectedRegistrationId: null, model: null, workerReady: false, images: { status: "unavailable", reason: "spending_limit_required" } };
const fetcher = vi.fn();
function request(action = "status", body?: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request(`${origin}/api/local/chatgpt/${action}`, { method: body === undefined ? "GET" : "POST", headers: { host: "127.0.0.1:3106", origin, "content-type": "application/json", ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("FLUID_RUNTIME", "local"); vi.stubEnv("VERCEL", ""); vi.stubEnv("APP_ORIGIN", origin); vi.stubEnv("FLUID_LOCAL_BRIDGE_TOKEN", "local_fixture_".padEnd(43, "x"));
  auth.mockResolvedValue({ userId: ownerId }); fetcher.mockImplementation(async () => Response.json(status));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("local ChatGPT bridge", () => {
  it("derives identity from Supabase and never exposes the worker capability", async () => {
    const response = await proxyLocalChatGPT(request(), "status");
    expect(response.status).toBe(200); expect(await response.json()).toEqual(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:3107/bridge/status");
    expect(JSON.parse(init.body)).toEqual({ ownerId, input: {} });
    expect(init.redirect).toBe("error");
  });
  it.each<Record<string, string>>([{ host: "evil.example" }, { origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }])("blocks an untrusted browser origin before identity or worker access: %j", async headers => {
    expect((await proxyLocalChatGPT(request("status", undefined, headers), "status")).status).toBe(403);
    expect(auth).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("accepts NextRequest loopback normalization while keeping the wire authority exact", async () => {
    const normalized = new NextRequest(request());
    expect(new URL(normalized.url).origin).toBe("http://localhost:3106");
    expect((await proxyLocalChatGPT(normalized, "status")).status).toBe(200);
    fetcher.mockResolvedValue(Response.json({ authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=fixture" }));
    expect((await proxyLocalChatGPT(new NextRequest(request("sign-in", {})), "sign-in")).status).toBe(200);
  });
  it("does not accept localhost as the wire Host or browser Origin after normalization", async () => {
    const hostileHeaders: Record<string, string>[] = [{ host: "localhost:3106" }, { origin: "http://localhost:3106" }];
    for (const headers of hostileHeaders) {
      expect((await proxyLocalChatGPT(new NextRequest(request("sign-in", {}, headers)), "sign-in")).status).toBe(403);
    }
    expect(auth).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps local capabilities unavailable on Vercel regardless of a local flag", async () => {
    vi.stubEnv("VERCEL", "1");
    expect((await proxyLocalChatGPT(request(), "status")).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires a verified Fluid account before accessing registration metadata", async () => {
    auth.mockRejectedValue(new ApiError("unauthenticated"));
    expect((await proxyLocalChatGPT(request(), "status")).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects caller-supplied owners and secret fields", async () => {
    expect((await proxyLocalChatGPT(request("sign-in", { ownerId }), "sign-in")).status).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(Response.json({ ...status, access_token: "synthetic-secret" }));
    const response = await proxyLocalChatGPT(request(), "status");
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("synthetic-secret");
  });
  it("refuses off-provider sign-in destinations", async () => {
    fetcher.mockResolvedValue(Response.json({ authorizationUrl: "https://evil.example/authorize" }));
    expect((await proxyLocalChatGPT(request("sign-in", {}), "sign-in")).status).toBe(503);
  });
  it.each(["https://user:secret@auth.openai.com/api/accounts/authorize", "https://auth.openai.com/api/accounts/authorize?id_token_hint=synthetic-secret", "https://auth.openai.com/api/accounts/authorize#synthetic-secret"])("rejects credentials embedded in a provider sign-in URL: %s", async authorizationUrl => {
    fetcher.mockResolvedValue(Response.json({ authorizationUrl }));
    const response = await proxyLocalChatGPT(request("sign-in", {}), "sign-in");
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("synthetic-secret");
  });
  it("allows production loopback only for the exact local runtime origin", () => {
    expect(getApplicationOrigin({ NODE_ENV: "production", FLUID_RUNTIME: "local", APP_ORIGIN: origin })).toBe(origin);
    for (const env of [{ NODE_ENV: "production", APP_ORIGIN: origin }, { NODE_ENV: "production", FLUID_RUNTIME: "local", VERCEL: "1", APP_ORIGIN: origin }, { NODE_ENV: "production", FLUID_RUNTIME: "local", APP_ORIGIN: "http://127.0.0.1:9999" }]) expect(() => getApplicationOrigin(env)).toThrow();
  });
  it("allows loopback session cookies without weakening hosted production cookies", () => {
    expect(shouldUseSecureSessionCookies({ NODE_ENV: "production", FLUID_RUNTIME: "local", APP_ORIGIN: origin })).toBe(false);
    for (const env of [{ NODE_ENV: "production", APP_ORIGIN: origin }, { NODE_ENV: "production", FLUID_RUNTIME: "local", VERCEL: "1", APP_ORIGIN: origin }, { NODE_ENV: "production", FLUID_RUNTIME: "local", APP_ORIGIN: "http://127.0.0.1:9999" }]) expect(shouldUseSecureSessionCookies(env)).toBe(true);
  });
});
