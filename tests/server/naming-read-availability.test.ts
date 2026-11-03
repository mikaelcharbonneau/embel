import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ verify: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/server/data/project-naming", () => ({ verifyProjectNameCandidates: mock.verify }));
vi.mock("@/server/api-text/config", () => ({ isHostedNamingRuntime: () => true, isLocalPollingRuntime: () => false }));
import { getNamingFeed } from "@/server/data/naming-brain";
import type { AuthenticatedContext } from "@/server/auth/context";
import { createNamingFeedController } from "@/components/naming/naming-feed-controller";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { contextSnapshotSchema } from "@/domain/projects";
const ownerId = "a0000000-0000-4000-8000-000000000001", projectId = "b0000000-0000-4000-8000-000000000001";
const feed = { version: 1, ownerId, projectId, projectRevision: 1, preferencesVersion: 1, steeringRevision: 0, feedbackRevision: 0, demandSequence: 0, entries: [], nextCursor: null, consumedThrough: null, activeRun: null, preparedSetId: null, paused: false, state: "active", availability: { status: "available", handlerVersion: "naming-brain-v1", protocol: "openai_agents", acceptedPolicyIdentity: "a".repeat(64) } };
const auth = { userId: ownerId, client: { rpc: mock.rpc, from: mock.from } } as unknown as AuthenticatedContext;
beforeEach(() => { vi.resetAllMocks(); mock.verify.mockResolvedValue(undefined); });

it("preserves a verified worker outage as the reason generation is unavailable", async () => {
  mock.rpc.mockImplementation(async (name: string) => ({ data: name === "get_naming_feed" ? feed
    : { status: "unavailable", executionAuthority: "hosted_owner_v1", reason: "worker_unavailable" }, error: null }));
  const result = await getNamingFeed(auth, projectId);
  expect(result.availability).toEqual({ status: "unavailable", code: "worker_unavailable" });
});

it.each(["timeout", "invalid", "transport"])("retains the verified saved feed when hosted readiness has a %s failure", async failure => {
  mock.rpc.mockImplementation(async (name: string) => {
    if (name === "get_naming_feed") return { data: feed, error: null };
    if (failure === "transport") throw Error("Synthetic offline readiness");
    return failure === "timeout" ? { data: null, error: { code: "57014" } } : { data: { status: "broken" }, error: null };
  });
  const result = await getNamingFeed(auth, projectId);
  expect(result).toMatchObject({ ownerId, projectId, entries: [], availability: { status: "unavailable", code: "naming_runtime_unavailable" } });
  expect(result.canResumeOnScroll).toBeUndefined(); expect(result.canPrefetchOnScroll).toBeUndefined();
  expect(mock.verify).toHaveBeenCalledExactlyOnceWith(auth, projectId, []);
  expect(mock.rpc.mock.calls.every(([name]) => name.startsWith("get_"))).toBe(true);
});

it.each([["P0002", "not_found"], ["PGRST301", "unauthenticated"], ["PGRST302", "unauthenticated"], ["PGRST303", "unauthenticated"], ["42501", "unauthenticated"]])("retains readiness authorization failure %s instead of concealing it as an outage", async (code, expected) => {
  mock.rpc.mockImplementation(async (name: string) => name === "get_naming_feed" ? { data: feed, error: null } : { data: null, error: { code } });
  await expect(getNamingFeed(auth, projectId)).rejects.toMatchObject({ code: expected, status: expected === "not_found" ? 404 : 401 });
});

it.each(["PGRST301", "PGRST302", "PGRST303", "42501"])("does not continue saved-feed verification after %s rejects authentication", async code => {
  mock.rpc.mockResolvedValue({ data: null, error: { code, message: "unauthenticated" } });
  await expect(getNamingFeed(auth, projectId)).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  expect(mock.verify).not.toHaveBeenCalled(); expect(mock.rpc).toHaveBeenCalledTimes(1);
});

it("never conceals failed saved-name provenance verification", async () => {
  mock.rpc.mockResolvedValue({ data: feed, error: null }); mock.verify.mockRejectedValue(Error("Synthetic invalid provenance"));
  await expect(getNamingFeed(auth, projectId)).rejects.toThrow("Synthetic invalid provenance");
  expect(mock.rpc).toHaveBeenCalledTimes(1);
});

