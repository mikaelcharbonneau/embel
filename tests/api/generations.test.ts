import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), start: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: doubles.auth }));
vi.mock("workflow/api", () => ({ start: doubles.start }));
vi.mock("../../src/workflows/probe", () => ({ probeGeneration: function probeGeneration() {} }));
import { POST as startRoute } from "../../src/app/api/projects/[projectId]/generations/route";
import { POST as cancelRoute } from "../../src/app/api/projects/[projectId]/generations/[runId]/cancel/route";
import { GET as creditsRoute } from "../../src/app/api/credits/route";

const origin = "https://fluid.example";
const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const project = "bbbbbbbb-2222-4222-8222-222222222222";
const runId = "cccccccc-3333-4333-8333-333333333333";
const row = (overrides: Record<string, unknown> = {}) => ({
  id: runId, owner_id: owner, project_id: project, kind: "engine.probe", status: "queued", credits: 0,
  workflow_run_id: null, error_code: null, cancel_requested_at: null, created_at: "2026-11-09T20:00:00Z", finished_at: null, ...overrides,
});
const body = { kind: "engine.probe", idempotencyKey: "probe-0123456789abcdef" };
function post(path: string, value: unknown = body, headers: Record<string, string> = {}) {
  return new Request(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
}
const params = () => ({ params: Promise.resolve({ projectId: project }) });
const runParams = () => ({ params: Promise.resolve({ projectId: project, runId }) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", origin);
  doubles.auth.mockResolvedValue({ userId: owner, client: { rpc: doubles.rpc } });
  doubles.rpc.mockResolvedValue({ data: row(), error: null });
  doubles.start.mockResolvedValue({ runId: "wrun_fixture" });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("starting a generation", () => {
  it("admits with the person's own login, then starts the workflow once", async () => {
    const response = await startRoute(post(`/api/projects/${project}/generations`), params());
    expect(response.status).toBe(202);
    const json = await response.json();
    expect(json.run).toMatchObject({ id: runId, status: "queued", outputs: [] });
    expect(json.run).not.toHaveProperty("workflow_run_id");
    expect(doubles.rpc).toHaveBeenCalledWith("start_generation", { p_project_id: project, p_kind: "engine.probe", p_idempotency_key: body.idempotencyKey, p_input: {} });
    expect(doubles.start).toHaveBeenCalledOnce();
    expect(doubles.start.mock.calls[0]![1]).toEqual([runId]);
  });
  it("doesn't start a second workflow for a replay of a started run", async () => {
    doubles.rpc.mockResolvedValueOnce({ data: row({ status: "running", workflow_run_id: "wrun_fixture" }), error: null });
    expect((await startRoute(post(`/api/projects/${project}/generations`), params())).status).toBe(202);
    expect(doubles.start).not.toHaveBeenCalled();
  });
  it("rejects forged origins, unknown kinds and extra fields before admission", async () => {
    expect((await startRoute(post(`/api/projects/${project}/generations`, body, { origin: "https://evil.invalid" }), params())).status).toBe(403);
    expect((await startRoute(post(`/api/projects/${project}/generations`, { ...body, kind: "strategy.competitors" }), params())).status).toBe(503);
    expect((await startRoute(post(`/api/projects/${project}/generations`, { ...body, ownerId: owner }), params())).status).toBe(422);
    expect(doubles.rpc).not.toHaveBeenCalled();
  });
  it.each([
    ["insufficient_credits", 402], ["daily_limit", 429], ["generation_active", 409], ["generation_paused", 503], ["not_found", 404], ["idempotency_conflict", 409],
  ])("maps %s from the database to %i without leaking details", async (message, status) => {
    doubles.rpc.mockResolvedValueOnce({ data: null, error: { message, code: "P0001", details: "private detail" } });
    const response = await startRoute(post(`/api/projects/${project}/generations`), params());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private");
    expect(doubles.start).not.toHaveBeenCalled();
  });
  it("reports a workflow that failed to start as unavailable", async () => {
    doubles.start.mockRejectedValueOnce(new Error("private queue outage"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await startRoute(post(`/api/projects/${project}/generations`), params());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
  it("refuses a run that belongs to someone else", async () => {
    doubles.rpc.mockResolvedValueOnce({ data: row({ owner_id: "dddddddd-4444-4444-8444-444444444444" }), error: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await startRoute(post(`/api/projects/${project}/generations`), params())).status).toBe(503);
    expect(doubles.start).not.toHaveBeenCalled();
  });
});

describe("cancelling and credits", () => {
  it("cancels through the owner's own login", async () => {
    doubles.rpc.mockResolvedValueOnce({ data: row({ status: "cancelled", cancel_requested_at: "2026-11-09T20:01:00Z" }), error: null });
    const response = await cancelRoute(post(`/api/projects/${project}/generations/${runId}/cancel`, {}), runParams());
    expect((await response.json()).run).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(doubles.rpc).toHaveBeenCalledWith("cancel_generation", { p_run_id: runId });
  });
  it("returns the plan, balance and renewal date", async () => {
    doubles.rpc.mockResolvedValueOnce({ data: { planId: "free", balance: 30, periodEnd: "2026-12-01T00:00:00Z" }, error: null });
    expect(await (await creditsRoute()).json()).toEqual({ credits: { planId: "free", balance: 30, periodEnd: "2026-12-01T00:00:00Z" } });
  });
});
