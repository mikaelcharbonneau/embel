import { expectProjectCanvas } from "./project-canvas-contract";
import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { accountProjectSchema, type AccountProject } from "../../src/domain/project-api";
import { contextSnapshotSchema } from "../../src/domain/projects";
import type { LocalDraft } from "../../src/components/workspace/local-drafts";

// Every account response is intercepted. These examples never use a live account or model.
// Strategy is the guided interview in the account workspace; the current brief is edited in its dialog.
const storageKey = "fluid.local-drafts.v1";
const now = "2026-10-03T03:00:00Z";
const id = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const profile = { sincerity: 20, excitement: 35, competence: 85, sophistication: 40, ruggedness: 0 };
const statement = "Repairable lighting that makes small homes easier to live in.";
const description = "A fixture studio making repairable lamps for people living in small homes.";
const source = { url: "https://example.com/strategy-source", title: "Synthetic source fixture", retrievedAt: now };

function fixtureProject(): AccountProject {
  return accountProjectSchema.parse({
    id, owner_id: owner, title: "Strategy browser fixture", scope: "complete_brand", current_revision: 4, created_at: now,
    context: {
      description, activity: "Lighting studio", offering: "Repairable lamps", knownAudience: "Small-home residents", reformulationConfirmed: true,
      competitors: [
        { id: "33333333-3333-4333-8333-333333333333", name: "Retained competitor fixture", relevance: "Similar customer need", origin: "research", sources: [source], selected: true },
        { id: "44444444-4444-4444-8444-444444444444", name: "Unretained competitor fixture", relevance: "An exploratory option", origin: "user", sources: [], selected: false },
      ], competitorReviewComplete: true,
      audienceSegments: [
        { id: "55555555-5555-4555-8555-555555555555", label: "Small-home residents", needs: ["Warm light", "Simple repairs"], reason: "Limited space", origin: "proposal", sources: [source], selected: true },
        { id: "66666666-6666-4666-8666-666666666666", label: "Unselected audience fixture", needs: ["Different light"], reason: "Another possible market", origin: "user", sources: [], selected: false },
      ],
      personality: profile, positioning: statement, creativeLocale: "fr-CA",
      intake: { step: "personality", identityNotes: "Keep these identity notes", namingNotes: "Keep these naming notes", audienceReviewedAt: now, personalityReviewedAt: now, positioningReviewedAt: now },
    },
  });
}

async function reply(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
}

async function capture(page: Page, info: TestInfo, filename: string) {
  // Mobile overflow can expand both innerWidth and document.scrollWidth together.
  // Compare with the configured viewport, which does not grow with document layout.
  const width = page.viewportSize()!.width;
  await expect.poll(() => page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(width);
  const screenshot = await page.screenshot({ path: info.outputPath(filename), fullPage: true, scale: "css", style: "nextjs-portal { visibility: hidden; }" });
  expect(screenshot.readUInt32BE(16)).toBe(width);
}

async function account(page: Page) {
  const state = { project: fixtureProject(), failure: 0, writes: [] as Record<string, unknown>[] };
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

async function openBrief(page: Page) {
  await page.goto(`/brands/account/${id}?view=strategy`);
  await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit brief", exact: true }).click();
  const brief = page.getByRole("dialog", { name: "Edit current brief", exact: true });
  await expect(brief).toBeVisible();
  return brief;
}

test("account fixture: failed saving and a revision conflict retain brief edits without claiming a save", async ({ page }) => {
  const state = await account(page);
  const brief = await openBrief(page);
  const field = brief.getByRole("textbox", { name: "Brief description", exact: true });
  state.failure = 503;
  await field.fill("An unfinished thought to keep,");
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(brief.getByRole("status")).toHaveText("Changes not saved");
  await expect(field).toHaveValue("An unfinished thought to keep,");
  state.failure = 409;
  await brief.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  const notices = page.getByRole("region", { name: "Conversation notices", exact: true });
  await expect(notices.getByText("A newer version is saved in your account.", { exact: true })).toBeVisible();
  await expect(notices.getByRole("status")).toHaveText("Changes not saved");
  await page.getByRole("button", { name: "Edit brief", exact: true }).click();
  await expect(brief.getByRole("status")).toHaveText("Changes not saved");
  await expect(field).toHaveValue("An unfinished thought to keep,");
  await brief.getByRole("button", { name: "Close", exact: true }).click();
  expect(state.project.context.description).toBe(description);
  expect(state.project.current_revision).toBe(4);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull();
  await notices.getByRole("button", { name: "Keep a recovery copy", exact: true }).click();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).not.toBeNull();
  const copy: LocalDraft = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).drafts[0], storageKey);
  expect(copy.description).toBe("An unfinished thought to keep,");
  expect(copy.preservedContext?.competitors[0]?.sources).toEqual([source]);
  expect(state.writes).toHaveLength(2);
  await page.goto(`/brands/${copy.id}`);
  await page.getByRole("button", { name: "Recover unsaved projects", exact: true }).click();
  await expect(page.getByRole("radio", { name: /Strategy browser fixture/ })).toBeVisible();
});

test("project design: Strategy and its brief open without changing the saved context", async ({ page }, info) => {
  const state = await account(page), original = JSON.stringify(state.project);
  const brief = await openBrief(page);
  await expect(brief.getByRole("textbox", { name: "Brief description", exact: true })).toHaveValue(description);
  await expect(brief.getByRole("textbox", { name: "What the business does", exact: true })).toHaveValue("Lighting studio");
  await expect(brief.getByRole("status")).toHaveText("Saved");
  const box = await brief.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  await capture(page, info, "project-brief.png");
  await brief.getByRole("button", { name: "Close", exact: true }).click();
  await expect(brief).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Edit brief", exact: true })).toBeFocused();
  await expectProjectCanvas(page);
  await capture(page, info, "project-strategy.png");
  expect(JSON.stringify(state.project)).toBe(original); expect(state.writes).toHaveLength(0);
});
