import { expect, test, type Page, type Route } from "@playwright/test";
import { accountProjectSchema, updateProjectInputSchema, type AccountProject } from "../../src/domain/project-api";
import type { ContextSnapshot, GuidedStage, GuidedTurn } from "../../src/domain/projects";
import { guidedReplySchema, type GuidedReply } from "../../src/domain/guided-interview";
import { enqueueStrategyJobSchema, strategyJobSchema, type StrategyJob, type StrategyOperation } from "../../src/domain/strategy-jobs";
import { captureUiEvidence } from "./ui-evidence";

// Dedicated headless-browser fixtures. Every API response is intercepted, and
// non-local requests are blocked before they can reach a host or a provider.
const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const otherOwner = "dddddddd-1111-4111-8111-111111111111";
const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
const when = "2026-10-14T10:00:00Z";
const initialPrompt = "Synthetic brief: a neighborhood kitchen serving seasonal lunches.";
const questions = {
  competitors: "Which brands should we keep as useful comparisons?",
  audience: "Who should this neighborhood kitchen serve first?",
  personality: "How should the brand sound and feel?",
};
const operations = [
  { operation: "strategy.reformulate", maximumCostMicrousd: 122880, interviewVersion: 1 },
  { operation: "strategy.competitors", maximumCostMicrousd: 3142880, interviewVersion: 1 },
  { operation: "strategy.audience", maximumCostMicrousd: 200000, interviewVersion: 1 },
  { operation: "strategy.personality", maximumCostMicrousd: 200000, interviewVersion: 1 },
] as const;
const competitors = [
  { id: "eeeeeeee-1111-4111-8111-000000000001", name: "Table Next Door", relevance: "A local seasonal lunch alternative for the same neighborhood.", url: "https://table.example/", selected: false, origin: "research" as const, sources: [{ url: "https://sources.example/table-profile", title: "Synthetic source: Table Next Door", retrievedAt: when }] },
  { id: "eeeeeeee-1111-4111-8111-000000000002", name: "Everyday Pantry", relevance: "A nearby ready-to-eat option with a different service model.", url: "https://pantry.example/", selected: false, origin: "research" as const, sources: [{ url: "https://sources.example/pantry-profile", title: "Synthetic source: Everyday Pantry", retrievedAt: when }] },
];
const audiences = [
  { id: "ffffffff-1111-4111-8111-000000000001", label: "Nearby office workers", needs: ["A nourishing lunch within a short break", "Clear daily menus"], reason: "Their regular lunch routine fits the kitchen's location and service.", selected: false, origin: "proposal" as const, sources: [] },
  { id: "ffffffff-1111-4111-8111-000000000002", label: "Neighborhood families", needs: ["Flexible takeaway portions", "A welcoming place to stop"], reason: "They can return throughout the week for useful everyday meals.", selected: false, origin: "proposal" as const, sources: [] },
];
const personalities = [
  { id: "warm-guide", label: "The warm guide", profile: { sincerity: 90, excitement: 35, competence: 75, sophistication: 30, ruggedness: 10 }, traits: ["Welcoming", "Practical", "Thoughtful"], toneExample: "Good food, a familiar face, and a little time for yourself.", expression: "Clear menu language with warm, direct invitations." },
  { id: "curious-host", label: "The curious host", profile: { sincerity: 70, excitement: 80, competence: 65, sophistication: 45, ruggedness: 15 }, traits: ["Curious", "Lively", "Open"], toneExample: "Something seasonal is on the table. Come try a bite.", expression: "Playful seasonal discoveries with friendly explanations." },
];

function fixtureProject(guided = true): AccountProject {
  return accountProjectSchema.parse({
    id: projectId, owner_id: owner, title: "Synthetic guided interview", scope: "complete_brand", current_revision: 1, created_at: when,
    context: { description: initialPrompt, intake: { step: "competitors", conversation: [{ id: "initial-prompt", kind: "user_message", text: initialPrompt, createdAt: when }],
      ...(guided ? { guidedInterview: { version: 1, stage: "competitors", turns: [{ id: "initial-research", userMessageId: "initial-prompt", stage: "competitors", purpose: "research", inputRevision: 1 }], answers: [] } } : {}),
    } },
  });
}

function queuedJob(operation: StrategyOperation, revision: number, ordinal: number): StrategyJob {
  return strategyJobSchema.parse({
    id: `cccccccc-1111-4111-8111-${String(ordinal).padStart(12, "0")}`, owner_id: owner, project_id: projectId,
    operation, input_revision: revision, state: "queued", progress: 0,
    reserved_cost_microusd: operations.find(item => item.operation === operation)?.maximumCostMicrousd ?? 200000,
    actual_cost_microusd: 0, error_code: null, cancel_requested_at: null, created_at: when, finished_at: null, results: [],
  });
}

