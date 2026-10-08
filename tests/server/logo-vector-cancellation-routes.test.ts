import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const f = vi.hoisted(() => ({ auth: vi.fn(), cancel: vi.fn(), read: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: f.auth }));
vi.mock("@/features/logo-vector/server/cancellation", () => ({ cancelLogoVectorEdit: f.cancel, readLogoVectorEditRequest: f.read }));
import { POST } from "@/app/api/projects/[projectId]/logo/edits/requests/[requestKey]/cancel/route";
import { GET } from "@/app/api/projects/[projectId]/logo/edits/requests/[requestKey]/route";
import { ApiError } from "@/server/http/errors";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../fixtures/logo-creation";
const workspace = syntheticLogoWorkspace(), auth = { userId: workspace.ownerId }, key = id(805);
const command = { method: "saveLogoEdit", body: { requestKey: key, expected: workspace.heads, baseVectorRevisionId: id(806), edit: { kind: "font", componentId: "lettering", fontVersionId: id(807) } } };
const scope = { params: Promise.resolve({ projectId: workspace.projectId, requestKey: key }) };
function request(body: unknown = command, headers = {}, query = "") { return new Request("https://fluid.invalid/api/cancel" + query, { method: "POST", headers: { Origin: "https://fluid.invalid", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }); }
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "https://fluid.invalid"); f.auth.mockResolvedValue(auth); });
afterEach(() => vi.unstubAllEnvs());
describe("bounded vector cancellation routes", () => {
  it("posts the path-bound complete command and keeps exact proof private", async () => {
    const proof = { status: "cancelled", ownerId: workspace.ownerId, projectId: workspace.projectId, requestKey: key, command };
    f.cancel.mockResolvedValue(proof); const req = request(), result = await POST(req, scope);
    expect(result.status).toBe(200); expect(await result.json()).toEqual(proof); expect(result.headers.get("cache-control")).toBe("private, no-store"); expect(result.headers.get("vary")).toBe("Cookie");
    expect(f.cancel).toHaveBeenCalledWith(auth, workspace.projectId, command, req.signal);
  });
  it("reads one exact key without a write and retains not_found uncertainty", async () => {
    f.read.mockResolvedValue({ status: "not_found" }); const req = new Request("https://fluid.invalid/api/request"), result = await GET(req, scope);
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ status: "not_found" }); expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(f.read).toHaveBeenCalledWith(auth, workspace.projectId, key, req.signal); expect(f.cancel).not.toHaveBeenCalled();
  });
  it("rejects anonymous, cross-origin, extra-field and changed-key POSTs before writing", async () => {
    f.auth.mockRejectedValueOnce(new ApiError("unauthenticated")); expect((await POST(request(), scope)).status).toBe(401);
    expect((await POST(request(command, { Origin: "https://foreign.invalid" }), scope)).status).toBe(403);
    expect((await POST(request({ ...command, ownerId: id(808) }), scope)).status).toBe(422);
    expect((await POST(request({ ...command, body: { ...command.body, requestKey: id(809) } }), scope)).status).toBe(422);
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it("bounds actual streamed bytes and rejects queries and malformed path IDs", async () => {
    expect((await POST(request({ ...command, huge: "x".repeat(33000) }, { "Content-Length": "1" }), scope)).status).toBe(413);
    for (const query of ["?ownerId=" + workspace.ownerId, "?requestKey=" + key, "?x=" + "x".repeat(4100)]) {
      expect((await POST(request(command, {}, query), scope)).status).toBe(422);
      expect((await GET(new Request("https://fluid.invalid/api" + query), scope)).status).toBe(422);
    }
    const badScope = { params: Promise.resolve({ projectId: "invalid", requestKey: key }) };
    expect((await POST(request(), badScope)).status).toBe(422); expect((await GET(new Request("https://fluid.invalid/api"), badScope)).status).toBe(422);
    expect(f.cancel).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
});
