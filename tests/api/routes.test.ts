import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), single: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: doubles.auth }));
import { POST as createProject } from "../../src/app/api/projects/route";
import { DELETE as cancelJob } from "../../src/app/api/jobs/[jobId]/route";
import { ApiError } from "../../src/server/http/errors";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "11111111-1111-4111-8111-111111111111";
const input = { title: "Local test fixture", scope: "naming_only", context: { description: "A local fixture, not model output." } };
const request = (body: unknown = input, origin = "https://fluid.example") => new Request("https://fluid.example/api/projects", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("web mutation security boundaries", () => {
  beforeEach(() => {
    vi.stubEnv("APP_ORIGIN", "https://fluid.example");
    doubles.auth.mockResolvedValue({ userId: ownerId, client: { rpc: doubles.rpc } });
    doubles.rpc.mockReturnValue({ single: doubles.single });
    doubles.single.mockResolvedValue({ data: { id: projectId, owner_id: ownerId, scope: "naming_only", title: input.title, current_revision: 1, created_at: "2026-10-02T00:00:00Z" }, error: null });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it("rejects a cross-origin mutation before database access", async () => {
    expect((await createProject(request(input, "https://untrusted.example"))).status).toBe(403);
    expect(doubles.auth).not.toHaveBeenCalled();
    expect(doubles.rpc).not.toHaveBeenCalled();
  });
  it("requires validated identity and does not impersonate a demo user", async () => {
    doubles.auth.mockRejectedValue(new ApiError("unauthenticated"));
    expect((await createProject(request())).status).toBe(401);
    expect(doubles.rpc).not.toHaveBeenCalled();
  });
  it("rejects owner injection and invalid scopes", async () => {
    expect((await createProject(request({ ...input, ownerId: "another-user" }))).status).toBe(422);
    expect((await createProject(request({ ...input, scope: "admin" }))).status).toBe(422);
    expect(doubles.rpc).not.toHaveBeenCalled();
  });
  it("uses ownership derived inside the authenticated RPC and excludes shared caches", async () => {
    const response = await createProject(request());
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(doubles.rpc).toHaveBeenCalledWith("create_project", expect.objectContaining({ p_scope: "naming_only", p_title: input.title }));
    expect(doubles.rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_owner_id");
    expect(doubles.single).toHaveBeenCalledOnce();
  });
  it("redacts raw database diagnostics and credentials", async () => {
    doubles.single.mockRejectedValue(new Error("fixture-secret-in-diagnostic"));
    const response = await createProject(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("fixture-secret");
  });
  it("never returns a lease token from the cancellation endpoint", async () => {
    doubles.rpc.mockResolvedValue({ data: { id: projectId, state: "cancel_requested", progress: 40, lease_token: "sensitive-worker-fence", worker_id: "internal-worker" }, error: null });
    const response = await cancelJob(new Request(`https://fluid.example/api/jobs/${projectId}`, { method: "DELETE", headers: { origin: "https://fluid.example" } }), { params: Promise.resolve({ jobId: projectId }) });
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.job.state).toBe("cancel_requested");
    expect(value.job).not.toHaveProperty("lease_token");
    expect(value.job).not.toHaveProperty("worker_id");
  });
});
