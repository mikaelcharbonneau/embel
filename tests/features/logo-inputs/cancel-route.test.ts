import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const f = vi.hoisted(() => ({ auth: vi.fn(), cancel: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: f.auth }));
vi.mock("@/server/data/logo-inputs", () => ({ productionLogoInputService: { cancelLogoInputRequest: f.cancel } }));
import { POST } from "@/app/api/projects/[projectId]/logo/inputs/requests/[requestKey]/cancel/route";
import { ApiError } from "@/server/http/errors";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../../fixtures/logo-creation";
const workspace = syntheticLogoWorkspace(), auth = { userId: workspace.ownerId }, key = id(801);
const input = { kind: "reference_upload", input: { requestKey: key, expected: workspace.heads, aspects: ["shape"], rightsDeclaration: "Permission to process" }, file: { mimeType: "image/png", byteLength: 100, contentHash: "a".repeat(64) } };
const scope = { params: Promise.resolve({ projectId: workspace.projectId, requestKey: key }) };
function request(body: unknown = input, headers = {}) { return new Request("https://fluid.invalid/api/cancel", { method: "POST", headers: { Origin: "https://fluid.invalid", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }); }
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "https://fluid.invalid"); f.auth.mockResolvedValue(auth); });
afterEach(() => vi.unstubAllEnvs());
describe("exact owned input cancellation route", () => {
  it("passes only the path-bound exact original request and returns private cancellation evidence", async () => {
    const evidence = { status: "rejected", ownerId: workspace.ownerId, projectId: workspace.projectId, requestKey: key, request: input, reason: "cancelled_by_user" };
    f.cancel.mockResolvedValue(evidence); const req = request(), result = await POST(req, scope);
    expect(result.status).toBe(200); expect(await result.json()).toEqual(evidence); expect(result.headers.get("cache-control")).toBe("private, no-store"); expect(result.headers.get("vary")).toBe("Cookie");
    expect(f.cancel).toHaveBeenCalledWith(auth, workspace.projectId, input, req.signal);
  });
  it("rejects unauthenticated, cross-origin and mismatched-key requests before service calls", async () => {
    f.auth.mockRejectedValueOnce(new ApiError("unauthenticated")); expect((await POST(request(), scope)).status).toBe(401);
    expect((await POST(request(input, { Origin: "https://foreign.invalid" }), scope)).status).toBe(403);
    expect((await POST(request({ ...input, input: { ...input.input, requestKey: id(999) } }), scope)).status).toBe(422);
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it("bounds real JSON bytes and rejects extra fields and unsafe identifiers", async () => {
    expect((await POST(request({ ...input, ownerId: id(99) }), scope)).status).toBe(422);
    expect((await POST(request(), { params: Promise.resolve({ projectId: "not-a-project", requestKey: key }) })).status).toBe(422);
    expect((await POST(request({ ...input, huge: "x".repeat(310000) }, { "Content-Length": "1" }), scope)).status).toBe(413);
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it("allows a prior raw URL spelling only as an unchanged rejection request", async () => {
    const body = { kind: "font_upload", input: { requestKey: key, expected: workspace.heads, licenseSourceUrl: "HTTPS://example.com/license", licenseText: "Old retained license", rightsDeclaration: "Permission" }, file: { mimeType: "font/ttf", byteLength: 100, contentHash: "a".repeat(64) } };
    f.cancel.mockResolvedValue({ status: "rejected" }); const req = request(body); expect((await POST(req, scope)).status).toBe(200); expect(f.cancel).toHaveBeenCalledWith(auth, workspace.projectId, body, req.signal);
  });
  it("does not turn a lost cancellation acknowledgement into confirmed rejection", async () => {
    f.cancel.mockRejectedValue(new ApiError("integration_unavailable")); const result = await POST(request(), scope);
    expect(result.status).toBe(503); expect(await result.json()).not.toHaveProperty("reason", "cancelled_by_user");
  });
});
