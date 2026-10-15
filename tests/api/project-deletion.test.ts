import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), single: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mock.auth }));
import { POST, DELETE } from "../../src/app/api/projects/[projectId]/deletion/route";
import { ApiError } from "../../src/server/http/errors";
import { setProjectDeleted } from "../../src/server/data/project-deletion";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const context = { params: Promise.resolve({ projectId: id }) };
const input = { expectedRevision: 3, expectedLifecycleVersion: 2 };
const project = { id, owner_id: owner, scope: "complete_brand", title: "Saved project", current_revision: 3,
  created_at: "2026-10-15T12:00:00.000Z", deleted_at: "2026-10-15T13:00:00.000Z", lifecycle_version: 3 };
const auth = () => ({ userId: owner, client: { rpc: mock.rpc } });
const request = (body: unknown = input, method = "POST", headers: Record<string, string> = {}) => new Request(`http://127.0.0.1:3106/api/projects/${id}/deletion`, {
  method, headers: { origin: "http://127.0.0.1:3106", "content-type": "application/json", "X-Embel-Account": owner, ...headers }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3106");
  mock.auth.mockResolvedValue(auth()); mock.rpc.mockReturnValue({ single: mock.single });
  mock.single.mockResolvedValue({ data: project, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("reversible project deletion API", () => {
  it("sends only the verified owned lifecycle CAS and returns private lifecycle metadata", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ project });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("set_project_deleted", {
      p_project_id: id, p_expected_revision: 3, p_expected_lifecycle_version: 2, p_deleted: true,
    });
  });
  it("restores the same project without a purge endpoint", async () => {
    mock.single.mockResolvedValue({ data: { ...project, deleted_at: null }, error: null });
    const response = await DELETE(request(input, "DELETE"), context);
    expect(response.status).toBe(200); expect((await response.json()).project.deleted_at).toBeNull();
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith("set_project_deleted", {
      p_project_id: id, p_expected_revision: 3, p_expected_lifecycle_version: 2, p_deleted: false,
    });
  });
  it("requires matching captured account, current auth, safe origin and UUID before RPC", async () => {
    for (const headers of [{ "X-Embel-Account": other }, { "X-Embel-Account": "" }]) expect((await POST(request(input, "POST", headers), context)).status).toBe(401);
    mock.auth.mockRejectedValueOnce(new ApiError("unauthenticated")); expect((await POST(request(), context)).status).toBe(401);
    expect((await POST(request(input, "POST", { origin: "https://hostile.example" }), context)).status).toBe(403);
    expect((await DELETE(request(input, "DELETE", { "sec-fetch-site": "cross-site" }), context)).status).toBe(403);
    expect((await POST(request(), { params: Promise.resolve({ projectId: "invalid" }) })).status).toBe(404);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it.each([{}, { expectedRevision: 3 }, { ...input, ownerId: other }, { ...input, purge: true }, { ...input, expectedRevision: 0 },
    { ...input, expectedRevision: 1.5 }, { ...input, expectedLifecycleVersion: -1 }, { ...input, expectedLifecycleVersion: 2147483647 }])("rejects invalid lifecycle intent: %j", async body => {
    expect((await POST(request(body), context)).status).toBe(422); expect(mock.rpc).not.toHaveBeenCalled();
  });
  it("bounds streamed bytes and refuses a wrong content type", async () => {
    expect((await POST(request({ ...input, extra: "x".repeat(1200) }, "POST", { "content-length": "1" }), context)).status).toBe(413);
    expect((await POST(request(input, "POST", { "content-type": "text/plain" }), context)).status).toBe(422);
    expect(mock.rpc).not.toHaveBeenCalled();
  });
  it.each([["P0002", 404], ["40001", 409], ["PT409", 409], ["22023", 422], ["PGRST202", 503]])("maps %s without leaking database internals", async (code, status) => {
    mock.single.mockResolvedValue({ data: null, error: { code, message: "private database diagnostic" } });
    const response = await POST(request(), context); expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).not.toContain("private database diagnostic");
  });
  it("explains unresolved work only for the exact safe busy sentinel", async () => {
    mock.single.mockResolvedValue({ data: null, error: { code: "PT409", message: "project_busy" } });
    const response = await POST(request(), context); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "project_busy" } });
  });
  it.each([{ owner_id: other }, { id: other }])("rejects a cross-owner or wrong-project success receipt", async patch => {
    mock.single.mockResolvedValue({ data: { ...project, ...patch }, error: null });
    expect((await POST(request(), context)).status).toBe(404);
  });
  it.each([{ deleted_at: null }, { lifecycle_version: 2 }, { current_revision: 4 }, { lifecycle_version: undefined }, { deleted_at: undefined }])("requires the actual acknowledged transition: %j", async patch => {
    mock.single.mockResolvedValue({ data: { ...project, ...patch }, error: null });
    expect((await POST(request(), context)).status).toBe(503);
  });
  it("independently validates service input", async () => {
    await expect(setProjectDeleted(auth() as never, id, { ...input, owner }, true)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(setProjectDeleted(auth() as never, "invalid", input, true)).rejects.toMatchObject({ code: "not_found" });
    expect(mock.rpc).not.toHaveBeenCalled();
  });
});
