import { captureUiEvidence } from "./ui-evidence";
import { expect, test, type Page, type Route } from "@playwright/test";
import { accountProjectSchema } from "../../src/domain/project-api";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { strategyJobSchema, type StrategyJob, type StrategyOperation } from "../../src/domain/strategy-jobs";
import { emptyLogoWorkspace } from "../fixtures/empty-logo-workspace";

// Every provider, account and job response is a synthetic intercepted fixture. No live inference.
// Strategy is the guided interview; the managed (uncapped) policy below is the current availability shape.
const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const anotherOwner = "dddddddd-1111-4111-8111-111111111111";
const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
const when = "2026-10-03T10:00:00Z";
const operations = (["strategy.reformulate", "strategy.competitors", "strategy.audience", "strategy.personality"] as const)
  .map((operation, index) => ({ operation, billingMode: "openai_api", spendControl: "uncapped", policyIdentity: String(index + 1).repeat(64), interviewVersion: 1 }));
function fixtureProject() {
  return accountProjectSchema.parse({ id: projectId, owner_id: owner, title: "Synthetic strategy fixture", scope: "complete_brand", current_revision: 1, created_at: when, context: { description: "A neighborhood lunch kitchen.", intake: { step: "competitors", conversation: [{ id: "prompt-fixture", kind: "user_message", text: "A neighborhood lunch kitchen.", createdAt: when }, { id: "competitors-fixture", kind: "widget", widget: "competitors", createdAt: when }] } } });
}
function fixtureJob(operation: StrategyOperation, revision: number, ordinal: number, policyIdentity: string): StrategyJob {
  return strategyJobSchema.parse({ id: `cccccccc-1111-4111-8111-${String(ordinal).padStart(12, "0")}`, owner_id: owner, project_id: projectId, operation, input_revision: revision, state: "queued", progress: 0, billingMode: "openai_api", spendControl: "uncapped", policyIdentity, reserved_cost_microusd: 0, actual_cost_microusd: 0, error_code: null, cancel_requested_at: null, created_at: when, finished_at: null, results: [] });
}
function complete(job: StrategyJob) {
  const result = { version: 1, provider: "openai", model: "fixture-model", responseId: "synthetic-response", requestId: null, generatedAt: when, usage: { inputTokens: 30, outputTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 } };
  const proposal = { message: "Synthetic provider response: a welcoming neighborhood kitchen.", activity: "Neighborhood kitchen", offering: "Seasonal lunches", knownAudience: "Neighbors", questions: ["Which neighborhood will you serve?"] };
  return strategyJobSchema.parse({ ...job, state: "succeeded", progress: 100, finished_at: when, results: [{ stepKey: "response", output: { ...result, operation: job.operation, proposal } }] });
}
async function reply(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
async function fixtures(page: Page) {
  const state = { project: fixtureProject(), owner, patchStatus: 200, queueStatus: 202, jobs: [] as StrategyJob[], enqueues: [] as Record<string, unknown>[], patches: [] as Record<string, unknown>[] };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const availability = { status: "available", operations };
    if (path === "/api/session") return reply(route, { user: { id: state.owner } });
    if (path === "/api/strategy") return reply(route, { availability });
    if (state.owner !== owner) return reply(route, { error: "Synthetic unavailable account" }, 404);
    if (path === `/api/projects/${projectId}/logo` && request.method() === "GET") return reply(route, emptyLogoWorkspace(state.project));
    if (path === `/api/projects/${projectId}/idea-source` || path === `/api/projects/${projectId}/standalone-source`) return reply(route, { ownerId: owner, projectId, source: null });
    if (path === `/api/projects/${projectId}/idea-attachments`) return reply(route, { ownerId: owner, projectId, items: [], nextCursor: null });
    if (path === `/api/projects/${projectId}`) {
      if (request.method() === "GET") return reply(route, { project: state.project });
      const body = request.postDataJSON(); state.patches.push(body);
      if (state.patchStatus !== 200) return reply(route, {}, state.patchStatus);
      if (body.expectedRevision !== state.project.current_revision) return reply(route, {}, 409);
      state.project = { ...state.project, title: body.title, context: contextSnapshotSchema.parse(body.context), current_revision: state.project.current_revision + 1 };
      return reply(route, { revision: { project_id: projectId, owner_id: owner, revision: state.project.current_revision, context: state.project.context, input_hash: "synthetic-input", created_at: when } });
    }
    if (path === `/api/projects/${projectId}/strategy`) {
      if (request.method() === "GET") return reply(route, { availability, jobs: state.jobs });
      const body = request.postDataJSON(); state.enqueues.push(body);
      if (state.queueStatus !== 202) return reply(route, {}, state.queueStatus);
      const previous = state.jobs.find(job => job.input_revision === body.expectedRevision && job.operation === body.operation);
      const job = previous ?? fixtureJob(body.operation, body.expectedRevision, state.jobs.length + 1, body.acceptedPolicyIdentity);
      if (!previous) state.jobs.push(job);
      return reply(route, { job }, 202);
    }
    const job = state.jobs.find(item => path.includes(item.id));
    if (job) return reply(route, { job });
    return reply(route, {}, 404);
  });
  return state;
}
async function open(page: Page) {
  await page.goto(`/brands/account/${projectId}`);
  await expect(page.getByRole("textbox", { name: "Message Embel" })).toBeVisible();
  await expect(page.getByText("Your brief is saved. Send a message below to begin competitor research when AI is available.", { exact: true })).toBeVisible();
}

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));

