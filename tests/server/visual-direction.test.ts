import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
import { GET, POST } from "@/app/api/projects/[projectId]/visual-direction/route";
import { ApiError } from "@/server/http/errors";
import { visualOverview, visualOwner, visualProject } from "../fixtures/visual-direction";
const overview = visualOverview({ likes: true, reviewed: true }), params = { params: Promise.resolve({ projectId: visualProject }) };
const input = { expectedRevision: 0, expectedProjectRevision: 1, expectedSelectionRevision: 1, catalogVersion: overview.inspiration.catalogVersion, guidance: overview.current!.guidance };
const request = (body: unknown = input, origin = "https://fluid.example.invalid") => new Request(`https://fluid.example.invalid/api/projects/${visualProject}/visual-direction`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "https://fluid.example.invalid"); mocks.auth.mockResolvedValue({ userId: visualOwner, client: { rpc: mocks.rpc } }); mocks.rpc.mockResolvedValue({ data: overview, error: null }); });
it("returns only a verified owned review with private headers and checks exact saves", async () => {
  expect((await GET(request(), params)).headers.get("cache-control")).toBe("private, no-store");
  expect((await POST(request(), params)).status).toBe(200);
  expect(mocks.rpc).toHaveBeenLastCalledWith("review_project_visual_direction", { p_project_id: visualProject, p_input: input });
  mocks.rpc.mockResolvedValue({ data: { ...overview, current: { ...overview.current, revision: 7 } }, error: null });
  expect((await POST(request(), params)).status).toBe(503);
  mocks.rpc.mockResolvedValue({ data: visualOverview({ ownerId: visualProject }), error: null });
  expect((await GET(request(), params)).status).toBe(404);
});
it("bounds strict input and requires the configured origin before auth or mutation", async () => {
  expect((await POST(request(input, "https://other.example.invalid"), params)).status).toBe(403);
  expect((await POST(request({ ...input, ownerId: visualOwner }), params)).status).toBe(422);
  expect((await POST(request({ ...input, references: [] }), params)).status).toBe(422);
  expect((await POST(request({ ...input, extra: "x".repeat(32768) }), params)).status).toBe(413);
  expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  expect((await GET(new Request(`${request().url}?ownerId=${visualOwner}`), params)).status).toBe(422);
});
it("sanitizes failed persistence and requires a freshly verified identity", async () => {
  for (const [code, status] of [["PT409", 409], ["P0002", 404], ["42P01", 503]] as const) {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "private database detail" } });
    const response = await POST(request(), params); expect(response.status).toBe(status); expect(await response.text()).not.toContain("database detail");
  }
  mocks.auth.mockRejectedValue(new ApiError("unauthenticated")); expect((await GET(request(), params)).status).toBe(401);
});
