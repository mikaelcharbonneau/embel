import { captureUiEvidence } from "./ui-evidence";
import { expect, test, type Page, type Route } from "@playwright/test";
import { accountProjectSchema, accountProjectSummarySchema, type AccountProject } from "../../src/domain/project-api";
import { contextSnapshotSchema, type ProjectScope } from "../../src/domain/projects";
import { namingSourceSchema, transformNames, type NameTransformInput } from "../../src/domain/naming";
import { createEmptyNamesWorkspace, namesWorkspaceSchema } from "../../src/components/naming/local-names";
import { getNamingFulfillment, projectNamingOverviewSchema, type NamingBatchEntry, type NamingJob } from "../../src/domain/naming-jobs";
import { namingPreferencesV1Schema, emptyNamingRejectionCounts, getNamingReadiness, initialNamingPreferences, nameIdentityKey, namingBatchTarget, namingStrategyBasis, namingStrategyKey, type CurrentNameSelection, type NamingPreferenceRevision, type NamingSession, type ProjectNameEntry } from "../../src/domain/project-naming";
import { DEFAULT_SUBSCRIPTION_LIMITS } from "../../src/domain/strategy-jobs";

// All accounts, provider output and database responses in this suite are intercepted local fixtures.
const ownerId = "aaaaaaaa-1111-4111-8111-111111111111";
const otherOwnerId = "dddddddd-1111-4111-8111-111111111111";
const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
const when = "2026-10-04T10:00:00.000Z";
const policyIdentity = "a".repeat(64);
const base = `/api/projects/${projectId}/naming`;
const url = `/brands/account/${projectId}/naming`;
const uuid = (group: string, n: number) => `${group}-1111-4111-8111-${String(n).padStart(12, "0")}`;

function fixtureProject(scope: ProjectScope = "naming_only"): AccountProject {
  return accountProjectSchema.parse({ id: projectId, owner_id: ownerId, title: "Synthetic naming project", scope, current_revision: 3, created_at: when, context: {
    description: "Synthetic brief: a warm neighborhood kitchen.", creativeLocale: "fr", intake: { namingNotes: "Warm and concise", conversation: [{ id: "fixture-user", kind: "user_message", text: "Synthetic brief: a warm neighborhood kitchen.", createdAt: when }], ...(scope === "complete_brand" ? { audienceReviewedAt: when, personalityReviewedAt: when, positioningReviewedAt: when } : {}) },
    ...(scope === "complete_brand" ? { activity: "Neighborhood kitchen", offering: "Seasonal lunches", knownAudience: "Neighbors", reformulationConfirmed: true, competitorReviewComplete: true, audienceSegments: [{ id: uuid("eeeeeeee", 999), label: "Local neighbors", needs: ["A warm lunch"], reason: "Nearby", selected: true, origin: "user" }], personality: { sincerity: 70, excitement: 30, competence: 60, sophistication: 30, ruggedness: 10 }, positioning: "A welcoming everyday kitchen for neighbors." } : {}),
  } });
}
function session(): NamingSession {
  return { ownerId, projectId, revision: 1, currentPreferencesVersion: 0, latestBatchSequence: 0, currentSelectionId: null, viewRevision: 1, viewState: { pane: "results", conversationOpen: true, filter: "all", query: "", visibleBatchId: null, scrollCandidateId: null, workshopCandidateId: null }, createdAt: when, updatedAt: when };
}

