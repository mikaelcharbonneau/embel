import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), brand: vi.fn(), source: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock("../../src/server/data/ideas", () => ({ listIdeas: mocks.list, getIdea: mocks.get, createIdea: mocks.create, updateIdea: mocks.update, createIdeaBrand: mocks.brand, getProjectIdeaSource: mocks.source }));
import { GET as list, POST as create } from "../../src/app/api/ideas/route";
import { GET as get, PATCH as update } from "../../src/app/api/ideas/[ideaId]/route";
import { POST as brand } from "../../src/app/api/ideas/[ideaId]/brand/route";
import { GET as source } from "../../src/app/api/projects/[projectId]/idea-source/route";
import { ApiError } from "../../src/server/http/errors";
import { ideaContentSchema } from "../../src/domain/ideas";
const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", key = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const auth = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", client: {} };
const ctx = { params: Promise.resolve({ ideaId: id, projectId: id }) };
const request = (method = "GET", body?: unknown, query = "", origin = "http://localhost:3105") => new Request("http://localhost:3105/api/ideas" + query, { method,
  ...(method !== "GET" ? { headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
describe("manual Ideas authenticated HTTP boundary", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "http://localhost:3105"); mocks.auth.mockResolvedValue(auth); });
  it("passes normalized bounded list query values with verified identity and private headers", async () => {
    const value = { ownerId: auth.userId, items: [], nextCursor: null }; mocks.list.mockResolvedValue(value);
    const r = await list(request("GET", undefined, "?limit=7&search=%25_&state=developing&cursorId=" + id + "&cursorCreatedAt=2026-10-05T12%3A00%3A00.000002Z"));
    expect(r.status).toBe(200); expect(await r.json()).toEqual(value);
    expect(mocks.list).toHaveBeenCalledWith(auth, { limit: 7, search: "%_", state: "developing", cursor: { id, createdAt: "2026-10-05T12:00:00.000002Z" } });
    expect(r.headers.get("Cache-Control")).toBe("private, no-store"); expect(r.headers.get("Vary")).toBe("Cookie");
  });
  it.each(["?ownerId=foreign", "?limit=7&limit=8", "?search=x&search=y", "?cursorId=" + id, "?cursorCreatedAt=2026-10-05T12%3A00%3A00Z", "?limit=1e1", "?limit=51", "?state=invented", "?search=" + "x".repeat(201)])("rejects unsupported, duplicated or invalid query %s", async query => {
    expect((await list(request("GET", undefined, query))).status).toBe(422); expect(mocks.list).not.toHaveBeenCalled();
  });
  it("creates, updates and promotes only explicit strict input bodies", async () => {
    mocks.create.mockResolvedValue({ id }); mocks.update.mockResolvedValue({ id }); mocks.brand.mockResolvedValue({ idea: { id }, link: { projectId: id } });
    expect((await create(request("POST", { requestKey: key, content: { title: "  Capture  " } }))).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(auth, { requestKey: key, content: ideaContentSchema.parse({ title: "Capture" }) });
    expect((await update(request("PATCH", { requestKey: key, expectedRevision: 1, content: { title: "Capture" } }), ctx)).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(auth, id, { requestKey: key, expectedRevision: 1, content: ideaContentSchema.parse({ title: "Capture" }) });
    expect((await brand(request("POST", { requestKey: key, expectedRevision: 2 }), ctx)).status).toBe(200);
    expect(mocks.brand).toHaveBeenCalledWith(auth, id, { requestKey: key, expectedRevision: 2 });
  });
  it("reads the bound idea and original source", async () => {
    mocks.get.mockResolvedValue({ id }); mocks.source.mockResolvedValue({ source: null });
    expect(await (await get(request(), ctx)).json()).toEqual({ idea: { id } });
    expect(await (await source(request(), ctx)).json()).toEqual({ source: null });
    expect(mocks.source).toHaveBeenCalledWith(auth, id);
  });
  it.each(["create", "update", "brand"] as const)("checks %s same origin before verified auth", async action => {
    const req = request(action === "update" ? "PATCH" : "POST", {}, "", "https://foreign.invalid");
    const r = action === "create" ? await create(req) : action === "update" ? await update(req, ctx) : await brand(req, ctx);
    expect(r.status).toBe(403); expect(mocks.auth).not.toHaveBeenCalled();
  });
  it.each(["create", "update", "brand"] as const)("caps %s streamed body before auth", async action => {
    const req = request(action === "update" ? "PATCH" : "POST", { title: "x".repeat(32769) });
    const r = action === "create" ? await create(req) : action === "update" ? await update(req, ctx) : await brand(req, ctx);
    expect(r.status).toBe(413); expect(mocks.auth).not.toHaveBeenCalled();
  });
  it.each([{ requestKey: key, content: { title: "Capture" }, ownerId: auth.userId }, { requestKey: key, content: { title: "Capture", ownerId: auth.userId } }])("rejects caller supplied ownership before auth", async body => {
    expect((await create(request("POST", body))).status).toBe(422); expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("rejects caller supplied promotion context before auth", async () => {
    expect((await brand(request("POST", { requestKey: key, expectedRevision: 1, context: {} }), ctx)).status).toBe(422); expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("requires authentication for every read and write", async () => {
    mocks.auth.mockRejectedValue(new ApiError("unauthenticated"));
    const responses = [await list(request()), await get(request(), ctx), await source(request(), ctx), await create(request("POST", { requestKey: key, content: { title: "x" } })),
      await update(request("PATCH", { requestKey: key, expectedRevision: 1, content: { title: "x" } }), ctx), await brand(request("POST", { requestKey: key, expectedRevision: 1 }), ctx)];
    expect(responses.map(r => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
    for (const r of responses) expect(r.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns safe foreign/conflict/unavailable responses", async () => {
    mocks.get.mockRejectedValue(new ApiError("not_found")); expect((await get(request(), ctx)).status).toBe(404);
    mocks.update.mockRejectedValue(new ApiError("conflict")); expect((await update(request("PATCH", { requestKey: key, expectedRevision: 1, content: { title: "x" } }), ctx)).status).toBe(409);
    mocks.list.mockRejectedValue(new ApiError("integration_unavailable")); expect((await list(request())).status).toBe(503);
    mocks.brand.mockRejectedValue(new Error("PRIVATE DATA")); const r = await brand(request("POST", { requestKey: key, expectedRevision: 1 }), ctx);
    expect(r.status).toBe(500); expect(await r.text()).not.toContain("PRIVATE DATA");
  });
});
