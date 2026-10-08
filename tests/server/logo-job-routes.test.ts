import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const f = vi.hoisted(() => ({ auth: vi.fn(), quote: vi.fn(), admit: vi.fn(), read: vi.fn(), reconcile: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: f.auth }));
vi.mock("../../src/server/data/logo-jobs", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/server/data/logo-jobs")>();
  return { ...actual, quoteLogoOperation: f.quote, admitLogoOperation: f.admit, readLogoRequest: f.read, reconcileLogoRequest: f.reconcile };
});
import { ApiError } from "../../src/server/http/errors";
import { LogoAdmissionRejectedError, LogoAdmissionUncertainError } from "../../src/server/data/logo-jobs";
import { POST as quote } from "../../src/app/api/projects/[projectId]/logo/quotes/route";
import { POST as admit } from "../../src/app/api/projects/[projectId]/logo/requests/route";
import { GET as read } from "../../src/app/api/projects/[projectId]/logo/requests/[requestKey]/route";
import { POST as reconcile } from "../../src/app/api/projects/[projectId]/logo/requests/[requestKey]/reconcile/route";
const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId = id(1), projectId = id(2), requestKey = id(3), quoteId = id(4);
const expected = { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 1, stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 } };
const intent = { requestKey, quoteId, expected, acceptedMaxCostMicrousd: 100 };
const context = { params: Promise.resolve({ projectId, requestKey }) };
const request = (body: unknown, origin = "https://fluid.invalid") => new Request("https://fluid.invalid/api/logo", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "https://fluid.invalid"); f.auth.mockResolvedValue({ userId: ownerId, client: {} }); });
afterEach(() => vi.unstubAllEnvs());
describe("logo durable HTTP routes", () => {
  it("quotes and admits only after authentication, origin and strict input checks", async () => {
    const input = { expected, operation: "concepts", briefRevisionId: id(5), referenceSnapshotId: id(6) };
    f.quote.mockResolvedValue({ fixture: "quote" }); f.admit.mockResolvedValue({ fixture: "dispatch" });
    expect((await quote(request(input), context)).status).toBe(200);
    expect(f.quote.mock.calls[0]![2]).toEqual(input);
    const response = await admit(request(intent), context);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(f.admit.mock.calls[0]![2]).toEqual(intent);
  });
  it("blocks cross-origin or malformed admission before the service", async () => {
    expect((await admit(request(intent, "https://evil.invalid"), context)).status).toBe(403);
    expect((await admit(request({ ...intent, ownerId }), context)).status).toBe(422);
    expect(f.admit).not.toHaveBeenCalled();
    f.auth.mockRejectedValue(new ApiError("unauthenticated"));
    expect((await admit(request(intent), context)).status).toBe(401);
  });
  it("exposes only an exact scoped typed rejection, not a generic conflict or foreign marker", async () => {
    f.admit.mockRejectedValueOnce(new LogoAdmissionRejectedError(ownerId, projectId, intent, "conflict"));
    expect(await (await admit(request(intent), context)).json()).toMatchObject({ rejection: { status: "rejected", ownerId, projectId, requestKey, quoteId } });
    f.admit.mockRejectedValueOnce(new ApiError("conflict"));
    expect(await (await admit(request(intent), context)).json()).not.toHaveProperty("rejection");
    f.admit.mockRejectedValueOnce(new LogoAdmissionRejectedError(id(99), projectId, intent, "conflict"));
    expect(await (await admit(request(intent), context)).json()).not.toHaveProperty("rejection");
  });
  it("keeps uncertain admission generic and never retries", async () => {
    f.admit.mockRejectedValue(new LogoAdmissionUncertainError(projectId, intent));
    const response = await admit(request(intent), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "integration_unavailable", message: "This integration is not configured or is unavailable." } });
    expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it("reads manual or generated request state through the unified owned service and reconciles without admission", async () => {
    f.read.mockResolvedValue({ status: "not_found" }); f.reconcile.mockResolvedValue({ status: "not_found" });
    expect((await read(new Request("https://fluid.invalid/api/logo"), context)).status).toBe(200);
    expect((await reconcile(request({}), context)).status).toBe(200);
    expect(f.read.mock.calls[0]!.slice(1)).toEqual([projectId, requestKey]);
    expect(f.reconcile.mock.calls[0]!.slice(1)).toEqual([projectId, requestKey]);
    expect(f.admit).not.toHaveBeenCalled(); expect(f.quote).not.toHaveBeenCalled();
  });
});