async function fixtures(page: Page, scope: ProjectScope = "naming_only") {
  const state = {
    ownerId: ownerId as string | null, project: fixtureProject(scope), session: null as NamingSession | null, preferences: null as NamingPreferenceRevision | null,
    candidates: [] as ProjectNameEntry[], batches: [] as NamingBatchEntry[], jobs: [] as NamingJob[], currentSelection: null as CurrentNameSelection | null,
    available: true, readStatus: 200, mutationStatus: 200, mutationCode: null as string | null, malformedOwner: false, lostEnqueue: false, lostTransform: false, lostRetention: false,
    transforms: new Map<string, unknown>(), names: createEmptyNamesWorkspace(), namesRevision: 1,
    requests: [] as Array<{ path: string; method: string; body: Record<string, unknown> | null }>,
    delay: null as null | { path: string; method: string; ready: boolean; settled: boolean; release: () => void; wait: Promise<void> },
    newProject: null as AccountProject | null,
  };
  function preferences() {
    state.session ??= session();
    state.session.currentPreferencesVersion += 1;
    state.preferences = { ownerId, projectId, version: state.session.currentPreferencesVersion, preferences: initialNamingPreferences(state.project.context), createdAt: when };
    state.session.viewState.conversationOpen = false;
  }
  function enqueue() {
    if (!state.preferences || !state.session) throw new Error("Fixture needs preferences");
    const sequence = state.session.latestBatchSequence + 1, targetCount = namingBatchTarget(sequence);
    const batchId = uuid("cccccccc", sequence), jobId = uuid("ffffffff", sequence);
    const batch = { id: batchId, ownerId, projectId, contextRevision: state.project.current_revision, strategyBasis: namingStrategyBasis(state.project.context), strategyKey: namingStrategyKey(state.project.context), preferencesVersion: state.preferences.version, preferences: namingPreferencesV1Schema.parse(state.preferences.preferences), favoritesSnapshot: state.candidates.filter(entry => entry.retention.favorite).map(entry => ({ candidateId: entry.candidate.id, value: entry.candidate.value })), acceptedPolicyIdentity: policyIdentity, sequence, targetCount, jobId, createdAt: when };
    const job: NamingJob = { id: jobId, owner_id: ownerId, project_id: projectId, operation: "naming.generate", input_revision: state.project.current_revision, state: "queued", progress: 0, error_code: null, cancel_requested_at: null, created_at: when, finished_at: null, billingMode: "chatgpt_subscription", policyIdentity, batchId, sequence, targetCount, results: [] };
    state.session.latestBatchSequence = sequence; state.session.revision += 1;
    state.batches.unshift({ batch, result: null }); state.jobs.unshift(job);
    return { batch, job, session: state.session };
  }
  function complete(count: number, names?: string[]) {
    const item = state.batches[0]!, job = state.jobs[0]!;
    const entries = Array.from({ length: count }, (_, index): ProjectNameEntry => {
      const id = uuid("eeeeeeee", item.batch.sequence * 1000 + index + 1), value = names?.[index] ?? (item.batch.sequence === 1 ? `Fixture ${String(index + 1).padStart(3, "0")}` : `Batch ${item.batch.sequence} name ${index + 1}`);
      return { candidate: { id, ownerId, projectId, value, identityKey: nameIdentityKey(value), rationale: "Synthetic provider rationale: a warm, concise direction.", contextRevision: item.batch.contextRevision, strategyBasis: item.batch.strategyBasis, strategyKey: item.batch.strategyKey, origin: { kind: "generated", ownerId, projectId, candidateId: id, contextRevision: item.batch.contextRevision, value, batchId: item.batch.id, jobId: job.id, stepKey: "response", provider: "openai", billingMode: "chatgpt_subscription", model: "synthetic-model", responseId: `synthetic-response-${item.batch.sequence}`, requestId: null, generatedAt: when }, createdAt: new Date(Date.parse(when) + (item.batch.sequence - 1) * 1_000_000 + index * 1000).toISOString() }, retention: { ownerId, projectId, candidateId: id, revision: 0, favorite: false, saved: false, updatedAt: null } };
    });
    const fulfillment = getNamingFulfillment(item.batch.targetCount, count, emptyNamingRejectionCounts());
    item.result = { ownerId, projectId, batchId: item.batch.id, jobId: job.id, stepKey: "response", candidateIds: entries.map(entry => entry.candidate.id), fulfillment, completedAt: when };
    state.jobs[0] = { ...job, state: "succeeded", progress: 100, finished_at: when, results: [{ stepKey: "response", output: { version: 1, operation: "naming.generate", provider: "openai", billingMode: "chatgpt_subscription", model: "synthetic-model", responseId: `synthetic-response-${item.batch.sequence}`, requestId: null, generatedAt: when, usage: null, batchId: item.batch.id, sequence: item.batch.sequence, targetCount: item.batch.targetCount, accepted: entries.map(entry => ({ value: entry.candidate.value, rationale: entry.candidate.rationale, identityKey: entry.candidate.identityKey })), fulfillment } }] };
    state.candidates.unshift(...entries);
  }
  function batchPage(params = new URLSearchParams()) {
    let rows = [...state.batches].sort((a, b) => a.batch.sequence - b.batch.sequence);
    if (params.get("cursorId")) rows = rows.slice(rows.findIndex(entry => entry.batch.id === params.get("cursorId")) + 1);
    const hasMore = rows.length > 100; rows = rows.slice(0, 100); const last = rows.at(-1)?.batch;
    return { ownerId, projectId, items: rows, nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null };
  }
  function overview(params = new URLSearchParams()) {
    const view = state.session?.viewState;
    const filter = params.get("filter") ?? view?.filter ?? "all", query = params.get("query") ?? view?.query ?? "", batchId = params.get("batchId") ?? view?.visibleBatchId;
    // Match get_project_naming's ascending (created_at, id) cursor order.
    let rows = state.candidates.filter(entry => (filter === "all" || filter === "favorite" && entry.retention.favorite || filter === "saved" && entry.retention.saved || filter === "retained" && (entry.retention.favorite || entry.retention.saved || entry.candidate.id === state.currentSelection?.candidate.id)) && entry.candidate.value.toLowerCase().includes(query.toLowerCase()) && (!batchId || entry.candidate.origin.kind === "generated" && entry.candidate.origin.batchId === batchId))
      .sort((a, b) => a.candidate.createdAt.localeCompare(b.candidate.createdAt) || a.candidate.id.localeCompare(b.candidate.id));
    if (params.get("cursorId")) rows = rows.slice(rows.findIndex(entry => entry.candidate.id === params.get("cursorId")) + 1);
    const hasMore = rows.length > 100; rows = rows.slice(0, 100);
    const last = rows.at(-1)?.candidate;
    const readiness = getNamingReadiness(state.project.context, state.project.scope);
    const data = projectNamingOverviewSchema.parse({ project: state.project, readiness, session: state.session, preferences: state.preferences, currentSelection: state.currentSelection,
      batches: batchPage(), candidates: { ownerId, projectId, items: rows, nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null },
      availability: state.available && readiness.ready ? { status: "available", operation: "naming.generate", billingMode: "chatgpt_subscription", policyIdentity, limits: { ...DEFAULT_SUBSCRIPTION_LIMITS, maxObservedWebSearchCalls: 0 } } : { status: "unavailable", operation: "naming.generate", reason: readiness.ready ? "naming_policy_unavailable" : "strategy_incomplete" }, jobs: state.jobs.slice(0, 20), screening: { domains: { status: "not_checked", reason: "integration_unavailable" }, handles: { status: "not_checked", reason: "integration_unavailable" }, trademarks: { status: "not_checked", reason: "integration_unavailable" } } });
    if (state.malformedOwner && data.candidates.items[0]) return { ...data, candidates: { ...data.candidates, items: [{ ...data.candidates.items[0], retention: { ...data.candidates.items[0].retention, ownerId: otherOwnerId } }] } };
    return data;
  }
  function hold(path: string, method: string) { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); state.delay = { path, method, wait, release, ready: false, settled: false }; }
  async function routeResponse(route: Route, body: unknown, status = 200) {
    const frozen = JSON.stringify(body);
    const delay = state.delay;
    const captured = delay && !delay.ready && delay.path === new URL(route.request().url()).pathname && delay.method === route.request().method();
    if (captured) { delay.ready = true; await delay.wait; }
    await route.fulfill({ status, contentType: "application/json", body: frozen }).catch(() => undefined);
    if (captured) delay.settled = true;
  }
  await page.route("**/api/**", async route => {
    const request = route.request(), target = new URL(request.url()), path = target.pathname, method = request.method();
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    state.requests.push({ path, method, body });
    if (path === "/api/session") return routeResponse(route, state.ownerId ? { user: { id: state.ownerId } } : {}, state.ownerId ? 200 : 401);
    if (!state.ownerId) return routeResponse(route, {}, 401);
    if (path === "/api/names/workspace") {
      if (state.ownerId !== ownerId) return routeResponse(route, { ownerId: state.ownerId, workspace: null });
      if (method === "PUT") { state.names = namesWorkspaceSchema.parse(body!.payload); state.namesRevision = Number(body!.expectedRevision) + 1; }
      return routeResponse(route, { ownerId, workspace: { id: uuid("abababab", 999), ownerId, revision: Math.max(1, state.namesRevision), payload: state.names, createdAt: when, updatedAt: when } });
    }
    if (state.ownerId !== ownerId) return routeResponse(route, {}, 404);
    if (path === "/api/strategy") return routeResponse(route, { availability: { status: "unavailable", operations: [], reason: "runtime_disabled" } });
    if (path === `/api/projects/${projectId}/strategy`) return routeResponse(route, { availability: { status: "unavailable", operations: [], reason: "runtime_disabled" }, jobs: [] });
    if (path === `/api/projects/${projectId}`) return routeResponse(route, { project: state.project });
    if (state.newProject && path === `/api/projects/${state.newProject.id}`) return routeResponse(route, { project: state.newProject });
    if (path === "/api/projects") return routeResponse(route, { projects: [state.project] });
    if (path === "/api/names") {
      let rows = state.candidates.filter(entry => entry.retention.favorite || entry.retention.saved || entry.candidate.id === state.currentSelection?.candidate.id)
        .sort((a, b) => a.candidate.createdAt.localeCompare(b.candidate.createdAt) || a.candidate.id.localeCompare(b.candidate.id));
      if (target.searchParams.get("cursorId")) rows = rows.slice(rows.findIndex(entry => entry.candidate.id === target.searchParams.get("cursorId")) + 1);
      const hasMore = rows.length > 100; rows = rows.slice(0, 100); const last = rows.at(-1)?.candidate;
      return routeResponse(route, { ownerId, items: rows.map(entry => ({ ...entry, project: accountProjectSummarySchema.parse(state.project), earlierContext: entry.candidate.strategyKey !== namingStrategyKey(state.project.context), currentSelection: entry.candidate.id === state.currentSelection?.candidate.id })), nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null });
    }
    if (path === base && method === "GET") return routeResponse(route, state.readStatus === 200 ? overview(target.searchParams) : {}, state.readStatus);
    if (path === `${base}/batches` && method === "GET") return routeResponse(route, batchPage(target.searchParams));
    if (method !== "GET" && state.mutationStatus !== 200) return routeResponse(route, state.mutationCode ? { error: { code: state.mutationCode, message: "Server fixture text must not be rendered." } } : {}, state.mutationStatus);
    if (path === `${base}/preferences`) {
      state.session ??= session();
      if (body?.expectedPreferencesVersion !== state.session.currentPreferencesVersion) return routeResponse(route, {}, 409);
      state.session.currentPreferencesVersion += 1; state.session.revision += 1;
      state.preferences = { ownerId, projectId, version: state.session.currentPreferencesVersion, preferences: body!.preferences as NamingPreferenceRevision["preferences"], createdAt: when };
      return routeResponse(route, { session: state.session, preferences: state.preferences });
    }
    if (path === `${base}/view`) {
      if (!state.session || state.session.viewRevision !== body?.expectedViewRevision) return routeResponse(route, {}, 409);
      state.session.viewState = body.viewState as NamingSession["viewState"]; state.session.viewRevision += 1;
      return routeResponse(route, { session: state.session });
    }
    if (path === `${base}/batches` && method === "POST") {
      const previous = state.batches.find(entry => entry.batch.sequence === Number(body?.expectedBatchSequence) + 1);
      const result = previous ? { batch: previous.batch, job: state.jobs.find(job => job.id === previous.batch.jobId), session: state.session } : enqueue();
      if (state.lostEnqueue) { state.lostEnqueue = false; return route.abort("failed"); }
      return routeResponse(route, result, 202);
    }
    if (path.startsWith(`${base}/batches/`)) {
      const item = state.batches.find(entry => entry.batch.id === path.split("/").at(-1))!;
      const job = state.jobs.find(entry => entry.id === item.batch.jobId)!;
      if (method === "DELETE") { job.state = "cancelled"; job.cancel_requested_at = when; }
      return routeResponse(route, { ...item, job });
    }
    if (path === `${base}/retention`) {
      const entry = state.candidates.find(item => item.candidate.id === body?.candidateId)!;
      if (entry.retention.revision !== body?.expectedRevision) return routeResponse(route, {}, 409);
      entry.retention = { ...entry.retention, favorite: Boolean(body.favorite), saved: Boolean(body.saved), revision: entry.retention.revision + 1, updatedAt: when };
      if (state.lostRetention) { state.lostRetention = false; return routeResponse(route, {}, 503); }
      return routeResponse(route, { entry });
    }
    if (path === `${base}/selection`) {
      const entry = state.candidates.find(item => item.candidate.id === body?.candidateId)!;
      if (state.project.current_revision !== body?.expectedRevision || entry.candidate.strategyKey !== namingStrategyKey(state.project.context) && !body.acceptEarlierContext) return routeResponse(route, {}, 409);
      state.project = { ...state.project, current_revision: state.project.current_revision + 1, context: { ...state.project.context, selectedName: entry.candidate.value, intake: { ...state.project.context.intake, suppliedName: entry.candidate.value } } };
      const selection = { id: uuid("abababab", state.project.current_revision), ownerId, projectId, candidateId: entry.candidate.id, projectRevision: state.project.current_revision, previousSelectionId: state.currentSelection?.selection.id ?? null, acceptedEarlierContext: Boolean(body.acceptEarlierContext), createdAt: when };
      state.currentSelection = { selection, candidate: entry.candidate }; state.session!.currentSelectionId = selection.id;
      return routeResponse(route, { project: state.project, session: state.session, currentSelection: state.currentSelection });
    }
    if (path === `${base}/transforms`) {
      if (state.transforms.has(String(body?.idempotencyKey))) return routeResponse(route, state.transforms.get(String(body?.idempotencyKey)));
      const parent = state.candidates.find(entry => entry.candidate.id === body?.parentCandidateId)!.candidate;
      const input = body!.input as NameTransformInput, output = transformNames(input), transformId = uuid("acacacac", state.requests.length);
      const history = parent.origin.kind === "transform" || parent.origin.kind === "account_copy" ? parent.origin.history : [], root = parent.origin.kind === "transform" || parent.origin.kind === "account_copy" ? parent.origin.root : parent.origin;
      const entries = output.candidates.map((item, index): ProjectNameEntry => {
        const id = uuid("edededed", state.requests.length * 100 + index);
        return { candidate: { ...parent, id, value: item.value, identityKey: nameIdentityKey(item.value), rationale: item.explanation, origin: { kind: "transform", authorship: "user_supplied", algorithmVersion: 1, transformId, parentCandidateId: parent.id, secondaryCandidateId: body?.secondaryCandidateId as string ?? null, root, history: [...history, { transformId, projectId, parentCandidateId: parent.id, secondaryCandidateId: body?.secondaryCandidateId as string ?? null, input, output: item.value, createdAt: when }] } }, retention: { ownerId, projectId, candidateId: id, revision: 0, favorite: false, saved: false, updatedAt: null } };
      });
      state.candidates.unshift(...entries);
      const response = { transform: { id: transformId, ownerId, projectId, parentCandidateId: parent.id, secondaryCandidateId: body?.secondaryCandidateId ?? null, algorithmVersion: 1, input, outputs: output.candidates.map((item, index) => ({ ...item, candidateId: entries[index]!.candidate.id })), truncated: output.truncated, notes: output.notes, createdAt: when }, entries };
      state.transforms.set(String(body?.idempotencyKey), response);
      if (state.lostTransform) { state.lostTransform = false; return route.abort("failed"); }
      return routeResponse(route, response);
    }
    if (path === `${base}/imports`) {
      const source = namingSourceSchema.parse(body?.source), capturedContext = contextSnapshotSchema.parse(body?.capturedContext), id = uuid("bcbcbcbc", state.requests.length);
      state.session ??= session();
      const entry: ProjectNameEntry = { candidate: { id, ownerId, projectId, value: source.value, identityKey: nameIdentityKey(source.value), rationale: "Copied from a browser name with user-supplied context.", contextRevision: state.project.current_revision, strategyBasis: namingStrategyBasis(state.project.context), strategyKey: namingStrategyKey(state.project.context), origin: { kind: "local_import", ownerId, projectId, candidateId: id, contextRevision: state.project.current_revision, source, capturedContext }, createdAt: when }, retention: { ownerId, projectId, candidateId: id, revision: 0, favorite: false, saved: false, updatedAt: null } };
      state.candidates.unshift(entry);
      return routeResponse(route, { entry });
    }
    if (path === `${base}/promote`) {
      const source = state.candidates.find(entry => entry.candidate.id === body?.sourceCandidateId)!.candidate;
      if (body?.expectedSourceProjectRevision !== state.project.current_revision || source.strategyKey !== namingStrategyKey(state.project.context) && !body.acceptEarlierContext) return routeResponse(route, {}, 409);
      const newId = uuid("bdbdbdbd", 1), candidateId = uuid("bdbdbdbd", 2), selectionId = uuid("bdbdbdbd", 3);
      const root = source.origin.kind === "transform" || source.origin.kind === "account_copy" ? source.origin.root : source.origin;
      const history = source.origin.kind === "transform" || source.origin.kind === "account_copy" ? source.origin.history : [];
      state.newProject = { ...state.project, id: newId, scope: "complete_brand", title: source.value, current_revision: 1, context: { ...state.project.context, selectedName: source.value, intake: { ...state.project.context.intake, suppliedName: source.value } } };
      const copied = { ...source, id: candidateId, projectId: newId, contextRevision: 1, origin: { kind: "account_copy", authorship: root.kind === "generated" && history.length === 0 ? "generated" : "user_supplied", sourceProjectId: projectId, sourceCandidateId: source.id, sourceContextRevision: state.project.current_revision, root, history } };
      return routeResponse(route, { project: state.newProject, session: { ...session(), projectId: newId, currentSelectionId: selectionId }, currentSelection: { candidate: copied, selection: { id: selectionId, ownerId, projectId: newId, candidateId, projectRevision: 1, previousSelectionId: null, acceptedEarlierContext: Boolean(body?.acceptEarlierContext), createdAt: when } } });
    }
    if (path === `/api/projects/${projectId}/expand`) { state.project = { ...state.project, scope: "complete_brand", current_revision: state.project.current_revision + 1 }; return routeResponse(route, { project: state.project }); }
    return routeResponse(route, {}, 404);
  });
  return { state, preferences, enqueue, complete, hold };
}
async function prepared(page: Page, count = 3, scope: ProjectScope = "naming_only") { const fixture = await fixtures(page, scope); fixture.preferences(); fixture.enqueue(); fixture.complete(count); return fixture; }
async function open(page: Page) { await page.goto(url); await expect(page.locator(".project-naming-header h1")).toBeVisible(); }
const card = (page: Page, name: string) => page.locator(".project-naming-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
async function localNameFixture(page: Page, fixture: Awaited<ReturnType<typeof fixtures>>) {
  const data = createEmptyNamesWorkspace();
  data.candidates.push({ source: { id: uuid("abababab", 555), value: "Local fixture name", createdAt: when, origin: "manual", history: [] }, context: contextSnapshotSchema.parse({ description: "Browser-only captured context" }), runId: null, explanation: "Added manually", favorite: false, saved: true });
  fixture.state.names = namesWorkspaceSchema.parse(data); fixture.state.namesRevision = 1;
  const raw = JSON.stringify(fixture.state.names);
  await page.addInitScript(value => localStorage.setItem("fluid.names.v1", value), raw);
  return raw;
}

test("naming fixture: reviewed Strategy opens Naming and keeps full context", async ({ page }, info) => {
  const { state } = await fixtures(page, "complete_brand");
  await page.goto(`/brands/account/${projectId}`);
  await page.getByRole("navigation", { name: "Project stages" }).getByRole("link", { name: "Naming", exact: true }).click();
  await expect(page).toHaveURL(url);
  await expect(page.getByRole("form", { name: "Naming preferences" })).toBeVisible();
  await expect(page.getByText(state.project.context.description, { exact: true })).toBeVisible();
  expect(state.requests.filter(request => request.method === "POST")).toHaveLength(0);
  await page.locator("#project-naming-preferences-heading").focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("naming-preferences.png"), fullPage: true, scale: "css" });
});