function configureFailedFeed(output: unknown | null, read?: () => Promise<unknown>) {
  const when = "2026-10-25T12:00:00Z";
  const source = { ...feed, canResumeOnScroll: true,
    // Supplied feed classifications are replaced by verified owned step data.
    failure: { code: "provider_budget_control_unavailable", retryable: false }, activeRun: {
      version: 1, ownerId, projectId, runId: "d0000000-0000-4000-8000-000000000001", jobId: "d0000000-0000-4000-8000-000000000002", batchId: "d0000000-0000-4000-8000-000000000003",
      revision: 2, resumedFromRunId: null, canResume: true, state: "failed", projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 0,
      snapshotHash: "b".repeat(64), acceptedPolicyIdentity: "a".repeat(64), progress: 0, preparedSetId: null,
      executionAuthority: "hosted_owner_v1", localPipelineVersion: 2, providerBudgetVersion: 1,
      fulfillment: { status: "none", targetCount: 100, acceptedCount: 0, missingCount: 100, coverageSatisfied: false, message: "Synthetic retained provider rejection." },
      accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null }, createdAt: when, updatedAt: when,
    } };
  mock.rpc.mockImplementation(async (name: string) => {
    if (name === "get_naming_feed") return { data: source, error: null };
    expect(name).toBe("get_hosted_naming_availability");
    return { data: { status: "available", executionAuthority: "hosted_owner_v1" }, error: null };
  });
  mock.from.mockImplementation((table: string) => {
    expect(table).toBe("job_steps");
    const filters = new Map<string, unknown>();
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.set(key, value); return query; }, in: () => query,
      limit: async (limit: number) => {
        expect(limit).toBe(7);
        expect(Object.fromEntries(filters)).toEqual({ owner_id: ownerId, project_id: projectId, job_id: source.activeRun.jobId });
        return read ? read() : { data: output === null ? [] : [{ owner_id: ownerId, project_id: projectId, job_id: source.activeRun.jobId, output }], error: null };
      } };
    return query;
  });
  return source;
}

