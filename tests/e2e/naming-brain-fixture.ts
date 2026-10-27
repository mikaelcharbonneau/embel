import { expect, type Page, type Route } from "@playwright/test";
import { accountProjectSchema, accountProjectSummarySchema } from "../../src/domain/project-api";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { initialNamingPreferencesV2, namingPreferencesV2Schema } from "../../src/domain/naming-brain-preferences";
import { ensureNamingRunIntentSchema, namingBrainRunSummarySchema, namingFeedEnsureResultSchema, namingFeedSchema, steerNamingFeedIntentSchema, stopNamingFeedIntentSchema, type NamingBrainRunSummary, type NamingFeedCursor, type NamingFeedEntry, type NamingFeedEnsureResult } from "../../src/domain/naming-brain";
import { getNamingReadiness, importProjectNameSchema, nameIdentityKey, namingStrategyBasis, namingStrategyKey, selectProjectNameSchema, updateNamingViewStateSchema, type NamingPreferenceRevision, type NamingSession, type ProjectNameEntry } from "../../src/domain/project-naming";
import { projectNamingOverviewSchema, type ProjectNamingOverview } from "../../src/domain/naming-jobs";

// Deliberately synthetic public-route fixtures. No SDK, worker, database, DNS or provider is called.
export const id = (n: number) => `cb000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ownerId = id(1), otherOwnerId = id(2), projectId = id(3);
export const base = `/api/projects/${projectId}/naming`, namingUrl = `/brands/account/${projectId}/naming`;
const when = "2026-10-16T12:00:00.000Z", policy = "a".repeat(64);
export const savedChoices = namingPreferencesV2Schema.parse({ ...initialNamingPreferencesV2(contextSnapshotSchema.parse({ description: "Synthetic neighborhood kitchen" })), approaches: ["real_words", "compounds"], directness: "all" });
export type RequestRecord = { path: string; method: string; body: Record<string, unknown> | null; account: string | undefined };
export async function namingFixture(page: Page, options: { saved?: boolean; count?: number; terminal?: "partial" | "needs_reconciliation"; progressive?: boolean; unavailable?: boolean } = {}) {
  const project = accountProjectSchema.parse({ id: projectId, owner_id: ownerId, title: "Synthetic Naming QA", scope: "naming_only", current_revision: 3, created_at: when, context: { description: "Synthetic brief: a warm neighborhood kitchen.", creativeLocale: "en", intake: { namingNotes: "Synthetic preferences only" } } });
  const session: NamingSession = { ownerId, projectId, revision: 1, currentPreferencesVersion: options.saved ? 1 : 0, latestBatchSequence: 0, currentSelectionId: null, viewRevision: 1, viewState: { pane: "results", conversationOpen: !options.saved, filter: "all", query: "", visibleBatchId: null, scrollCandidateId: null, workshopCandidateId: null }, createdAt: when, updatedAt: when };
  const state = { owner: ownerId as string | null, project, session, preferences: options.saved ? { ownerId, projectId, version: 1, preferences: savedChoices, createdAt: when } as NamingPreferenceRevision : null,
    rows: [] as NamingFeedEntry[], manual: [] as ProjectNameEntry[], currentSelection: null as ProjectNamingOverview["currentSelection"], activeRun: null as NamingBrainRunSummary | null, demand: options.count ? 1 : 0, steering: 0, feedback: 0, paused: false, requests: [] as RequestRecord[], ensureMode: "append" as "append" | "pending" | "partial" | "unknown", failOnce: null as null | { path: string; status: number; afterSave?: boolean },
    savedEnsures: new Map<string, NamingFeedEnsureResult>(), created: new Map<string, typeof project>(), nextRun: 1,
    progressive: false, consumedThrough: null as NamingFeedCursor | null,
  };
  const holds: { path: string; method: string; ready: boolean; settled: boolean; release: () => void; wait: Promise<void> }[] = [];
  function hold(path: string, method: string) { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); const value = { path, method, ready: false, settled: false, release, wait }; holds.push(value); return value; }
  function makeRun(kind: NamingBrainRunSummary["state"], number = state.nextRun++, resumedFromRunId: string | null = null) {
    const partial = kind === "partial";
    return namingBrainRunSummarySchema.parse({ version: 1, ownerId, projectId, runId: id(10_000 + number), jobId: id(20_000 + number), batchId: id(30_000 + number), revision: 1, resumedFromRunId, canResume: partial, state: kind, projectRevision: state.project.current_revision, preferencesVersion: state.session.currentPreferencesVersion, feedbackRevision: state.feedback, steeringRevision: state.steering, demandSequence: state.demand, snapshotHash: "b".repeat(64), acceptedPolicyIdentity: policy, progress: kind === "succeeded" ? 100 : 20, preparedSetId: kind === "succeeded" ? id(40_000 + number) : null,
      fulfillment: kind === "succeeded" ? { status: "complete", targetCount: 100, acceptedCount: 100, missingCount: 0, coverageSatisfied: true, message: null } : partial ? { status: "partial", targetCount: 100, acceptedCount: 20, missingCount: 80, coverageSatisfied: false, message: "Synthetic partial result: 20 names retained." } : null,
      accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null }, createdAt: when, updatedAt: when });
  }
  function row(position: number, run: NamingBrainRunSummary): NamingFeedEntry {
    const candidateId = id(100_000 + position), value = `Synthetic ${String(position).padStart(3, "0")}`;
    return { entryId: id(200_000 + position), position, runId: run.runId, steeringRevision: run.steeringRevision, primaryApproach: position % 2 ? "real_words" : "compounds", additionalApproaches: [], publishedClaims: [], entry: { candidate: { id: candidateId, ownerId, projectId, value, identityKey: nameIdentityKey(value), rationale: "Synthetic creative interpretation; no factual or availability claim.", contextRevision: state.project.current_revision, strategyBasis: namingStrategyBasis(state.project.context), strategyKey: namingStrategyKey(state.project.context), createdAt: when, origin: { kind: "generated", version: 2, handlerVersion: "naming-brain-v1", ownerId, projectId, candidateId, contextRevision: state.project.current_revision, value, batchId: run.batchId, jobId: run.jobId, runId: run.runId, sourceArtifactId: id(300_000 + position), sourceStageKey: "creation", stepKey: "prepare", provider: "openai", billingMode: "openai_api", protocol: "openai_agents", model: "synthetic-never-call", sessionId: `synthetic-session-${position}`, turnId: `synthetic-turn-${position}`, responseId: null, agentId: null, requestId: null, providerItemId: `synthetic-item-${position}`, generatedAt: when } }, retention: { ownerId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null } } };
  }
  function add(count: number, run = makeRun("succeeded")) { state.session.latestBatchSequence += 1; const start = state.rows.length; const added = Array.from({ length: count }, (_, n) => row(start + n + 1, run)); state.rows.push(...added); state.activeRun = run; return added; }
  if (options.count) add(options.count);
  if (options.terminal) state.activeRun = makeRun(options.terminal);
  function feed(after = 0, explicit?: NamingFeedEntry[]) {
    const entries = explicit ?? state.rows.filter(item => item.position > after).slice(0, 100), last = entries.at(-1);
    return namingFeedSchema.parse({ version: 1, ownerId, projectId, projectRevision: state.project.current_revision, preferencesVersion: state.session.currentPreferencesVersion, feedbackRevision: state.feedback, steeringRevision: state.steering, demandSequence: state.demand, entries, nextCursor: !explicit && last && state.rows.some(item => item.position > last.position) ? { entryId: last.entryId, position: last.position } : null, consumedThrough: state.consumedThrough, activeRun: state.activeRun, preparedSetId: null, paused: state.paused, state: state.paused ? "paused" : state.activeRun?.state === "needs_reconciliation" ? "blocked" : "active", availability: options.unavailable ? { status: "unavailable", code: "synthetic_unavailable" } : { status: "available", handlerVersion: "naming-brain-v1", protocol: "openai_agents", acceptedPolicyIdentity: policy },
      ...(options.progressive ? { retentionRevision: state.rows.reduce((sum, row) => sum + row.entry.retention.revision, 0),
        ...(!state.paused && state.activeRun?.state === "succeeded" && state.activeRun.fulfillment?.status === "complete" ? { canPrefetchOnScroll: true } : {}),
        ...(state.progressive ? { progressive: { version: 1, targetCount: 100, publishedCount: state.rows.filter(row => row.runId === state.activeRun?.runId).length } } : {}) } : {}),
    });
  }
  function overview(params: URLSearchParams) {
    const filter = params.get("filter") ?? state.session.viewState.filter, query = params.get("query") ?? state.session.viewState.query;
    const items = [...state.rows.map(row => row.entry), ...state.manual].filter(entry => (filter === "all" || filter === "favorite" && entry.retention.favorite || filter === "saved" && entry.retention.saved) && entry.candidate.value.toLowerCase().includes(query.toLowerCase())).slice(0, 100);
    return projectNamingOverviewSchema.parse({ project: state.project, readiness: getNamingReadiness(state.project.context, state.project.scope), session: state.session, preferences: state.preferences, currentSelection: state.currentSelection, batches: { ownerId, projectId, items: [], nextCursor: null }, candidates: { ownerId, projectId, items, nextCursor: null }, availability: { status: "unavailable", operation: "naming.generate", reason: "naming_policy_unavailable" }, jobs: [], screening: { domains: { status: "not_checked", reason: "integration_unavailable" }, handles: { status: "not_checked", reason: "integration_unavailable" }, trademarks: { status: "not_checked", reason: "integration_unavailable" } } });
  }
  async function reply(route: Route, value: unknown, status = 200) {
    const body = JSON.stringify(value), request = route.request();
    const delayed = holds.find(item => !item.ready && item.path === new URL(request.url()).pathname && item.method === request.method());
    if (delayed) { delayed.ready = true; await delayed.wait; }
    await route.fulfill({ status, contentType: "application/json", body }).catch(() => undefined);
    if (delayed) delayed.settled = true;
  }
  await page.route("**/api/**", async route => {
    const request = route.request(), target = new URL(request.url()), path = target.pathname, method = request.method(), body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    state.requests.push({ path, method, body, account: request.headers()["x-embel-account"] });
    if (path === "/api/session") return reply(route, state.owner ? { user: { id: state.owner } } : {}, state.owner ? 200 : 401);
    if (state.owner !== ownerId) return reply(route, {}, state.owner ? 404 : 401);
    const failure = state.failOnce?.path === path && method !== "GET" ? state.failOnce : null;
    if (failure) { state.failOnce = null; if (!failure.afterSave) return reply(route, {}, failure.status); }
    if (path === "/api/account/profile") return reply(route, { profile: { ownerId, email: "synthetic@example.test", revision: 0, updatedAt: null, values: { fullName: "", timeZone: "UTC", dateFormat: "friendly" } } });
    if (path === "/api/names/workspace") return reply(route, { ownerId, workspace: null });
    if (path === "/api/names/ai") return reply(route, { ownerId, availability: { status: "unavailable", reason: "setup_required" }, jobs: [], hasMore: false });
    if (path === "/api/projects/page") return reply(route, { ownerId, items: [accountProjectSummarySchema.parse(state.project)], nextCursor: null });
    if (path === "/api/projects" && method === "POST") {
      const key = String(body!.requestKey); if (!state.created.has(key)) { state.project = accountProjectSchema.parse({ ...state.project, title: body!.title, scope: body!.scope, context: body!.context, current_revision: 1 }); state.created.set(key, state.project); }
      return reply(route, failure ? {} : { project: state.created.get(key) }, failure?.status ?? 200);
    }
    if (path === "/api/projects") return reply(route, { projects: [state.project] });
    if (path === `/api/projects/${projectId}`) return reply(route, { project: state.project });
    if (path === `/api/projects/${projectId}/strategy`) return reply(route, { availability: { status: "unavailable", operations: [], reason: "runtime_disabled" }, jobs: [] });
    if (path === base) return reply(route, overview(target.searchParams));
    if (path === `${base}/custom`) return reply(route, { ownerId, projectId, items: state.manual, nextCursor: null });
    if (path === `${base}/imports`) {
      const input = importProjectNameSchema.parse(body);
      if (input.expectedProjectRevision !== state.project.current_revision) return reply(route, {}, 409);
      let entry = state.manual.find(row => row.candidate.origin.kind === "local_import" && row.candidate.origin.source.id === input.source.id);
      if (!entry) {
        const candidateId = id(500_000 + state.manual.length), value = input.source.value;
        entry = { candidate: { id: candidateId, ownerId, projectId, value, identityKey: nameIdentityKey(value), rationale: "Synthetic custom name", contextRevision: input.expectedProjectRevision, strategyBasis: namingStrategyBasis(input.capturedContext), strategyKey: namingStrategyKey(input.capturedContext), createdAt: when, origin: { kind: "local_import", ownerId, projectId, candidateId, contextRevision: input.expectedProjectRevision, source: input.source, capturedContext: input.capturedContext } }, retention: { ownerId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null } };
        state.manual.push(entry);
      }
      return reply(route, failure ? {} : { entry }, failure?.status ?? 200);
    }
    if (path === `${base}/selection`) {
      const input = selectProjectNameSchema.parse(body), entry = [...state.manual, ...state.rows.map(row => row.entry)].find(row => row.candidate.id === input.candidateId);
      if (!entry || input.expectedRevision !== state.project.current_revision) return reply(route, {}, 409);
      state.project = accountProjectSchema.parse({ ...state.project, current_revision: input.expectedRevision + 1, context: { ...state.project.context, selectedName: entry.candidate.value, intake: { ...state.project.context.intake, suppliedName: entry.candidate.value } } });
      const selection = { id: id(600_000), ownerId, projectId, candidateId: input.candidateId, projectRevision: state.project.current_revision, previousSelectionId: state.session.currentSelectionId, acceptedEarlierContext: input.acceptEarlierContext, createdAt: when };
      state.currentSelection = { selection, candidate: entry.candidate }; state.session.currentSelectionId = selection.id;
      return reply(route, { project: state.project, currentSelection: state.currentSelection, session: state.session });
    }
    if (path === `${base}/feed`) return reply(route, { feed: feed(Number(target.searchParams.get("cursorPosition") ?? 0)) });
    if (path === `${base}/preferences`) {
      const value = namingPreferencesV2Schema.parse(body!.preferences);
      if (body!.expectedPreferencesVersion === state.session.currentPreferencesVersion) { state.session.currentPreferencesVersion += 1; state.session.revision += 1; state.preferences = { ownerId, projectId, version: state.session.currentPreferencesVersion, preferences: value, createdAt: when }; }
      else if (Number(body!.expectedPreferencesVersion) + 1 !== state.session.currentPreferencesVersion || JSON.stringify(value) !== JSON.stringify(state.preferences?.preferences)) return reply(route, {}, 409);
      return reply(route, failure ? {} : { session: state.session, preferences: state.preferences }, failure?.status ?? 200);
    }
    if (path === `${base}/view`) {
      const input = updateNamingViewStateSchema.parse(body);
      if (input.expectedViewRevision !== state.session.viewRevision) return reply(route, {}, 409);
      const previous = state.session.viewState.namingChat, checkpoint = input.viewState.namingChat;
      if (checkpoint && JSON.stringify(checkpoint) !== JSON.stringify(previous) && checkpoint.preferencesVersion !== state.session.currentPreferencesVersion) return reply(route, {}, 409);
      state.session.viewState = { ...input.viewState, ...(!checkpoint && previous ? { namingChat: previous } : {}) };
      state.session.viewRevision += 1; state.session.revision += 1;
      return reply(route, failure ? {} : { session: state.session }, failure?.status ?? 200);
    }
    if (path === `${base}/retention`) { const entry = [...state.manual, ...state.rows.map(row => row.entry)].find(row => row.candidate.id === body!.candidateId)!; if (entry.retention.revision !== body!.expectedRevision) return reply(route, {}, 409); entry.retention = { ...entry.retention, revision: entry.retention.revision + 1, favorite: Boolean(body!.favorite), saved: Boolean(body!.saved), updatedAt: when }; state.feedback += 1; return reply(route, { entry }); }
    if (path === `${base}/feed/ensure`) {
      const intent = ensureNamingRunIntentSchema.parse(body);
      if (state.savedEnsures.has(intent.idempotencyKey)) return reply(route, state.savedEnsures.get(intent.idempotencyKey));
      if (state.paused || intent.reason === "resume") { state.demand += 1; state.paused = false; }
      else if (!state.demand) state.demand = 1;
      const run = makeRun(state.ensureMode === "append" ? "succeeded" : state.ensureMode === "pending" ? "running" : state.ensureMode === "partial" ? "partial" : "needs_reconciliation", undefined, intent.reason === "resume" ? intent.resumeOfRunId : null);
      state.activeRun = run;
      if (options.progressive) { state.progressive = true; state.consumedThrough = intent.consumedThrough; }
      let result: NamingFeedEnsureResult;
      if (state.ensureMode === "append") { const added = add(100, run); result = { status: "appended", feed: feed(0, added), runId: run.runId, appendedEntryIds: added.map(row => row.entryId) }; }
      else if (state.ensureMode === "pending") result = { status: "pending", feed: feed(), run, reused: false };
      else if (state.ensureMode === "partial") { const added = add(20, run); result = { status: "incomplete", feed: feed(0, added), run, fulfillment: run.fulfillment!, message: "Synthetic partial result retained.", canResume: true }; }
      else result = { status: "blocked", feed: feed(), code: "unknown_execution", message: "Synthetic unknown outcome requires resolution.", action: "resolve" };
      result = namingFeedEnsureResultSchema.parse(result); state.savedEnsures.set(intent.idempotencyKey, result); return reply(route, failure ? {} : result, failure?.status ?? 200);
    }
    if (path === `${base}/steering`) { const intent = steerNamingFeedIntentSchema.parse(body); if (intent.expectedSteeringRevision !== state.steering) return reply(route, {}, 409); const old = state.activeRun; state.steering += 1; state.activeRun = null; return reply(route, { feed: feed(), supersededRunIds: old ? [old.runId] : [], cancellationRequestedRunIds: old?.state === "running" ? [old.runId] : [] }); }
    if (path === `${base}/feed/stop`) { stopNamingFeedIntentSchema.parse(body); state.paused = true; state.demand += 1; if (state.activeRun?.state === "running") state.activeRun = { ...state.activeRun, state: "cancel_requested", revision: state.activeRun.revision + 1 }; return reply(route, { feed: feed() }); }
    return reply(route, {}, 404);
  });
  return { state, hold, add, feed, makeRun, mutations: (suffix = "/feed/ensure") => state.requests.filter(row => row.path.endsWith(suffix) && row.method !== "GET") };
}
export async function openNaming(page: Page) { await page.goto(namingUrl); await expect(page.getByRole("heading", { name: "Find a name that feels right" })).toBeVisible(); }
export const namingCard = (page: Page, n: number) => page.locator(".naming-feed-card").filter({ has: page.getByRole("heading", { name: `Synthetic ${String(n).padStart(3, "0")}`, exact: true }) });
export async function frameBarrier(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
export async function scrollToTail(page: Page, interact = true) {
  await page.locator(".naming-feed-tail").scrollIntoViewIfNeeded(); await frameBarrier(page);
  if (interact) { await page.locator(".naming-feed-tail").hover(); await page.mouse.wheel(0, 120); await frameBarrier(page); }
}

/** Responsive presentation helpers preserve the real explicit decision/admission boundaries. */
export async function showNamingChat(page: Page) {
  const open = page.getByRole("button", { name: "Open chat", exact: true });
  if (await open.isVisible()) await open.click();
}
export async function showNamingNames(page: Page) {
  const close = page.getByRole("button", { name: "Close chat", exact: true });
  if (await close.isVisible()) await close.click();
}
export async function finishNamingChat(page: Page) {
  const next = page.getByRole("button", { name: "Continue", exact: true });
  while (await next.isVisible()) {
    const question = await page.locator("#project-naming-preferences-heading").innerText();
    await next.click();
    // A final submit may intentionally expire the account in a 401 fixture.
    // Treat removal as a transition, while the calling test still verifies the
    // exact pending request and explicit recovery behavior.
    await expect.poll(async () => { return page.locator("#project-naming-preferences-heading").evaluateAll(nodes => nodes[0]?.textContent ?? null); }).not.toBe(question);
  }
}
export async function editNamingApproaches(page: Page) {
  await showNamingChat(page);
  const edit = page.getByRole("button", { name: "Edit answer: Which approaches would you like to explore?", exact: true });
  if (await edit.isVisible()) await edit.click();
}