test("naming fixture: saved complete-brand selection continues to Inspiration without generating images", async ({ page }) => {
  const fixture = await prepared(page, 1, "complete_brand");
  await open(page);
  await expect(page.getByRole("link", { name: "Continue to Inspiration" })).toHaveCount(0);
  await card(page, "Fixture 001").getByRole("button", { name: "Use this name", exact: true }).click();
  await expect(page.getByRole("region", { name: "Name screening" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue to Inspiration" })).toHaveAttribute("href", `/brands/account/${projectId}/inspiration`);
  expect(fixture.state.project.context.selectedName).toBe("Fixture 001");
  expect(fixture.state.requests.filter(request => request.path.includes("/identity/") && request.method !== "GET")).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole("link", { name: "Continue to Inspiration" })).toHaveAttribute("href", `/brands/account/${projectId}/inspiration`);
});

test("naming fixture: preferences collapse, generate250, favorite reload, screening and restore preserve state", async ({ page }, info) => {
  const fixture = await fixtures(page); await open(page);
  await page.getByRole("button", { name: "Continue to names" }).click();
  await expect(page.getByRole("form", { name: "Naming preferences" })).toHaveCount(0);
  await page.getByRole("button", { name: "Generate 250 names", exact: true }).click();
  await expect(page.getByText("Names queued", { exact: true })).toBeVisible();
  fixture.complete(250);
  await expect(page.getByText("Latest batch · 1 · 250 / 250 names", { exact: true })).toBeVisible();
  await expect(page.locator(".project-naming-card")).toHaveCount(100);
  await page.getByRole("button", { name: "Load more saved names" }).click();
  await expect(page.locator(".project-naming-card")).toHaveCount(200);
  await page.getByRole("button", { name: "Load more saved names" }).click();
  await expect(page.locator(".project-naming-card")).toHaveCount(250);
  await expect(page.getByRole("button", { name: "Load more saved names" })).toHaveCount(0);
  expect(fixture.state.candidates).toHaveLength(250);
  await page.locator("#project-naming-results-heading").focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("naming-results-grid.png"), scale: "css" });
  await card(page, "Fixture 001").getByRole("button", { name: "Favorite Fixture 001", exact: true }).click();
  await page.reload();
  await expect(card(page, "Fixture 001").getByRole("button", { name: "Unfavorite Fixture 001", exact: true })).toBeVisible();
  await page.getByLabel("Filter project names").selectOption("favorite");
  await expect(page.locator(".project-naming-card")).toHaveCount(1);
  await card(page, "Fixture 001").getByRole("button", { name: "Use this name", exact: true }).click();
  await expect(page.getByRole("region", { name: "Name screening" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue to Inspiration" })).toHaveCount(0);
  await expect(page.getByText("Not checked here", { exact: true })).toHaveCount(3);
  for (const tool of ["domains", "handles", "trademarks"]) await expect(page.getByRole("region", { name: "Name screening" }).getByRole("link", { name: `Open ${tool}`, exact: true })).toHaveAttribute("href", `/${tool}`);
  await page.locator("#project-naming-screening-heading").focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("naming-screening.png"), fullPage: true, scale: "css" });
  await page.getByRole("button", { name: "Change name", exact: true }).click();
  await expect(page.getByLabel("Filter project names")).toHaveValue("favorite");
  await expect(card(page, "Fixture 001")).toBeFocused();
  expect(fixture.state.candidates[0]!.retention.favorite).toBe(true);
  expect(fixture.state.project.scope).toBe("naming_only");
  expect(fixture.state.project.context.description).toContain("Synthetic brief");
  expect(await page.evaluate(() => localStorage.getItem("fluid.names.v1") ?? "")).not.toContain("Fixture 001");
  await page.locator("#project-naming-results-heading").focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("naming-results.png"), fullPage: true, scale: "css" });
});

