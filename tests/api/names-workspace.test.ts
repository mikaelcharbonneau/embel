import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), save: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock("../../src/server/data/names-workspace", () => ({ getNamesWorkspace: mocks.read, saveNamesWorkspace: mocks.save }));
import { GET, PUT } from "../../src/app/api/names/workspace/route";
import { ApiError } from "../../src/server/http/errors";
import { NAMES_WORKSPACE_MUTATION_MAX_BYTES } from "../../src/domain/names-workspace";
import { namesFixtureId as id, namesWorkspaceFixture } from "../fixtures/names-workspace";

const origin = "http://localhost:3105", auth = { userId: id(900), client: {} };
const input = () => ({ requestKey: id(999), expectedRevision: 0, payload: namesWorkspaceFixture() });
const request = (method = "GET", body?: unknown, query = "", requestOrigin = origin) => new Request(origin + "/api/names/workspace" + query, {
  method, ...(method === "PUT" ? { headers: { "content-type": "application/json", origin: requestOrigin, "X-Embel-Account": auth.userId }, body: JSON.stringify(body) } : {}),
});
describe("account Names workspace HTTP boundary", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", origin); mocks.auth.mockResolvedValue(auth); });
  it("uses verified account identity and private no-store responses for read and autosave", async () => {
    mocks.read.mockResolvedValue({ ownerId: auth.userId, workspace: null }); mocks.save.mockResolvedValue({ ownerId: auth.userId, workspace: { id: id(800) } });
    const read = await GET(request()), save = await PUT(request("PUT", input()));
    expect(read.status).toBe(200); expect(save.status).toBe(200);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(auth); expect(mocks.save).toHaveBeenCalledExactlyOnceWith(auth, input());
    for (const response of [read, save]) { expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie"); }
  });
  it("requires matching mutation origin before authentication or persistence", async () => {
    expect((await PUT(request("PUT", input(), "", "https://foreign.invalid"))).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([null, "invalid-account", id(901)])("rejects missing, malformed or stale captured account %s before writing", async expectedOwner => {
    const req = request("PUT", input());
    if (expectedOwner === null) req.headers.delete("X-Embel-Account");
    else req.headers.set("X-Embel-Account", expectedOwner);
    const response = await PUT(req);
    expect(response.status).toBe(401); expect(mocks.auth).toHaveBeenCalledOnce(); expect(mocks.save).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(auth.userId);
  });
  it("does not redirect an existing tab's payload into a newly signed-in cookie account", async () => {
    mocks.auth.mockResolvedValue({ ...auth, userId: id(901) });
    expect((await PUT(request("PUT", input()))).status).toBe(401);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(["GET", "PUT"])("refuses query owner or payload injection for %s", async method => {
    expect((await (method === "GET" ? GET : PUT)(request(method, input(), "?ownerId=" + id(900)))).status).toBe(422);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("bounds actual streamed UTF-8 bytes despite a false Content-Length", async () => {
    const req = request("PUT", { ...input(), padding: "🙂".repeat(Math.ceil(NAMES_WORKSPACE_MUTATION_MAX_BYTES / 4)) });
    req.headers.set("content-length", "12");
    expect((await PUT(req)).status).toBe(413); expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([{ ...input(), ownerId: id(901) }, { ...input(), requestKey: "invalid" }, { ...input(), expectedRevision: -1 },
    { ...input(), payload: { ...namesWorkspaceFixture(), version: 2 } }])("rejects malformed or injected envelopes before auth", async value => {
    expect((await PUT(request("PUT", value))).status).toBe(422); expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("requires authentication for both operations", async () => {
    mocks.auth.mockRejectedValue(new ApiError("unauthenticated"));
    expect((await GET(request())).status).toBe(401); expect((await PUT(request("PUT", input()))).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([["conflict", 409], ["integration_unavailable", 503]] as const)("reports %s without success fallback", async (code, status) => {
    mocks.save.mockRejectedValue(new ApiError(code)); expect((await PUT(request("PUT", input()))).status).toBe(status);
  });
  it("contains private failure details", async () => {
    mocks.save.mockRejectedValue(new Error("PRIVATE DATABASE DATA"));
    const response = await PUT(request("PUT", input())); expect(response.status).toBe(500); expect(await response.text()).not.toContain("PRIVATE DATABASE DATA");
  });
});