function choiceReply(turn: GuidedTurn): Extract<GuidedReply, { kind: "choices" }> {
  const common = { turnId: turn.id, stage: turn.stage, kind: "choices", message: `Synthetic ${turn.stage} guidance from the saved brief.`, question: questions[turn.stage], selectionMode: turn.stage === "personality" ? "single" : "multiple" };
  const options = turn.stage === "competitors"
    ? competitors.map((payload, index) => ({ id: payload.id, label: payload.name, description: index ? "A useful adjacent example of everyday convenience." : "A close comparison for seasonal lunches and neighborhood familiarity.", stage: "competitors", payload, recommended: index === 0, recommendationReason: index === 0 ? "Its local lunch focus makes the comparison useful for your first decisions." : null }))
    : turn.stage === "audience"
      ? audiences.map((payload, index) => ({ id: payload.id, label: payload.label, description: index ? "Families living within an easy walk." : "People working within a short walk at lunchtime.", stage: "audience", payload, recommended: index === 0, recommendationReason: index === 0 ? "A repeated weekday need can support a focused opening offer." : null }))
      : personalities.map(({ id, label, ...payload }, index) => ({ id, label, description: index ? "An energetic host who makes discovery feel easy." : "A welcoming neighbor who makes good food feel uncomplicated.", stage: "personality", payload, recommended: index === 0, recommendationReason: index === 0 ? "Warmth and practical confidence fit the everyday neighborhood promise." : null }));
  return guidedReplySchema.parse({ ...common, options }) as Extract<GuidedReply, { kind: "choices" }>;
}

function completedJob(job: StrategyJob, guidance?: GuidedReply): StrategyJob {
  const message = guidance?.message ?? "Synthetic saved legacy response.";
  const proposal = job.operation === "strategy.reformulate" ? { message, activity: "Neighborhood kitchen", offering: "Seasonal lunches", knownAudience: "Neighbors", questions: [] }
    : job.operation === "strategy.competitors" ? { message, competitors }
      : job.operation === "strategy.audience" ? { message, segments: audiences }
        : job.operation === "strategy.personality" ? { message, personality: personalities[0]!.profile }
          : { message, positioning: "A synthetic legacy positioning statement." };
  return strategyJobSchema.parse({ ...job, state: "succeeded", progress: 100, finished_at: when, results: [{ stepKey: "response", output: {
    version: 1, provider: "openai", model: "synthetic-guided-model", responseId: `synthetic-${job.id}`, requestId: null, generatedAt: when,
    usage: { inputTokens: 50, outputTokens: 40, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: job.operation === "strategy.competitors" ? 1 : 0 },
    operation: job.operation, proposal, ...(guidance ? { guidance } : {}),
  } }] });
}

async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
}

type FixtureState = {
  project: AccountProject;
  owner: string;
  jobs: StrategyJob[];
  enqueues: ReturnType<typeof enqueueStrategyJobSchema.parse>[];
  patches: ReturnType<typeof updateProjectInputSchema.parse>[];
  creates: unknown[];
  cancels: string[];
  unhandledWrites: string[];
  externalRequests: string[];
  snapshots: Map<number, ContextSnapshot>;
  queueStatus: number;
  queueReplies: number;
  overviewStatus: number;
  overviewReads: number;
  patchStatus: number;
  commitBeforeQueueFailure: boolean;
  enqueueGate: Promise<void> | null;
  pendingReply: GuidedReply | null;
};
const scenarios = new WeakMap<Page, FixtureState>();