test("naming fixture: 250-name batch reloads and 50-name append preserves all 300 names", async ({ page }, info) => {
  const fixture = await prepared(page, 250); await open(page);
  await expect(page.getByText("Latest batch · 1 · 250 / 250 names", { exact: true })).toBeVisible();
  const original = JSON.stringify(fixture.state.candidates);
  await page.getByRole("button", { name: "Load more saved names" }).click();
  await expect(page.locator(".project-naming-card")).toHaveCount(200);
  await page.getByRole("button", { name: "Load more saved names" }).click();
  await expect(page.locator(".project-naming-card")).toHaveCount(250);
  await page.reload();
  await expect(page.getByText("Latest batch · 1 · 250 / 250 names", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Generate 50 more names", exact: true }).click();
  fixture.complete(50);
  await expect(page.getByText("Latest batch · 2 · 50 / 50 names", { exact: true })).toBeVisible();
  expect(JSON.stringify(fixture.state.candidates.filter(entry => entry.candidate.origin.kind === "generated" && entry.candidate.origin.batchId === uuid("cccccccc", 1)))).toBe(original);
  expect(new Set(fixture.state.candidates.map(entry => entry.candidate.identityKey)).size).toBe(300);
  await expect(page.locator(".project-naming-card")).toHaveCount(100);
  await page.getByRole("button", { name: "Load more saved names" }).click();
  await expect(page.locator(".project-naming-card")).toHaveCount(200);
  await page.getByRole("button", { name: "Load more saved names" }).click();
  await expect(page.locator(".project-naming-card")).toHaveCount(300);
  await expect(page.getByRole("button", { name: "Load more saved names" })).toHaveCount(0);
  await page.locator("#project-naming-results-heading").focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("naming-250-plus-50-local-fixture.png"), scale: "css" });
});

test("naming fixture: a completed append remains visible after loading every earlier page without reloading", async ({ page }) => {
  const fixture = await prepared(page, 250); await open(page);
  await page.getByRole("button", { name: "Load more saved names" }).click();
  await expect(page.locator(".project-naming-card")).toHaveCount(200);
  await page.getByRole("button", { name: "Load more saved names" }).click();
  await expect(page.locator(".project-naming-card")).toHaveCount(250);
  await expect(page.getByRole("button", { name: "Load more saved names" })).toHaveCount(0);
  const original = JSON.stringify(fixture.state.candidates);
  await page.getByRole("button", { name: "Generate 50 more names", exact: true }).click();
  await expect(page.getByText("Names queued", { exact: true })).toBeVisible();
  fixture.complete(50);
  await expect(page.locator(".project-naming-card")).toHaveCount(300);
  await expect(card(page, "Batch 2 name 50")).toBeVisible();
  expect(JSON.stringify(fixture.state.candidates.filter(entry => entry.candidate.origin.kind === "generated" && entry.candidate.origin.batchId === uuid("cccccccc", 1)))).toBe(original);
  expect(fixture.state.requests.filter(request => request.path === `${base}/batches` && request.method === "POST")).toHaveLength(1);
});

