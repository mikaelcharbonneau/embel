import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { DEFAULT_SUBSCRIPTION_LIMITS } from "../../src/domain/strategy-jobs";

vi.mock("server-only", () => ({}));
const doubles = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), summaries: vi.fn(), from: vi.fn(), eq: vi.fn(), select: vi.fn(), within: vi.fn(), publish: vi.fn(), readiness: vi.fn() }));
vi.mock("../../src/server/api-text/publication", () => ({ publishApiTextDispatch: doubles.publish }));
vi.mock("../../src/server/api-text/readiness", () => ({ getApiTextWorkerReadiness: doubles.readiness }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: doubles.auth }));
import { GET as overview, POST as enqueue } from "../../src/app/api/projects/[projectId]/strategy/route";
import { GET as getJob, DELETE as cancel } from "../../src/app/api/projects/[projectId]/strategy/[jobId]/route";
import { POST as apply } from "../../src/app/api/projects/[projectId]/strategy/[jobId]/apply/route";
import { GET as runtime } from "../../src/app/api/strategy/route";
import { ApiError } from "../../src/server/http/errors";
import { enqueueStrategyJob, getStrategyAvailability } from "../../src/server/data/strategy-jobs";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const context = contextSnapshotSchema.parse({ description: "Explicit local API fixture." });
const job = {
  id: jobId, owner_id: ownerId, project_id: projectId, operation: "strategy.reformulate", input_revision: 1, state: "queued", progress: 0,
  reserved_cost_microusd: 122_880, actual_cost_microusd: 0, error_code: null, cancel_requested_at: null,
  created_at: "2026-10-03T12:00:00Z", finished_at: null,
};
const output = {
  version: 1, operation: "strategy.reformulate", provider: "openai", model: "fixture-model", responseId: "local-fixture-response", requestId: null, generatedAt: "2026-10-03T12:00:00Z",
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 },
  proposal: { message: "Explicit local result fixture, not live output", activity: "Fixture activity", offering: "Fixture offering", knownAudience: "", questions: [] },
};
const resultStep = { job_id: jobId, owner_id: ownerId, project_id: projectId, step_key: "proposal", state: "succeeded", output };
const application = { jobId, stepKey: "proposal", inputRevision: 1, appliedRevision: 2, appliedAt: "2026-10-04T12:00:00Z" };
const applicationRow = { job_id: jobId, step_key: "proposal", owner_id: ownerId, project_id: projectId, input_revision: 1, applied_revision: 2, applied_at: application.appliedAt };
const available = { status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 122_880 }] };
const dispatch = { version: 1, jobId, policyIdentity: "a".repeat(64), deploymentId: "dpl_synthetic", dispatchIdentity: "b".repeat(64) };
const enqueueInput = { operation: "strategy.reformulate", expectedRevision: 1, idempotencyKey: "local-api-request-0001", acceptedMaxCostMicrousd: 122_880 };
const params = (project = projectId, id = jobId) => ({ params: Promise.resolve({ projectId: project, jobId: id }) });
function request(body?: unknown, method = "POST", headers?: Record<string, string>) {
  return new Request(`https://fluid.example/api/projects/${projectId}/strategy`, {
    method, headers: { origin: "https://fluid.example", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("strategy API authorization, bounded inputs and actual durable outputs", () => {
  let rows: { jobs: unknown[]; job_steps: unknown[]; strategy_job_applications: unknown[] };
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("APP_ORIGIN", "https://fluid.example");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt");
    vi.stubEnv("FLUID_API_TEXT_WORKER_ORIGIN", "https://fluid-api-text-worker-qualified.vercel.app");
    rows = { jobs: [job], job_steps: [], strategy_job_applications: [] };
    doubles.auth.mockResolvedValue({ userId: ownerId, client: { rpc: (name: string, args: { p_job_id?: string | null }) => name === "get_strategy_job_summaries" ? doubles.summaries(args) : doubles.rpc(name, args), from: doubles.from } });
    doubles.rpc.mockImplementation(async (name: string) => ({ data: name === "get_strategy_availability" ? available : { ...job, dispatch }, error: null }));
    doubles.summaries.mockImplementation(async (args: { p_job_id: string | null }) => ({ data: args.p_job_id === null ? rows.jobs : rows.jobs.slice(0, 1), error: null }));
    doubles.publish.mockResolvedValue({ state: "published", messageId: "synthetic_queue_message" });
    doubles.readiness.mockResolvedValue({ version: 1, deploymentId: "dpl_synthetic", operations: ["strategy.reformulate"] });
    doubles.from.mockImplementation((table: keyof typeof rows) => {
      const query = {
        select: (columns: string) => { doubles.select(table, columns); return query; },
        eq: (field: string, value: unknown) => { doubles.eq(table, field, value); return query; },
        in: (field: string, value: unknown) => { doubles.within(table, field, value); return query; },
        order: () => query, limit: () => query,
        maybeSingle: async () => ({ data: rows[table][0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve({ data: rows[table], error: null }).then(resolve, reject),
      };
      return query;
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("uses the separate policy-bound managed uncapped admission without a dollar field", async () => {
    const identity = "e".repeat(64);
    const input = { operation: "strategy.reformulate", expectedRevision: 1, idempotencyKey: "strategy.managed.v3.inert0001", billingMode: "openai_api", spendControl: "uncapped", acceptedPolicyIdentity: identity };
    doubles.rpc.mockResolvedValueOnce({ data: { ...job, billingMode: "openai_api", spendControl: "uncapped", policyIdentity: identity, dispatch }, error: null });
    const response = await enqueue(request(input), params());
    expect(response.status).toBe(202);
    expect(doubles.rpc.mock.calls[0]).toEqual(["enqueue_managed_strategy_job", { p_project_id: projectId, p_expected_revision: 1, p_operation: "strategy.reformulate", p_idempotency_key: input.idempotencyKey, p_accepted_policy_identity: identity }]);
    expect((await response.json()).job).toMatchObject({ billingMode: "openai_api", spendControl: "uncapped", policyIdentity: identity });
  });

  it("does not fall back to bounded admission when the managed contract is unavailable", async () => {
    doubles.rpc.mockResolvedValue({ data: null, error: { code: "42883" } });
    const input = { operation: "strategy.reformulate", expectedRevision: 1, idempotencyKey: "strategy.managed.v3.inert0001", billingMode: "openai_api", spendControl: "uncapped", acceptedPolicyIdentity: "e".repeat(64) };
    const response = await enqueue(request(input), params());
    expect(response.status).toBe(503);
    expect(doubles.rpc.mock.calls.map(([name]) => name)).toEqual(["enqueue_managed_strategy_job"]);
    expect(doubles.publish).not.toHaveBeenCalled();
  });

  it("uses SQL managed readiness without substituting legacy aggregate worker readiness", async () => {
    const configured = { status: "available", operations: [{ operation: "strategy.reformulate", billingMode: "openai_api", spendControl: "uncapped", policyIdentity: "e".repeat(64), interviewVersion: 1 }] };
    doubles.rpc.mockResolvedValueOnce({ data: configured, error: null });
    expect(await getStrategyAvailability(await doubles.auth(), projectId)).toEqual(configured);
    expect(doubles.readiness).not.toHaveBeenCalled();
  });

  it("roundtrips owned v3 summaries using only projected metadata on both list and single-job reads", async () => {
    const identity = "e".repeat(64);
    rows.jobs = [{ ...job, state: "succeeded", input_version: 3, input_spend_control: "uncapped", input_policy_identity: identity }];
    const list = await overview(request(undefined, "GET"), params());
    expect(list.status).toBe(200);
    expect((await list.json()).jobs[0]).toMatchObject({ id: jobId, billingMode: "openai_api", spendControl: "uncapped", policyIdentity: identity });
    const single = await getJob(request(undefined, "GET"), params());
    expect(single.status).toBe(200);
    const payload = await single.json();
    expect(payload.job).toMatchObject({ id: jobId, billingMode: "openai_api", spendControl: "uncapped", policyIdentity: identity });
    expect(payload.job).not.toHaveProperty("input"); expect(payload.job).not.toHaveProperty("input_version");
    expect(doubles.summaries).toHaveBeenNthCalledWith(1, { p_project_id: projectId, p_job_id: null });
    expect(doubles.summaries).toHaveBeenNthCalledWith(2, { p_project_id: projectId, p_job_id: jobId });
    expect(doubles.select.mock.calls.some(([table]) => table === "jobs")).toBe(false);
  });

  it("returns an empty shared overview without ever selecting raw job input", async () => {
    vi.stubEnv("EMBEL_SHARED_WORKERS_ENABLED", "true");
    rows.jobs = [];
    const configured = { status: "available", operations: ["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality"].map(operation => ({ operation, billingMode: "openai_api", spendControl: "uncapped", policyIdentity: "e".repeat(64), interviewVersion: 1 })) };
    doubles.rpc.mockResolvedValue({ data: configured, error: null });
    const response = await overview(request(undefined, "GET"), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ availability: configured, jobs: [] });
    expect(doubles.rpc).toHaveBeenCalledExactlyOnceWith("get_shared_strategy_availability", { p_project_id: projectId });
    expect(doubles.summaries).toHaveBeenCalledExactlyOnceWith({ p_project_id: projectId, p_job_id: null });
    expect(doubles.from).not.toHaveBeenCalled();
    expect(doubles.publish).not.toHaveBeenCalled();
  });

  it.each(["42501", "PGRST202"])("does not fall back to raw input when metadata RPC fails (%s)", async code => {
    doubles.summaries.mockResolvedValue({ data: null, error: { code } });
    expect((await getJob(request(undefined, "GET"), params())).status).toBe(503);
    expect(doubles.from).not.toHaveBeenCalled();
  });

  it("refuses multiple results for an exact-job read", async () => {
    doubles.summaries.mockResolvedValue({ data: [job, job], error: null });
    expect((await getJob(request(undefined, "GET"), params())).status).toBe(503);
  });

  it("refuses malformed projected v3 metadata instead of relabelling it as a bounded job", async () => {
    rows.jobs = [{ ...job, state: "succeeded", input_version: 3, input_spend_control: "uncapped", input_policy_identity: null }];
    const response = await getJob(request(undefined, "GET"), params());
    expect(response.status).toBe(503);
  });

  it("rejects a request mixing new uncapped authority and a dollar consent", async () => {
    const response = await enqueue(request({ ...enqueueInput, billingMode: "openai_api", spendControl: "uncapped", acceptedPolicyIdentity: "e".repeat(64) }), params());
    expect(response.status).toBe(422); expect(doubles.rpc).not.toHaveBeenCalled();
  });

  it("uses the explicit local database witness and durable admission without hosted publication", async () => {
    for (const key of Object.keys(process.env)) if (key === "VERCEL" || key.startsWith("VERCEL_")) vi.stubEnv(key, undefined);
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("FLUID_RUNTIME", "local"); vi.stubEnv("FLUID_LOCAL_PROTOTYPE", "true"); vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3106");
    doubles.rpc.mockImplementation(async (name: string) => ({ data: name === "get_local_strategy_availability" ? available : job, error: null }));
    const auth = await doubles.auth();
    expect(await getStrategyAvailability(auth, projectId)).toEqual(available);
    expect(await enqueueStrategyJob(auth, projectId, enqueueInput)).toEqual({ ...job, results: [] });
    expect(doubles.rpc.mock.calls.map(([name]) => name)).toEqual(["get_local_strategy_availability", "enqueue_local_strategy_job"]);
    expect(doubles.publish).not.toHaveBeenCalled(); expect(doubles.readiness).not.toHaveBeenCalled();
  });

  it("enqueues only the authenticated revision-bound request and returns sanitized durable status", async () => {
    doubles.rpc.mockResolvedValueOnce({ data: { ...job, dispatch, lease_token: "private-fencing-token", input: { secret: "never expose" } }, error: null });
    const response = await enqueue(request(enqueueInput), params());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ job: { ...job, dispatchState: "published", results: [] } });
    expect(doubles.rpc).toHaveBeenCalledExactlyOnceWith("enqueue_strategy_job", {
      p_project_id: projectId, p_expected_revision: 1, p_operation: "strategy.reformulate", p_idempotency_key: enqueueInput.idempotencyKey, p_accepted_max_cost_microusd: 122_880,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("publishes only the owner-verified admitted message and preserves pending publication honestly", async () => {
    doubles.publish.mockResolvedValueOnce({ state: "dispatch_pending" });
    const response = await enqueue(request(enqueueInput), params());
    expect(response.status).toBe(202);
    expect((await response.json()).job).toMatchObject({ id: jobId, state: "queued", dispatchState: "dispatch_pending" });
    expect(doubles.publish).toHaveBeenCalledExactlyOnceWith(dispatch);
  });

  it("never publishes a foreign or malformed admitted descriptor", async () => {
    for (const malformed of [{ ...dispatch, jobId: otherOwner }, { ...dispatch, prompt: "untrusted" }, undefined]) {
      doubles.rpc.mockResolvedValueOnce({ data: { ...job, dispatch: malformed }, error: null });
      expect((await enqueue(request(enqueueInput), params())).status).toBe(503);
    }
    expect(doubles.publish).not.toHaveBeenCalled();
  });

  it("a publication exception preserves the admitted job for exact replay and repair", async () => {
    doubles.publish.mockRejectedValueOnce(new Error("private transport detail"));
    const response = await enqueue(request(enqueueInput), params());
    expect(response.status).toBe(202);
    expect((await response.json()).job.dispatchState).toBe("dispatch_pending");
  });

  it("terminal historical API replay needs no new publication", async () => {
    doubles.rpc.mockResolvedValueOnce({ data: { ...job, state: "failed" }, error: null });
    const response = await enqueue(request(enqueueInput), params());
    expect(response.status).toBe(202);
    expect((await response.json()).job.state).toBe("failed");
    expect(doubles.publish).not.toHaveBeenCalled();
  });

  it.each([{ ownerId }, { model: "unapproved" }, { context }, { output }, { policy: {} }, { expectedRevision: 0 }, { acceptedMaxCostMicrousd: -1 }, { operation: "identity.image" }])("rejects untrusted enqueue field %j before any database mutation", async extra => {
    expect((await enqueue(request({ ...enqueueInput, ...extra }), params())).status).toBe(422);
    expect(doubles.rpc).not.toHaveBeenCalled();
  });

  it("enforces origin, streamed body limit, verified auth and resource identifiers", async () => {
    expect((await enqueue(request(enqueueInput, "POST", { origin: "https://foreign.example" }), params())).status).toBe(403);
    expect(doubles.auth).not.toHaveBeenCalled();
    expect((await enqueue(request("x".repeat(2049)), params())).status).toBe(413);
    expect((await enqueue(request(enqueueInput, "POST", { "content-type": "text/plain" }), params())).status).toBe(422);
    doubles.auth.mockRejectedValueOnce(new ApiError("unauthenticated"));
    expect((await enqueue(request(enqueueInput), params())).status).toBe(401);
    expect((await enqueue(request(enqueueInput), params("bad-id"))).status).toBe(404);
    expect(doubles.rpc).not.toHaveBeenCalled();
  });

  it.each([["P0002", 404], ["40001", 409], ["PT409", 409], ["23505", 409], ["22023", 422], ["P0001", 503], ["08006", 503]] as const)("maps SQL %s to safe %i without leaking diagnostics", async (code, status) => {
    doubles.rpc.mockResolvedValue({ data: null, error: { code, message: "private-provider-database-details" } });
    const response = await enqueue(request(enqueueInput), params());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private-provider-database-details");
  });

  it("reads pre-project availability through verified auth and owner-bound project availability", async () => {
    const response = await runtime();
    expect(await response.json()).toEqual({ availability: available });
    expect(doubles.rpc).toHaveBeenCalledWith("get_strategy_availability", { p_project_id: null });
    const projectResponse = await overview(request(undefined, "GET"), params());
    expect(await projectResponse.json()).toEqual({ availability: available, jobs: [{ ...job, results: [] }] });
    expect(doubles.rpc).toHaveBeenCalledWith("get_strategy_availability", { p_project_id: projectId });
    expect(doubles.summaries).toHaveBeenCalledWith({ p_project_id: projectId, p_job_id: null });
    doubles.auth.mockRejectedValueOnce(new ApiError("unauthenticated"));
    expect((await runtime()).status).toBe(401);
  });

  it.each([
    ["FLUID_API_TEXT_WORKER_ORIGIN", ""], ["FLUID_API_TEXT_WORKER_ORIGIN", "https://foreign.example"],
    ["VERCEL_PROJECT_ID", "prj_other"], ["VERCEL_ENV", "development"], ["VERCEL_TARGET_ENV", "preview"],
  ])("hides API readiness when the publisher configuration is unavailable (%s)", async (key, value) => {
    vi.stubEnv(key, value);
    const unavailable = { status: "unavailable", operations: [], reason: "worker_unavailable" };
    expect(await (await runtime()).json()).toEqual({ availability: unavailable });
    expect(await (await overview(request(undefined, "GET"), params())).json()).toEqual({ availability: unavailable, jobs: [{ ...job, results: [] }] });
    expect(doubles.publish).not.toHaveBeenCalled();
  });

  it("keeps ready subscription operations when API publication is unconfigured", async () => {
    vi.stubEnv("FLUID_API_TEXT_WORKER_ORIGIN", "");
    const subscription = { operation: "strategy.audience", billingMode: "chatgpt_subscription", policyIdentity: "a".repeat(64), limits: DEFAULT_SUBSCRIPTION_LIMITS };
    for (const operations of [[subscription], [...available.operations, subscription]]) {
      doubles.rpc.mockResolvedValueOnce({ data: { status: "available", operations }, error: null });
      expect(await (await runtime()).json()).toEqual({ availability: { status: "available", operations: [subscription] } });
    }
  });

  it.each([null, { version: 1, deploymentId: "dpl_synthetic", operations: [] }])("hides API operations when the configured worker is not qualified (%j)", async readiness => {
    doubles.readiness.mockResolvedValue(readiness);
    const unavailable = { status: "unavailable", operations: [], reason: "worker_unavailable" };
    expect(await (await runtime()).json()).toEqual({ availability: unavailable });
    expect(await (await overview(request(undefined, "GET"), params())).json()).toEqual({ availability: unavailable, jobs: [{ ...job, results: [] }] });
    expect(doubles.publish).not.toHaveBeenCalled();
  });

  it("intersects worker qualification with caller eligibility without altering costs or subscription operations", async () => {
    const audience = { operation: "strategy.audience", maximumCostMicrousd: 44_000, billingMode: "openai_api" };
    const subscription = { operation: "strategy.personality", billingMode: "chatgpt_subscription", policyIdentity: "a".repeat(64), limits: DEFAULT_SUBSCRIPTION_LIMITS };
    doubles.rpc.mockResolvedValueOnce({ data: { status: "available", operations: [...available.operations, audience, subscription] }, error: null });
    doubles.readiness.mockResolvedValueOnce({ version: 1, deploymentId: "dpl_synthetic", operations: ["strategy.audience", "strategy.positioning"] });
    expect(await (await runtime()).json()).toEqual({ availability: { status: "available", operations: [audience, subscription] } });
    expect(doubles.rpc).toHaveBeenCalledExactlyOnceWith("get_strategy_availability", { p_project_id: null });
  });

  it("preserves subscription readiness when the API worker is unreachable", async () => {
    const subscription = { operation: "strategy.audience", billingMode: "chatgpt_subscription", policyIdentity: "a".repeat(64), limits: DEFAULT_SUBSCRIPTION_LIMITS };
    doubles.rpc.mockResolvedValueOnce({ data: { status: "available", operations: [...available.operations, subscription] }, error: null });
    doubles.readiness.mockResolvedValueOnce(null);
    expect(await (await runtime()).json()).toEqual({ availability: { status: "available", operations: [subscription] } });
  });

  it("does not probe the API worker for a SQL refusal or subscription-only availability", async () => {
    const unavailable = { status: "unavailable", operations: [], reason: "budget_unavailable" };
    doubles.rpc.mockResolvedValueOnce({ data: unavailable, error: null });
    expect(await (await runtime()).json()).toEqual({ availability: unavailable });
    const subscription = { operation: "strategy.audience", billingMode: "chatgpt_subscription", policyIdentity: "a".repeat(64), limits: DEFAULT_SUBSCRIPTION_LIMITS };
    doubles.rpc.mockResolvedValueOnce({ data: { status: "available", operations: [subscription] }, error: null });
    expect(await (await runtime()).json()).toEqual({ availability: { status: "available", operations: [subscription] } });
    expect(doubles.readiness).not.toHaveBeenCalled();
  });

  it("preserves a database readiness refusal and does not use web provider credentials as worker readiness", async () => {
    vi.stubEnv("FLUID_PAID_CALLS_APPROVED", "false");
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(await (await runtime()).json()).toEqual({ availability: available });
    vi.stubEnv("FLUID_API_TEXT_WORKER_ORIGIN", "");
    const unavailable = { status: "unavailable", operations: [], reason: "budget_unavailable" };
    doubles.rpc.mockResolvedValueOnce({ data: unavailable, error: null });
    expect(await (await runtime()).json()).toEqual({ availability: unavailable });
  });

  it("retains an admitted pending request and its exact replay while publication is unconfigured", async () => {
    vi.stubEnv("FLUID_API_TEXT_WORKER_ORIGIN", "");
    doubles.readiness.mockResolvedValue(null);
    doubles.publish.mockResolvedValue({ state: "dispatch_pending" });
    for (let replay = 0; replay < 2; replay += 1) {
      const response = await enqueue(request(enqueueInput), params());
      expect(response.status).toBe(202);
      expect((await response.json()).job).toMatchObject({ id: jobId, state: "queued", dispatchState: "dispatch_pending" });
    }
    expect(doubles.rpc.mock.calls[0]).toEqual(doubles.rpc.mock.calls[1]);
    expect(doubles.publish).toHaveBeenNthCalledWith(1, dispatch);
    expect(doubles.publish).toHaveBeenNthCalledWith(2, dispatch);
    expect(doubles.readiness).not.toHaveBeenCalled();
  });

  it("returns preserved partial output from owned successful steps and filters every boundary", async () => {
    rows.jobs = [{ ...job, state: "partial", progress: 40 }];
    rows.job_steps = [resultStep];
    const response = await getJob(request(undefined, "GET"), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ job: { ...job, state: "partial", progress: 40, results: [{ stepKey: "proposal", output }] } });
    expect(doubles.eq).toHaveBeenCalledWith("job_steps", "owner_id", ownerId);
    expect(doubles.eq).toHaveBeenCalledWith("job_steps", "project_id", projectId);
    expect(doubles.within).toHaveBeenCalledWith("job_steps", "job_id", [jobId]);
    expect(doubles.eq).toHaveBeenCalledWith("job_steps", "state", "succeeded");
    expect(doubles.select.mock.calls.some(([table, columns]) => table === "jobs" && String(columns).includes("lease_token"))).toBe(false);
  });

  it.each([{ owner_id: otherOwner }, { project_id: "33333333-3333-4333-8333-333333333333" }, { id: "33333333-3333-4333-8333-333333333333" }])("rejects mismatched job response %j before using it", async mismatch => {
    rows.jobs = [{ ...job, ...mismatch }];
    expect((await getJob(request(undefined, "GET"), params())).status).toBe(404);
  });

  it("refuses foreign/malformed result rows rather than displaying forged AI output", async () => {
    rows.job_steps = [{ ...resultStep, owner_id: otherOwner }];
    expect((await getJob(request(undefined, "GET"), params())).status).toBe(404);
    rows.job_steps = [{ ...resultStep, output: { ...output, operation: "strategy.competitors" } }];
    expect((await getJob(request(undefined, "GET"), params())).status).toBe(503);
  });

  it("recovers the exact server-owned application with the durable result after a lost apply response", async () => {
    rows.jobs = [{ ...job, state: "succeeded", progress: 100 }];
    rows.job_steps = [resultStep];
    rows.strategy_job_applications = [applicationRow];
    const response = await getJob(request(undefined, "GET"), params());
    expect(response.status).toBe(200);
    expect((await response.json()).job.results).toEqual([{ stepKey: "proposal", output, application }]);
    expect(doubles.eq).toHaveBeenCalledWith("strategy_job_applications", "owner_id", ownerId);
    expect(doubles.eq).toHaveBeenCalledWith("strategy_job_applications", "project_id", projectId);
    expect(doubles.within).toHaveBeenCalledWith("strategy_job_applications", "job_id", [jobId]);
  });

  it.each([
    [{ owner_id: otherOwner }, 404], [{ project_id: otherOwner }, 404], [{ job_id: otherOwner }, 404],
    [{ step_key: "different" }, 503], [{ input_revision: 2, applied_revision: 3 }, 503],
    [{ applied_revision: 3 }, 503], [{ applied_at: "not-a-date" }, 503],
  ])("refuses mismatched or malformed application rows %j", async (mismatch, status) => {
    rows.job_steps = [resultStep];
    rows.strategy_job_applications = [{ ...applicationRow, ...mismatch }];
    expect((await getJob(request(undefined, "GET"), params())).status).toBe(status);
  });

  it("rejects duplicated receipts instead of arbitrarily choosing proof", async () => {
    rows.job_steps = [resultStep];
    rows.strategy_job_applications = [applicationRow, applicationRow];
    expect((await getJob(request(undefined, "GET"), params())).status).toBe(503);
  });

  it("cancels only after verifying the job/project binding and returns actual cancel state with partials", async () => {
    rows.jobs = [];
    expect((await cancel(request(undefined, "DELETE"), params())).status).toBe(404);
    expect(doubles.rpc).not.toHaveBeenCalled();
    rows.jobs = [{ ...job, state: "running" }];
    rows.job_steps = [resultStep];
    doubles.rpc.mockImplementation(async () => {
      rows.jobs = [{ ...job, state: "cancel_requested" }];
      return { data: { lease_token: "never serialized" }, error: null };
    });
    const response = await cancel(request(undefined, "DELETE"), params());
    expect(doubles.rpc).toHaveBeenCalledExactlyOnceWith("request_job_cancel", { p_job_id: jobId });
    expect(await response.json()).toEqual({ job: { ...job, state: "cancel_requested", results: [{ stepKey: "proposal", output }] } });
  });

  it("applies a server-owned step only, preserves revision guard and rejects submitted output", async () => {
    rows.jobs = [{ ...job, state: "succeeded", progress: 100 }];
    rows.job_steps = [resultStep];
    const project = { id: projectId, owner_id: ownerId, scope: "complete_brand", title: "Local fixture", current_revision: 2, created_at: job.created_at, context };
    doubles.rpc.mockResolvedValue({ data: { project, application }, error: null });
    const response = await apply(request({ expectedRevision: 1, stepKey: "proposal" }), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ project, application });
    expect(doubles.rpc).toHaveBeenCalledExactlyOnceWith("apply_strategy_job_result_v2", { p_project_id: projectId, p_job_id: jobId, p_expected_revision: 1, p_step_key: "proposal" });
    doubles.rpc.mockClear();
    expect((await apply(request({ expectedRevision: 2, stepKey: "proposal" }), params())).status).toBe(409);
    expect((await apply(request({ expectedRevision: 1, stepKey: "unknown" }), params())).status).toBe(404);
    expect((await apply(request({ expectedRevision: 1, stepKey: "proposal", output }), params())).status).toBe(422);
    expect(doubles.rpc).not.toHaveBeenCalled();
  });

  it.each([
    undefined, { ...application, jobId: otherOwner }, { ...application, stepKey: "wrong-step" },
    { ...application, inputRevision: 2, appliedRevision: 3 }, { ...application, appliedRevision: 3 },
  ])("rejects absent or mismatched RPC application proof %j", async invalidApplication => {
    rows.job_steps = [resultStep];
    const project = { id: projectId, owner_id: ownerId, scope: "complete_brand", title: "Local fixture", current_revision: 2, created_at: job.created_at, context };
    doubles.rpc.mockResolvedValue({ data: { project, application: invalidApplication }, error: null });
    expect((await apply(request({ expectedRevision: 1, stepKey: "proposal" }), params())).status).toBe(503);
  });

  it.each([["40001", 500], ["40001", 503], ["PT409", 409]])("maps apply SQLSTATE %s and upstream HTTP %i to conflict", async (code, status) => {
    vi.stubEnv("FLUID_RUNTIME", "local");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rows.job_steps = [resultStep];
    doubles.rpc.mockResolvedValue({ data: null, error: { code, message: "private-database-message" }, status });
    const response = await apply(request({ expectedRevision: 1, stepKey: "proposal" }), params());
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("private-database-message");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { code: "", status: 0, codeType: "string", safeCode: "unrecognized", safeStatus: 0 },
    { code: undefined, status: 500, codeType: "undefined", safeCode: "unrecognized", safeStatus: 500 },
    { code: null, status: 503, codeType: "null", safeCode: "unrecognized", safeStatus: 503 },
    { code: 40001, status: 500, codeType: "number", safeCode: "unrecognized", safeStatus: 500 },
    { code: "PGRST000", status: 503, codeType: "string", safeCode: "PGRST000", safeStatus: 503 },
    { code: "private-error-code", status: "private-status", codeType: "string", safeCode: "unrecognized", safeStatus: null },
    { code: { toString: () => { throw new Error("must not stringify unknown code"); } }, status: NaN, codeType: "object", safeCode: "unrecognized", safeStatus: null },
  ])("classifies unavailable apply RPC responses locally without serializing private data: $codeType/$safeStatus", async sample => {
    vi.stubEnv("FLUID_RUNTIME", "local");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rows.job_steps = [resultStep];
    doubles.rpc.mockResolvedValue({ data: "private-response-body", error: {
      code: sample.code, message: "private-database-message", details: "private-details", headers: { authorization: "private-header" },
    }, status: sample.status });
    const response = await apply(request({ expectedRevision: 1, stepKey: "proposal" }), params());
    expect(response.status).toBe(503);
    expect(warn).toHaveBeenCalledExactlyOnceWith("[fluid:strategy]", {
      stage: "apply_rpc", codeType: sample.codeType, code: sample.safeCode, status: sample.safeStatus,
    });
    expect(await response.text()).not.toContain("private-");
  });

  it.each([
    { runtime: "", vercel: "" }, { runtime: "local", vercel: "1" },
  ])("suppresses diagnostics outside the local runtime: $runtime/$vercel", async env => {
    vi.stubEnv("FLUID_RUNTIME", env.runtime);
    vi.stubEnv("VERCEL", env.vercel);
    vi.stubEnv("VERCEL_ENV", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rows.job_steps = [resultStep];
    doubles.rpc.mockResolvedValue({ data: null, error: { code: "PGRST000" }, status: 503 });
    expect((await apply(request({ expectedRevision: 1, stepKey: "proposal" }), params())).status).toBe(503);
    expect(warn).not.toHaveBeenCalled();
  });

  it("distinguishes failed apply reads from malformed apply responses without logging schema paths or values", async () => {
    vi.stubEnv("FLUID_RUNTIME", "local");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rows.job_steps = [{ ...resultStep, output: "private-output-value" }];
    expect((await apply(request({ expectedRevision: 1, stepKey: "proposal" }), params())).status).toBe(503);
    expect(warn.mock.calls).toEqual([
      ["[fluid:strategy]", { stage: "stored_value", issueCodes: ["invalid_union"] }],
      ["[fluid:strategy]", { stage: "apply_read" }],
    ]);
    expect(doubles.rpc).not.toHaveBeenCalled();
    warn.mockClear();
    rows.job_steps = [resultStep];
    doubles.rpc.mockResolvedValue({ data: { "private-field-name": "private-field-value" }, error: null, status: 200 });
    expect((await apply(request({ expectedRevision: 1, stepKey: "proposal" }), params())).status).toBe(503);
    expect(warn).toHaveBeenCalledExactlyOnceWith("[fluid:strategy]", { stage: "apply_response", issueCodes: ["invalid_type", "unrecognized_keys"] });
  });
});
