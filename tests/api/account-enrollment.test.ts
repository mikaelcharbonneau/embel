import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), ensure: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: doubles.auth }));
vi.mock("@/server/data/account-enrollment", () => ({ readAccountServiceEnrollment: doubles.read, ensureAccountServiceEnrollment: doubles.ensure }));
import { GET, POST } from "@/app/api/account/enrollment/route";
import { ApiError } from "@/server/http/errors";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", account = { userId: owner, client: {} };
const pending = { ownerId: owner, generation: 1, status: "pending", capabilities: { home_attachments: false, identity_transactions: false,
  strategy: false, naming: false, logo: false }, updatedAt: "2026-10-27T00:00:00Z" };
function request(body: unknown = {}, origin = "http://localhost:3105", query = "") {
  return new Request(`http://localhost:3105/api/account/enrollment${query}`, { method: "POST", headers: {
    origin, "content-type": "application/json", "X-Embel-Account": owner }, body: JSON.stringify(body) });
}
function readRequest(captured = owner) {
  return new Request("http://localhost:3105/api/account/enrollment", { headers: { "X-Embel-Account": captured } });
}
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "http://localhost:3105");
  doubles.auth.mockResolvedValue(account); doubles.read.mockResolvedValue(pending); doubles.ensure.mockResolvedValue(pending); });
afterEach(() => vi.unstubAllEnvs());
describe("verified owner enrollment HTTP boundary", () => {
  it("keeps GET read-only and returns only the owner-projected private status", async () => {
    const req = readRequest(), response = await GET(req);
    expect(await response.json()).toEqual({ enrollment: pending }); expect(doubles.read).toHaveBeenCalledWith(account, req.signal);
    expect(doubles.ensure).not.toHaveBeenCalled(); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });
  it("rejects GET when the cookie account changes after the browser captured its owner", async () => {
    doubles.auth.mockResolvedValue({ userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", client: {} });
    const response = await GET(readRequest());
    expect(response.status).toBe(401); expect(doubles.read).not.toHaveBeenCalled(); expect(doubles.ensure).not.toHaveBeenCalled();
  });
  it.each([null, "invalid"])("requires a valid captured GET account %s", async captured => {
    const req = readRequest(captured ?? owner); if (captured === null) req.headers.delete("X-Embel-Account");
    expect((await GET(req)).status).toBe(401); expect(doubles.read).not.toHaveBeenCalled();
  });
  it("ensures idempotently through the verified context and never accepts an owner/capability payload", async () => {
    const req = request(); expect((await POST(req)).status).toBe(200);
    expect(doubles.ensure).toHaveBeenCalledWith(account, req.signal);
    doubles.auth.mockClear(); doubles.ensure.mockClear();
    for (const value of [{ ownerId: owner }, { capability: "logo" }, { roleName: "postgres" }, { force: true }]) expect((await POST(request(value))).status).toBe(422);
    expect(doubles.auth).not.toHaveBeenCalled(); expect(doubles.ensure).not.toHaveBeenCalled();
  });
  it("rejects missing/cross-site Origin before looking up an account", async () => {
    expect((await POST(request({}, "https://foreign.invalid"))).status).toBe(403);
    const missing = request(); missing.headers.delete("origin"); expect((await POST(missing)).status).toBe(403);
    const cross = request(); cross.headers.set("sec-fetch-site", "cross-site"); expect((await POST(cross)).status).toBe(403);
    expect(doubles.auth).not.toHaveBeenCalled();
  });
  it.each([null, "invalid", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])("fences a stale captured account %s", async captured => {
    const req = request(); if (captured) req.headers.set("X-Embel-Account", captured); else req.headers.delete("X-Embel-Account");
    expect((await POST(req)).status).toBe(401); expect(doubles.ensure).not.toHaveBeenCalled();
  });
  it("rejects query selectors and oversized bodies before any enrollment effect", async () => {
    expect((await POST(request({}, "http://localhost:3105", "?owner=other"))).status).toBe(422);
    expect((await GET(new Request("http://localhost:3105/api/account/enrollment?force=true"))).status).toBe(422);
    expect((await POST(request({ text: "x".repeat(1025) }))).status).toBe(413); expect(doubles.ensure).not.toHaveBeenCalled();
  });
  it("reports missing enrollment SQL as unavailable without turning it into an Auth failure", async () => {
    doubles.ensure.mockRejectedValue(new ApiError("integration_unavailable"));
    expect((await POST(request())).status).toBe(503);
    doubles.auth.mockRejectedValue(new ApiError("unauthenticated"));
    expect((await POST(request())).status).toBe(401); expect((await GET(new Request("http://localhost:3105/api/account/enrollment"))).status).toBe(401);
  });
  it("hides unexpected database/credential details", async () => {
    doubles.read.mockRejectedValue(new Error("private operator credential"));
    const response = await GET(readRequest());
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("private operator");
  });
});