test("naming fixture: partial transport success stays73/250; modifications apply only to future batches", async ({ page }) => {
  const fixture = await prepared(page, 73); await open(page);
  await expect(page.getByText("Latest batch · 1 · 73 / 250 names · partial", { exact: true })).toBeVisible();
  await expect(page.getByText("Request completed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Modify filters" }).click();
  await page.getByLabel("Style and words to avoid", { exact: false }).fill("A different future direction");
  await page.getByRole("button", { name: "Save for future batches" }).click();
  await expect(page.getByRole("form", { name: "Naming preferences" })).toHaveCount(0);
  expect(fixture.state.batches[0]!.batch.preferences.notes).toBe("Warm and concise");
  expect(fixture.state.candidates).toHaveLength(73);
  await page.getByRole("button", { name: "Generate 50 more names", exact: true }).click();
  expect(fixture.state.batches[0]!.batch.preferences.notes).toBe("A different future direction");
  expect(fixture.state.batches[1]!.batch.preferences.notes).toBe("Warm and concise");
  fixture.complete(50);
  await expect(page.getByText("Latest batch · 2 · 50 / 50 names", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more saved names" }).click();
  await expect(page.locator(".project-naming-card")).toHaveCount(123);
  await page.getByRole("button", { name: "Reopen naming conversation" }).click();
  await expect(page.getByRole("form", { name: "Naming preferences" })).toBeVisible();
  await page.getByRole("button", { name: "Close naming conversation" }).click();
  await page.getByText("Batch history · 2 loaded", { exact: true }).click();
  await expect(page.getByRole("button", { name: /Batch 1 · preferences 1/ })).toBeVisible();
});

test("naming fixture: remote preference versions preserve pending local edits until resolved", async ({ page }) => {
  const fixture = await prepared(page); await open(page);
  await page.getByRole("button", { name: "Modify filters" }).click();
  const notes = page.getByLabel("Style and words to avoid", { exact: false });
  await notes.fill("My unfinished direction");
  fixture.state.preferences = { ...fixture.state.preferences!, version: 2, preferences: { ...fixture.state.preferences!.preferences, notes: "Saved in another tab" } };
  fixture.state.session!.currentPreferencesVersion = 2;
  await card(page, "Fixture 001").getByRole("button", { name: "Favorite Fixture 001", exact: true }).click();
  await expect(page.getByText("A newer preference version is saved", { exact: true })).toBeVisible();
  await expect(notes).toHaveValue("My unfinished direction");
  await expect(page.getByRole("button", { name: "Save for future batches" })).toBeDisabled();
  await page.getByRole("button", { name: "Keep my preference edits" }).click();
  await page.getByRole("button", { name: "Save for future batches" }).click();
  await expect(page.getByRole("form", { name: "Naming preferences" })).toHaveCount(0);
  expect(fixture.state.preferences!.version).toBe(3);
  expect(fixture.state.preferences!.preferences.notes).toBe("My unfinished direction");
  await page.getByRole("button", { name: "Modify filters" }).click();
  await notes.fill("Another local draft");
  fixture.state.preferences = { ...fixture.state.preferences!, version: 4, preferences: { ...fixture.state.preferences!.preferences, notes: "Latest saved direction" } };
  fixture.state.session!.currentPreferencesVersion = 4;
  await card(page, "Fixture 001").getByRole("button", { name: "Unfavorite Fixture 001", exact: true }).click();
  await page.getByRole("button", { name: "Load latest preferences" }).click();
  await expect(notes).toHaveValue("Latest saved direction");
  await expect(page.getByRole("button", { name: "Save for future batches" })).toBeEnabled();
});

test("naming fixture: changed views never label old rows or reuse their pagination cursor", async ({ page }) => {
  const fixture = await prepared(page, 100); fixture.enqueue(); fixture.complete(50); await open(page);
  await expect(card(page, "Batch 2 name 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more saved names" })).toBeVisible();
  fixture.hold(base, "GET");
  await page.getByLabel("Shown batch").selectOption(uuid("cccccccc", 1));
  const held = fixture.state.delay!; await expect.poll(() => held.ready).toBe(true);
  await expect(page.locator(".project-naming-card")).toHaveCount(0);
  await expect(page.getByText("Loading names in this view…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more saved names" })).toHaveCount(0);
  held.release(); await expect.poll(() => held.settled).toBe(true);
  await expect(card(page, "Fixture 001")).toBeVisible();
  await expect(card(page, "Batch 2 name 1")).toHaveCount(0);
  fixture.state.readStatus = 503;
  await page.getByLabel("Shown batch").selectOption(uuid("cccccccc", 2));
  await expect(page.getByText("This list could not be loaded. Check the latest version to try again.", { exact: true })).toBeVisible();
  await expect(page.locator(".project-naming-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load more saved names" })).toHaveCount(0);
  fixture.state.readStatus = 200;
  await page.getByRole("button", { name: "Check latest version" }).click();
  await expect(card(page, "Batch 2 name 1")).toBeVisible();
  await expect(page.locator(".project-naming-card")).toHaveCount(50);
  fixture.state.session!.viewState.visibleBatchId = uuid("cccccccc", 1);
  fixture.state.session!.viewRevision += 1;
  await card(page, "Batch 2 name 1").getByRole("button", { name: "Favorite Batch 2 name 1", exact: true }).click();
  await expect(page.getByLabel("Shown batch")).toHaveValue(uuid("cccccccc", 1));
  await expect(card(page, "Fixture 001")).toBeVisible();
  await expect(card(page, "Batch 2 name 1")).toHaveCount(0);
});

test("naming fixture: a changed strategy requires a fresh earlier-context acknowledgement", async ({ page }) => {
  const fixture = await prepared(page);
  fixture.state.project = { ...fixture.state.project, current_revision: 4, context: { ...fixture.state.project.context, description: "First revised direction" } };
  await open(page);
  await card(page, "Fixture 001").getByRole("button", { name: "Use this name", exact: true }).click();
  await page.getByLabel("I have reviewed this name against the current strategy and want to use it.").check();
  await expect(page.getByRole("button", { name: "Use earlier-context name" })).toBeEnabled();
  fixture.state.project = { ...fixture.state.project, current_revision: 5, context: { ...fixture.state.project.context, description: "Second revised direction" } };
  await card(page, "Fixture 001").getByRole("button", { name: "Favorite Fixture 001", exact: true }).click();
  await expect(page.getByRole("button", { name: "Use earlier-context name" })).toBeDisabled();
  await expect(page.getByLabel("I have reviewed this name against the current strategy and want to use it.")).not.toBeChecked();
  expect(fixture.state.requests.filter(request => request.path === `${base}/selection`)).toHaveLength(0);
});

test("naming fixture: stale names need acknowledgement and restoring creates a new selection without favorites", async ({ page }) => {
  const fixture = await prepared(page); fixture.state.project = { ...fixture.state.project, current_revision: 4, context: { ...fixture.state.project.context, description: "Changed synthetic strategy." } }; await open(page);
  await card(page, "Fixture 001").getByRole("button", { name: "Use this name" }).click();
  await expect(page.getByRole("button", { name: "Use earlier-context name" })).toBeDisabled();
  expect(fixture.state.currentSelection).toBeNull();
  await page.getByRole("checkbox", { name: /I have reviewed this name/ }).check();
  await page.getByRole("button", { name: "Use earlier-context name" }).click();
  await expect(page.getByRole("region", { name: "Name screening" })).toBeVisible();
  const first = fixture.state.currentSelection!.selection.id;
  await page.getByRole("button", { name: "Change name" }).click();
  await card(page, "Fixture 002").getByRole("button", { name: "Use this name" }).click();
  await page.getByRole("checkbox", { name: /I have reviewed this name/ }).check();
  await page.getByRole("button", { name: "Use earlier-context name" }).click();
  await expect(page.getByRole("region", { name: "Name screening" })).toBeVisible();
  expect(fixture.state.currentSelection!.selection.previousSelectionId).toBe(first);
  await page.getByRole("button", { name: "Change name" }).click();
  await card(page, "Fixture 001").getByRole("button", { name: "Use this name" }).click();
  await page.getByRole("checkbox", { name: /I have reviewed this name/ }).check();
  await page.getByRole("button", { name: "Use earlier-context name" }).click();
  await expect(page.getByRole("region", { name: "Name screening" })).toBeVisible();
  expect(fixture.state.currentSelection!.selection.id).not.toBe(first);
  expect(fixture.state.candidates.every(entry => !entry.retention.favorite)).toBe(true);
});

test("naming fixture: cancellation retains prior batches and absent runtime never claims generation", async ({ page }) => {
  const fixture = await prepared(page); fixture.enqueue(); await open(page);
  await page.getByRole("button", { name: "Cancel generation", exact: true }).click();
  await expect(page.getByText("Generation cancelled", { exact: true })).toBeVisible();
  await expect(page.locator(".project-naming-card")).toHaveCount(3);
  fixture.state.available = false; await page.reload();
  await expect(page.getByRole("button", { name: "Generate 50 more names" })).toBeDisabled();
  await expect(page.getByText(/Naming is not enabled for this ChatGPT connection/)).toBeVisible();
});

test("naming fixture: incomplete Strategy and identity-only direct routes never enable naming", async ({ page }) => {
  const fixture = await fixtures(page, "complete_brand"); fixture.state.project.context = contextSnapshotSchema.parse({ description: "Missing strategy fixture" }); await open(page);
  await expect(page.getByText("Strategy needs review", { exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "Naming preferences" })).toHaveCount(0);
  fixture.state.project.scope = "visual_identity_only"; await page.reload();
  await expect(page.getByRole("heading", { name: "This project focuses on visual identity" })).toBeVisible();
  expect(fixture.state.requests.some(request => request.method === "POST")).toBe(false);
});

test("naming fixture: upstream changes while running label the frozen results", async ({ page }) => {
  const fixture = await fixtures(page); fixture.preferences(); fixture.enqueue(); await open(page);
  fixture.state.project = { ...fixture.state.project, current_revision: 4, context: { ...fixture.state.project.context, description: "Changed while generating" } };
  await expect(page.getByText(/The saved project changed after this batch started/)).toBeVisible();
  fixture.complete(3);
  await expect(card(page, "Fixture 001").getByText("Earlier strategy", { exact: true })).toBeVisible();
});

