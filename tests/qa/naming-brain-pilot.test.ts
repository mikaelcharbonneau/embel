import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The opt-in Node runner is deliberately source-only ESM.
import { runNamingPilot, validatePilotConfiguration } from "../../scripts/naming-brain-pilot.mjs";
import { context as brief, id, preferences, snapshot } from "../domain/naming-brain-fixtures";
import { reviewedStrategy } from "../fixtures/reviewed-strategy";
// Naming needs a reviewed Strategy now that every project is a complete brand.
const context = reviewedStrategy(brief);
import { accountProjectSchema } from "../../src/domain/project-api";
import { getNamingReadiness, namingStrategyBasis, namingStrategyKey } from "../../src/domain/project-naming";
import { namingBrainRunSchema, namingBrainRunSummarySchema, namingFeedEnsureResultSchema, namingFeedSchema, namingStageKeySchema, type EnsureNamingRunIntent } from "../../src/domain/naming-brain";
const now = Date.parse("2026-10-16T13:00:00.000Z"), at = new Date(now).toISOString();
const origin = "https://synthetic-pilot.invalid", ownerId = id(1), projectId = id(2), policy = "a".repeat(64), cookie = "synthetic_session=NEVER_A_REAL_CREDENTIAL";
function configuration() { return { version: 1, origin, ownerId, projectId, sourceRevision: "b".repeat(40), migrationSha256: "c".repeat(64), policyIdentity: policy,
  approval: { executionAuthorized: true, fundingAuthorized: true, activationReadbackVerified: true, exactOriginAndRevisionVerified: true, approvedAt: at, expiresAt: new Date(now + 600_000).toISOString(), maxNewRuns: 1, aggregateCeilingMicrousd: 25_000_000, runAllowanceMicrousd: 5_000_000 },
  accounting: { observedAt: at, completeOwnerInventoryVerified: true, noUnknownDispatchOrOverrunVerified: true, aggregateCommittedMicrousd: 0, runs: [] as { projectId: string; runId: string }[] },
  intent: { version: 1, reason: "initial", expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0, expectedDemandSequence: 0, consumedThrough: null, idempotencyKey: "synthetic-fixed-pilot-intent" } as EnsureNamingRunIntent };
}
function fixture() {
  const config = configuration();
  const project = accountProjectSchema.parse({ id: projectId, owner_id: ownerId, title: "Synthetic pilot", scope: "complete_brand", current_revision: 1, created_at: at, context });
  const summary = namingBrainRunSummarySchema.parse({ version: 1, ownerId, projectId, runId: id(3), jobId: id(4), batchId: id(5), revision: 1, resumedFromRunId: null, canResume: false, state: "running", projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 0, snapshotHash: policy, acceptedPolicyIdentity: policy, progress: 1, preparedSetId: null, fulfillment: null, accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null }, createdAt: at, updatedAt: at });
  const feed = namingFeedSchema.parse({ version: 1, ownerId, projectId, projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 0, entries: [], nextCursor: null, consumedThrough: null, activeRun: null, preparedSetId: null, paused: false, state: "active", availability: { status: "available", handlerVersion: "naming-brain-v1", protocol: "openai_agents", acceptedPolicyIdentity: policy } });
  const overview = { project, readiness: getNamingReadiness(context, "complete_brand"), session: { ownerId, projectId, revision: 1, currentPreferencesVersion: 1, latestBatchSequence: 0, currentSelectionId: null, viewRevision: 1, viewState: { pane: "results", conversationOpen: false, filter: "all", query: "", visibleBatchId: null, scrollCandidateId: null, workshopCandidateId: null }, createdAt: at, updatedAt: at }, preferences: { ownerId, projectId, version: 1, preferences: preferences(), createdAt: at }, currentSelection: null, batches: { ownerId, projectId, items: [], nextCursor: null }, candidates: { ownerId, projectId, items: [], nextCursor: null }, availability: { status: "unavailable", operation: "naming.generate", reason: "naming_policy_unavailable" }, jobs: [], screening: Object.fromEntries(["domains", "handles", "trademarks"].map(key => [key, { status: "not_checked", reason: "integration_unavailable" }])) };
  const routes = new Map<string, unknown>([["/api/session", { user: { id: ownerId } }], [`/api/projects/${projectId}`, { project }], [`/api/projects/${projectId}/naming`, overview], [`/api/projects/${projectId}/naming/feed`, { feed }], [`/api/projects/${projectId}/naming/feed/ensure`, { status: "pending", run: summary, feed: { ...feed, activeRun: summary }, reused: false }]]);
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => { requests.push({ url, init }); const value = routes.get(new URL(url).pathname); if (!value) throw new Error("Unexpected synthetic request"); return Response.json(value); });
  const options = { executionApproved: true, now, cookie, fetch };
  function prior(state: "succeeded" | "needs_reconciliation", number = 3) {
    const run = namingBrainRunSchema.parse({ ...summary, runId: id(number), state, snapshot: snapshot(), stages: namingStageKeySchema.options.map(stageKey => ({ stageKey, state: "pending", artifactIds: [], startedAt: null, finishedAt: null, errorCode: null })) });
    config.accounting.runs.push({ projectId, runId: run.runId }); config.accounting.aggregateCommittedMicrousd += 5_000_000;
    routes.set(`/api/projects/${projectId}/naming/runs/${run.runId}`, { run }); return run;
  }
  function appended(run = summary, head = run) {
    const candidateId = id(100), value = "Synthetic", entryId = id(101);
    const candidate = { id: candidateId, ownerId, projectId, value, identityKey: "synthetic", rationale: "Synthetic creative interpretation.", contextRevision: 1, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), createdAt: at,
      origin: { kind: "generated", version: 2, handlerVersion: "naming-brain-v1", ownerId, projectId, candidateId, contextRevision: 1, value, batchId: run.batchId, jobId: run.jobId, runId: run.runId, sourceArtifactId: id(102), sourceStageKey: "creation", stepKey: "prepare", provider: "openai", billingMode: "openai_api", protocol: "openai_agents", model: "synthetic-never-call", sessionId: "synthetic-session", turnId: "synthetic-turn", agentId: null, requestId: null, responseId: null, providerItemId: "synthetic-item", generatedAt: at } };
    return namingFeedEnsureResultSchema.parse({ status: "appended", runId: run.runId, appendedEntryIds: [entryId], feed: { ...feed, demandSequence: head.demandSequence, activeRun: head, entries: [{ entryId, position: 1, runId: run.runId, steeringRevision: 0, primaryApproach: "real_words", additionalApproaches: [], publishedClaims: [], entry: { candidate, retention: { ownerId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null } } }] } });
  }
  return { config, options, fetch, requests, routes, summary, feed, project, prior, appended };
}

