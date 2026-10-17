import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The opt-in Node runner is deliberately source-only ESM.
import { runNamingPilot, validatePilotConfiguration } from "../../scripts/naming-brain-pilot.mjs";
import { context, id, preferences, snapshot } from "../domain/naming-brain-fixtures";
import { accountProjectSchema } from "../../src/domain/project-api";
import { getNamingReadiness } from "../../src/domain/project-naming";
import { namingBrainRunSchema, namingBrainRunSummarySchema, namingFeedSchema, namingStageKeySchema } from "../../src/domain/naming-brain";
const now = Date.parse("2026-10-16T13:00:00.000Z"), at = new Date(now).toISOString();
const origin = "https://synthetic-pilot.invalid", ownerId = id(1), projectId = id(2), policy = "a".repeat(64), cookie = "synthetic_session=NEVER_A_REAL_CREDENTIAL";
function configuration() { return { version: 1, origin, ownerId, projectId, sourceRevision: "b".repeat(40), migrationSha256: "c".repeat(64), policyIdentity: policy,
  approval: { executionAuthorized: true, fundingAuthorized: true, activationReadbackVerified: true, exactOriginAndRevisionVerified: true, approvedAt: at, expiresAt: new Date(now + 600_000).toISOString(), maxNewRuns: 1, aggregateCeilingMicrousd: 25_000_000, runAllowanceMicrousd: 5_000_000 },
  accounting: { observedAt: at, completeOwnerInventoryVerified: true, noUnknownDispatchOrOverrunVerified: true, aggregateCommittedMicrousd: 0, runs: [] as { projectId: string; runId: string }[] },
  intent: { version: 1, reason: "initial", expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0, expectedDemandSequence: 0, consumedThrough: null, idempotencyKey: "synthetic-fixed-pilot-intent" } };
}
function fixture() {
  const config = configuration();
  const project = accountProjectSchema.parse({ id: projectId, owner_id: ownerId, title: "Synthetic pilot", scope: "naming_only", current_revision: 1, created_at: at, context });
  const summary = namingBrainRunSummarySchema.parse({ version: 1, ownerId, projectId, runId: id(3), jobId: id(4), batchId: id(5), revision: 1, resumedFromRunId: null, canResume: false, state: "running", projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 0, snapshotHash: policy, acceptedPolicyIdentity: policy, progress: 1, preparedSetId: null, fulfillment: null, accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null }, createdAt: at, updatedAt: at });
  const feed = namingFeedSchema.parse({ version: 1, ownerId, projectId, projectRevision: 1, preferencesVersion: 1, feedbackRevision: 0, steeringRevision: 0, demandSequence: 0, entries: [], nextCursor: null, consumedThrough: null, activeRun: null, preparedSetId: null, paused: false, state: "active", availability: { status: "available", handlerVersion: "naming-brain-v1", protocol: "openai_agents", acceptedPolicyIdentity: policy } });
  const overview = { project, readiness: getNamingReadiness(context, "naming_only"), session: { ownerId, projectId, revision: 1, currentPreferencesVersion: 1, latestBatchSequence: 0, currentSelectionId: null, viewRevision: 1, viewState: { pane: "results", conversationOpen: false, filter: "all", query: "", visibleBatchId: null, scrollCandidateId: null, workshopCandidateId: null }, createdAt: at, updatedAt: at }, preferences: { ownerId, projectId, version: 1, preferences: preferences(), createdAt: at }, currentSelection: null, batches: { ownerId, projectId, items: [], nextCursor: null }, candidates: { ownerId, projectId, items: [], nextCursor: null }, availability: { status: "unavailable", operation: "naming.generate", reason: "naming_policy_unavailable" }, jobs: [], screening: Object.fromEntries(["domains", "handles", "trademarks"].map(key => [key, { status: "not_checked", reason: "integration_unavailable" }])) };
  const routes = new Map<string, unknown>([["/api/session", { user: { id: ownerId } }], [`/api/projects/${projectId}`, { project }], [`/api/projects/${projectId}/naming`, overview], [`/api/projects/${projectId}/naming/feed`, { feed }], [`/api/projects/${projectId}/naming/feed/ensure`, { status: "pending", run: summary, feed: { ...feed, activeRun: summary }, reused: false }]]);
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => { requests.push({ url, init }); const value = routes.get(new URL(url).pathname); if (!value) throw new Error("Unexpected synthetic request"); return Response.json(value); });
  const options = { executionApproved: true, now, cookie, fetch };
  function prior(state: "succeeded" | "needs_reconciliation", number = 3) {
    const run = namingBrainRunSchema.parse({ ...summary, runId: id(number), state, snapshot: snapshot(), stages: namingStageKeySchema.options.map(stageKey => ({ stageKey, state: "pending", artifactIds: [], startedAt: null, finishedAt: null, errorCode: null })) });
    config.accounting.runs.push({ projectId, runId: run.runId }); config.accounting.aggregateCommittedMicrousd += 5_000_000;
    routes.set(`/api/projects/${projectId}/naming/runs/${run.runId}`, { run }); return run;
  }
  return { config, options, fetch, requests, routes, summary, feed, project, prior };
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
  it("never retries a lost admission or exposes a raw private failure", async () => {
    const f = fixture(), inert = f.options.fetch; f.options.fetch = vi.fn(async (url, init) => { if (init.method === "POST") throw new Error("PRIVATE_ERROR_WITH_SECRET"); return inert(url, init); });
    await expect(runNamingPilot(f.config, f.options)).rejects.toThrow("admission_outcome_unknown_keep_exact_intent"); expect(f.options.fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });
  it("returns a database blocker without continuing or treating the cap as expense", async () => {
    const f = fixture(); f.routes.set(`/api/projects/${projectId}/naming/feed/ensure`, { status: "blocked", feed: f.feed, code: "observed_overrun", message: "Synthetic private body", action: "resolve" });
    expect(await runNamingPilot(f.config, f.options)).toEqual({ status: "blocked", action: "resolve", newRunRequested: false, finalCharge: null }); expect(f.requests.filter(request => request.init.method === "POST")).toHaveLength(1);
  });
});