async function fixtures(page: Page, { guided = true, seeded = false }: { guided?: boolean; seeded?: boolean } = {}): Promise<FixtureState> {
  const project = fixtureProject(guided);
  const state: FixtureState = {
    project, owner, jobs: seeded ? [completedJob(queuedJob("strategy.competitors", 1, 1), choiceReply(project.context.intake.guidedInterview!.turns[0]!))] : [],
    enqueues: [], patches: [], creates: [], cancels: [], unhandledWrites: [], externalRequests: [], snapshots: new Map([[1, project.context]]),
    queueStatus: 202, queueReplies: 0, overviewStatus: 200, overviewReads: 0, patchStatus: 200, commitBeforeQueueFailure: false, enqueueGate: null, pendingReply: null,
  };
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.hostname !== "127.0.0.1") { state.externalRequests.push(url.origin); return route.abort("blockedbyclient"); }
    if (!path.startsWith("/api/")) return route.continue();
    const availability = { status: "available", operations };
    if (path === "/api/session") return json(route, { user: { id: state.owner } });
    if (path === "/api/strategy") return json(route, { availability });
    if (state.owner !== owner) return json(route, {}, 404);
    if (path === "/api/projects/page") return json(route, { ownerId: owner, items: [], nextCursor: null });
    if (path === "/api/home/attachments/capability") return json(route, { ownerId: owner, policy: null, reason: "Synthetic fixture: file storage unavailable." });
    if (path === `/api/projects/${projectId}/idea-source` || path === `/api/projects/${projectId}/standalone-source`) return json(route, { ownerId: owner, projectId, source: null });
    if (path === `/api/projects/${projectId}/idea-attachments`) return json(route, { ownerId: owner, projectId, items: [], nextCursor: null });
    if (path === "/api/projects" && method === "POST") {
      const body = request.postDataJSON(); state.creates.push(body);
      state.project = accountProjectSchema.parse({ ...body, id: projectId, owner_id: owner, current_revision: 1, created_at: when });
      state.snapshots.set(1, state.project.context);
      return json(route, { project: state.project }, 201);
    }
    if (path === `/api/projects/${projectId}` && method === "GET") return json(route, { project: state.project });
    if (path === `/api/projects/${projectId}` && method === "PATCH") {
      const body = updateProjectInputSchema.parse(request.postDataJSON()); state.patches.push(body);
      if (state.patchStatus !== 200) return json(route, {}, state.patchStatus);
      if (body.expectedRevision !== state.project.current_revision) return json(route, {}, 409);
      state.project = accountProjectSchema.parse({ ...state.project, title: body.title ?? state.project.title, context: body.context, current_revision: state.project.current_revision + 1 });
      state.snapshots.set(state.project.current_revision, state.project.context);
      return json(route, { revision: { project_id: projectId, owner_id: owner, revision: state.project.current_revision, context: state.project.context, input_hash: "synthetic-guided-input", created_at: when } });
    }
    if (path === `/api/projects/${projectId}/strategy` && method === "GET") {
      state.overviewReads += 1;
      return json(route, state.overviewStatus === 200 ? { availability, jobs: state.jobs } : {}, state.overviewStatus);
    }
    if (path === `/api/projects/${projectId}/strategy` && method === "POST") {
      const body = enqueueStrategyJobSchema.parse(request.postDataJSON()); state.enqueues.push(body);
      if (state.queueStatus !== 202 && !state.commitBeforeQueueFailure) return json(route, {}, state.queueStatus);
      if (body.expectedRevision !== state.project.current_revision) return json(route, {}, 409);
      let job = state.jobs.find(item => item.operation === body.operation && item.input_revision === body.expectedRevision);
      if (!job) { job = queuedJob(body.operation, body.expectedRevision, state.jobs.length + 1); state.jobs.push(job); }
      if (state.enqueueGate) await state.enqueueGate;
      if (state.pendingReply) {
        job = completedJob(job, state.pendingReply);
        state.jobs = state.jobs.map(item => item.id === job!.id ? job! : item);
      }
      await json(route, state.queueStatus === 202 ? { job } : {}, state.queueStatus);
      state.queueReplies += 1;
      return;
    }
    const job = state.jobs.find(item => path === `/api/projects/${projectId}/strategy/${item.id}`);
    if (job && method === "GET") return json(route, { job });
    if (job && method === "DELETE") {
      state.cancels.push(job.id);
      const cancelled = strategyJobSchema.parse({ ...job, state: "cancelled", cancel_requested_at: when, finished_at: when });
      state.jobs = state.jobs.map(item => item.id === job.id ? cancelled : item);
      return json(route, { job: cancelled });
    }
    if (!["GET", "HEAD"].includes(method)) state.unhandledWrites.push(`${method} ${path}`);
    return json(route, {}, 404);
  });
  scenarios.set(page, state);
  return state;
}

function currentTurn(state: FixtureState, job = state.jobs.at(-1)!): GuidedTurn {
  const turn = state.snapshots.get(job.input_revision)?.intake.guidedInterview?.turns.find(item => item.inputRevision === job.input_revision);
  if (!turn) throw new Error(`Synthetic request ${job.id} has no saved turn at revision ${job.input_revision}`);
  return turn;
}

function completeLatest(state: FixtureState, reply?: GuidedReply) {
  const job = state.jobs.at(-1)!;
  state.jobs[state.jobs.length - 1] = completedJob(job, reply ?? choiceReply(currentTurn(state, job)));
}

async function openProject(page: Page) {
  await page.goto(`/brands/account/${projectId}`);
}

async function openHomeAndSend(page: Page) {
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/strategy" && response.request().method() === "GET"),
    page.goto("/"),
  ]);
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(initialPrompt);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
}

function widget(page: Page, stage: GuidedStage) {
  return page.getByRole("group", { name: questions[stage], exact: true });
}

async function expectSingleWidget(page: Page, stage: GuidedStage) {
  await expect(widget(page, stage)).toBeVisible();
  await expect(page.locator("fieldset.guided-choice-widget")).toHaveCount(1);
}

async function expectReplyArrivalInViewport(page: Page, stage: GuidedStage, firstChoiceLabel: string) {
  // Assert before any interaction: Playwright clicks/focus would otherwise hide
  // a scroll regression by bringing an offscreen question or card into view.
  await expectSingleWidget(page, stage);
  await expect(page.locator(".project-workspace-header")).toBeInViewport({ ratio: 1 });
  const question = widget(page, stage).locator("h3");
  await expect(question).toHaveText(questions[stage]);
  await expect(question).toBeInViewport({ ratio: 1 });
  await expect(widget(page, stage).getByText(firstChoiceLabel, { exact: true })).toBeInViewport({ ratio: 1 });
}

async function expectRequest(state: FixtureState, count: number, operation: StrategyOperation) {
  await expect.poll(() => state.enqueues.length).toBe(count);
  const enqueue = state.enqueues.at(-1)!;
  expect(enqueue).toMatchObject({ operation, expectedRevision: state.project.current_revision });
  const turn = currentTurn(state);
  expect(turn.inputRevision).toBe(enqueue.expectedRevision);
  expect(turn.purpose === "message" ? "strategy.reformulate" : `strategy.${turn.stage}`).toBe(operation);
}

