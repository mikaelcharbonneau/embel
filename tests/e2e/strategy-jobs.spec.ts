import { captureUiEvidence } from "./ui-evidence";
import { expect, test, type Page, type Route } from "@playwright/test";
import { accountProjectSchema } from "../../src/domain/project-api";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { DEFAULT_SUBSCRIPTION_LIMITS, strategyJobSchema, type StrategyJob, type StrategyOperation } from "../../src/domain/strategy-jobs";

// Every provider, account and job response is a synthetic intercepted fixture. No live inference.
const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const anotherOwner = "dddddddd-1111-4111-8111-111111111111";
const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
const when = "2026-10-03T10:00:00Z";
const subscriptionPolicyIdentity = "a".repeat(64);
const caps = [
  { operation: "strategy.reformulate", maximumCostMicrousd: 122880 },
  { operation: "strategy.competitors", maximumCostMicrousd: 3142880 },
  { operation: "strategy.audience", maximumCostMicrousd: 200000 },
  { operation: "strategy.personality", maximumCostMicrousd: 200000 },
  { operation: "strategy.positioning", maximumCostMicrousd: 200000 },
];
function fixtureProject() {
  return accountProjectSchema.parse({ id: projectId, owner_id: owner, title: "Synthetic strategy fixture", scope: "complete_brand", current_revision: 1, created_at: when, context: { description: "A neighborhood lunch kitchen.", intake: { step: "competitors", conversation: [{ id: "prompt-fixture", kind: "user_message", text: "A neighborhood lunch kitchen.", createdAt: when }, { id: "competitors-fixture", kind: "widget", widget: "competitors", createdAt: when }] } } });
}
function fixtureJob(operation: StrategyOperation, revision: number, ordinal: number, billingMode: "openai_api" | "chatgpt_subscription" = "openai_api", policyIdentity = subscriptionPolicyIdentity): StrategyJob {
  return strategyJobSchema.parse({ id: `cccccccc-1111-4111-8111-${String(ordinal).padStart(12, "0")}`, owner_id: owner, project_id: projectId, operation, input_revision: revision, state: "queued", progress: 0, ...(billingMode === "chatgpt_subscription" ? { billingMode, policyIdentity } : { reserved_cost_microusd: caps.find(item => item.operation === operation)!.maximumCostMicrousd, actual_cost_microusd: 0 }), error_code: null, cancel_requested_at: null, created_at: when, finished_at: null, results: [] });
}
function complete(job: StrategyJob) {
  const result = { version: 1, provider: "openai", model: "fixture-model", responseId: "synthetic-response", requestId: null, generatedAt: when, usage: { inputTokens: 30, outputTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 } };
  const proposal = job.operation === "strategy.reformulate"
    ? { message: "Synthetic provider response: a welcoming neighborhood kitchen.", activity: "Neighborhood kitchen", offering: "Seasonal lunches", knownAudience: "Neighbors", questions: ["Which neighborhood will you serve?"] }
    : { message: "Synthetic competitor research result.", competitors: [{ id: "eeeeeeee-1111-4111-8111-111111111111", name: "Fixture competitor", relevance: "A local alternative", url: "https://example.com/kitchen", selected: false, origin: "research", sources: [{ url: "https://example.com/kitchen", title: "Synthetic source", retrievedAt: when }] }] };
  return strategyJobSchema.parse({ ...job, state: "succeeded", progress: 100, finished_at: when, results: [{ stepKey: "response", output: { ...result, ...(job.billingMode === "chatgpt_subscription" ? { billingMode: "chatgpt_subscription", usage: null } : {}), operation: job.operation, proposal } }] });
}
async function reply(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
async function fixtures(page: Page) {
  const state = { project: fixtureProject(), owner, available: true, responseOnly: false, policyIdentity: subscriptionPolicyIdentity, billingMode: "openai_api" as "openai_api" | "chatgpt_subscription", patchStatus: 200, queueStatus: 202, applyReplyStatus: 200, jobs: [] as StrategyJob[], enqueues: [] as Record<string, unknown>[], patches: [] as Record<string, unknown>[], applies: [] as Record<string, unknown>[] };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const availability = state.available ? { status: "available", operations: state.billingMode === "chatgpt_subscription" ? caps.map(item => ({ operation: item.operation, billingMode: "chatgpt_subscription", limits: DEFAULT_SUBSCRIPTION_LIMITS, policyIdentity: state.policyIdentity })) : caps.filter(item => !state.responseOnly || item.operation === "strategy.reformulate") } : { status: "unavailable", operations: [], reason: "worker_unavailable" };
    if (path === "/api/session") return reply(route, { user: { id: state.owner } });
    if (path === "/api/strategy") return reply(route, { availability });
    if (state.owner !== owner) return reply(route, { error: "Synthetic unavailable account" }, 404);
    if (path === "/api/projects" && request.method() === "POST") {
      state.project = accountProjectSchema.parse({ ...request.postDataJSON(), id: projectId, owner_id: owner, current_revision: 1, created_at: when });
      return reply(route, { project: state.project }, 201);
    }
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
      const job = previous ?? fixtureJob(body.operation, body.expectedRevision, state.jobs.length + 1, body.billingMode, body.acceptedPolicyIdentity);
      if (!previous) state.jobs.push(job);
      return reply(route, { job }, 202);
    }
    const job = state.jobs.find(item => path.includes(item.id));
    if (job && path.endsWith("/apply")) {
      const body = request.postDataJSON(); state.applies.push(body);
      const result = job.results.find(item => item.stepKey === body.stepKey);
      if (result?.application && result.application.inputRevision === body.expectedRevision && result.application.appliedRevision === state.project.current_revision) return reply(route, { project: state.project, application: result.application });
      if (body.expectedRevision !== state.project.current_revision || job.input_revision !== state.project.current_revision) return reply(route, {}, 409);
      const output = result?.output;
      if (!output) return reply(route, {}, 422);
      const context = output.operation === "strategy.reformulate" ? { ...state.project.context, activity: output.proposal.activity, offering: output.proposal.offering, knownAudience: output.proposal.knownAudience } : output.operation === "strategy.competitors" ? { ...state.project.context, competitors: [...state.project.context.competitors, ...output.proposal.competitors] } : state.project.context;
      state.project = { ...state.project, context: contextSnapshotSchema.parse(context), current_revision: state.project.current_revision + 1 };
      const application = { jobId: job.id, stepKey: body.stepKey, inputRevision: body.expectedRevision, appliedRevision: state.project.current_revision, appliedAt: when };
      result!.application = application;
      return reply(route, { project: state.project, application }, state.applyReplyStatus);
    }
    if (job && request.method() === "DELETE") { job.state = "cancelled"; job.cancel_requested_at = when; return reply(route, { job }); }
    if (job) return reply(route, { job });
    return reply(route, {}, 404);
  });
  return state;
}
async function open(page: Page) {
  await page.goto(`/brands/account/${projectId}`);
  await expect(page.getByRole("textbox", { name: "Message Fluid" })).toBeVisible();
  await expect(page.getByText(/Sending uses (OpenAI|your ChatGPT plan)/)).toBeVisible();
}