/** Embel working on a reply: the research card for competitors, the thinking line otherwise. */
function working(page: Page) {
  return page.locator(".guided-thinking[role=status]").or(page.getByRole("region", { name: /^(Researching your competitors|Cancelling research…)$/ }));
}

test("strategy fixture: rejected saves retain the prompt and never enqueue provider work", async ({ page }) => {
  const state = await fixtures(page); state.patchStatus = 409; await open(page);
  await page.getByRole("textbox", { name: "Message Embel" }).fill("Keep this unsaved correction.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("A newer version is saved in your account.", { exact: false })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Embel" })).toHaveValue("Keep this unsaved correction.");
  expect(state.patches).toHaveLength(1);
  expect(state.enqueues).toHaveLength(0);
  await expect(working(page)).toHaveCount(0);
});

test("strategy fixture: unconfirmed enqueue shows no invented progress and retries the same saved request", async ({ page }) => {
  const state = await fixtures(page); state.queueStatus = 503; await open(page);
  await page.getByRole("textbox", { name: "Message Embel" }).fill("Keep the saved prompt after a queue failure.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect.poll(() => state.enqueues.length).toBe(1);
  await expect(page.locator(".guided-user-message").getByText("Keep the saved prompt after a queue failure.", { exact: true })).toBeVisible();
  expect(state.project.current_revision).toBe(2);
  const retry = page.getByRole("button", { name: "Retry research", exact: true });
  await expect(retry).toBeEnabled();
  await expect(working(page)).toHaveCount(0);
  expect(state.enqueues[0]).toMatchObject({ operation: "strategy.competitors", expectedRevision: 2, spendControl: "uncapped" });
  state.queueStatus = 202;
  await retry.click();
  await expect(working(page)).toBeVisible();
  expect(state.patches).toHaveLength(1);
  expect(state.enqueues).toHaveLength(2);
  expect(state.enqueues[0]).toEqual(state.enqueues[1]);
});

test("strategy fixture: another owner's job response never enters the transcript", async ({ page }) => {
  const state = await fixtures(page); state.jobs = [{ ...complete(fixtureJob("strategy.reformulate", 1, 1, operations[0]!.policyIdentity)), owner_id: anotherOwner }]; await page.goto(`/brands/account/${projectId}`);
  await expect(page.getByText("No verified account session.", { exact: false })).toBeVisible();
  await expect(page.getByText("Synthetic provider response: a welcoming neighborhood kitchen.", { exact: true })).toHaveCount(0);
});

test("strategy fixture: project context cannot push the composer below the viewport", async ({ page }, info) => {
  await fixtures(page); await open(page);
  await page.screenshot({ path: info.outputPath("account-conversation-viewport.png"), fullPage: true, scale: "css" });
  const composer = await page.getByRole("region", { name: "Strategy composer", exact: true }).boundingBox();
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(page.viewportSize()!.height);
});