for (const committed of [false, true]) test("naming fixture: workshop favorite 503 reports uncertainty without retry; committed=" + committed, async ({ page }) => {
  const fixture = await prepared(page); await open(page);
  const original = JSON.stringify(fixture.state.candidates);
  await card(page, "Fixture 001").getByText("Origin and tools", { exact: true }).click();
  await card(page, "Fixture 001").getByRole("button", { name: "Use in workshop" }).click();
  await page.getByLabel("Suffixes", { exact: true }).fill("QA");
  await page.getByRole("button", { name: "Run Affixes" }).click();
  await expect(card(page, "Fixture 001QA")).toBeVisible();
  fixture.state.available = false;
  if (committed) fixture.state.lostRetention = true;
  else fixture.state.mutationStatus = 503;
  await card(page, "Fixture 001QA").getByRole("button", { name: "Favorite Fixture 001QA", exact: true }).click();
  await expect(page.getByText("The favorite change could not be confirmed. Check the latest version before trying again.", { exact: true })).toBeVisible();
  expect(JSON.stringify(fixture.state.candidates.filter(entry => entry.candidate.origin.kind === "generated"))).toBe(original);
  expect(fixture.state.candidates.find(entry => entry.candidate.value === "Fixture 001QA")!.retention.favorite).toBe(committed);
  fixture.state.mutationStatus = 200;
  await page.getByRole("button", { name: "Check latest version" }).click();
  await expect(card(page, "Fixture 001QA").getByRole("button", { name: committed ? "Unfavorite Fixture 001QA" : "Favorite Fixture 001QA", exact: true })).toBeVisible();
  expect(fixture.state.requests.filter(request => request.path === `${base}/retention`)).toHaveLength(1);
  expect(fixture.state.requests.filter(request => request.path === `${base}/batches` && request.method === "POST")).toHaveLength(0);
  await page.reload();
  await expect(card(page, "Fixture 001QA").getByRole("button", { name: committed ? "Unfavorite Fixture 001QA" : "Favorite Fixture 001QA", exact: true })).toBeVisible();
});

test("naming fixture: revision conflicts and failed reads retain truthful state", async ({ page }) => {
  const fixture = await prepared(page); fixture.state.mutationStatus = 409; await open(page);
  await card(page, "Fixture 001").getByRole("button", { name: "Favorite Fixture 001", exact: true }).click();
  await expect(page.getByText(/The project or naming workspace changed/)).toBeVisible();
  expect(fixture.state.candidates[0]!.retention.favorite).toBe(false);
  fixture.state.readStatus = 503; await page.reload();
  await expect(page.getByText(/Naming is unavailable right now/)).toBeVisible();
  await expect(page.getByText("Fixture 001", { exact: true })).toHaveCount(0);
});

test("naming fixture: naming history capacity has specific guidance and preserves earlier names", async ({ page }) => {
  const fixture = await prepared(page); await open(page);
  fixture.state.mutationStatus = 409; fixture.state.mutationCode = "naming_history_capacity";
  await page.getByRole("button", { name: "Generate 50 more names" }).click();
  await expect(page.getByText("This project’s naming history has reached the generation limit. Your saved names are preserved.", { exact: true })).toBeVisible();
  await expect(page.getByText("Server fixture text must not be rendered.", { exact: true })).toHaveCount(0);
  await expect(page.locator(".project-naming-card")).toHaveCount(3);
  expect(fixture.state.batches).toHaveLength(1);
});

test("naming fixture: a lost enqueue response recovers the same durable batch", async ({ page }) => {
  const fixture = await fixtures(page); fixture.preferences(); fixture.state.lostEnqueue = true; await open(page);
  await page.getByRole("button", { name: "Generate 250 names" }).click();
  await expect(page.getByText("Names queued", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Names queued", { exact: true })).toBeVisible();
  expect(fixture.state.batches).toHaveLength(1);
  expect(fixture.state.requests.filter(request => request.path === `${base}/batches` && request.method === "POST")).toHaveLength(1);
});

test("naming fixture: malformed nested ownership never renders private candidates", async ({ page }) => {
  const fixture = await prepared(page); fixture.state.malformedOwner = true; await open(page);
  await expect(page.getByText(/The naming response could not be verified/)).toBeVisible();
  await expect(page.getByText("Fixture 001", { exact: true })).toHaveCount(0);
});

test("naming fixture: expired login hides account names", async ({ page }) => {
  const fixture = await prepared(page); await open(page); await expect(card(page, "Fixture 001")).toBeVisible();
  fixture.state.ownerId = null; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText(/No verified account session/)).toBeVisible();
  await expect(page.getByText("Fixture 001", { exact: true })).toHaveCount(0);
});

for (const action of ["overview", "preferences", "view", "retention", "selection", "generation", "cancellation", "transform", "library", "import", "promotion", "candidate pagination", "batch pagination", "library pagination", "expansion"] as const) {
  test(`naming privacy fixture: changed account fences pending ${action}`, async ({ page }) => {
    const fixture = await prepared(page, action === "candidate pagination" || action === "library pagination" ? 100 : 3);
    if (action === "candidate pagination" || action === "library pagination") { fixture.enqueue(); fixture.complete(50); }
    if (action === "batch pagination") for (let index = 0; index < 100; index += 1) { fixture.enqueue(); fixture.complete(1); }
    if (action === "library pagination") for (const entry of fixture.state.candidates) entry.retention = { ...entry.retention, favorite: true, revision: 1, updatedAt: when };
    if (action === "cancellation") fixture.enqueue();
    if (action === "library" || action === "promotion") fixture.state.candidates[0]!.retention = { ...fixture.state.candidates[0]!.retention, revision: 1, favorite: true, updatedAt: when };
    if (action === "import") await localNameFixture(page, fixture);
    if (action === "overview") fixture.hold(base, "GET");
    await open(page);
    const firstName = [...fixture.state.candidates].sort((a, b) => a.candidate.createdAt.localeCompare(b.candidate.createdAt) || a.candidate.id.localeCompare(b.candidate.id))[0]!.candidate.value;
    if (action !== "overview") await expect(card(page, firstName)).toBeVisible();
    if (action === "preferences") { await page.getByRole("button", { name: "Modify filters" }).click(); await expect(page.getByRole("form", { name: "Naming preferences" })).toBeVisible(); fixture.hold(`${base}/preferences`, "PATCH"); await page.getByRole("button", { name: "Save for future batches" }).click(); }
    if (action === "view") { fixture.hold(`${base}/view`, "PATCH"); await page.getByLabel("Filter project names").selectOption("favorite"); }
    if (action === "retention") { fixture.hold(`${base}/retention`, "PATCH"); await card(page, "Fixture 001").getByRole("button", { name: "Favorite Fixture 001", exact: true }).click(); }
    if (action === "selection") { fixture.hold(`${base}/selection`, "POST"); await card(page, "Fixture 001").getByRole("button", { name: "Use this name", exact: true }).click(); }
    if (action === "generation") { fixture.hold(`${base}/batches`, "POST"); await page.getByRole("button", { name: "Generate 50 more names" }).click(); }
    if (action === "cancellation") { fixture.hold(`${base}/batches/${fixture.state.jobs[0]!.batchId}`, "DELETE"); await page.getByRole("button", { name: "Cancel generation" }).click(); }
    if (action === "transform") { await card(page, "Fixture 001").getByText("Origin and tools", { exact: true }).click(); await card(page, "Fixture 001").getByRole("button", { name: "Use in workshop" }).click(); await page.getByLabel("Suffixes", { exact: true }).fill("ly"); fixture.hold(`${base}/transforms`, "POST"); await page.getByRole("button", { name: "Run Affixes" }).click(); }
    if (action === "library") { await page.goto("/names"); fixture.hold("/api/names", "GET"); await page.getByRole("tab", { name: "Library", exact: true }).click(); }
    if (action === "import") { await page.getByText("Copy a name from your library", { exact: true }).click(); await page.getByLabel("Library name to copy").selectOption(uuid("abababab", 555)); fixture.hold(`${base}/imports`, "POST"); await page.getByRole("button", { name: "Copy into this project" }).click(); }
    if (action === "promotion") { await page.goto("/names"); await page.getByRole("tab", { name: "Library", exact: true }).click(); await expect(card(page, "Fixture 001")).toBeVisible(); fixture.hold(`${base}/promote`, "POST"); await card(page, "Fixture 001").getByRole("button", { name: "Create brand" }).click(); }
    if (action === "candidate pagination") { fixture.hold(base, "GET"); await page.getByRole("button", { name: "Load more saved names" }).click(); }
    if (action === "batch pagination") { await page.getByText("Batch history · 100 loaded", { exact: true }).click(); fixture.hold(`${base}/batches`, "GET"); await page.getByRole("button", { name: "Load more batches" }).click(); }
    if (action === "library pagination") { await page.goto("/names"); await page.getByRole("tab", { name: "Library", exact: true }).click(); await expect(card(page, firstName)).toBeVisible(); fixture.hold("/api/names", "GET"); await page.getByRole("button", { name: "Load more account names" }).click(); }
    if (action === "expansion") { fixture.hold(`/api/projects/${projectId}/expand`, "POST"); await page.getByRole("button", { name: "Expand to complete brand" }).click(); }
    // The held response remains addressable after capture so it can return late.
    const held = fixture.state.delay;
    if (held) await expect.poll(() => held.ready).toBe(true);
    // Find the captured delay through an explicit response promise is unnecessary: navigation aborts it;
    // releasing the promise below also tests transports that return after the identity fence.
    fixture.state.ownerId = otherOwnerId;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText(firstName, { exact: true })).toHaveCount(0);
    held?.release();
    if (held) await expect.poll(() => held.settled).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText(firstName, { exact: true })).toHaveCount(0);
    await expect(page.locator(".project-naming-card")).toHaveCount(0);
    await expect(page).not.toHaveURL(new RegExp(`/brands/account/(?!${projectId})`));
  });
}

