import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { accountProjectSchema, type AccountProject } from "../../src/domain/project-api";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { accountProjectDraft } from "../../src/components/workspace/project-draft-adapter";
import type { LocalDraft } from "../../src/components/workspace/local-drafts";

// Every account response is intercepted. These examples never use a live account or model.
const storageKey = "fluid.local-drafts.v1";
const now = "2026-10-03T03:00:00Z";
const id = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const profile = { sincerity: 20, excitement: 35, competence: 85, sophistication: 40, ruggedness: 0 };
const statement = "Repairable lighting that makes small homes easier to live in.";
const source = { url: "https://example.com/strategy-source", title: "Synthetic source fixture", retrievedAt: now };
const labels = ["Sincerity", "Excitement", "Competence", "Sophistication", "Ruggedness"];

function fixtureProject(reviewed = true): AccountProject {
  return accountProjectSchema.parse({
    id, owner_id: owner, title: "Strategy browser fixture", scope: "naming_only", current_revision: 4, created_at: now,
    context: {
      description: "A fixture studio making repairable lamps for people living in small homes.", activity: "Lighting studio", offering: "Repairable lamps", knownAudience: "Small-home residents", reformulationConfirmed: true,
      competitors: [
        { id: "33333333-3333-4333-8333-333333333333", name: "Retained competitor fixture", relevance: "Similar customer need", origin: "research", sources: [source], selected: true },
        { id: "44444444-4444-4444-8444-444444444444", name: "Unretained competitor fixture", relevance: "An exploratory option", origin: "user", sources: [], selected: false },
      ], competitorReviewComplete: true,
      audienceSegments: [
        { id: "55555555-5555-4555-8555-555555555555", label: "Small-home residents", needs: ["Warm light", "Simple repairs"], reason: "Limited space", origin: "proposal", sources: [source], selected: true },
        { id: "66666666-6666-4666-8666-666666666666", label: "Unselected audience fixture", needs: ["Different light"], reason: "Another possible market", origin: "user", sources: [], selected: false },
      ],
      personality: profile, positioning: statement, selectedName: "Luma fixture", creativeLocale: "fr-CA",
      intake: { step: "personality", suppliedName: "Luma fixture", identityNotes: "Keep these identity notes", namingNotes: "Keep these naming notes", audienceReviewedAt: now, personalityReviewedAt: reviewed ? now : null, positioningReviewedAt: reviewed ? now : null },
    },
  });
}

async function reply(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
}

async function anonymous(page: Page) {
  await page.route("**/api/**", (route) => reply(route, { error: "Synthetic anonymous fixture" }, 401));
}

async function seed(page: Page, draft: LocalDraft) {
  await page.addInitScript(({ storageKey, draft }) => {
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify({ version: 1, drafts: [draft] }));
  }, { storageKey, draft });
}

async function readDraft(page: Page): Promise<LocalDraft> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).drafts[0], storageKey);
}

async function startEmptyStrategy(page: Page) {
  await anonymous(page);
  const project = fixtureProject(false);
  project.context.personality = null;
  project.context.positioning = "";
  await seed(page, { ...accountProjectDraft(project), preservedContext: project.context });
  await page.goto(`/brands/${id}`);
  await expect(page.getByRole("heading", { name: "Personality", exact: true })).toBeVisible();
}

async function stage(page: Page, label: "Personality" | "Positioning" | "Audience" | "Competitors") {
  await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
  const edit = page.getByRole("button", { name: `Edit ${label.toLowerCase()}`, exact: true });
  if (await edit.count()) await edit.click();
  await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
}

async function capture(page: Page, info: TestInfo, filename: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  // Mobile overflow can expand both innerWidth and document.scrollWidth together.
  // Compare with the configured viewport, which does not grow with document layout.
  const width = page.viewportSize()!.width;
  await expect.poll(() => page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(width);
  const screenshot = await page.screenshot({ path: info.outputPath(filename), fullPage: true, scale: "css", style: "nextjs-portal { visibility: hidden; }" });
  expect(screenshot.readUInt32BE(16)).toBe(width);
}

async function account(page: Page, reviewed = true) {
  const state = { project: fixtureProject(reviewed), failure: 0, writes: [] as Record<string, unknown>[] };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") return reply(route, { user: { id: owner } });
    if (path === `/api/projects/${id}/strategy` && request.method() === "GET") return reply(route, { availability: { status: "unavailable", operations: [], reason: "runtime_disabled" }, jobs: [] });
    if (path !== `/api/projects/${id}`) return reply(route, { error: "Synthetic not found" }, 404);
    if (request.method() === "GET") return reply(route, { project: state.project });
    if (request.method() !== "PATCH") return reply(route, { error: "Synthetic unsupported method" }, 405);
    const body = request.postDataJSON() as Record<string, unknown>;
    state.writes.push(body);
    if (state.failure) return reply(route, { error: "Synthetic save failure" }, state.failure);
    if (body.expectedRevision !== state.project.current_revision) return reply(route, { error: "Synthetic version conflict" }, 409);
    state.project = { ...state.project, title: typeof body.title === "string" ? body.title : state.project.title, context: contextSnapshotSchema.parse(body.context), current_revision: state.project.current_revision + 1 };
    return reply(route, { revision: { project_id: id, owner_id: owner, revision: state.project.current_revision, context: state.project.context, input_hash: "synthetic-only", created_at: now } });
  });
  return state;
}