async function expectOnlyExplicitResume(projected: Awaited<ReturnType<typeof getNamingFeed>>, source: ReturnType<typeof configureFailedFeed>) {
  const original = structuredClone(source.activeRun);
  expect(projected.availability).toEqual(feed.availability);
  expect(projected.activeRun).toEqual(original);
  expect(projected.activeRun?.canResume).toBe(true);
  expect(projected.canResumeOnScroll).toBeUndefined();

  const account = { userId: ownerId, generation: 1 }, memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
  const context = contextSnapshotSchema.parse({ description: "Synthetic historical rejection recovery" });
  memory.connectPreferences(account, projectId, { ownerId, projectId, version: 1, createdAt: original.createdAt,
    preferences: { ...initialNamingPreferencesV2(context), approaches: ["real_words"], directness: "open_ended" } }, context);
  const resumedRun = { ...projected.activeRun!, runId: "d0000000-0000-4000-8000-000000000004", jobId: "d0000000-0000-4000-8000-000000000005", batchId: "d0000000-0000-4000-8000-000000000006",
    revision: 1, resumedFromRunId: original.runId, demandSequence: 1, state: "queued" as const, canResume: false, fulfillment: null, providerBudgetVersion: 2 as const };
  const request = vi.fn(async (path: string, _schema: unknown, options: { method?: string; body?: unknown }) => options.method === "POST"
    ? { status: "pending", reused: false, run: resumedRun, feed: { ...projected, activeRun: resumedRun, demandSequence: 1 } } : { feed: projected });
  const controller = createNamingFeedController({ account, projectId, memory, request: request as never, eligible: () => true, visible: () => true });
  try {
    await controller.load();
    controller.interact(true); await controller.demand(); await controller.poll();
    expect(request.mock.calls.filter(([, , options]) => options.method === "POST")).toHaveLength(0);
    expect(await controller.resume()).toBe(true);
    const posts = request.mock.calls.filter(([, , options]) => options.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe(`/api/projects/${projectId}/naming/feed/ensure`);
    expect(posts[0]![2].body).toMatchObject({ reason: "resume", resumeOfRunId: original.runId, expectedRunRevision: original.revision, expectedDemandSequence: 0 });
    expect(memory.get(account, projectId)?.feed.feed?.activeRun).toMatchObject({ providerBudgetVersion: 2, resumedFromRunId: original.runId });
    expect(source.activeRun).toEqual(original);
  } finally { controller.dispose(); }
}

it.each(["provider_configuration_rejected", "provider_budget_control_unavailable", "provider_request_rejected"] as const)("requires explicit Resume after a verified %s while retaining current uncapped availability", async code => {
  const source = configureFailedFeed({ errorCode: "provider_request_rejected", ...(code === "provider_request_rejected" ? {} : { partialArtifacts: [{ type: "provider_failure", code, retryable: false }] }) });
  const projected = await getNamingFeed(auth, projectId);
  expect(projected.failure).toEqual({ code, retryable: false });
  await expectOnlyExplicitResume(projected, source);
});

it.each(["provider_configuration_rejected", "provider_budget_control_unavailable"] as const)("recognizes the nonretryable %s error code without a partial marker", async code => {
  const source = configureFailedFeed({ errorCode: code });
  const projected = await getNamingFeed(auth, projectId);
  expect(projected.failure).toEqual({ code, retryable: false });
  await expectOnlyExplicitResume(projected, source);
});

it.each(["query_error", "transport", "null_reply", "non_array", "missing_error", "malformed_row", "malformed_output", "malformed_marker",
  "missing_marker_type", "misspelled_marker_type", "null_marker_type", "untyped_failure_code", "untyped_retryability"] as const)("withholds scroll Resume when the owned failure classification is unverified: %s", async failure => {
  const source = configureFailedFeed({ partialArtifacts: [{ type: "provider_failure", code: "provider_configuration_rejected", retryable: false }] }, async () => {
    const row = { owner_id: ownerId, project_id: projectId, job_id: source.activeRun.jobId, output: {} };
    if (failure === "transport") throw Error("Synthetic classification transport failure");
    if (failure === "query_error") return { data: null, error: { code: "57014" } };
    if (failure === "null_reply") return null;
    if (failure === "non_array") return { data: {}, error: null };
    if (failure === "missing_error") return { data: [] };
    if (failure === "malformed_row") return { data: [row, null], error: null };
    if (failure === "malformed_output") return { data: [{ ...row, output: { partialArtifacts: "unavailable" } }], error: null };
    let partial: unknown = { type: "provider_failure", code: "provider_configuration_rejected", retryable: true };
    if (failure === "missing_marker_type") partial = { code: "provider_configuration_rejected", retryable: false };
    if (failure === "misspelled_marker_type") partial = { type: "provider_failur", code: "provider_configuration_rejected", retryable: false };
    if (failure === "null_marker_type") partial = { type: null, code: "provider_configuration_rejected", retryable: false };
    if (failure === "untyped_failure_code") partial = { code: "provider_configuration_rejected" };
    if (failure === "untyped_retryability") partial = { retryable: false };
    return { data: [{ ...row, output: { partialArtifacts: [partial] } }], error: null };
  });
  const projected = await getNamingFeed(auth, projectId);
  expect(projected.entries).toEqual(source.entries);
  expect(projected.failure).toBeUndefined();
  await expectOnlyExplicitResume(projected, source);
});

it("still rejects a foreign failure-classification row rather than concealing it as an outage", async () => {
  configureFailedFeed(null, async () => ({ data: [{ owner_id: "a0000000-0000-4000-8000-000000000002", project_id: projectId, job_id: "d0000000-0000-4000-8000-000000000002", output: {} }], error: null }));
  await expect(getNamingFeed(auth, projectId)).rejects.toMatchObject({ code: "not_found", status: 404 });
});

it("retains safe scroll Resume when no owned nonretryable failure is recorded", async () => {
  configureFailedFeed(null);
  const result = await getNamingFeed(auth, projectId);
  expect(result.failure).toBeUndefined();
  expect(result.availability).toEqual(feed.availability);
  expect(result.canResumeOnScroll).toBe(true);
  expect(result.activeRun?.canResume).toBe(true);
});

it.each([
  { providerItemId: "item_synthetic", type: "reasoning", content: "Synthetic retained provider output." },
  { providerCallKey: "creation.synthetic", status: "rejected_before_dispatch", code: "local_dispatch_not_attempted", receipt: {} },
])("retains safe scroll Resume with a non-failure partial: %j", async partial => {
  configureFailedFeed({ partialArtifacts: [partial] });
  const result = await getNamingFeed(auth, projectId);
  expect(result.failure).toBeUndefined();
  expect(result.canResumeOnScroll).toBe(true);
  expect(result.activeRun?.canResume).toBe(true);
});
