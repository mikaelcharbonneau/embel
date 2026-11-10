import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), capabilities: vi.fn(), lookup: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock("@/server/standalone-providers/live-runtime", () => ({
  standaloneCapabilities: mocks.capabilities,
  runStandaloneLookup: mocks.lookup,
}));
import { GET, POST } from "@/app/api/standalone-checks/route";
import { ApiError } from "@/server/http/errors";
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  origin = "http://localhost:3105";
const target = { tool: "domains", domain: "example.com" };
const request = (body: unknown = target, headers: HeadersInit = {}) =>
  new Request(`${origin}/api/standalone-checks`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "X-Embel-Account": ownerId, ...headers },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("FLUID_RUNTIME", "local");
  vi.stubEnv("VERCEL", "");
  mocks.auth.mockResolvedValue({ userId: ownerId });
  mocks.capabilities.mockReturnValue({ ownerId, domains: "rdap", youtube: false, euipo: false });
  mocks.lookup.mockResolvedValue({ status: "failed", code: "unsupported_target", retryAfterSeconds: null });
});
afterEach(() => vi.unstubAllEnvs());
describe("private live lookup routes", () => {
  it("returns only safe capability flags with an authenticated owner and no-store headers", async () => {
    const response = await GET(new Request(`${origin}/api/standalone-checks`));
    expect(await response.json()).toEqual({ ownerId, domains: "rdap", youtube: false, euipo: false });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });
  it("derives the owner exclusively from authentication and forwards cancellation", async () => {
    const input = request();
    const response = await POST(input);
    expect(response.status).toBe(200);
    expect(mocks.lookup).toHaveBeenCalledWith(ownerId, target, input.signal);
    expect(await response.json()).toMatchObject({ ownerId, result: { status: "failed", code: "unsupported_target" } });
  });
  it.each([undefined, "invalid", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])(
    "rejects missing or mismatched captured accounts before provider admission: %s",
    async (expectedOwner) => {
      const input = request();
      if (expectedOwner) input.headers.set("X-Embel-Account", expectedOwner);
      else input.headers.delete("X-Embel-Account");
      expect((await POST(input)).status).toBe(401);
      expect(mocks.lookup).not.toHaveBeenCalled();
    },
  );
  it("rejects a stale tab after cookies switch accounts without starting a provider lookup", async () => {
    mocks.auth.mockResolvedValue({ userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it.each(["GET", "POST"])("blocks anonymous %s before runtime/provider access", async (method) => {
    mocks.auth.mockRejectedValue(new ApiError("unauthenticated"));
    const response =
      method === "GET" ? await GET(new Request(`${origin}/api/standalone-checks`)) : await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
  });
  it.each([
    { ...target, ownerId },
    { ...target, url: "https://arbitrary.test" },
    { ...target, token: "forged" },
    { tool: "domains", domain: "https://localhost" },
  ])("rejects owner, credential, URL and invalid domain injection before execution", async (body) => {
    expect((await POST(request(body))).status).toBe(422);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("requires same-origin admission and a bounded body", async () => {
    expect((await POST(request(target, { origin: "https://other.test" }))).status).toBe(403);
    expect(await POST(request({ junk: "x".repeat(8193) }))).toHaveProperty("status", 413);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("sanitizes invalid runtime responses and arbitrary errors", async () => {
    mocks.lookup.mockRejectedValue(new Error("secret-token private database"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret-token");
  });
});
