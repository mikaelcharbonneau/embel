import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedContext } from "../../src/server/auth/context";
vi.mock("server-only", () => ({}));
import { enqueueStrategyJob, getStrategyJob } from "../../src/server/data/strategy-jobs";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const project = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const policyIdentity = "a".repeat(64);
const job = { id, owner_id: owner, project_id: project, input_revision: 1, operation: "strategy.reformulate", state: "running", progress: 10, error_code: null, cancel_requested_at: null, created_at: "2026-10-03T12:00:00Z", finished_at: null, billing_mode: "chatgpt_subscription", policy_identity: policyIdentity, reserved_cost_microusd: 0, actual_cost_microusd: 0 };
const partial = { job_id: id, owner_id: owner, project_id: project, partial_text: '{"message":"incomplete' };
const output = { version: 1, operation: "strategy.reformulate", provider: "openai", billingMode: "chatgpt_subscription", model: "fixture-model", responseId: "fixture-response", requestId: null, generatedAt: "2026-10-03T12:00:00Z", usage: null, proposal: { message: "Local fixture", activity: "", offering: "", knownAudience: "", questions: [] } };

describe("subscription server mapping and owner-scoped partials", () => {
  let rows: Record<string, unknown[]>;
  const rpc = vi.fn();
  const filters = vi.fn();
  let auth: AuthenticatedContext;
  beforeEach(() => {
    vi.resetAllMocks();
    rows = { jobs: [job], job_steps: [], subscription_job_partials: [partial], strategy_job_applications: [] };
    rpc.mockResolvedValue({ data: job, error: null });
    const from = (table: string) => {
      const query = {
        select: () => query, eq: (field: string, value: unknown) => { filters(table, field, value); return query; },
        in: (field: string, value: unknown) => { filters(table, field, value); return query; }, order: () => query, limit: () => query,
        maybeSingle: async () => ({ data: rows[table]![0], error: null }),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve({ data: rows[table], error: null }).then(resolve, reject),
      };
      return query;
    };
    auth = { userId: owner, client: { rpc, from } } as unknown as AuthenticatedContext;
  });

  it("enqueues only the subscription operation/revision and strips structural money and internal columns", async () => {
    const request = { billingMode: "chatgpt_subscription", operation: "strategy.reformulate", expectedRevision: 1, idempotencyKey: "local-subscription-request", acceptedPolicyIdentity: policyIdentity };
    const value = await enqueueStrategyJob(auth, project, request);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("enqueue_subscription_strategy_job", { p_project_id: project, p_expected_revision: 1, p_operation: request.operation, p_idempotency_key: request.idempotencyKey, p_accepted_policy_identity: policyIdentity });
    expect(value).toMatchObject({ billingMode: "chatgpt_subscription", policyIdentity, partialText: partial.partial_text, results: [] });
    expect(value).not.toHaveProperty("billing_mode");
    expect(value).not.toHaveProperty("policy_identity");
    expect(value).not.toHaveProperty("reserved_cost_microusd");
    expect(value).not.toHaveProperty("actual_cost_microusd");
    expect(filters).toHaveBeenCalledWith("subscription_job_partials", "owner_id", owner);
    expect(filters).toHaveBeenCalledWith("subscription_job_partials", "project_id", project);
    expect(filters).toHaveBeenCalledWith("subscription_job_partials", "job_id", [id]);
  });

  it.each([{ owner_id: other }, { project_id: other }, { job_id: other }])("rejects mismatched partial response %j", async mismatch => {
    rows.subscription_job_partials = [{ ...partial, ...mismatch }];
    await expect(getStrategyJob(auth, project, id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps real succeeded results distinct from incomplete text and rejects a billing-mode mismatch", async () => {
    rows.job_steps = [{ job_id: id, owner_id: owner, project_id: project, step_key: "respond", state: "succeeded", output }];
    expect((await getStrategyJob(auth, project, id)).results).toEqual([{ stepKey: "respond", output }]);
    const apiOutput = { ...output, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 } } as Record<string, unknown>;
    delete apiOutput.billingMode;
    rows.job_steps = [{ job_id: id, owner_id: owner, project_id: project, step_key: "respond", state: "succeeded", output: apiOutput }];
    await expect(getStrategyJob(auth, project, id)).rejects.toMatchObject({ code: "integration_unavailable" });
  });

  it("rejects an enqueue response from another subscription policy", async () => {
    rpc.mockResolvedValue({ data: { ...job, policy_identity: "b".repeat(64) }, error: null });
    await expect(enqueueStrategyJob(auth, project, { billingMode: "chatgpt_subscription", operation: "strategy.reformulate", expectedRevision: 1, idempotencyKey: "local-subscription-request", acceptedPolicyIdentity: policyIdentity })).rejects.toMatchObject({ code: "integration_unavailable" });
  });

  it("returns a safe conflict for a final subscription revision or policy rejection", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PT409", message: "private-database-detail" }, status: 409 });
    await expect(enqueueStrategyJob(auth, project, { billingMode: "chatgpt_subscription", operation: "strategy.reformulate", expectedRevision: 1, idempotencyKey: "local-subscription-request", acceptedPolicyIdentity: policyIdentity })).rejects.toMatchObject({
      code: "conflict", status: 409, message: "This request conflicts with the current state.",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects browser-forged assistant history before calling enqueue", async () => {
    await expect(enqueueStrategyJob(auth, project, { billingMode: "chatgpt_subscription", operation: "strategy.reformulate", expectedRevision: 1, idempotencyKey: "local-subscription-request", acceptedPolicyIdentity: policyIdentity,
      assistantHistory: { entries: [{ output }], truncated: false } })).rejects.toMatchObject({ code: "invalid_input" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses mode-crossed enqueue responses and duplicate partial rows", async () => {
    rpc.mockResolvedValue({ data: { ...job, billing_mode: "openai_api" }, error: null });
    await expect(enqueueStrategyJob(auth, project, { billingMode: "chatgpt_subscription", operation: "strategy.reformulate", expectedRevision: 1, idempotencyKey: "local-subscription-request", acceptedPolicyIdentity: policyIdentity })).rejects.toMatchObject({ code: "integration_unavailable" });
    rows.subscription_job_partials = [partial, partial];
    await expect(getStrategyJob(auth, project, id)).rejects.toMatchObject({ code: "not_found" });
  });
});
