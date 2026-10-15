import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), get: vi.fn(), save: vi.fn(), source: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock("../../src/server/data/standalone-workspaces", () => ({ getStandaloneWorkspace: mocks.get, saveStandaloneWorkspace: mocks.save, getStandaloneImport: mocks.source }));
import { GET, PUT } from "../../src/app/api/workspaces/[tool]/route";
import { GET as source } from "../../src/app/api/workspaces/imports/route";
import { ApiError } from "../../src/server/http/errors";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", auth = { userId: id, client: {} };
const context = { params: Promise.resolve({ tool: "domains" }) };
const input = { requestKey: id, expectedRevision: 0, payload: {}, imports: [] };
const request = (method = "GET", body?: unknown, query = "", origin = "http://localhost:3105") => new Request("http://localhost:3105/api/workspaces/domains" + query, {
  method, ...(method === "PUT" ? { body: JSON.stringify(body), headers: { "content-type": "application/json", origin, "X-Embel-Account": id } } : {}),
});
describe("standalone authenticated HTTP boundary", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "http://localhost:3105"); mocks.auth.mockResolvedValue(auth); });
  it("reads/saves through verified context with private no-store responses", async () => {
    mocks.get.mockResolvedValue({ ownerId: id, workspace: null }); mocks.save.mockResolvedValue({ ownerId: id, workspace: { id } });
    const read = await GET(request(), context), write = await PUT(request("PUT", input), context);
    expect(read.status).toBe(200); expect(write.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith(auth, "domains"); expect(mocks.save).toHaveBeenCalledWith(auth, "domains", input);
    for (const r of [read, write]) { expect(r.headers.get("Cache-Control")).toBe("private, no-store"); expect(r.headers.get("Vary")).toBe("Cookie"); }
  });
  it("resolves imports only through the authenticated explicit owned-project read", async () => {
    mocks.source.mockResolvedValue({ ownerId: id, source: null });
    expect(await (await source(request("GET", undefined, "?projectId=" + id))).json()).toEqual({ ownerId: id, source: null });
    expect(mocks.source).toHaveBeenCalledWith(auth, id);
  });
  it.each([undefined, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "invalid"]) ("rejects a missing or mismatched expected account before saving: %s", async expectedOwner => {
    const req = request("PUT", input);
    if (expectedOwner) req.headers.set("X-Embel-Account", expectedOwner); else req.headers.delete("X-Embel-Account");
    const response = await PUT(req, context);
    expect(response.status).toBe(401); expect(mocks.save).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it.each(["", "?ownerId=" + id, "?projectId=bad", "?projectId=" + id + "&projectId=" + id, "?projectId=" + id + "&name=Forged"])("rejects malformed or injected source query %s", async query => {
    expect((await source(request("GET", undefined, query))).status).toBe(422); expect(mocks.source).not.toHaveBeenCalled();
  });
  it("rejects cross-origin writes before authentication", async () => {
    expect((await PUT(request("PUT", input, "", "https://foreign.invalid"), context)).status).toBe(403); expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("enforces actual UTF-8 body bounds even with a false Content-Length", async () => {
    const req = request("PUT", { ...input, payload: "🙂".repeat(40000) }); req.headers.set("content-length", "10");
    expect((await PUT(req, context)).status).toBe(413); expect(mocks.auth).not.toHaveBeenCalled();
  });
  it.each([{ ...input, ownerId: id }, { ...input, expectedRevision: -1 }, { ...input, requestKey: "bad" }])("rejects unsupported envelope fields before auth", async body => {
    expect((await PUT(request("PUT", body), context)).status).toBe(422); expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("rejects query payloads, unsupported tools and malformed JSON", async () => {
    expect((await GET(request("GET", undefined, "?ownerId=" + id), context)).status).toBe(422);
    expect((await GET(request(), { params: Promise.resolve({ tool: "orders" }) })).status).toBe(404);
    const broken = new Request("http://localhost:3105/api/workspaces/domains", { method: "PUT", headers: { "content-type": "application/json", origin: "http://localhost:3105" }, body: "{" });
    expect((await PUT(broken, context)).status).toBe(422);
  });
  it("requires verified auth for every endpoint and contains internal details", async () => {
    mocks.auth.mockRejectedValue(new ApiError("unauthenticated"));
    expect((await GET(request(), context)).status).toBe(401); expect((await PUT(request("PUT", input), context)).status).toBe(401);
    expect((await source(request("GET", undefined, "?projectId=" + id))).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValue(auth); mocks.save.mockRejectedValue(new Error("PRIVATE DETAILS"));
    const r = await PUT(request("PUT", input), context); expect(r.status).toBe(500); expect(await r.text()).not.toContain("PRIVATE DETAILS");
  });
  it.each([["not_found", 404], ["conflict", 409], ["integration_unavailable", 503]] as const)("returns honest %s status", async (code, status) => {
    mocks.save.mockRejectedValue(new ApiError(code)); expect((await PUT(request("PUT", input), context)).status).toBe(status);
  });
});
