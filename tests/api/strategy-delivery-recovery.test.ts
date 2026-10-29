import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), from: vi.fn(), publish: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: mock.auth }));
vi.mock("@/server/api-text/publication", () => ({ publishApiTextDispatch: mock.publish }));
import { POST } from "@/app/api/projects/[projectId]/strategy/[jobId]/delivery/route";
import { GET } from "@/app/api/projects/[projectId]/strategy/[jobId]/route";
import { GET as overview } from "@/app/api/projects/[projectId]/strategy/route";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const job = { id, owner_id: owner, project_id: project, operation: "strategy.competitors", input_revision: 3, state: "queued",
  progress: 0, reserved_cost_microusd: 122880, actual_cost_microusd: 0, error_code: null, cancel_requested_at: null,
  created_at: "2026-10-20T03:00:00Z", finished_at: null };
const dispatch = { version: 1, jobId: id, policyIdentity: "a".repeat(64), deploymentId: "dpl_original", dispatchIdentity: "b".repeat(64) };
const params = { params: Promise.resolve({ projectId: project, jobId: id }) };
const request = (body: unknown = {}, headers: Record<string, string> = {}) => new Request(`https://fluid.example/api/projects/${project}/strategy/${id}/delivery`, {
  method: "POST", headers: { origin: "https://fluid.example", "content-type": "application/json", "X-Embel-Account": owner, ...headers }, body: JSON.stringify(body),
});
let delivery: unknown[], current: unknown;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "https://fluid.example"); vi.stubEnv("VERCEL", "1");
  current = job; delivery = [{ job, dispatchState: "dispatch_pending", canRetryDelivery: true, dispatch }];
  mock.auth.mockResolvedValue({ userId: owner, client: { rpc: (name: string, args: unknown) => name === "get_strategy_job_summaries" ? Promise.resolve({ data: current ? [current] : [], error: null }) : mock.rpc(name, args), from: mock.from } });
  mock.rpc.mockImplementation(async () => ({ data: delivery, error: null }));
  mock.publish.mockResolvedValue({ state: "published", messageId: "synthetic" });
  mock.from.mockImplementation((table: string) => {
    const query = { select: () => query, eq: () => query, in: () => query, order: () => query, limit: () => query,
      maybeSingle: async () => ({ data: current, error: null }),
      then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: table === "jobs" ? [current] : [], error: null }).then(resolve) };
    return query;
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("explicit exact-job delivery POST", () => {
  it("publishes only the persisted descriptor and returns no worker internals", async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ job: { ...job, dispatchState: "published", canRetryDelivery: false, results: [] } });
    expect(mock.publish).toHaveBeenCalledExactlyOnceWith(dispatch);
    expect(mock.rpc.mock.calls.every(([name, args]) => name === "get_strategy_job_deliveries" && JSON.stringify(args) === JSON.stringify({ p_project_id: project, p_job_ids: [id] }))).toBe(true);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("restores pending delivery capability on read without publishing", async () => {
    const response = await GET(new Request(`https://fluid.example/api/projects/${project}/strategy/${id}`), params);
    expect(await response.json()).toEqual({ job: { ...job, dispatchState: "dispatch_pending", canRetryDelivery: true, results: [] } });
    expect(mock.publish).not.toHaveBeenCalled();
  });
  it("keeps the recovery capability when ordinary new-admission availability is request_active", async () => {
    const availability = { status: "unavailable", reason: "request_active", operations: [] };
    mock.rpc.mockImplementation(async (name: string) => ({ data: name === "get_strategy_availability" ? availability : delivery, error: null }));
    const response = await overview(new Request(`https://fluid.example/api/projects/${project}/strategy`), params);
    expect(await response.json()).toEqual({ availability, jobs: [{ ...job, dispatchState: "dispatch_pending", canRetryDelivery: true, results: [] }] });
    expect(mock.publish).not.toHaveBeenCalled();
  });
  it("reports uncertain delivery honestly and keeps the original job", async () => {
    mock.publish.mockResolvedValue({ state: "dispatch_pending" });
    const response = await POST(request(), params);
    expect(await response.json()).toEqual({ job: { ...job, dispatchState: "dispatch_pending", canRetryDelivery: true, results: [] } });
    expect(mock.publish).toHaveBeenCalledOnce();
  });
  it("returns a concurrent claim without overwriting it as queued", async () => {
    mock.publish.mockImplementation(async () => { current = { ...job, state: "running" }; return { state: "already_processing" }; });
    expect((await (await POST(request(), params)).json()).job.state).toBe("running");
  });
  it("prefers a durable publication receipt over a lost transport acknowledgement", async () => {
    mock.publish.mockImplementation(async () => {
      delivery = [{ job, dispatchState: "published", canRetryDelivery: false, dispatch: null }];
      return { state: "dispatch_pending" };
    });
    expect((await (await POST(request(), params)).json()).job).toMatchObject({ id, dispatchState: "published", canRetryDelivery: false });
    expect(mock.publish).toHaveBeenCalledOnce();
  });
  it("keeps ordinary status readable with no retry capability if the optional RPC is unavailable", async () => {
    mock.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    const response = await GET(new Request(`https://fluid.example/api/projects/${project}/strategy/${id}`), params);
    expect(await response.json()).toEqual({ job: { ...job, results: [] } });
    expect((await POST(request(), params)).status).toBe(503);
    expect(mock.publish).not.toHaveBeenCalled();
  });
  it.each([
    ["missing or terminal", []],
    ["already published", [{ job, dispatchState: "published", canRetryDelivery: false, dispatch: null }]],
    ["stale or issued", [{ job, dispatchState: "dispatch_pending", canRetryDelivery: false, dispatch: null }]],
    ["foreign owner", [{ job: { ...job, owner_id: project }, dispatchState: "dispatch_pending", canRetryDelivery: true, dispatch }]],
    ["foreign project", [{ job: { ...job, project_id: owner }, dispatchState: "dispatch_pending", canRetryDelivery: true, dispatch }]],
    ["different job", [{ job: { ...job, id: project }, dispatchState: "dispatch_pending", canRetryDelivery: true, dispatch }]],
    ["different descriptor", [{ job, dispatchState: "dispatch_pending", canRetryDelivery: true, dispatch: { ...dispatch, jobId: project } }]],
    ["cancelled", [{ job: { ...job, cancel_requested_at: "2026-10-20T03:02:00Z" }, dispatchState: "dispatch_pending", canRetryDelivery: true, dispatch }]],
  ])("refuses %s before publication", async (_name, rows) => {
    delivery = rows;
    expect((await POST(request(), params)).status).toBeGreaterThanOrEqual(400);
    expect(mock.publish).not.toHaveBeenCalled();
  });
  it.each([
    ["another account", {}, { "X-Embel-Account": project }],
    ["foreign origin", {}, { origin: "https://other.example" }],
    ["caller dispatch", { dispatch }, {}],
    ["caller cap/key", { acceptedMaxCostMicrousd: 999999, idempotencyKey: "replacement" }, {}],
  ])("rejects %s without a database recovery read", async (_name, body, headers) => {
    expect((await POST(request(body, headers as Record<string, string>), params)).status).toBeGreaterThanOrEqual(400);
    expect(mock.rpc).not.toHaveBeenCalled(); expect(mock.publish).not.toHaveBeenCalled();
  });
});