test("naming fixture: keyboard controls and long names fit desktop and mobile", async ({ page }, info) => {
  const fixture = await fixtures(page); fixture.preferences(); fixture.enqueue(); fixture.complete(2, ["VeryLongSyntheticName".repeat(7), "Courte"]); await open(page);
  await expect(page.locator(".project-naming-card")).toHaveCount(2);
  await page.getByLabel("Filter project names").focus();
  await expect(page.getByLabel("Filter project names")).toBeFocused();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  await page.locator("#project-naming-results-heading").focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("naming-long-names.png"), fullPage: true, scale: "css" });
});

test("naming fixture: a lost workshop response reuses one idempotent run", async ({ page }) => {
  const fixture = await prepared(page); fixture.state.lostTransform = true; await open(page);
  await card(page, "Fixture 001").getByText("Origin and tools", { exact: true }).click();
  await card(page, "Fixture 001").getByRole("button", { name: "Use in workshop" }).click();
  await page.getByLabel("Suffixes", { exact: true }).fill("ly");
  await page.getByRole("button", { name: "Run Affixes" }).click();
  await expect(page.getByText(/The naming workspace could not be reached/)).toBeVisible();
  await page.getByRole("button", { name: "Run Affixes" }).click();
  await expect(page.getByText(/1 workshop results saved/)).toBeVisible();
  const requests = fixture.state.requests.filter(request => request.path === `${base}/transforms`);
  expect(requests).toHaveLength(2);
  expect(requests[0]!.body!.idempotencyKey).toBe(requests[1]!.body!.idempotencyKey);
  expect(fixture.state.candidates.filter(entry => entry.candidate.value === "Fixture 001ly")).toHaveLength(1);
});

test("naming fixture: Blend preserves the chosen immutable parent when two names match", async ({ page }) => {
  const fixture = await prepared(page); await open(page);
  const originalId = fixture.state.candidates[0]!.candidate.id;
  await card(page, "Fixture 002").getByText("Origin and tools", { exact: true }).click();
  await card(page, "Fixture 002").getByRole("button", { name: "Use in workshop" }).click();
  await page.getByRole("radio", { name: /Swap/ }).check();
  await page.getByLabel("Find exact text").fill("002");
  await page.getByLabel("Replace with").fill("001");
  await page.getByRole("button", { name: "Run Swap" }).click();
  await expect(page.getByText(/1 workshop results saved/)).toBeVisible();
  const duplicate = fixture.state.candidates.find(entry => entry.candidate.origin.kind === "transform")!;
  expect(duplicate.candidate.value).toBe("Fixture 001");
  await page.getByRole("button", { name: "Back to names", exact: true }).click();
  await card(page, "Fixture 003").getByText("Origin and tools", { exact: true }).click();
  await card(page, "Fixture 003").getByRole("button", { name: "Use in workshop" }).click();
  await page.getByRole("radio", { name: /Blend/ }).check();
  await page.getByLabel("Second name").selectOption(originalId);
  await expect(page.getByLabel("Second name")).toHaveValue(originalId);
  await page.getByRole("button", { name: "Run Blend" }).click();
  await expect(page.getByText(/1 workshop results saved/)).toBeVisible();
  const request = fixture.state.requests.filter(item => item.path === `${base}/transforms`).at(-1)!;
  expect(request.body!.secondaryCandidateId).toBe(originalId);
  expect(request.body!.secondaryCandidateId).not.toBe(duplicate.candidate.id);
  expect(request.body!.input).toMatchObject({ kind: "blend", right: "Fixture 001" });
  expect(fixture.state.candidates[0]!.candidate.origin).toMatchObject({ kind: "transform", secondaryCandidateId: originalId });
});

for (const field of ["favorite", "saved"] as const) for (const committed of [false, true]) {
  test("naming fixture: account library " + field + " 503 reports uncertainty without retry; committed=" + committed, async ({ page }) => {
    const fixture = await prepared(page);
    fixture.state.candidates[0]!.retention = { ...fixture.state.candidates[0]!.retention, revision: 1, favorite: field === "saved", saved: field === "favorite", updatedAt: when };
    const originals = JSON.stringify(fixture.state.candidates.map(entry => entry.candidate));
    await page.goto("/names"); await page.getByRole("tab", { name: "Library", exact: true }).click();
    await expect(card(page, "Fixture 001")).toBeVisible();
    if (committed) fixture.state.lostRetention = true;
    else fixture.state.mutationStatus = 503;
    await card(page, "Fixture 001").getByRole("button", { name: field === "favorite" ? "Favorite Fixture 001" : "Save", exact: true }).click();
    await expect(page.getByText(field === "favorite"
      ? "The favorite change could not be confirmed. Check the latest version before trying again."
      : "The change to saved names could not be confirmed. Check the latest version before trying again.", { exact: true })).toBeVisible();
    expect(JSON.stringify(fixture.state.candidates.map(entry => entry.candidate))).toBe(originals);
    expect(fixture.state.candidates[0]!.retention[field]).toBe(committed);
    fixture.state.mutationStatus = 200;
    await page.getByRole("button", { name: "Check account names", exact: true }).click();
    await expect(card(page, "Fixture 001").getByRole("button", { name: field === "favorite"
      ? (committed ? "Unfavorite Fixture 001" : "Favorite Fixture 001")
      : (committed ? "Unsave" : "Save"), exact: true })).toBeVisible();
    expect(fixture.state.requests.filter(request => request.path === `${base}/retention`)).toHaveLength(1);
    expect(fixture.state.requests.filter(request => request.path === `${base}/batches` && request.method === "POST")).toHaveLength(0);
    await page.reload(); await page.getByRole("tab", { name: "Library", exact: true }).click();
    await expect(card(page, "Fixture 001").getByRole("button", { name: field === "favorite"
      ? (committed ? "Unfavorite Fixture 001" : "Favorite Fixture 001")
      : (committed ? "Unsave" : "Save"), exact: true })).toBeVisible();
  });
}