test("strategy fixture: Send waits for response acceptance, then researches the new revision once", async ({ page }, testInfo) => {
  const state = await fixtures(page); await open(page);
  await expect(page.getByText(/Sending uses OpenAI.*\$3.27/)).toBeVisible();
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Focus on office workers at lunch.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  expect(state.patches[0]?.context).toMatchObject({ intake: { conversation: expect.arrayContaining([expect.objectContaining({ kind: "user_message", text: "Focus on office workers at lunch." })]) } });
  expect(state.enqueues[0]).toMatchObject({ operation: "strategy.reformulate", expectedRevision: 2, acceptedMaxCostMicrousd: 122880 });
  state.jobs[0] = complete(state.jobs[0]!);
  await expect(page.getByText("Synthetic provider response: a welcoming neighborhood kitchen.", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(1);
  await page.getByRole("button", { name: "View latest AI activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Response complete", exact: true })).toBeFocused();
  const heading = await page.getByRole("heading", { name: "Response complete", exact: true }).boundingBox();
  const composer = await page.locator(".conversation-compose-area").boundingBox();
  expect(heading!.y + heading!.height).toBeLessThan(composer!.y);
  expect(state.enqueues).toHaveLength(1);
  expect(state.project.context.activity).toBe("");
  await expect(page.getByText("Competitor research queued", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Apply response", exact: true })).toBeEnabled();
  expect(state.enqueues).toHaveLength(1);
  await page.getByRole("button", { name: "Apply response", exact: true }).click();
  await expect(page.getByText("Saved to account · version 3", { exact: true })).toBeVisible();
  await expect(page.getByText("Competitor research queued", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(2);
  expect(state.enqueues[1]).toMatchObject({ operation: "strategy.competitors", expectedRevision: 3, acceptedMaxCostMicrousd: 3142880 });
  expect(state.project.context.activity).toBe("Neighborhood kitchen");
  expect(state.project.context.reformulationConfirmed).toBe(false);
  await expect(page.getByText("Applied to saved version · 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request response", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Competitor research queued", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(2);
  state.jobs[1] = complete(state.jobs[1]!);
  await expect(page.getByText("Synthetic competitor research result.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply competitor research", exact: true }).click();
  await expect(page.getByText("Saved to account · version 4", { exact: true })).toBeVisible();
  expect(state.project.context.competitors[0]).toMatchObject({ name: "Fixture competitor", selected: false });
  expect(state.project.context.competitorReviewComplete).toBe(false);
  await page.getByRole("button", { name: "View latest AI activity", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("strategy-conversation.png"), fullPage: true, scale: "css" });
});

test("strategy fixture: rejected saves retain the prompt and never enqueue provider work", async ({ page }) => {
  const state = await fixtures(page); state.patchStatus = 409; await open(page);
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Keep this unsaved correction.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Keep this unsaved correction.", { exact: true })).toBeVisible();
  await expect(page.getByText("A newer version is saved in your account.", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(0);
  await expect(page.getByText("Response queued", { exact: true })).toHaveCount(0);
});

test("strategy fixture: applied results retain their exact acceptance status after reload", async ({ page }) => {
  const state = await fixtures(page); state.jobs = [complete(fixtureJob("strategy.reformulate", 1, 1))]; await open(page);
  await expect(page.getByText("Synthetic provider response: a welcoming neighborhood kitchen.", { exact: true })).toBeVisible();
  expect(state.applies).toHaveLength(0); expect(state.project.context.activity).toBe("");
  await page.getByRole("button", { name: "Apply response", exact: true }).click();
  await expect(page.getByText("Saved to account · version 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Applied to saved version · 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Earlier version · 1", { exact: true })).toHaveCount(0);
  expect(state.project.context.activity).toBe("Neighborhood kitchen");
  expect(state.project.context.reformulationConfirmed).toBe(false);
  expect(state.applies).toEqual([{ expectedRevision: 1, stepKey: "response" }]);
  await expect(page.getByRole("button", { name: "Applied response", exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByText("Applied to saved version · 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Applied response", exact: true })).toBeDisabled();
  expect(state.enqueues).toHaveLength(0);
});

test("strategy fixture: cancellation stops the accepted chain and unavailable integration stays honest", async ({ page }) => {
  const state = await fixtures(page); await open(page);
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Start another response.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel response", exact: true }).click();
  await expect(page.getByText("Response cancelled", { exact: true })).toBeVisible();
  state.jobs[0] = complete(state.jobs[0]!);
  await page.reload();
  await expect(page.getByText("Synthetic provider response: a welcoming neighborhood kitchen.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply response", exact: true }).click();
  await expect(page.getByText("Saved to account · version 3", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(1);
  state.available = false; await page.reload();
  await expect(page.getByText(/OpenAI is unavailable.*continue editing/)).toBeVisible();
});

test("strategy fixture: another owner's job response never enters the transcript", async ({ page }) => {
  const state = await fixtures(page); state.jobs = [{ ...complete(fixtureJob("strategy.reformulate", 1, 1)), owner_id: anotherOwner }]; await page.goto(`/brands/account/${projectId}`);
  await expect(page.getByText("No verified account session.", { exact: false })).toBeVisible();
  await expect(page.getByText("Synthetic provider response: a welcoming neighborhood kitchen.", { exact: true })).toHaveCount(0);
});

test("strategy fixture: initial Send keeps the browser copy and creates a genuine account request", async ({ page }) => {
  const state = await fixtures(page); await page.goto("/brands/new");
  await expect(page.getByText(/Sending saves an account copy.*\$3.27/)).toBeVisible();
  await page.getByRole("textbox", { name: "Your prompt" }).fill("Synthetic initial prompt for a local kitchen.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectId}$`));
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  expect(state.project.context.intake.conversation?.[0]).toMatchObject({ kind: "user_message", text: "Synthetic initial prompt for a local kitchen." });
  expect(state.enqueues).toHaveLength(1);
  expect(state.enqueues[0]).toMatchObject({ operation: "strategy.reformulate", expectedRevision: 1, acceptedMaxCostMicrousd: 122880 });
  const browser = JSON.parse((await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1")))!);
  expect(browser.drafts[0].description).toBe("Synthetic initial prompt for a local kitchen.");
});

test("strategy fixture: unconfirmed enqueue shows no invented progress and retries the same saved request", async ({ page }) => {
  const state = await fixtures(page); state.queueStatus = 503; await open(page);
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Keep the saved prompt after a queue failure.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Saved to account · version 2", { exact: true })).toBeVisible();
  await expect(page.getByText(/no new job was confirmed/)).toBeVisible();
  await expect(page.getByText("Response queued", { exact: true })).toHaveCount(0);
  state.queueStatus = 202;
  await page.getByRole("button", { name: "Request response", exact: true }).click();
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  expect(state.patches).toHaveLength(1);
  expect(state.enqueues).toHaveLength(2);
  expect(state.enqueues[0]).toEqual(state.enqueues[1]);
});

test("strategy fixture: a lost Apply response recovers the exact saved application before research", async ({ page }) => {
  const state = await fixtures(page); state.applyReplyStatus = 503; await open(page);
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Recover this explicitly accepted response.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  state.jobs[0] = complete(state.jobs[0]!);
  await page.getByRole("button", { name: "Apply response", exact: true }).click();
  await expect(page.getByText("Saved to account · version 3", { exact: true })).toBeVisible();
  await expect(page.getByText("Competitor research queued", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Applied response", exact: true })).toBeDisabled();
  expect(state.applies).toEqual([{ expectedRevision: 2, stepKey: "response" }]);
  expect(state.enqueues).toHaveLength(2);
  expect(state.enqueues[1]).toMatchObject({ operation: "strategy.competitors", expectedRevision: 3, acceptedMaxCostMicrousd: 3142880 });
  await page.reload();
  await expect(page.getByText("Competitor research queued", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(2);
  expect(state.applies).toHaveLength(1);
});

test("strategy fixture: retrying research preserves the original allowance and new revision", async ({ page }) => {
  const state = await fixtures(page); await open(page);
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Keep this research request available after an outage.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  state.jobs[0] = complete(state.jobs[0]!); state.queueStatus = 503;
  await page.getByRole("button", { name: "Apply response", exact: true }).click();
  await expect(page.getByText("Saved to account · version 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry competitor research", exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(2);
  await expect(page.getByText("Competitor research queued", { exact: true })).toHaveCount(0);
  state.queueStatus = 202;
  await page.getByRole("button", { name: "Retry competitor research", exact: true }).click();
  await expect(page.getByText("Competitor research queued", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(3);
  expect(state.enqueues[1]).toEqual(state.enqueues[2]);
  expect(state.enqueues[2]).toMatchObject({ expectedRevision: 3, acceptedMaxCostMicrousd: 3142880 });
  expect(state.applies).toHaveLength(1);
});

test("strategy fixture: reload resumes accepted research from the durable receipt without another Apply", async ({ page }) => {
  const state = await fixtures(page); state.billingMode = "chatgpt_subscription"; await open(page);
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Continue the accepted request after reloading.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  state.jobs[0] = complete(state.jobs[0]!); state.queueStatus = 503;
  await page.getByRole("button", { name: "Apply response", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry competitor research", exact: true })).toBeVisible();
  state.queueStatus = 202;
  await page.reload();
  await expect(page.getByText("Competitor research queued", { exact: true })).toBeVisible();
  await expect(page.getByText("Applied to saved version · 3", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(3);
  expect(state.enqueues[1]).toEqual(state.enqueues[2]);
  expect(state.enqueues[2]).toMatchObject({ expectedRevision: 3, billingMode: "chatgpt_subscription", acceptedPolicyIdentity: subscriptionPolicyIdentity });
  expect(state.applies).toHaveLength(1);
});

test("strategy fixture: edits stop automatic research and block applying an old input", async ({ page }) => {
  const state = await fixtures(page); await open(page);
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Prepare this response.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rename project" }).click();
  await page.getByRole("textbox", { name: "Project label" }).fill("New unsaved title");
  state.jobs[0] = complete(state.jobs[0]!);
  await expect(page.getByText("Synthetic provider response: a welcoming neighborhood kitchen.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply response", exact: true })).toBeDisabled();
  expect(state.enqueues).toHaveLength(1);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Saved to account · version 3", { exact: true })).toBeVisible();
  await expect(page.getByText("Earlier version · 2", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(1);
});

for (const applyReplyStatus of [200, 503]) test(`strategy fixture: typing during Apply keeps the newer draft with HTTP ${applyReplyStatus}`, async ({ page }) => {
  const state = await fixtures(page); state.applyReplyStatus = applyReplyStatus; state.jobs = [complete(fixtureJob("strategy.reformulate", 1, 1))];
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/strategy/*/apply", async route => { started(); await pending; await route.fallback(); });
  await open(page);
  await page.getByRole("button", { name: "Apply response", exact: true }).click();
  await requested;
  await page.getByRole("button", { name: "Rename project" }).click();
  await page.getByRole("textbox", { name: "Project label" }).fill("Keep this edit made during Apply");
  release();
  await expect(page.getByText("A newer version is saved in your account.", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Project label" })).toHaveValue("Keep this edit made during Apply");
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save edits as browser copy", exact: true })).toBeEnabled();
  expect(state.project.context.activity).toBe("Neighborhood kitchen");
});

test("strategy fixture: a late accepted job is fenced after an account change", async ({ page }) => {
  const state = await fixtures(page);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route(`**/api/projects/${projectId}/strategy`, async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON(); started(); await pending;
    await reply(route, { job: complete(fixtureJob("strategy.reformulate", body.expectedRevision, 1)) }, 202);
  });
  await open(page);
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Private prior-account message.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await requested;
  await expect(page.getByText("Response queued", { exact: true })).toHaveCount(0);
  await expect(page.getByText("OpenAI is processing this saved version.", { exact: false })).toHaveCount(0);
  state.owner = anotherOwner;
  await page.getByRole("button", { name: "Check account", exact: true }).click();
  await expect(page.getByText("This project is not available to this account.", { exact: true })).toBeVisible();
  release();
  await expect(page.getByText("Synthetic provider response: a welcoming neighborhood kitchen.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Private prior-account message.", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"))).toBeNull();
});

test("subscription fixture: real message text streams without exposing JSON or inventing a complete proposal", async ({ page }) => {
  const state = await fixtures(page); state.billingMode = "chatgpt_subscription"; await open(page);
  await expect(page.getByText(/ChatGPT plan limits apply\. Fluid allows up to 20 requests per hour and 3 queued requests/)).toBeVisible();
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Use the selected ChatGPT connection for this fixture.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  expect(state.enqueues[0]).toMatchObject({ billingMode: "chatgpt_subscription", operation: "strategy.reformulate", expectedRevision: 2, acceptedPolicyIdentity: subscriptionPolicyIdentity });
  expect(state.enqueues[0]).not.toHaveProperty("acceptedMaxCostMicrousd");
  const partial = String.raw`{"message":"Synthetic streamed message: \"lunch\"\nNeighbors \uD83D`;
  state.jobs[0] = strategyJobSchema.parse({ ...state.jobs[0], state: "partial", partialText: partial });
  const incomplete = page.getByLabel("Incomplete response", { exact: true });
  await expect(incomplete).toBeVisible();
  await expect(incomplete.getByText('Synthetic streamed message: "lunch" Neighbors', { exact: true })).toBeVisible();
  await expect(page.getByText('{"message":', { exact: false })).toHaveCount(0);
  await expect(page.getByText("\\uD83D", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply response", exact: true })).toHaveCount(0);
  state.jobs[0] = strategyJobSchema.parse({ ...state.jobs[0], partialText: partial + "\\uDE80" });
  await expect(incomplete.getByText('Synthetic streamed message: "lunch" Neighbors 🚀', { exact: true })).toBeVisible();
  state.jobs[0] = complete(state.jobs[0]!);
  await expect(page.getByRole("button", { name: "Apply response", exact: true })).toBeEnabled();
  await expect(incomplete).toHaveCount(0);
  await expect(page.getByText(/Synthetic streamed message/)).toHaveCount(0);
  expect(state.enqueues).toHaveLength(1);
  await page.getByRole("button", { name: "Apply response", exact: true }).click();
  await expect(page.getByText("Competitor research queued", { exact: true })).toBeVisible();
  expect(state.enqueues[1]).toMatchObject({ billingMode: "chatgpt_subscription", operation: "strategy.competitors", expectedRevision: 3, acceptedPolicyIdentity: subscriptionPolicyIdentity });
  expect(state.enqueues[1]).not.toHaveProperty("acceptedMaxCostMicrousd");
  await expect(page.getByText(/Reserved limit|\$0/)).toHaveCount(0);
});

test("subscription fixture: cancelled and uncertain partials stay incomplete and render only plain text", async ({ page }) => {
  const state = await fixtures(page); state.billingMode = "chatgpt_subscription";
  const message = '<img src=x onerror="alert(1)"> Synthetic retained message';
  state.jobs = [strategyJobSchema.parse({ ...fixtureJob("strategy.reformulate", 1, 1, "chatgpt_subscription"), state: "cancelled", cancel_requested_at: when, partialText: JSON.stringify({ reasoning: { message: "Never display this reasoning field" }, message }).slice(0, -2) })];
  await open(page);
  const incomplete = page.getByLabel("Incomplete response", { exact: true });
  await expect(incomplete.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByText("Response cancelled", { exact: true })).toBeVisible();
  await expect(incomplete.locator("img,script")).toHaveCount(0);
  await expect(page.getByText(/Never display this reasoning field/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply response", exact: true })).toHaveCount(0);
  state.jobs[0] = strategyJobSchema.parse({ ...state.jobs[0], state: "needs_reconciliation", cancel_requested_at: null });
  await page.reload();
  await expect(page.getByText("Response needs status verification", { exact: true })).toBeVisible();
  await expect(incomplete.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByText("Incomplete response", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply response", exact: true })).toHaveCount(0);
});

test("subscription fixture: a change to API billing stops an accepted subscription chain", async ({ page }) => {
  const state = await fixtures(page); state.billingMode = "chatgpt_subscription"; await open(page);
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Preserve the subscription allowance.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  state.billingMode = "openai_api"; state.jobs[0] = complete(state.jobs[0]!);
  await expect(page.getByText("Response complete", { exact: true })).toBeVisible();
  await expect(page.getByText(/Sending uses OpenAI.*\$3.27/)).toBeVisible();
  await page.getByRole("button", { name: "Apply response", exact: true }).click();
  await expect(page.getByText("Saved to account · version 3", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(1);
  await page.reload();
  await expect(page.getByText("Response complete", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(1);
});

test("subscription fixture: changing the selected policy stops continuation until a new message", async ({ page }) => {
  const state = await fixtures(page); state.billingMode = "chatgpt_subscription"; await open(page);
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Use the original selected connection.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  state.policyIdentity = "b".repeat(64); state.jobs[0] = complete(state.jobs[0]!);
  await expect(page.getByText("Response complete", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply response", exact: true }).click();
  await expect(page.getByText("Saved to account · version 3", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(1);
  await page.reload();
  await expect(page.getByText("Response complete", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(1);
  await page.getByRole("textbox", { name: "Message Fluid" }).fill("Start with the newly selected model.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(2);
  expect(state.enqueues[1]).toMatchObject({ operation: "strategy.reformulate", expectedRevision: 4, acceptedPolicyIdentity: state.policyIdentity });
});

test("subscription fixture: initial Send discloses plan usage and preserves the browser copy", async ({ page }) => {
  const state = await fixtures(page); state.billingMode = "chatgpt_subscription"; await page.goto("/brands/new");
  await expect(page.getByText(/Sending saves an account copy and uses your ChatGPT plan/)).toBeVisible();
  await page.getByRole("textbox", { name: "Your prompt" }).fill("Synthetic plan-backed initial prompt.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectId}$`));
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  expect(state.enqueues[0]).toMatchObject({ billingMode: "chatgpt_subscription", expectedRevision: 1 });
  expect(state.enqueues[0]).not.toHaveProperty("acceptedMaxCostMicrousd");
  expect(await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"))).toContain("Synthetic plan-backed initial prompt.");
});


for (const applyReplyStatus of [200, 503]) test(`response-only fixture: Home saves one response and never adds research after apply/reload with HTTP ${applyReplyStatus}`, async ({ page }) => {
  const state = await fixtures(page); state.responseOnly = true; state.applyReplyStatus = applyReplyStatus;
  await page.goto("/brands/new");
  await expect(page.getByText(/Sending saves an account copy and requests a response, up to \$0.13/)).toBeVisible();
  await expect(page.getByText(/Competitor research is unavailable/)).toBeVisible();
  await page.getByRole("textbox", { name: "Your prompt" }).fill("Synthetic response-only initial prompt.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectId}$`));
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  expect(state.enqueues).toEqual([expect.objectContaining({ operation: "strategy.reformulate", expectedRevision: 1, acceptedMaxCostMicrousd: 122880 })]);
  expect(state.project.context.description).toBe("Synthetic response-only initial prompt.");
  const consent = await page.evaluate(() => JSON.parse(sessionStorage.getItem("fluid.strategy-consent.v1") ?? "[]"));
  expect(consent).toEqual([{ ownerId: owner, projectId, revision: 1, kind: "response_only", billingMode: "openai_api", reformulationCap: 122880 }]);
  state.jobs[0] = complete(state.jobs[0]!);
  await expect(page.getByRole("button", { name: "Apply response", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Apply response", exact: true }).click();
  await expect(page.getByText("Saved to account · version 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Applied to saved version · 2", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(1);
  state.responseOnly = false;
  await page.reload();
  await expect(page.getByText("Applied to saved version · 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Research competitors", exact: true })).toBeEnabled();
  expect(state.enqueues).toHaveLength(1);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("fluid.strategy-consent.v1") ?? "[]"))).toEqual(consent);
  await page.getByRole("button", { name: "Research competitors", exact: true }).click();
  await expect(page.getByText("Competitor research queued", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(2);
  expect(state.enqueues[1]).toMatchObject({ operation: "strategy.competitors", expectedRevision: 2, acceptedMaxCostMicrousd: 3142880 });
});

test("response-only fixture: uncertain response retry keeps its saved consent when research later becomes ready", async ({ page }) => {
  const state = await fixtures(page); state.responseOnly = true; state.queueStatus = 503;
  await page.goto("/brands/new");
  await expect(page.getByText(/requests a response, up to \$0.13/)).toBeVisible();
  await page.getByRole("textbox", { name: "Your prompt" }).fill("Synthetic retained response-only consent.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText(/Your account copy is saved, but the AI request is not confirmed/)).toBeVisible();
  state.responseOnly = false; state.queueStatus = 202;
  await page.getByRole("link", { name: "Open saved account project and check AI status" }).click();
  await expect(page.getByText("Response only · up to $0.13", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Request response", exact: true }).click();
  await expect(page.getByText("Response queued", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(2); expect(state.enqueues[0]).toEqual(state.enqueues[1]);
  state.jobs[0] = complete(state.jobs[0]!);
  await expect(page.getByRole("button", { name: "Apply response", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Apply response", exact: true }).click();
  await expect(page.getByText("Applied to saved version · 2", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Applied to saved version · 2", { exact: true })).toBeVisible();
  expect(state.enqueues).toHaveLength(2);
  expect(state.enqueues.every(item => item.operation === "strategy.reformulate")).toBe(true);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));

test("strategy fixture: project context cannot push the composer below the viewport", async ({ page }, info) => {
  await fixtures(page); await open(page);
  await expect(page.getByRole("textbox", { name: "Message Fluid", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("account-conversation-viewport.png"), fullPage: true, scale: "css" });
  const composer = await page.locator(".conversation-compose-area").boundingBox();
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(page.viewportSize()!.height);
});