describe("Naming pilot admission guards, with inert fetch only", () => {
  it("refuses by default before any network request", async () => { const f = fixture(); await expect(runNamingPilot(f.config, { ...f.options, executionApproved: false })).rejects.toThrow("explicit_execution_approval_required"); expect(f.fetch).not.toHaveBeenCalled(); });
  it.each(["http://synthetic-pilot.invalid", "https://user:secret@synthetic-pilot.invalid", "https://synthetic-pilot.invalid/path", "https://synthetic-pilot.invalid/"])("requires an exact credential-free HTTPS origin: %s", value => { expect(() => validatePilotConfiguration({ ...configuration(), origin: value }, { executionApproved: true, now })).toThrow("exact_https_origin_required"); });
  it("rejects missing activation/funding authority, stale accounting and exhausted allowance", () => {
    const f = fixture(); const config = structuredClone(f.config); config.approval.fundingAuthorized = false; expect(() => validatePilotConfiguration(config, f.options)).toThrow("invalid_approval_configuration");
    config.approval.fundingAuthorized = true; config.accounting.observedAt = new Date(now - 600_001).toISOString(); expect(() => validatePilotConfiguration(config, f.options)).toThrow("stale_approval_or_accounting");
    config.accounting.observedAt = at; config.accounting.aggregateCommittedMicrousd = 25_000_000; expect(() => validatePilotConfiguration(config, f.options)).toThrow("aggregate_allowance_exhausted");
  });
  it("verifies authenticated owner before reading private project data", async () => { const f = fixture(); f.routes.set("/api/session", { user: { id: id(99) } }); await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("authenticated_owner_mismatch"); expect(f.requests).toHaveLength(1); });
  it("verifies project owner and saved preference readiness", async () => {
    const f = fixture(); f.routes.set(`/api/projects/${projectId}`, { project: { ...f.project, owner_id: id(99) } }); await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("owned_project_mismatch"); expect(f.requests.some(request => request.init.method === "POST")).toBe(false);
  });
  it("will not forward credentials to a redirect or alternate origin", async () => {
    const f = fixture(); f.options.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://other.invalid/steal" } })); await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("redirect_or_origin_mismatch"); expect(f.options.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = f.options.fetch.mock.calls[0] as unknown as [string, RequestInit]; expect(url).toBe(`${origin}/api/session`); expect(init.redirect).toBe("error");
  });
  it("stops on unknown execution even when the aggregate has room", async () => { const f = fixture(); f.prior("needs_reconciliation"); await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("prior_execution_requires_resolution"); expect(f.requests.some(request => request.init.method === "POST")).toBe(false); });
  it("keeps completed output liabilities held and rejects an understated total", async () => { const f = fixture(); f.prior("succeeded"); f.config.accounting.aggregateCommittedMicrousd = 0; await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("aggregate_accounting_mismatch"); expect(f.requests.some(request => request.init.method === "POST")).toBe(false); });
  it.each(["confirmed_expense", "stage_witness"] as const)("refuses an observed per-run overrun before POST despite an affirmative operator assertion: %s", async witness => {
    const f = fixture(), prior = f.prior("succeeded");
    const run = namingBrainRunSchema.parse(witness === "confirmed_expense"
      ? { ...prior, accounting: { status: "settled", heldAllowanceMicrousd: 0, confirmedActualCostMicrousd: 6_000_000 } }
      : { ...prior, stages: prior.stages.map(stage => stage.stageKey === "creation" ? { ...stage, state: "failed", errorCode: "provider_cost_exceeded" } : stage) });
    f.config.accounting.aggregateCommittedMicrousd = witness === "confirmed_expense" ? 6_000_000 : 5_000_000;
    f.routes.set(`/api/projects/${projectId}/naming/runs/${run.runId}`, { run });
    await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("prior_observed_overrun");
    expect(f.requests.filter(request => request.init.method === "POST")).toHaveLength(0);
  });
  it("allows a confirmed expense exactly at the per-run allowance without inventing the next charge", async () => {
    const f = fixture(), prior = f.prior("succeeded");
    f.routes.set(`/api/projects/${projectId}/naming/runs/${prior.runId}`, { run: { ...prior, accounting: { status: "settled", heldAllowanceMicrousd: 0, confirmedActualCostMicrousd: 5_000_000 } } });
    expect(await runNamingPilot(f.config, f.options)).toMatchObject({ status: "pending", finalCharge: null });
    expect(f.requests.filter(request => request.init.method === "POST")).toHaveLength(1);
  });
  it("rejects an unlisted active run, stale basis and changed policy", async () => {
    const f = fixture(); f.routes.set(`/api/projects/${projectId}/naming/feed`, { feed: { ...f.feed, activeRun: f.summary } }); await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("incomplete_accounting_inventory");
    f.routes.set(`/api/projects/${projectId}/naming/feed`, { feed: { ...f.feed, preferencesVersion: 2 } }); await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("saved_basis_changed");
    f.routes.set(`/api/projects/${projectId}/naming/feed`, { feed: { ...f.feed, availability: { ...f.feed.availability, acceptedPolicyIdentity: "d".repeat(64) } } }); await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("readiness_or_policy_mismatch");
    expect(f.requests.some(request => request.init.method === "POST")).toBe(false);
  });
  it("sends one exact saved intent with expected-account fencing and leaves final cost unknown", async () => {
    const f = fixture(); const result = await runNamingPilot(f.config, f.options);
    expect(f.requests.filter(request => request.init.method === "POST")).toHaveLength(1);
    const sent = f.requests.at(-1)!; expect(sent.url).toBe(`${origin}/api/projects/${projectId}/naming/feed/ensure`); expect(JSON.parse(String(sent.init.body))).toEqual(f.config.intent);
    expect(sent.init.headers).toMatchObject({ "X-Embel-Account": ownerId, Origin: origin, Cookie: cookie }); expect(result.accounting).toEqual(f.summary.accounting); expect(result.finalCharge).toBeNull(); expect(result.status).toBe("pending");
  });
  it("refuses a schema-valid pending receipt for another demand sequence and retains the exact intent", async () => {
    const f = fixture(), run = { ...f.summary, demandSequence: 5 };
    f.routes.set(`/api/projects/${projectId}/naming/feed/ensure`, namingFeedEnsureResultSchema.parse({ status: "pending", run, reused: false, feed: { ...f.feed, demandSequence: 5, activeRun: run } }));
    await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("admission_demand_mismatch_keep_exact_intent");
    expect(f.requests.filter(request => request.init.method === "POST")).toHaveLength(1);
    expect(JSON.parse(String(f.requests.at(-1)!.init.body))).toEqual(f.config.intent);
  });
  it("refuses a receipt that consumed another feed position", async () => {
    const f = fixture();
    f.routes.set(`/api/projects/${projectId}/naming/feed/ensure`, namingFeedEnsureResultSchema.parse({ status: "pending", run: f.summary, reused: false, feed: { ...f.feed, activeRun: f.summary, consumedThrough: { entryId: id(80), position: 3 } } }));
    await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("admission_demand_mismatch_keep_exact_intent");
    expect(f.requests.filter(request => request.init.method === "POST")).toHaveLength(1);
  });
  it("refuses an appended receipt whose explicit run differs from its active head without another request", async () => {
    const f = fixture(), other = { ...f.summary, runId: id(81), jobId: id(82), batchId: id(83) };
    f.routes.set(`/api/projects/${projectId}/naming/feed/ensure`, f.appended(other, f.summary));
    await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("appended_run_unconfirmed_keep_exact_intent");
    expect(f.requests.filter(request => request.init.method === "POST")).toHaveLength(1);
    expect(f.requests.at(-1)!.url).toBe(`${origin}/api/projects/${projectId}/naming/feed/ensure`);
  });
  it("binds an appended result to its explicit owned run", async () => {
    const f = fixture(); f.routes.set(`/api/projects/${projectId}/naming/feed/ensure`, f.appended());
    expect(await runNamingPilot(f.config, f.options)).toMatchObject({ status: "appended", runId: id(3), jobId: id(4), uniqueNamesInReceipt: 1, finalCharge: null });
    expect(f.requests.filter(request => request.init.method === "POST")).toHaveLength(1);
  });
  it("accepts a paid Resume only at the advanced demand and exact consumed position", async () => {
    const f = fixture(), prior = f.prior("succeeded", 30), source = { ...f.summary, runId: prior.runId, state: "partial" as const, canResume: true, demandSequence: 2 };
    f.routes.set(`/api/projects/${projectId}/naming/runs/${prior.runId}`, { run: namingBrainRunSchema.parse({ ...prior, ...source }) });
    const consumedThrough = { entryId: id(80), position: 3 };
    f.config.intent = { ...f.config.intent, reason: "resume", expectedDemandSequence: 2, consumedThrough, resumeOfRunId: source.runId, expectedRunRevision: 1 };
    f.routes.set(`/api/projects/${projectId}/naming/feed`, { feed: { ...f.feed, demandSequence: 2, activeRun: source } });
    const run = { ...f.summary, demandSequence: 3, resumedFromRunId: source.runId };
    f.routes.set(`/api/projects/${projectId}/naming/feed/ensure`, namingFeedEnsureResultSchema.parse({ status: "pending", run, reused: false, feed: { ...f.feed, demandSequence: 3, consumedThrough, activeRun: run } }));
    expect(await runNamingPilot(f.config, f.options)).toMatchObject({ status: "pending", runId: id(3) });
    f.routes.set(`/api/projects/${projectId}/naming/feed/ensure`, namingFeedEnsureResultSchema.parse({ status: "pending", run: { ...run, demandSequence: 2 }, reused: false, feed: { ...f.feed, demandSequence: 2, consumedThrough, activeRun: { ...run, demandSequence: 2 } } }));
    await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("admission_demand_mismatch_keep_exact_intent");
  });
  it("never retries a lost admission or exposes a raw private failure", async () => {
    const f = fixture(), inert = f.options.fetch; f.options.fetch = vi.fn(async (url, init) => { if (init.method === "POST") throw new Error("PRIVATE_ERROR_WITH_SECRET"); return inert(url, init); });
    await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("admission_outcome_unknown_keep_exact_intent"); expect(f.options.fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });
  it("returns a database blocker without continuing or treating the cap as expense", async () => {
    const f = fixture(); f.routes.set(`/api/projects/${projectId}/naming/feed/ensure`, { status: "blocked", feed: f.feed, code: "observed_overrun", message: "Synthetic private body", action: "resolve" });
    expect(await runNamingPilot(f.config, f.options)).toEqual({ status: "blocked", action: "resolve", newRunRequested: false, finalCharge: null }); expect(f.requests.filter(request => request.init.method === "POST")).toHaveLength(1);
  });
});
