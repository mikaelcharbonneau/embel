import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { accountProjectSchema, type AccountProject } from "../../src/domain/project-api";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { accountProjectDraft } from "../../src/components/workspace/project-draft-adapter";
import type { LocalDraft } from "../../src/components/workspace/local-drafts";

// Synthetic examples and intercepted account APIs only. No research or hosted identity calls.
const key = "fluid.local-drafts.v1";
const when = "2026-10-03T03:00:00Z";
const projectId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const competitorId = "33333333-3333-4333-8333-333333333333";
const source = { url: "https://example.com/source-fixture", title: "Synthetic historical source", retrievedAt: when };

function fixtureProject(): AccountProject {
  return accountProjectSchema.parse({
    id: projectId, owner_id: ownerId, title: "Competitor QA fixture", scope: "naming_only", current_revision: 3, created_at: when,
    context: {
      description: "A local fixture neighborhood kitchen serving lunch to nearby workers.", activity: "Neighborhood kitchen", offering: "Seasonal lunches", knownAudience: "Nearby workers", reformulationConfirmed: true,
      competitors: [{ id: competitorId, name: "Existing fixture", relevance: "A similar lunch service", url: "https://example.com/existing", selected: true, origin: "research", sources: [source] }],
      competitorReviewComplete: true, positioning: "Retain this downstream fixture", selectedName: "Fixture Kitchen",
      personality: { sincerity: 80, excitement: 20, competence: 70, sophistication: 30, ruggedness: 10 },
      intake: { step: "competitors", suppliedName: "Fixture Kitchen", audienceReviewedAt: when },
    },
  });
}

async function reply(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
}

async function anonymousFixture(page: Page) {
  await page.route("**/api/**", (route) => reply(route, { error: "Synthetic anonymous fixture" }, 401));
}

async function accountFixture(page: Page) {
  const state = { project: fixtureProject(), failure: 0, writes: [] as Record<string, unknown>[] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") return reply(route, { user: { id: ownerId } });
    if (path === `/api/projects/${projectId}/strategy` && request.method() === "GET") return reply(route, { availability: { status: "unavailable", operations: [], reason: "runtime_disabled" }, jobs: [] });
    if (path !== `/api/projects/${projectId}`) return reply(route, { error: "Synthetic not-found fixture" }, 404);
    if (request.method() === "GET") return reply(route, { project: state.project });
    if (request.method() !== "PATCH") return reply(route, { error: "Synthetic unsupported fixture" }, 405);
    const body = request.postDataJSON() as Record<string, unknown>;
    state.writes.push(body);
    if (state.failure) return reply(route, { error: "Synthetic save failure" }, state.failure);
    if (body.expectedRevision !== state.project.current_revision) return reply(route, { error: "Synthetic conflict" }, 409);
    state.project = {
      ...state.project, title: typeof body.title === "string" ? body.title : state.project.title,
      context: contextSnapshotSchema.parse(body.context), current_revision: state.project.current_revision + 1,
    };
    return reply(route, { revision: { project_id: projectId, owner_id: ownerId, revision: state.project.current_revision, context: state.project.context, input_hash: "synthetic-fixture-only", created_at: when } });
  });
  return state;
}

async function seedLegacyDraft(page: Page) {
  const project = fixtureProject();
  // Simulate the previous version's browser recovery copy: hidden saved context,
  // with no new editable competitor list or review comparison key.
  const draft = { ...accountProjectDraft(project), preservedContext: project.context, stage: "audience" as const };
  delete draft.competitors;
  delete draft.competitorReviewKey;
  await page.addInitScript(({ key, draft }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ version: 1, drafts: [draft] }));
  }, { key, draft });
}

async function browserDraft(page: Page): Promise<LocalDraft> {
  return page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)!).drafts[0], key);
}