async function expectNoLegacyClutter(page: Page) {
  await expect(page.getByRole("navigation", { name: "Project stages", exact: true })).toHaveCount(0);
  await expect(page.getByText("Project details and saving", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Project context", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Apply (response|competitor research|audience proposal|personality proposal)$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "View latest AI activity", exact: true })).toHaveCount(0);
  await expect(page.locator(".conversation-result-navigation, .strategy-proposal-details, .project-details-disclosure")).toHaveCount(0);
  await expect(page.getByText(/Sending uses OpenAI|Reserved limit|OpenAI is processing this saved version|Step [1-4] of 4/)).toHaveCount(0);
}

async function expectComposerInViewport(page: Page) {
  const composer = page.getByRole("textbox", { name: "Message Embel", exact: true });
  await expect(composer).toBeVisible();
  const send = page.getByRole("button", { name: "Send prompt", exact: true });
  await expect(send).toBeVisible();
  const bounds = await send.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBe(44);
  expect(bounds!.height).toBe(44);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("guided interview: Home sends research and keeps the original mark pending until the durable result", async ({ page }, info) => {
  const state = await fixtures(page);
  await openHomeAndSend(page);
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectId}$`));
  await expectRequest(state, 1, "strategy.competitors");
  expect(state.creates).toHaveLength(1);
  expect(state.project.context.description).toBe(initialPrompt);
  expect(state.project.context.intake.guidedInterview).toMatchObject({ version: 1, stage: "competitors", answers: [] });
  const loading = page.getByRole("region", { name: "Researching your competitors", exact: true });
  await expect(loading).toBeVisible();
  await expect(loading.locator('img[src="/embel-mark.svg"]')).toBeVisible();
  await expect.poll(() => loading.locator('img[src="/embel-mark.svg"]').evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await expect(page.getByRole("button", { name: "Cancel research", exact: true })).toBeEnabled();
  await expect(page.locator("fieldset.guided-choice-widget")).toHaveCount(0);
  await expect(loading.locator(".guided-research-mark-motion")).not.toHaveCSS("animation-name", "none");
  await page.screenshot({ path: info.outputPath("guided-research-pending.png"), fullPage: true, scale: "css" });
  state.jobs[0] = strategyJobSchema.parse({ ...state.jobs[0], state: "running", progress: 40 });
  await page.reload();
  await expect(loading).toBeVisible();
  expect(state.enqueues).toHaveLength(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(loading.locator(".guided-research-mark-motion")).toHaveCSS("animation-name", "none");
  completeLatest(state);
  await expectReplyArrivalInViewport(page, "competitors", "Table Next Door");
  await page.screenshot({ path: info.outputPath("guided-competitor-arrival-viewport.png"), scale: "css" });
  await expect(loading).toHaveCount(0);
  await expect(widget(page, "competitors").getByRole("checkbox", { checked: true })).toHaveCount(0);
  await expect(widget(page, "competitors").getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await expect(widget(page, "competitors").getByText("Recommended", { exact: true })).toHaveCount(1);
  await expect(widget(page, "competitors").getByText("Why we recommend it", { exact: true })).toBeVisible();
  const references = page.getByRole("group", { name: "References for Table Next Door", exact: true });
  await expect(references.getByRole("link", { name: /Visit website/ })).toHaveAttribute("href", "https://table.example/");
  await expect(references.getByRole("link", { name: /Synthetic source: Table Next Door/ })).toHaveAttribute("href", "https://sources.example/table-profile");
  await expectNoLegacyClutter(page);
  await expectComposerInViewport(page);
  await page.screenshot({ path: info.outputPath("guided-competitor-choices.png"), fullPage: true, scale: "css" });
  expect(state.enqueues).toHaveLength(1);
  expect(state.externalRequests).toEqual([]); expect(state.unhandledWrites).toEqual([]);
});

test("guided interview: explicit selections save, reload, and finish at personality", async ({ page }, info) => {
  const state = await fixtures(page, { seeded: true });
  await openProject(page);
  await expectSingleWidget(page, "competitors");
  const firstChoice = widget(page, "competitors").getByRole("checkbox", { name: "Table Next Door", exact: true });
  await firstChoice.focus(); await page.keyboard.press("Space");
  await expect(firstChoice).toBeChecked();
  expect(state.enqueues).toHaveLength(0); expect(state.patches).toHaveLength(0);
  await widget(page, "competitors").getByRole("button", { name: "Continue", exact: true }).click();
  await expectRequest(state, 1, "strategy.audience");
  expect(state.project.context.competitorReviewComplete).toBe(true);
  expect(state.project.context.competitors.filter(item => item.selected).map(item => item.id)).toEqual([competitors[0]!.id]);
  expect(state.project.context.intake.guidedInterview?.answers[0]).toMatchObject({ stage: "competitors", optionIds: [competitors[0]!.id], customText: null });
  await page.reload();
  await expect(page.getByRole("button", { name: `Edit your answer: ${questions.competitors}`, exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(1);
  completeLatest(state);
  await expectReplyArrivalInViewport(page, "audience", "Nearby office workers");
  await page.screenshot({ path: info.outputPath("guided-audience-arrival-viewport.png"), scale: "css" });
  await expect(widget(page, "audience").getByRole("checkbox", { checked: true })).toHaveCount(0);
  await expect(widget(page, "audience").getByText("A nourishing lunch within a short break · Clear daily menus", { exact: true })).toBeVisible();
  await widget(page, "audience").getByRole("checkbox", { name: "Nearby office workers", exact: true }).check();
  await widget(page, "audience").getByRole("checkbox", { name: "Neighborhood families", exact: true }).check();
  await widget(page, "audience").getByRole("button", { name: "Continue", exact: true }).click();
  await expectRequest(state, 2, "strategy.personality");
  expect(state.project.context.audienceSegments.filter(item => item.selected)).toHaveLength(2);
  expect(state.project.context.intake.audienceReviewedAt).not.toBeNull();
  completeLatest(state);
  await expectReplyArrivalInViewport(page, "personality", "The warm guide");
  await page.screenshot({ path: info.outputPath("guided-personality-arrival-viewport.png"), scale: "css" });
  await expect(widget(page, "personality").getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(widget(page, "personality").getByText("Example tone", { exact: true })).toHaveCount(2);
  await widget(page, "personality").getByRole("radio", { name: "The warm guide", exact: true }).check();
  await widget(page, "personality").getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => state.project.context.intake.guidedInterview?.stage).toBe("complete");
  await expect(page.getByText("Your brand strategy is saved. You can revisit any answer above.", { exact: true })).toBeVisible();
  expect(state.project.context.personality).toEqual(personalities[0]!.profile);
  expect(state.project.context.intake.personalityReviewedAt).not.toBeNull();
  expect(state.project.context.intake.guidedInterview?.answers.map(answer => answer.stage)).toEqual(["competitors", "audience", "personality"]);
  await expect(page.locator("fieldset.guided-choice-widget")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: `Edit your answer: ${questions.personality}`, exact: true })).toBeVisible();
  await expect(page.getByText(initialPrompt, { exact: true })).toBeVisible();
  await expectComposerInViewport(page);
  await expectNoLegacyClutter(page);
  expect(state.enqueues.map(item => item.operation)).toEqual(["strategy.audience", "strategy.personality"]);
  expect(state.unhandledWrites).toEqual([]);
  const savedReviews = { audience: state.project.context.intake.audienceReviewedAt, personality: state.project.context.intake.personalityReviewedAt };
  await page.getByRole("textbox", { name: "Message Embel", exact: true }).fill("Why is the warm guide a useful tone for this kitchen?");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expectRequest(state, 3, "strategy.reformulate");
  expect(state.project.context.intake.guidedInterview?.answers).toHaveLength(3);
  const clarificationTurn = currentTurn(state);
  completeLatest(state, guidedReplySchema.parse({ kind: "answer", turnId: clarificationTurn.id, stage: clarificationTurn.stage, message: "Synthetic clarification: a warm, practical tone makes an everyday visit feel easy." }));
  await expect(page.getByText("Synthetic clarification: a warm, practical tone makes an everyday visit feel easy.", { exact: true })).toBeVisible();
  await expect.poll(() => state.project.context.intake.guidedInterview?.stage).toBe("complete");
  expect(state.project.context.intake.audienceReviewedAt).toBe(savedReviews.audience);
  expect(state.project.context.intake.personalityReviewedAt).toBe(savedReviews.personality);
  expect(state.project.context.intake.guidedInterview?.answers).toHaveLength(3);
  await page.reload();
  await expect(page.getByText("Your brand strategy is saved. You can revisit any answer above.", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(3);
  await page.screenshot({ path: info.outputPath("guided-interview-complete.png"), fullPage: true, scale: "css" });
  await page.getByRole("button", { name: `Edit your answer: ${questions.competitors}`, exact: true }).click();
  await expectRequest(state, 4, "strategy.competitors");
  expect(state.project.context.intake.guidedInterview?.stage).toBe("competitors");
  expect(state.project.context.intake.guidedInterview?.answers).toEqual([]);
  expect(state.project.context.competitorReviewComplete).toBe(false);
  expect(state.project.context.intake.audienceReviewedAt).toBeNull();
  expect(state.project.context.intake.personalityReviewedAt).toBeNull();
  expect(state.project.context.personality).toEqual(personalities[0]!.profile);
  expect(state.jobs.filter(job => job.state === "succeeded")).toHaveLength(4);
  completeLatest(state);
  await expectSingleWidget(page, "competitors");
  await widget(page, "competitors").getByRole("checkbox", { name: "Everyday Pantry", exact: true }).check();
  await widget(page, "competitors").getByRole("button", { name: "Continue", exact: true }).click();
  await expectRequest(state, 5, "strategy.audience");
  expect(state.project.context.competitors.filter(item => item.selected).map(item => item.id)).toEqual([competitors[1]!.id]);
  expect(state.project.context.intake.audienceReviewedAt).toBeNull();
  expect(state.enqueues.some(item => item.operation === "strategy.positioning")).toBe(false);
});

test("guided interview: a clear custom answer saves its interpreted decision and requests only the next stage", async ({ page }) => {
  const state = await fixtures(page, { seeded: true });
  await openProject(page); await expectSingleWidget(page, "competitors");
  const answer = "Use the neighborhood cooperative as our only comparison.";
  await page.getByRole("textbox", { name: "Message Embel", exact: true }).fill(answer);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expectRequest(state, 1, "strategy.reformulate");
  const turn = currentTurn(state);
  expect(turn).toMatchObject({ stage: "competitors", purpose: "message" });
  expect(state.project.context.intake.conversation).toEqual(expect.arrayContaining([expect.objectContaining({ id: turn.userMessageId, kind: "user_message", text: answer })]));
  const selected = { id: "eeeeeeee-1111-4111-8111-000000000003", name: "Neighborhood cooperative", relevance: "The user's preferred local comparison.", selected: false, origin: "user" as const, sources: [] };
  completeLatest(state, guidedReplySchema.parse({ kind: "accepted", turnId: turn.id, stage: turn.stage, message: "Synthetic acceptance: I will use the neighborhood cooperative as your comparison.", selection: { stage: "competitors", competitors: [selected] }, customText: answer }));
  await expectRequest(state, 2, "strategy.audience");
  expect(state.project.context.competitors.filter(item => item.selected)).toEqual([{ ...selected, selected: true }]);
  expect(state.project.context.intake.guidedInterview?.answers[0]).toMatchObject({ stage: "competitors", turnId: turn.id, optionIds: [], customText: answer });
  await page.reload();
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(2);
  completeLatest(state);
  await expectSingleWidget(page, "audience");
  expect(state.unhandledWrites).toEqual([]);
});

for (const kind of ["answer", "question"] as const) test(`guided interview: a clarification ${kind} keeps the current stage and never approves a choice`, async ({ page }) => {
  const state = await fixtures(page, { seeded: true });
  await openProject(page); await expectSingleWidget(page, "competitors");
  await page.getByRole("textbox", { name: "Message Embel", exact: true }).fill("Why is Table Next Door a useful comparison?");
  await page.getByRole("textbox", { name: "Message Embel", exact: true }).press("Enter");
  await expectRequest(state, 1, "strategy.reformulate");
  const turn = currentTurn(state);
  const message = "Synthetic clarification: its weekday service overlaps with your proposed lunch offer.";
  completeLatest(state, guidedReplySchema.parse({ kind, turnId: turn.id, stage: turn.stage, message, ...(kind === "question" ? { question: "Should the comparison focus on service or on menu variety?" } : {}) }));
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  if (kind === "question") await expect(page.getByText("Should the comparison focus on service or on menu variety?", { exact: true })).toBeVisible();
  expect(state.project.context.intake.guidedInterview?.stage).toBe("competitors");
  expect(state.project.context.intake.guidedInterview?.answers).toEqual([]);
  expect(state.project.context.competitorReviewComplete).toBe(false);
  expect(state.project.context.competitors.some(item => item.selected)).toBe(false);
  await page.reload();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(1);
  await expectComposerInViewport(page);
  await expectSingleWidget(page, "competitors");
  await widget(page, "competitors").getByRole("checkbox", { name: "Table Next Door", exact: true }).check();
  await widget(page, "competitors").getByRole("button", { name: "Continue", exact: true }).click();
  await expectRequest(state, 2, "strategy.audience");
  expect(state.project.context.intake.guidedInterview?.answers[0]).toMatchObject({ turnId: "initial-research", optionIds: [competitors[0]!.id] });
  expect(state.project.context.intake.conversation).toEqual(expect.arrayContaining([expect.objectContaining({ text: "Why is Table Next Door a useful comparison?" })]));
  expect(state.unhandledWrites).toEqual([]);
});

for (const errorCode of ["provider_error", "operator_abandoned_billing_unresolved"]) test(`guided interview: failed research (${errorCode}) retains the prompt and explicit retry starts a new saved turn`, async ({ page }) => {
  const state = await fixtures(page);
  state.jobs = [strategyJobSchema.parse({ ...queuedJob("strategy.competitors", 1, 1), state: "failed", error_code: errorCode, finished_at: when })];
  await openProject(page);
  await expect(page.getByText(initialPrompt, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Researching your competitors", exact: true })).toHaveCount(0);
  await expect(page.locator("fieldset.guided-choice-widget")).toHaveCount(0);
  expect(state.enqueues).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry research", exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(0);
  expect(state.project.current_revision).toBe(1);
  await page.getByRole("button", { name: "Retry research", exact: true }).click();
  await expectRequest(state, 1, "strategy.competitors");
  expect(currentTurn(state).id).not.toBe("initial-research");
  expect(state.project.context.intake.guidedInterview?.turns).toHaveLength(2);
  await expect(page.getByRole("heading", { name: "Researching your competitors", exact: true })).toBeVisible();
  completeLatest(state);
  await expectSingleWidget(page, "competitors");
  expect(state.project.context.description).toBe(initialPrompt);
});

test("guided interview: cancellation follows the job and never fabricates completed research", async ({ page }) => {
  const state = await fixtures(page);
  state.jobs = [queuedJob("strategy.competitors", 1, 1)];
  await openProject(page);
  await expect(page.getByRole("heading", { name: "Researching your competitors", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel research", exact: true }).click();
  await expect.poll(() => state.cancels.length).toBe(1);
  await expect(page.getByRole("heading", { name: "Researching your competitors", exact: true })).toHaveCount(0);
  await expect(page.getByText(initialPrompt, { exact: true })).toBeVisible();
  await expect(page.getByText(/cancelled/i)).toBeVisible();
  await expect(page.locator("fieldset.guided-choice-widget")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(/cancelled/i)).toBeVisible();
  expect(state.enqueues).toHaveLength(0);
  expect(state.project.context.intake.guidedInterview?.answers).toEqual([]);
});

test("guided interview: active research polling failure keeps status recovery in the viewport", async ({ page }, info) => {
  const state = await fixtures(page);
  state.jobs = [queuedJob("strategy.competitors", 1, 1)];
  await openProject(page);
  const loading = page.getByRole("region", { name: "Researching your competitors", exact: true });
  await expect(loading).toBeVisible();
  expect(state.overviewReads).toBeGreaterThan(0);
  state.overviewStatus = 503;
  const error = page.getByRole("alert").filter({ hasText: "Research status could not be checked. Your prompt is saved." });
  const checkStatus = page.getByRole("button", { name: "Check status", exact: true });
  await expect(error).toBeVisible();
  await expect(loading).toBeVisible();
  await expect(error).toBeInViewport({ ratio: 1 });
  await expect(checkStatus).toBeInViewport({ ratio: 1 });
  await expect(checkStatus).toBeEnabled();
  await page.screenshot({ path: info.outputPath("guided-research-status-recovery-viewport.png"), scale: "css" });
  expect(state.enqueues).toHaveLength(0);
  const readsBeforeRecovery = state.overviewReads;
  state.overviewStatus = 200;
  await checkStatus.click();
  await expect.poll(() => state.overviewReads).toBeGreaterThan(readsBeforeRecovery);
  await expect(error).toHaveCount(0);
  await expect(loading).toBeVisible();
  completeLatest(state);
  await expectReplyArrivalInViewport(page, "competitors", "Table Next Door");
  expect(state.enqueues).toHaveLength(0);
  expect(state.jobs).toHaveLength(1);
});

test("guided interview: an uncertain provider outcome offers status recovery without another request", async ({ page }) => {
  const state = await fixtures(page);
  state.jobs = [strategyJobSchema.parse({ ...queuedJob("strategy.competitors", 1, 1), state: "needs_reconciliation", error_code: "provider_outcome_uncertain" })];
  await openProject(page);
  await expect(page.getByText(initialPrompt, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Researching your competitors", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Retry research|Retry request/, exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  expect(state.enqueues).toHaveLength(0);
  completeLatest(state);
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expectSingleWidget(page, "competitors");
  expect(state.enqueues).toHaveLength(0);
});

test("guided interview: a verified saved reply clears a lost acknowledgement warning without resending", async ({ page }) => {
  const state = await fixtures(page, { seeded: true });
  let release!: () => void;
  state.enqueueGate = new Promise<void>(resolve => { release = resolve; });
  state.queueStatus = 500;
  state.commitBeforeQueueFailure = true;
  await openProject(page);
  await expectSingleWidget(page, "competitors");
  await page.getByRole("textbox", { name: "Message Embel", exact: true }).fill("Why are these useful comparisons?");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expectRequest(state, 1, "strategy.reformulate");
  const message = "Synthetic clarification: these comparisons address a similar everyday lunch need.";
  state.pendingReply = guidedReplySchema.parse({ kind: "answer", turnId: currentTurn(state).id, stage: "competitors", message });
  state.overviewStatus = 503;
  release();
  const warning = page.getByRole("alert").filter({ hasText: "The strategy request could not be confirmed." });
  await expect(warning).toBeVisible();
  expect(state.enqueues).toHaveLength(1);
  expect(state.jobs).toHaveLength(2);
  const originalJob = state.jobs.at(-1)!.id;
  state.overviewStatus = 200;
  await warning.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(warning).toHaveCount(0);
  expect(state.enqueues).toHaveLength(1);
  expect(state.jobs.at(-1)!.id).toBe(originalJob);
  await page.reload();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(warning).toHaveCount(0);
  expect(state.enqueues).toHaveLength(1);
});

test("guided interview: a selection save conflict retains the decision and blocks the next request", async ({ page }) => {
  const state = await fixtures(page, { seeded: true }); state.patchStatus = 409;
  await openProject(page); await expectSingleWidget(page, "competitors");
  await widget(page, "competitors").getByRole("checkbox", { name: "Table Next Door", exact: true }).check();
  await widget(page, "competitors").getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("A newer version is saved in your account.", { exact: true })).toBeVisible();
  expect(state.patches).toHaveLength(1); expect(state.enqueues).toHaveLength(0);
  expect(state.project.current_revision).toBe(1);
  expect(state.patches[0]!.context.intake.guidedInterview?.answers[0]).toMatchObject({ optionIds: [competitors[0]!.id] });
  await expect(page.getByText(initialPrompt, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load latest version", exact: true })).toBeVisible();
});

test("guided interview: a lost queue acknowledgement recovers the existing research without duplicate admission", async ({ page }) => {
  const state = await fixtures(page); state.queueStatus = 503; state.commitBeforeQueueFailure = true;
  await openHomeAndSend(page);
  await expect.poll(() => state.enqueues.length).toBe(1);
  await expect(page.getByRole("link", { name: /Open saved account project.*status/ })).toBeVisible();
  state.queueStatus = 202;
  await page.getByRole("link", { name: /Open saved account project.*status/ }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectId}$`));
  await expect(page.getByRole("heading", { name: "Researching your competitors", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Researching your competitors", exact: true })).toBeVisible();
  expect(state.creates).toHaveLength(1); expect(state.enqueues).toHaveLength(1); expect(state.jobs).toHaveLength(1);
  completeLatest(state); await expectSingleWidget(page, "competitors");
  expect(state.enqueues).toHaveLength(1);
});

test("guided interview: opening a legacy project keeps its original response and never enrolls it automatically", async ({ page }) => {
  const state = await fixtures(page, { guided: false });
  state.jobs = [completedJob(queuedJob("strategy.reformulate", 1, 1))];
  await openProject(page);
  await expect(page.getByText(initialPrompt, { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic saved legacy response.", { exact: true })).toBeVisible();
  expect(state.project.context.intake.guidedInterview).toBeUndefined();
  expect(state.enqueues).toHaveLength(0); expect(state.patches).toHaveLength(0);
  await page.reload();
  await expect(page.getByText("Synthetic saved legacy response.", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(0); expect(state.patches).toHaveLength(0);
  await expect(page.getByRole("heading", { name: "Researching your competitors", exact: true })).toHaveCount(0);
});

for (const mismatch of ["turn", "revision"] as const) test(`guided interview: a result with the wrong ${mismatch} cannot become the current decision`, async ({ page }) => {
  const state = await fixtures(page);
  const savedTurn = state.project.context.intake.guidedInterview!.turns[0]!;
  const reply = choiceReply(savedTurn);
  const invalid = { ...reply, ...(mismatch === "turn" ? { turnId: "unrelated-turn" } : {}), message: "Synthetic unrelated result must remain hidden." };
  state.jobs = [completedJob(queuedJob("strategy.competitors", mismatch === "revision" ? 2 : 1, 1), invalid)];
  if (mismatch === "revision") state.jobs.unshift(strategyJobSchema.parse({ ...queuedJob("strategy.competitors", 1, 2), state: "needs_reconciliation", error_code: "provider_outcome_uncertain" }));
  await openProject(page);
  await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic unrelated result must remain hidden.", { exact: true })).toHaveCount(0);
  await expect(page.locator("fieldset.guided-choice-widget")).toHaveCount(0);
  expect(state.enqueues).toHaveLength(0); expect(state.patches).toHaveLength(0);
  expect(state.project.context.intake.guidedInterview?.answers).toEqual([]);
});

test("guided interview: an account change hides a delayed reply and clears the prior owner's message", async ({ page }) => {
  const state = await fixtures(page, { seeded: true });
  await openProject(page); await expectSingleWidget(page, "competitors");
  let release!: () => void;
  state.enqueueGate = new Promise<void>(resolve => { release = resolve; });
  const privateMessage = "Synthetic private message from the previous account.";
  await page.getByRole("textbox", { name: "Message Embel", exact: true }).fill(privateMessage);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect.poll(() => state.enqueues.length).toBe(1);
  await expect(page.getByText(privateMessage, { exact: true })).toBeVisible();
  const turn = currentTurn(state);
  state.pendingReply = guidedReplySchema.parse({ kind: "answer", turnId: turn.id, stage: turn.stage, message: "Synthetic private delayed assistant answer." });
  state.owner = otherOwner;
  try {
    // Returning to the tab verifies the active account, including an account
    // changed in another tab. Keep the old response pending across this fence.
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/session" && response.request().method() === "GET"),
      page.evaluate(() => window.dispatchEvent(new Event("focus"))),
    ]);
    await expect(page.getByText("This project is not available to this account.", { exact: true })).toBeVisible();
  } finally { release(); }
  await expect.poll(() => state.queueReplies).toBe(1);
  await expect(page.getByText("This project is not available to this account.", { exact: true })).toBeVisible();
  await expect(page.getByText(privateMessage, { exact: true })).toHaveCount(0);
  await expect(page.getByText("Synthetic private delayed assistant answer.", { exact: true })).toHaveCount(0);
  await expect(page.getByText(initialPrompt, { exact: true })).toHaveCount(0);
  await expect(page.locator("fieldset.guided-choice-widget")).toHaveCount(0);
  expect(state.enqueues).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"))).toBeNull();
});

test.afterEach(async ({ page }, info) => {
  const state = scenarios.get(page);
  if (state) {
    expect(state.externalRequests, "No remote request should be attempted by the synthetic workflow").toEqual([]);
    expect(state.unhandledWrites, "Every browser mutation must use an intercepted fixture route").toEqual([]);
  }
  await captureUiEvidence(page, info);
});