test("a profile starts only after user action and explicit reviews survive reload with keyboard boundary values", async ({ page }, info) => {
  await startEmptyStrategy(page);
  await expect(page.getByRole("slider")).toHaveCount(0);
  expect((await readDraft(page)).personality).toBeNull();
  await page.reload();
  await expect(page.getByRole("slider")).toHaveCount(0);
  await page.getByRole("button", { name: "Enter my own profile", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("slider")).toHaveCount(5);
  for (const label of labels) await expect(page.getByRole("slider", { name: label, exact: true })).toHaveValue("50");
  expect((await readDraft(page)).personalityReviewedAt).toBeNull();
  await page.getByRole("slider", { name: "Sincerity", exact: true }).focus();
  await page.keyboard.press("Home");
  await expect(page.getByRole("slider", { name: "Sincerity", exact: true })).toHaveValue("0");
  await page.getByRole("slider", { name: "Competence", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("slider", { name: "Competence", exact: true })).toHaveValue("100");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("slider", { name: "Competence", exact: true })).toHaveValue("99");
  expect((await readDraft(page)).audienceReviewedAt).toBe(now);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await capture(page, info, "personality-manual.png");
  await page.getByRole("button", { name: "Keep personality", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Positioning", exact: true })).toBeVisible();
  expect((await readDraft(page)).personalityReviewedAt).toBeTruthy();
  await page.getByRole("textbox", { name: "Positioning statement", exact: true }).fill("For small homes,");
  expect((await readDraft(page)).audienceReviewedAt).toBe(now);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Positioning statement", exact: true })).toHaveValue("For small homes,");
  expect((await readDraft(page)).positioningReviewedAt).toBeNull();
  await page.getByRole("textbox", { name: "Positioning statement", exact: true }).fill("X");
  await page.getByRole("button", { name: "Approve strategy", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Positioning", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
  await stage(page, "Positioning");
  await page.getByRole("textbox", { name: "Positioning statement", exact: true }).fill(statement);
  await expect(page.getByRole("region", { name: "Positioning", exact: true }).getByText("Confirmed", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Approve strategy", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("region", { name: "Positioning", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await capture(page, info, "positioning-reviewed.png");
  await stage(page, "Personality");
  await expect(page.getByRole("slider", { name: "Sincerity", exact: true })).toHaveValue("0");
  await expect(page.getByRole("slider", { name: "Competence", exact: true })).toHaveValue("99");
  await page.getByRole("slider", { name: "Sincerity", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("region", { name: "Personality", exact: true }).getByText("Confirmed", { exact: true })).toHaveCount(0);
  await stage(page, "Positioning");
  await expect(page.getByRole("region", { name: "Positioning", exact: true }).getByText("Confirmed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Positioning statement", exact: true })).toHaveValue(statement);
});

test("positioning can be drafted ahead but cannot be approved without a reviewed personality", async ({ page }, info) => {
  await startEmptyStrategy(page);
  await page.getByRole("button", { name: "Continue later", exact: true }).click();
  await page.getByRole("textbox", { name: "Positioning statement", exact: true }).fill("A partial statement to return to later.");
  await page.getByRole("button", { name: "Approve strategy", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText(/personality/i);
  expect((await readDraft(page)).personality).toBeNull();
  expect((await readDraft(page)).positioningReviewedAt).toBeNull();
  await capture(page, info, "positioning-review-needed.png");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Positioning statement", exact: true })).toHaveValue("A partial statement to return to later.");
  await stage(page, "Personality");
  await expect(page.getByRole("button", { name: "Enter my own profile", exact: true })).toBeVisible();
  await expect(page.getByRole("slider")).toHaveCount(0);
});

test("legacy saved strategy is preserved and displayed without inventing completed reviews", async ({ page }) => {
  await anonymous(page);
  const project = fixtureProject(false);
  const draft = { ...accountProjectDraft(project), preservedContext: project.context };
  delete draft.personality; delete draft.positioning;
  delete draft.personalityReviewedAt; delete draft.positioningReviewedAt;
  delete draft.personalityReviewKey; delete draft.positioningReviewKey;
  await seed(page, draft);
  await page.goto(`/brands/${id}`);
  await stage(page, "Personality");
  await expect(page.getByRole("slider", { name: "Sincerity", exact: true })).toHaveValue("20");
  await expect(page.getByRole("region", { name: "Personality", exact: true }).getByText("Confirmed", { exact: true })).toHaveCount(0);
  await stage(page, "Positioning");
  await expect(page.getByRole("textbox", { name: "Positioning statement", exact: true })).toHaveValue(statement);
  await expect(page.getByRole("region", { name: "Positioning", exact: true }).getByText("Confirmed", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Positioning statement", exact: true })).toHaveValue(statement);
});

test("unselected context edits preserve strategy reviews while selected audience edits invalidate them", async ({ page }) => {
  await anonymous(page);
  const project = fixtureProject();
  await seed(page, { ...accountProjectDraft(project), preservedContext: project.context });
  await page.goto(`/brands/${id}`);
  await stage(page, "Audience");
  await page.getByRole("textbox", { name: "Audience name", exact: true }).nth(1).fill("An exploratory audience correction");
  await stage(page, "Personality");
  await expect(page.getByRole("region", { name: "Personality", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
  await stage(page, "Positioning");
  await expect(page.getByRole("region", { name: "Positioning", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
  await stage(page, "Competitors");
  await page.getByRole("textbox", { name: "Competitor name", exact: true }).nth(1).fill("An exploratory competitor correction");
  await stage(page, "Personality");
  await expect(page.getByRole("region", { name: "Personality", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
  await stage(page, "Positioning");
  await expect(page.getByRole("region", { name: "Positioning", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
  await stage(page, "Audience");
  await page.getByRole("textbox", { name: "What do they need?", exact: true }).first().fill("A changed selected audience need");
  await stage(page, "Personality");
  await expect(page.getByRole("region", { name: "Personality", exact: true }).getByText("Confirmed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "Competence", exact: true })).toHaveValue("85");
  await stage(page, "Positioning");
  await expect(page.getByRole("region", { name: "Positioning", exact: true }).getByText("Confirmed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Positioning statement", exact: true })).toHaveValue(statement);
  const saved = await readDraft(page);
  expect(saved.personalityReviewedAt).toBeNull();
  expect(saved.positioningReviewedAt).toBeNull();
  expect(saved.preservedContext?.competitors[0]?.sources).toEqual([source]);
});

test("account fixture: strategy reviews save with values and provenance and survive reload", async ({ page }) => {
  const state = await account(page, false);
  await page.goto(`/brands/account/${id}`);
  await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toBeVisible();
  await stage(page, "Personality");
  await page.getByRole("slider", { name: "Sincerity", exact: true }).focus();
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "Keep personality", exact: true }).click();
  await page.getByRole("textbox", { name: "Positioning statement", exact: true }).fill("My revised positioning fixture.");
  await page.getByRole("button", { name: "Approve strategy", exact: true }).click();
  await expect(page.getByText("Strategy approved and saved to your account.", { exact: true })).toBeVisible();
  await expect(page.locator(".project-workspace-save")).toContainText("v5");
  expect(state.project.context.personality).toEqual({ ...profile, sincerity: 0 });
  expect(state.project.context.positioning).toBe("My revised positioning fixture.");
  expect(state.project.context.intake.personalityReviewedAt).toBeTruthy();
  expect(state.project.context.intake.positioningReviewedAt).toBeTruthy();
  expect(state.project.context.selectedName).toBe("Luma fixture");
  expect(state.project.context.competitors[0]?.sources).toEqual([source]);
  expect(state.project.context.audienceSegments[0]?.sources).toEqual([source]);
  expect(JSON.stringify(state.writes[0])).not.toMatch(/(?:personality|positioning|competitor)ReviewKey/);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull();
  await page.reload();
  await expect(page.getByRole("region", { name: "Positioning", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
  await stage(page, "Personality");
  await expect(page.getByRole("slider", { name: "Sincerity", exact: true })).toHaveValue("0");
  await expect(page.getByRole("region", { name: "Personality", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
});

test("account fixture: incomplete Strategy approval resumes the required review before saving", async ({ page }) => {
  const state = await account(page);
  state.project = { ...state.project, scope: "complete_brand", context: { ...state.project.context, intake: { ...state.project.context.intake, audienceReviewedAt: null, positioningReviewedAt: null } } };
  await page.goto(`/brands/account/${id}`);
  await stage(page, "Positioning");
  await page.getByRole("button", { name: "Approve strategy", exact: true }).click();
  await expect(page.getByText("Review your audience before approving Strategy. Your current content is kept.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep audience", exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Keep audience", exact: true }).click();
  await page.getByRole("button", { name: "Keep personality", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Positioning statement", exact: true })).toHaveValue(statement);
  await page.getByRole("button", { name: "Approve strategy", exact: true }).click();
  await expect(page.getByText("Strategy approved and saved to your account.", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Project stages" }).getByRole("link", { name: "Naming", exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.project.context.positioning).toBe(statement);
  expect(state.project.context.competitors[0]?.sources).toEqual([source]);
});

test("account fixture: failed saving and a revision conflict retain partial strategy for an explicit browser copy", async ({ page }) => {
  const state = await account(page);
  await page.goto(`/brands/account/${id}`);
  await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toBeVisible();
  await stage(page, "Personality");
  await page.getByRole("slider", { name: "Ruggedness", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await stage(page, "Positioning");
  await page.getByRole("textbox", { name: "Positioning statement", exact: true }).fill("An unfinished thought to keep,");
  state.failure = 503;
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator("main").getByRole("alert").filter({ hasText: "Account saving is unavailable" })).toContainText("Account saving is unavailable");
  await expect(page.getByRole("textbox", { name: "Positioning statement", exact: true })).toHaveValue("An unfinished thought to keep,");
  state.failure = 409;
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator("main").getByRole("alert").filter({ hasText: "A newer version is saved" })).toContainText("A newer version is saved");
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull();
  await page.getByRole("button", { name: "Save edits as browser copy", exact: true }).click();
  const copy = await readDraft(page);
  expect(copy.positioning).toBe("An unfinished thought to keep,");
  expect(copy.personality?.ruggedness).toBe(1);
  expect(copy.personalityReviewedAt).toBeNull();
  expect(copy.positioningReviewedAt).toBeNull();
  expect(copy.preservedContext?.competitors[0]?.sources).toEqual([source]);
  expect(state.project.context.positioning).toBe(statement);
  await page.goto(`/brands/${copy.id}`);
  await expect(page.getByRole("textbox", { name: "Positioning statement", exact: true })).toHaveValue("An unfinished thought to keep,");
});

test("browser storage failure retains the current strategy without claiming a durable save", async ({ page }) => {
  await anonymous(page);
  const project = fixtureProject();
  await seed(page, { ...accountProjectDraft(project), preservedContext: project.context, stage: "positioning" });
  await page.goto(`/brands/${id}`);
  await stage(page, "Positioning");
  const before = await page.evaluate((key) => localStorage.getItem(key), storageKey);
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("Synthetic quota failure", "QuotaExceededError");
      return original.call(this, name, value);
    };
  }, storageKey);
  await page.getByRole("textbox", { name: "Positioning statement", exact: true }).fill("My retained in-tab positioning edit.");
  await expect(page.getByText("This tab only", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve strategy", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("this tab");
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(before);
  await stage(page, "Personality");
  await stage(page, "Positioning");
  await expect(page.getByRole("textbox", { name: "Positioning statement", exact: true })).toHaveValue("My retained in-tab positioning edit.");
});


test("project design: all Strategy reviews and optional live brief retain the saved context", async ({ page }, info) => {
  const state = await account(page), original = JSON.stringify(state.project);
  await page.goto(`/brands/account/${id}`);
  await expect(page.locator(".project-workspace-title")).toHaveText(state.project.title);
  for (const widget of ["competitors", "audience", "personality", "positioning"] as const) {
    await page.goto(`/brands/account/${id}#strategy-${widget}`);
    await expect(page.getByRole("region", { name: widget.charAt(0).toUpperCase() + widget.slice(1), exact: true })).toBeVisible();
    await capture(page, info, `project-strategy-${widget}.png`);
  }
  await page.getByRole("button", { name: "Live brief", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Live brief" })).toBeVisible();
  await page.getByRole("button", { name: "Edit brief", exact: true }).click();
  await expect(page.getByRole("region", { name: "Project brief", exact: true })).toBeVisible();
  expect(JSON.stringify(state.project)).toBe(original); expect(state.writes).toHaveLength(0);
  await capture(page, info, "project-brief.png");
});