test("naming fixture: delayed library reads cannot roll back newer retention", async ({ page }) => {
  const fixture = await prepared(page);
  fixture.state.candidates[0]!.retention = { ...fixture.state.candidates[0]!.retention, revision: 1, favorite: true, saved: true, updatedAt: when };
  await page.goto("/names"); await page.getByRole("tab", { name: "Library", exact: true }).click();
  await expect(card(page, "Fixture 001")).toBeVisible();
  fixture.state.mutationStatus = 409;
  await card(page, "Fixture 001").getByRole("button", { name: "Unfavorite Fixture 001", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check account names" })).toBeVisible();
  fixture.hold("/api/names", "GET");
  await page.getByRole("button", { name: "Check account names" }).click();
  const held = fixture.state.delay!; await expect.poll(() => held.ready).toBe(true);
  fixture.state.mutationStatus = 200;
  await card(page, "Fixture 001").getByRole("button", { name: "Unfavorite Fixture 001", exact: true }).click();
  await expect(card(page, "Fixture 001").getByRole("button", { name: "Favorite Fixture 001", exact: true })).toBeVisible();
  held.release();
  await expect.poll(() => held.settled).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(card(page, "Fixture 001").getByRole("button", { name: "Favorite Fixture 001", exact: true })).toBeVisible();
});

test("naming fixture: library import preserves original and account promotion stays private", async ({ page }) => {
  const fixture = await prepared(page);
  const original = await localNameFixture(page, fixture);
  await open(page);
  await page.getByText("Copy a name from your library", { exact: true }).click();
  await page.getByLabel("Library name to copy").selectOption(uuid("abababab", 555));
  await page.getByRole("button", { name: "Copy into this project" }).click();
  await expect(card(page, "Local fixture name")).toBeVisible();
  expect(fixture.state.currentSelection).toBeNull();
  expect(fixture.state.project.context.description).toContain("Synthetic brief");
  expect(await page.evaluate(() => localStorage.getItem("fluid.names.v1"))).toBe(original);
  await card(page, "Local fixture name").getByRole("button", { name: "Favorite Local fixture name", exact: true }).click();
  await page.goto("/names"); await page.getByRole("tab", { name: "Library", exact: true }).click();
  await expect(card(page, "Local fixture name")).toBeVisible();
  await card(page, "Local fixture name").getByRole("button", { name: "Create brand" }).click();
  await expect(page).toHaveURL(`/brands/account/${uuid("bdbdbdbd", 1)}`);
  expect(fixture.state.newProject!.scope).toBe("complete_brand");
  expect(fixture.state.newProject!.context.selectedName).toBe("Local fixture name");
  expect(await page.evaluate(() => localStorage.getItem("fluid.names.v1"))).toBe(original);
});

test("naming fixture: promoting an earlier-context name requires acknowledgement of the current source revision", async ({ page }) => {
  const fixture = await prepared(page);
  const candidate = fixture.state.candidates[0]!.candidate, originalBasis = JSON.stringify(candidate.strategyBasis);
  fixture.state.candidates[0]!.retention = { ...fixture.state.candidates[0]!.retention, saved: true, revision: 1, updatedAt: when };
  fixture.state.project = { ...fixture.state.project, current_revision: 4, context: { ...fixture.state.project.context, description: "Newer source project direction" } };
  await page.goto("/names"); await page.getByRole("tab", { name: "Library", exact: true }).click();
  await card(page, "Fixture 001").getByRole("button", { name: "Create brand", exact: true }).click();
  await expect(page.getByRole("region", { name: "Create brand confirmation" })).toBeVisible();
  const confirm = page.getByRole("button", { name: "Create brand with this name", exact: true });
  const acknowledgement = page.getByLabel("I have reviewed this name against the project's current context and want to use it.");
  await expect(confirm).toBeDisabled();
  expect(fixture.state.requests.filter(request => request.path === `${base}/promote`)).toHaveLength(0);
  await acknowledgement.check();
  fixture.state.project = { ...fixture.state.project, current_revision: 5, context: { ...fixture.state.project.context, description: "Newest saved source direction" } };
  await confirm.click();
  await expect(page.getByRole("button", { name: "Check account names" })).toBeVisible();
  expect(fixture.state.newProject).toBeNull();
  await page.getByRole("button", { name: "Check account names" }).click();
  await expect(confirm).toBeDisabled();
  await expect(acknowledgement).not.toBeChecked();
  await acknowledgement.check(); await confirm.click();
  await expect(page).toHaveURL(`/brands/account/${uuid("bdbdbdbd", 1)}`);
  const requests = fixture.state.requests.filter(request => request.path === `${base}/promote`);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.body).toMatchObject({ expectedSourceProjectRevision: 5, acceptEarlierContext: true });
  expect(requests[1]!.body!.idempotencyKey).not.toBe(requests[0]!.body!.idempotencyKey);
  expect(fixture.state.newProject!.context.description).toBe("Newest saved source direction");
  expect(JSON.stringify(candidate.strategyBasis)).toBe(originalBasis);
});

test("naming fixture: dirty Strategy memory survives library navigation and blocks direct Naming", async ({ page }) => {
  test.setTimeout(45_000);
  const fixture = await prepared(page, 3, "complete_brand");
  fixture.state.candidates[0]!.retention = { ...fixture.state.candidates[0]!.retention, revision: 1, favorite: true, updatedAt: when };
  const answer = "Keep this unsaved direction for neighborhood families.";
  const patches: string[] = [];
  await page.route(`**/api/projects/${projectId}/strategy`, route => route.request().method() === "GET"
    ? route.fulfill({ json: { availability: { status: "available", operations: [{ operation: "strategy.competitors", maximumCostMicrousd: 10000, interviewVersion: 1 }] }, jobs: [] } })
    : route.fallback());
  await page.route(`**/api/projects/${projectId}`, route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    patches.push(route.request().postData()!);
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto(`/brands/account/${projectId}`);
  await page.getByRole("textbox", { name: "Message Embel", exact: true }).fill(answer);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry save", exact: true })).toBeVisible();
  await expect(page.getByRole("log", { name: "Conversation" }).getByText(answer, { exact: true })).toBeVisible();
  expect(patches).toHaveLength(1);
  const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole("link", { name: "Names", exact: true }).click();
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await card(page, "Fixture 001").getByRole("link", { name: "Synthetic naming project", exact: false }).click();
  await expect(page).toHaveURL(url);
  await expect(page.getByText("Save your Strategy changes first", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate 50 more names" })).toBeDisabled();
  await expect(card(page, "Fixture 001").getByRole("button", { name: "Use this name" })).toBeDisabled();
  await page.getByRole("link", { name: "Back to Strategy", exact: false }).click();
  await expect(page.getByRole("log", { name: "Conversation" }).getByText(answer, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry save", exact: true })).toBeVisible();
  expect(patches).toHaveLength(1);
  expect(fixture.state.requests.filter(request => request.path.endsWith("/strategy") && request.method === "POST")).toHaveLength(0);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));


test("project design: inspecting a name is read-only and selecting remains explicit", async ({ page }, info) => {
  const fixture = await prepared(page, 3, "complete_brand"); await open(page);
  const before = fixture.state.requests.filter(request => request.method !== "GET").length;
  await card(page, "Fixture 001").getByRole("button", { name: "Inspect name Fixture 001", exact: true }).click();
  await expect(page.getByRole("region", { name: "Inspect name", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixture 001", exact: true })).toBeVisible();
  expect(fixture.state.project.context.selectedName).toBeNull();
  expect(fixture.state.requests.filter(request => request.method !== "GET")).toHaveLength(before);
  await expect(page.getByText("Not checked", { exact: true })).toHaveCount(3);
  await page.getByRole("button", { name: "Back to results", exact: true }).click();
  await expect(card(page, "Fixture 001")).toBeVisible();
  await card(page, "Fixture 001").getByRole("button", { name: "Inspect name Fixture 001", exact: true }).click();
  await page.getByRole("region", { name: "Inspect name", exact: true }).getByRole("button", { name: "Use this name", exact: true }).click();
  await expect(page.getByRole("region", { name: "Name screening" })).toBeVisible();
  expect(fixture.state.project.context.selectedName).toBe("Fixture 001");
  await page.screenshot({ path: info.outputPath("project-name-screening.png"), fullPage: true });
});

test("project design: collapsing controls retains the naming preference draft", async ({ page }, info) => {
  await fixtures(page); await open(page);
  const form = page.getByRole("form", { name: "Naming preferences" });
  const textarea = form.locator("textarea");
  await textarea.fill("Synthetic unsaved control draft");
  await page.getByRole("button", { name: "Collapse Naming panel", exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole("button", { name: "Open Naming panel", exact: true }).click();
  await expect(textarea).toHaveValue("Synthetic unsaved control draft");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole("button", { name: "Controls", exact: true }).click();
  await expect(textarea).toHaveValue("Synthetic unsaved control draft");
  const width = page.viewportSize()!.width;
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.screenshot({ path: info.outputPath("project-naming-controls.png"), fullPage: true });
});