async function capture(page: Page, info: TestInfo, filename: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const width = page.viewportSize()!.width;
  await expect.poll(() => page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(width);
  const screenshot = await page.screenshot({ path: info.outputPath(filename), fullPage: true, scale: "css", style: "nextjs-portal { visibility: hidden; }" });
  expect(screenshot.readUInt32BE(16)).toBe(width);
}

async function startCompetitors(page: Page) {
  await anonymousFixture(page);
  await page.goto("/brands/new?scope=naming_only");
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill("A neighborhood kitchen serving seasonal weekday lunches to nearby workers.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Competitors", exact: true })).toBeVisible();
}

async function returnToCompetitors(page: Page) {
  await expect(page.getByRole("heading", { name: "Competitors", exact: true })).toBeVisible();
  const edit = page.getByRole("button", { name: "Edit competitors", exact: true });
  if (await edit.count()) await edit.click();
  await expect(page.getByRole("heading", { name: "Competitors", exact: true })).toBeVisible();
}

async function addCompetitor(page: Page, name = "Supplied lunch fixture") {
  await page.getByRole("button", { name: "Add competitor", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Competitor name", exact: true })).toBeFocused();
  await page.getByRole("textbox", { name: "Competitor name", exact: true }).fill(name);
  await page.getByRole("textbox", { name: "Why is it relevant?", exact: true }).fill("It serves a similar lunch need nearby.");
  await page.getByRole("textbox", { name: /^Website/ }).fill("https://example.com/lunch-fixture");
  await page.getByRole("checkbox", { name: "Retain competitor", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("checkbox", { name: "Retained competitor", exact: true })).toBeChecked();
}

test("supplied competitors save before audience and remain editable after reload", async ({ page }, testInfo) => {
  await startCompetitors(page);
  await addCompetitor(page);
  await page.getByRole("button", { name: "Keep competitors", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Audience", exact: true })).toBeVisible();
  expect((await browserDraft(page)).competitorReviewKey).toBeTruthy();
  await page.getByRole("button", { name: "Add audience", exact: true }).click();
  // Adding an audience deliberately focuses its name on the next animation frame.
  // Wait for that transition before filling another input to avoid focus stealing.
  await expect(page.getByRole("textbox", { name: "Audience name", exact: true })).toBeFocused();
  await page.getByRole("textbox", { name: "Audience name", exact: true }).fill("Nearby workers");
  await page.getByRole("textbox", { name: "What do they need?" }).fill("A quick, reliable lunch.");
  await expect(page.getByRole("textbox", { name: "What do they need?" })).toHaveValue("A quick, reliable lunch.");
  await page.getByRole("textbox", { name: "Why are they a fit?" }).fill("Their workplaces are nearby.");
  await expect(page.getByRole("textbox", { name: "Why are they a fit?" })).toHaveValue("Their workplaces are nearby.");
  await page.getByRole("checkbox", { name: "Select as target" }).check();
  await page.getByRole("button", { name: "Keep audience" }).click();
  await expect(page.getByRole("region", { name: "Audience", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
  const completed = await browserDraft(page);
  expect(completed.audienceReviewedAt).toBeTruthy();
  expect(completed.competitorReviewKey).toBeTruthy();
  await page.reload();
  await returnToCompetitors(page);
  await expect(page.getByRole("textbox", { name: "Competitor name", exact: true })).toHaveValue("Supplied lunch fixture");
  await expect(page.getByRole("textbox", { name: /^Website/ })).toHaveValue("https://example.com/lunch-fixture");
  await expect(page.getByRole("region", { name: "Competitors", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
  await capture(page, testInfo, "competitor-review.png");
  await page.getByRole("textbox", { name: "Why is it relevant?", exact: true }).fill("An edited assessment that needs review.");
  await expect(page.getByRole("region", { name: "Competitors", exact: true }).getByText("Confirmed", { exact: true })).toHaveCount(0);
  expect((await browserDraft(page)).audienceReviewedAt).toBeNull();
  await page.reload();
  await returnToCompetitors(page);
  await expect(page.getByRole("textbox", { name: "Why is it relevant?", exact: true })).toHaveValue("An edited assessment that needs review.");
});

test("an empty retained set needs an explicit choice and removal preserves the other supplied entry", async ({ page }) => {
  await startCompetitors(page);
  await page.getByRole("button", { name: "Keep competitors", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await page.getByRole("checkbox", { name: "I have no relevant competitors to retain", exact: true }).check();
  await page.getByRole("button", { name: "Keep competitors", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Audience", exact: true })).toBeVisible();
  await returnToCompetitors(page);
  await page.getByRole("checkbox", { name: "I have no relevant competitors to retain", exact: true }).uncheck();
  await expect(page.getByRole("region", { name: "Competitors", exact: true }).getByText("Confirmed", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Keep competitors", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await addCompetitor(page);
  await page.getByRole("button", { name: "Add another competitor", exact: true }).click();
  await page.getByRole("textbox", { name: "Competitor name", exact: true }).nth(1).fill("Second supplied fixture");
  await page.getByRole("button", { name: "Remove competitor 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Keep it", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Remove competitor 1", exact: true })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Competitor name", exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Remove competitor 1", exact: true }).click();
  await page.getByRole("button", { name: "Keep it", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Competitor name", exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Remove competitor 1", exact: true }).click();
  await page.getByRole("button", { name: "Remove competitor", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Competitor name", exact: true })).toHaveValue("Second supplied fixture");
  await expect(page.getByRole("textbox", { name: "Competitor name", exact: true })).toBeFocused();
  await page.reload();
  await returnToCompetitors(page);
  await expect(page.getByRole("textbox", { name: "Competitor name", exact: true })).toHaveValue("Second supplied fixture");
  expect((await browserDraft(page)).competitors).toHaveLength(1);
});

test("unsafe links stay as editable text and block completion without pretending to research", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await startCompetitors(page);
  await expect(page.getByText("AI replies are not available in this browser draft.", { exact: true })).toBeVisible();
  await addCompetitor(page);
  await page.getByRole("textbox", { name: /^Website/ }).fill("javascript:alert('synthetic-fixture')");
  await page.getByRole("button", { name: "Keep competitors", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Competitors", exact: true })).toBeVisible();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /^Website/ })).toHaveValue("javascript:alert('synthetic-fixture')");
  await page.reload();
  await expect(page.getByRole("textbox", { name: /^Website/ })).toHaveValue("javascript:alert('synthetic-fixture')");
  await page.getByRole("textbox", { name: /^Website/ }).fill("");
  await page.getByRole("textbox", { name: "Why is it relevant?", exact: true }).fill("");
  await page.getByRole("button", { name: "Keep competitors", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await capture(page, testInfo, "competitor-validation.png");
  expect(errors).toEqual([]);
});

test("legacy browser recovery drafts expose retained competitors without discarding saved research", async ({ page }) => {
  await anonymousFixture(page);
  await seedLegacyDraft(page);
  await page.goto(`/brands/${projectId}`);
  await returnToCompetitors(page);
  await expect(page.getByRole("textbox", { name: "Competitor name", exact: true })).toHaveValue("Existing fixture");
  await expect(page.getByRole("region", { name: "Competitors", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Why is it relevant?", exact: true }).fill("My correction to the stored fixture");
  await page.reload();
  await returnToCompetitors(page);
  await expect(page.getByRole("textbox", { name: "Why is it relevant?", exact: true })).toHaveValue("My correction to the stored fixture");
  const draft = await browserDraft(page);
  expect(draft.preservedContext?.competitors[0]?.sources).toEqual([source]);
  expect(draft.preservedContext?.positioning).toBe("Retain this downstream fixture");
  expect(draft.competitors?.[0]?.relevance).toBe("My correction to the stored fixture");
});

test("failed browser writes keep competitor edits in this tab and never claim durable saving", async ({ page }) => {
  await anonymousFixture(page);
  await seedLegacyDraft(page);
  await page.goto(`/brands/${projectId}`);
  await returnToCompetitors(page);
  const before = await page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
  await page.evaluate((storageKey) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === storageKey) throw new DOMException("Synthetic storage failure", "QuotaExceededError");
      return original.call(this, name, value);
    };
  }, key);
  await page.getByRole("textbox", { name: "Why is it relevant?", exact: true }).fill("Keep this unsaved competitor edit");
  await expect(page.getByText("This tab only", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Keep competitors", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("this tab");
  await expect(page.getByRole("status")).toContainText("storage");
  expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), key)).toBe(before);
  await returnToCompetitors(page);
  await expect(page.getByRole("textbox", { name: "Why is it relevant?", exact: true })).toHaveValue("Keep this unsaved competitor edit");
});

test("account fixture: corrected competitor evidence and downstream context survive saving and reload", async ({ page }) => {
  const state = await accountFixture(page);
  await page.goto(`/brands/account/${projectId}`);
  await returnToCompetitors(page);
  await expect(page.getByRole("textbox", { name: "Competitor name", exact: true })).toHaveValue("Existing fixture");
  await page.getByText("Saved references (1)", { exact: true }).click();
  await expect(page.getByRole("link", { name: /Synthetic historical source/ })).toHaveAttribute("href", source.url);
  await expect(page.getByRole("link", { name: /Synthetic historical source/ })).toHaveAttribute("rel", "noopener noreferrer");
  await page.getByRole("textbox", { name: "Competitor name", exact: true }).fill("My corrected competitor fixture");
  await expect(page.getByText("Check these saved references against your current entry.", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: /^Website/ }).fill("");
  await page.getByRole("button", { name: "Keep competitors", exact: true }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Saved to account · version 4", { exact: true })).toBeVisible();
  expect(state.project.context.competitors[0]).toEqual({ id: competitorId, name: "My corrected competitor fixture", relevance: "A similar lunch service", selected: true, origin: "user", sources: [source] });
  expect(state.project.context.competitorReviewComplete).toBe(true);
  expect(state.project.context.positioning).toBe("Retain this downstream fixture");
  expect(state.project.context.personality).toEqual(fixtureProject().context.personality);
  expect(JSON.stringify(state.writes[0])).not.toContain("competitorReviewKey");
  expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), key)).toBeNull();
  await page.reload();
  await returnToCompetitors(page);
  await expect(page.getByRole("textbox", { name: "Competitor name", exact: true })).toHaveValue("My corrected competitor fixture");
  await expect(page.getByRole("textbox", { name: /^Website/ })).toBeEmpty();
  await expect(page.getByRole("region", { name: "Competitors", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
});

test("account fixture: a revision conflict keeps competitor edits for an explicit browser recovery copy", async ({ page }) => {
  const state = await accountFixture(page);
  state.failure = 409;
  await page.goto(`/brands/account/${projectId}`);
  await returnToCompetitors(page);
  await page.getByRole("textbox", { name: "Why is it relevant?", exact: true }).fill("Keep my unsaved competitor correction");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("A newer version is saved");
  await expect(page.getByRole("textbox", { name: "Why is it relevant?", exact: true })).toHaveValue("Keep my unsaved competitor correction");
  expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), key)).toBeNull();
  await page.getByRole("button", { name: "Save edits as browser copy", exact: true }).click();
  const copy = await browserDraft(page);
  expect(copy.competitors?.[0]?.relevance).toBe("Keep my unsaved competitor correction");
  expect(copy.preservedContext?.competitors[0]?.sources).toEqual([source]);
  expect(copy.preservedContext?.positioning).toBe("Retain this downstream fixture");
  expect(state.project.context.competitors[0]?.relevance).toBe("A similar lunch service");
  await page.goto(`/brands/${copy.id}`);
  await returnToCompetitors(page);
  await expect(page.getByRole("textbox", { name: "Why is it relevant?", exact: true })).toHaveValue("Keep my unsaved competitor correction");
});
