import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), lookup: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock("@/server/standalone-providers/live-runtime", () => ({ runStandaloneLookup: mocks.lookup }));
import { GET, POST } from "@/app/api/projects/[projectId]/screening/route";
import { POST as CHECK } from "@/app/api/projects/[projectId]/screening/check/route";
import { ApiError } from "@/server/http/errors";
import {
  screeningBasis,
  screeningInput,
  screeningOwner,
  screeningPage,
  screeningProject,
  screeningRecord,
} from "../fixtures/project-screening";
const params = () => ({ params: Promise.resolve({ projectId: screeningProject }) });
const request = (body?: unknown, path = "", origin = "https://fluid.example") =>
  new Request(`https://fluid.example/api/projects/${screeningProject}/screening${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const checkInput = {
  selectionId: screeningInput.selectionId,
  expectedProjectRevision: 2,
  criteria: screeningInput.criteria,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", "https://fluid.example");
  mocks.auth.mockResolvedValue({ userId: screeningOwner, client: { rpc: mocks.rpc } });
  mocks.rpc.mockImplementation(async (name: string) => ({
    error: null,
    data: name === "get_project_screening" ? screeningPage : screeningRecord,
  }));
  mocks.lookup.mockResolvedValue({ status: "failed", code: "unavailable", retryAfterSeconds: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
describe("project screening authenticated API", () => {
  it("reads private owner records and records only reviewed notes with exact RPC arguments", async () => {
    const response = await GET(request(), params());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await POST(request(screeningInput), params())).status).toBe(200);
    expect(mocks.rpc).toHaveBeenLastCalledWith("record_project_screening", {
      p_project_id: screeningProject,
      p_input: screeningInput,
    });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("authenticates live access, fences current context before/after providers and does not persist a result", async () => {
    const response = await CHECK(request(checkInput), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      basis: screeningBasis,
      result: { status: "failed", code: "unavailable" },
    });
    expect(mocks.rpc.mock.calls.map((call) => call[0])).toEqual(["get_project_screening", "get_project_screening"]);
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith(
      screeningOwner,
      screeningInput.criteria,
      expect.any(AbortSignal),
    );
    mocks.rpc.mockResolvedValueOnce({ error: null, data: { ...screeningPage, currentBasis: null } });
    expect((await CHECK(request(checkInput), params())).status).toBe(409);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it("discards an in-flight result if selection/context changes", async () => {
    mocks.rpc.mockResolvedValueOnce({ error: null, data: screeningPage }).mockResolvedValueOnce({
      error: null,
      data: { ...screeningPage, projectRevision: 3, currentBasis: { ...screeningBasis, projectRevision: 3 } },
    });
    expect((await CHECK(request(checkInput), params())).status).toBe(409);
    expect(mocks.rpc.mock.calls.some((call) => call[0] === "record_project_screening")).toBe(false);
  });
  it("rejects forged evidence, owners, cursors, missing consent and foreign origins before writes", async () => {
    for (const extra of [
      { providerResult: { availability: "available" } },
      { ownerId: screeningRecord.id },
      { verification: "verified" },
      { acknowledged: false },
    ])
      expect((await POST(request({ ...screeningInput, ...extra }), params())).status).toBe(422);
    expect((await POST(request(screeningInput, "", "https://foreign.example"), params())).status).toBe(403);
    expect((await GET(request(undefined, "?ownerId=forged"), params())).status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("fails closed on another owner's database response and a mismatched stored intent", async () => {
    mocks.rpc.mockResolvedValueOnce({
      error: null,
      data: { ...screeningPage, ownerId: screeningRecord.id, currentBasis: null },
    });
    expect((await GET(request(), params())).status).toBe(404);
    mocks.rpc.mockResolvedValueOnce({ error: null, data: { ...screeningRecord, notes: "Other notes" } });
    expect((await POST(request(screeningInput), params())).status).toBe(503);
  });
  it("rejects unauthorized reads, wrong selected mark, oversized and unsupported bodies", async () => {
    mocks.auth.mockRejectedValueOnce(new ApiError("unauthenticated"));
    expect((await GET(request(), params())).status).toBe(401);
    expect(
      (
        await CHECK(
          request({
            ...checkInput,
            criteria: { tool: "trademarks", mark: "Other", mode: "exact_word", jurisdictions: ["EM"], niceClasses: [] },
          }),
          params(),
        )
      ).status,
    ).toBe(422);
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect((await POST(request({ ...screeningInput, notes: "x".repeat(33000) }), params())).status).toBe(413);
  });
  it.each([
    ["PT409", 409],
    ["P0002", 404],
    ["22023", 422],
    ["08006", 503],
  ])("maps database errors without private details (%s)", async (code, status) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "sensitive database detail" } });
    const response = await POST(request(screeningInput), params());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("sensitive");
  });
});
