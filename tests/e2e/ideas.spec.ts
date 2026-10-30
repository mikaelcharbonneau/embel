import { captureUiEvidence } from "./ui-evidence";
import { expect, test, type Page, type Route, type Locator } from "@playwright/test";
import { accountProjectSchema } from "../../src/domain/project-api";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { emptyLogoWorkspace } from "../fixtures/empty-logo-workspace";

// Synthetic, intercepted account fixtures only. No live auth, persistence, or generation.
const ownerA = "aaaaaaaa-1111-4111-8111-111111111111";
const ownerB = "bbbbbbbb-1111-4111-8111-111111111111";
const ideaId = "11111111-1111-4111-8111-111111111111";
const ideaB = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const when = "2026-10-05T10:00:00.123456Z";
type Content = { title: string; description: string; theme: string; state: "to_explore" | "developing" | "used"; details: Record<"problem" | "audience" | "solution" | "differentiation" | "revenueHypotheses" | "validationSteps" | "notes", string> };
type Idea = { id: string; ownerId: string; revision: number; content: Content; createdAt: string; updatedAt: string; links: Link[] };
type Link = { id: string; ownerId: string; ideaId: string; ideaRevision: number; projectId: string; requestKey: string; createdAt: string };
function content(title = "Quiet kitchen fixture"): Content {
  return { title, description: "A private fixture for seasonal lunches.", theme: "", state: "to_explore", details: { problem: "", audience: "", solution: "", differentiation: "", revenueHypotheses: "", validationSteps: "", notes: "" } };
}
function idea(id = ideaId, ownerId = ownerA, title?: string): Idea {
  return { id, ownerId, revision: 1, content: content(title), createdAt: when, updatedAt: when, links: [] };
}
function summary(item: Idea) {
  return { id: item.id, ownerId: item.ownerId, revision: item.revision, title: item.content.title, description: item.content.description, theme: item.content.theme, state: item.content.state, createdAt: item.createdAt, updatedAt: item.updatedAt };
}
function fixtureId(index: number) { return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`; }

async function reply(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
}

async function emptyAccount(page: Page) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return reply(route, { user: { id: ownerA } });
    if (path === "/api/ideas") return reply(route, { ownerId: ownerA, items: [], nextCursor: null });
    return reply(route, { error: "Synthetic unavailable fixture" }, 503);
  });
}

async function accountFixtures(page: Page, initial = [idea()]) {
  const state = {
    owner: ownerA, sessionStatus: 200, patchStatus: 200,
    ideas: new Map(initial.map(item => [item.id, structuredClone(item)])),
    writes: [] as { path: string; method: string; body: Record<string, unknown> }[],
    queries: [] as URLSearchParams[],
    receipts: new Map<string, unknown>(),
    sources: new Map<string, { link: Link; content: Content }>(),
    projects: new Map<string, ReturnType<typeof accountProjectSchema.parse>>(),
    loseCreateResponse: false, loseSaveResponse: false, loseBrandResponse: false,
  };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/session") return reply(route, state.sessionStatus === 200 ? { user: { id: state.owner } } : {}, state.sessionStatus);
    if (path === "/api/auth/sign-out") { state.sessionStatus = 401; return reply(route, { authenticated: false }); }
    if (state.sessionStatus !== 200) return reply(route, {}, 401);
    if (path === "/api/projects/page") return reply(route, { ownerId: state.owner, items: [], nextCursor: null });
    if (path === "/api/ideas" && request.method() === "GET") {
      state.queries.push(url.searchParams);
      const search = url.searchParams.get("search")?.toLocaleLowerCase() ?? "";
      const filter = url.searchParams.get("state");
      const cursorId = url.searchParams.get("cursorId");
      const items = [...state.ideas.values()].filter(item => item.ownerId === state.owner && (!filter || item.content.state === filter) && `${item.content.title}\n${item.content.description}`.toLocaleLowerCase().includes(search))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const start = cursorId ? items.findIndex(item => item.id === cursorId) + 1 : 0;
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const pageItems = items.slice(start, start + limit);
      const anchor = pageItems.at(-1);
      return reply(route, { ownerId: state.owner, items: pageItems.map(summary), nextCursor: anchor && start + limit < items.length ? { createdAt: anchor.createdAt, id: anchor.id } : null });
    }
    if (path.startsWith("/api/ideas") && request.method() !== "GET") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.writes.push({ path, method: request.method(), body });
      const key = `${state.owner}:${path}:${String(body.requestKey)}`;
      if (state.receipts.has(key)) return reply(route, state.receipts.get(key));
      if (path === "/api/ideas") {
        const id = state.ideas.has(ideaId) ? fixtureId(999) : ideaId;
        const saved = { ...idea(id, state.owner), content: body.content as Content };
        state.ideas.set(id, saved); state.receipts.set(key, { idea: saved });
        if (state.loseCreateResponse) { state.loseCreateResponse = false; return route.abort("failed"); }
        return reply(route, { idea: saved }, 201);
      }
      const current = state.ideas.get(path.split("/")[3] ?? "");
      if (!current || current.ownerId !== state.owner) return reply(route, {}, 404);
      if (body.expectedRevision !== current.revision) return reply(route, {}, 409);
      if (path.endsWith("/brand")) {
        const link: Link = { id: fixtureId(888), ownerId: state.owner, ideaId: current.id, ideaRevision: current.revision, projectId, requestKey: body.requestKey as string, createdAt: when };
        const saved = { ...current, revision: current.revision + 1, content: { ...current.content, state: "used" as const }, links: [...current.links, link] };
        const project = accountProjectSchema.parse({ id: projectId, owner_id: state.owner, current_revision: 1, created_at: when, title: current.content.title, scope: "complete_brand", context: contextSnapshotSchema.parse({ description: current.content.description.trim() || current.content.title, offering: current.content.details.solution.trim(), knownAudience: current.content.details.audience.trim() }) });
        state.ideas.set(current.id, saved); state.sources.set(projectId, { link, content: structuredClone(current.content) }); state.projects.set(projectId, project);
        const response = { idea: saved, link }; state.receipts.set(key, response);
        if (state.loseBrandResponse) { state.loseBrandResponse = false; return route.abort("failed"); }
        return reply(route, response, 201);
      }
      if (state.patchStatus !== 200) return reply(route, {}, state.patchStatus);
      const saved = { ...current, revision: current.revision + 1, content: body.content as Content };
      state.ideas.set(current.id, saved); state.receipts.set(key, { idea: saved });
      if (state.loseSaveResponse) { state.loseSaveResponse = false; return route.abort("failed"); }
      return reply(route, { idea: saved });
    }
    if (path.startsWith("/api/ideas/") && request.method() === "GET") {
      const current = state.ideas.get(path.split("/")[3] ?? "");
      return current?.ownerId === state.owner ? reply(route, { idea: current }) : reply(route, {}, 404);
    }
    const project = state.projects.get(path.split("/")[3] ?? "");
    if (!project || project.owner_id !== state.owner) return reply(route, {}, 404);
    if (path === `/api/projects/${project.id}/logo` && request.method() === "GET") return reply(route, emptyLogoWorkspace(project));
    if (path.endsWith("/idea-source")) return reply(route, { ownerId: state.owner, projectId: project.id, source: state.sources.get(project.id) ?? null });
    if (path.endsWith("/strategy")) return reply(route, { availability: { status: "unavailable", operations: [], reason: "runtime_disabled" }, jobs: [] });
    return reply(route, { project });
  });
  return state;
}

async function openIdea(page: Page, id = ideaId) {
  await page.goto(`/ideas/${id}`);
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toBeVisible();
}
async function clickAccountAction(page: Page, name: "Check account" | "Sign out") {
  const menu = page.getByLabel("Account menu", { exact: true });
  if (await menu.count() && !await menu.evaluate(element => element.parentElement?.hasAttribute("open"))) await menu.click();
  const action = page.locator(".workspace-account-panel").getByRole("button", { name, exact: true });
  await expect(action).toBeEnabled();
  await action.click();
}
async function browserValues(page: Page) { return page.evaluate(() => Object.values(localStorage).join("\n")); }
async function openContext(page: Page, selector: string) {
  const section = page.locator(selector), trigger = section.locator(":scope > button[aria-haspopup='dialog']");
  await trigger.click();
  const dialog = section.locator(":scope > dialog"); await expect(dialog).toBeVisible();
  return dialog;
}
async function closeContext(dialog: Locator) {
  await dialog.locator(":scope > header").getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function expectSavedVersion(page: Page, version: number) {
  const dialog = await openContext(page, ".idea-detail-metadata");
  await expect(dialog.getByText(`Saved to account · version ${version}.`, { exact: true })).toBeVisible();
  await closeContext(dialog);
}
async function expectProjectLabel(page: Page, title: string) {
  await page.getByRole("button", { name: "Edit brief", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit current brief", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Project label", exact: true })).toHaveValue(title);
  await closeContext(dialog);
}

test("Ideas design: progressive notes and saved details preserve fields, focus and one next-step region", async ({ page }, info) => {
  await page.setViewportSize(info.project.name === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
  const saved = idea(ideaId, ownerA, "A long retained idea title for a seasonal kitchen serving a changing neighborhood".repeat(2).slice(0, 160));
  saved.content.details.problem = "Retained user-authored problem notes. ".repeat(15);
  saved.content.details.solution = "Retained solution notes";
  const state = await accountFixtures(page, [saved]); await openIdea(page);
  const notes = page.locator(".idea-development-panel"), metadata = page.locator(".idea-detail-metadata");
  await expect(notes.locator(":scope > dialog")).not.toBeVisible(); await expect(metadata.locator(":scope > dialog")).not.toBeVisible();
  await expect(page.getByLabel("Save status", { exact: true })).toHaveText("Saved");
  await expect(page.locator(".idea-detail-save-state")).toHaveCount(0);
  const trigger = notes.locator(":scope > button[aria-haspopup='dialog']"); await trigger.focus(); await trigger.press("Enter");
  const notesDialog = notes.locator(":scope > dialog"); await expect(notesDialog).toBeVisible();
  const problem = page.getByRole("textbox", { name: "Problem", exact: true }); await expect(problem).toHaveValue(saved.content.details.problem);
  const node = await problem.elementHandle();
  await closeContext(notesDialog); await expect(trigger).toBeFocused();
  await trigger.press("Enter"); expect(await problem.evaluate((element, original) => element === original, node)).toBe(true);
  await expect(problem).toHaveValue(saved.content.details.problem);
  await closeContext(notesDialog);
  const next = page.getByRole("complementary", { name: "Continue with this idea", exact: true });
  await expect(next.getByRole("button", { name: "Create brand", exact: true })).toBeVisible();
  const attachment = next.locator(".idea-attach-disclosure"); await expect(attachment.locator(":scope > dialog")).not.toBeVisible();
  await attachment.locator(":scope > button[aria-haspopup='dialog']").focus(); await page.keyboard.press("Enter");
  await expect(next.getByRole("heading", { name: "Attach to an existing brand", exact: true })).toBeVisible();
  await expect(next.getByRole("button", { name: "Attach to brand", exact: true })).toBeDisabled();
  await closeContext(attachment.locator(":scope > dialog"));
  await expectSavedVersion(page, 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(state.writes).toEqual([]);
  await page.evaluate(() => { document.querySelector("#main-content")?.scrollTo(0, 0); window.scrollTo(0, 0); });
  await captureUiEvidence(page, info);
});

test("Ideas fixture: quick capture, optional details, automatic save and reload retain user text only in the account", async ({ page }, testInfo) => {
  const state = await accountFixtures(page, []);
  await page.goto("/ideas");
  await page.getByRole("button", { name: "Add idea", exact: true }).click();
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Private quick capture fixture");
  await page.getByRole("textbox", { name: "Description (optional)", exact: true }).fill("<script>Private idea text</script>");
  await page.getByRole("button", { name: "Save idea", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/ideas/${ideaId}$`));
  expect(state.writes[0]!.body).toMatchObject({ content: { title: "Private quick capture fixture", state: "to_explore" } });
  expect(Object.keys(state.writes[0]!.body).sort()).toEqual(["content", "requestKey"]);
  const notesDialog = await openContext(page, ".idea-development-panel");
  await page.getByRole("textbox", { name: "Proposed solution", exact: true }).fill("Seasonal lunches delivered nearby");
  await page.getByRole("textbox", { name: "Audience", exact: true }).fill("Local workers");
  const extraDialog = await openContext(page, ".idea-extra-details");
  await page.getByRole("textbox", { name: "Revenue hypotheses", exact: true }).fill("A user-authored monthly lunch plan hypothesis");
  await closeContext(extraDialog); await closeContext(notesDialog);
  await page.getByRole("combobox", { name: "Idea state", exact: true }).selectOption("developing");
  await expect(page.getByRole("button", { name: "Create brand", exact: true })).toBeDisabled();
  await expect.poll(() => state.ideas.get(ideaId)?.content).toMatchObject({ state: "developing", details: {
    revenueHypotheses: "A user-authored monthly lunch plan hypothesis", solution: "Seasonal lunches delivered nearby", audience: "Local workers",
  } });
  await expect(page.getByLabel("Save status", { exact: true })).toHaveText("Saved");
  expect(state.ideas.get(ideaId)!.revision).toBeGreaterThanOrEqual(2);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Private quick capture fixture");
  const restoredNotes = await openContext(page, ".idea-development-panel");
  const restoredExtra = await openContext(page, ".idea-extra-details");
  await expect(page.getByRole("textbox", { name: "Revenue hypotheses", exact: true })).toHaveValue("A user-authored monthly lunch plan hypothesis");
  await closeContext(restoredExtra); await closeContext(restoredNotes);
  expect(await browserValues(page)).not.toContain("Private quick capture fixture");
  expect(await browserValues(page)).not.toContain("monthly lunch");
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: testInfo.outputPath("idea-detail.png"), fullPage: true, scale: "css" });
});

test("Ideas fixture: search and state apply across the library and reset continuation", async ({ page }) => {
  const items = Array.from({ length: 57 }, (_, index) => {
    const item = idea(fixtureId(index + 1), ownerA, `Library fixture ${index}`);
    if (index < 5) item.content.description = "Old hidden search needle %_ fixture";
    if (index % 2 === 0) item.content.state = "developing";
    return item;
  });
  const state = await accountFixtures(page, items);
  await page.goto("/ideas");
  await expect(page.getByRole("button", { name: "Load more ideas", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more ideas", exact: true }).click();
  await expect.poll(() => state.queries.length).toBe(2);
  expect(state.queries[1]!.get("cursorId")).toBeTruthy();
  await page.getByRole("searchbox", { name: "Search ideas", exact: true }).fill("needle %_");
  await page.getByRole("searchbox", { name: "Search ideas", exact: true }).press("Enter");
  await expect(page.getByRole("link", { name: /Library fixture/ })).toHaveCount(5);
  expect(state.queries.at(-1)?.get("search")).toBe("needle %_");
  expect(state.queries.at(-1)?.get("cursorId")).toBeNull();
  await page.getByRole("combobox", { name: "Filter by state", exact: true }).selectOption("developing");
  await expect(page.getByRole("link", { name: /Library fixture/ })).toHaveCount(3);
  expect(state.queries.at(-1)?.get("state")).toBe("developing");
  expect(state.queries.at(-1)?.get("cursorId")).toBeNull();
  await expect(page.getByRole("button", { name: "Load more ideas", exact: true })).toHaveCount(0);
});

test("Ideas fixture: an obsolete search response cannot replace the current library", async ({ page }) => {
  const state = await accountFixtures(page, [idea(), idea(ideaB, ownerA, "New current search fixture")]);
  let release!: () => void;
  let start!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { start = resolve; });
  await page.route("**/api/ideas?**", async route => {
    if (new URL(route.request().url()).searchParams.get("search") !== "old") return route.fallback();
    start(); await wait;
    await reply(route, { ownerId: ownerA, items: [summary(idea())], nextCursor: null });
  });
  await page.goto("/ideas");
  await page.getByRole("searchbox", { name: "Search ideas", exact: true }).fill("old");
  await page.getByRole("searchbox", { name: "Search ideas", exact: true }).press("Enter");
  await requested;
  await page.getByRole("searchbox", { name: "Search ideas", exact: true }).fill("New current");
  await page.getByRole("searchbox", { name: "Search ideas", exact: true }).press("Enter");
  await expect(page.getByRole("link", { name: /New current search fixture/ })).toBeVisible();
  release();
  await expect(page.getByRole("link", { name: /Quiet kitchen fixture/ })).toHaveCount(0);
  expect(state.queries.at(-1)?.get("search")).toBe("New current");
});

test("Ideas fixture: resubmitting the same search keeps the current page and continuation", async ({ page }) => {
  const state = await accountFixtures(page, Array.from({ length: 57 }, (_, index) => idea(fixtureId(index + 1), ownerA, `Repeat search fixture ${index}`)));
  await page.goto("/ideas");
  await expect(page.getByRole("button", { name: "Load more ideas", exact: true })).toBeEnabled();
  await expect(page.getByRole("link", { name: /Repeat search fixture/ })).toHaveCount(25);
  await page.getByRole("searchbox", { name: "Search ideas", exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "Load more ideas", exact: true })).toBeEnabled();
  await expect(page.getByRole("link", { name: /Repeat search fixture/ })).toHaveCount(25);
  expect(state.queries).toHaveLength(1);
});

test("Ideas fixture: a lost create response retries the same intent and a double click admits one write", async ({ page }) => {
  const state = await accountFixtures(page, []);
  state.loseCreateResponse = true;
  await page.goto("/ideas");
  await page.getByRole("button", { name: "Add idea", exact: true }).click();
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Private retry fixture");
  await page.locator(".ideas-capture form").evaluate(form => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await expect(page.getByRole("button", { name: "Retry saving idea", exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Private retry fixture");
  await page.getByRole("button", { name: "Retry saving idea", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/ideas/${ideaId}$`));
  expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
  expect(state.ideas.size).toBe(1);
});

test("Ideas fixture: unknown save retains text and an explicit retry reuses its revision and request key", async ({ page }) => {
  const state = await accountFixtures(page);
  state.loseSaveResponse = true;
  await openIdea(page);
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Private saved-response retry fixture");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Private saved-response retry fixture");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expectSavedVersion(page, 2);
  expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
  expect(state.ideas.get(ideaId)?.revision).toBe(2);
});

test("Ideas fixture: an unavailable mutation reports unconfirmed delivery while retaining the original save", async ({ page }) => {
  const state = await accountFixtures(page);
  state.patchStatus = 503;
  await openIdea(page);
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Unavailable save fixture");
  await expect(page.locator("main").getByRole("alert")).toContainText("could not be confirmed");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  state.patchStatus = 200;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expectSavedVersion(page, 2);
  expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
});

test("Ideas fixture: conflict preserves edits and replacing them requires an explicit choice", async ({ page }) => {
  const state = await accountFixtures(page);
  await openIdea(page);
  state.ideas.set(ideaId, { ...idea(), revision: 2, content: content("Remote latest fixture") });
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Private conflicting title fixture");
  await expect(page.locator("main").getByRole("alert")).toContainText("A newer version is saved");
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Private conflicting title fixture");
  await page.getByRole("button", { name: "Load latest version", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Private conflicting title fixture");
  await page.getByRole("button", { name: "Load latest version", exact: true }).click();
  await page.getByRole("button", { name: "Replace with latest version", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Remote latest fixture");
  await expectSavedVersion(page, 2);
});

test("Ideas fixture: a schema-valid multibyte idea cannot exceed the full request byte cap", async ({ page }) => {
  const state = await accountFixtures(page);
  await openIdea(page);
  const oversized = "漢".repeat(11_000);
  await page.getByRole("textbox", { name: "Description (optional)", exact: true }).fill(oversized);
  await expect(page.locator("main").getByRole("alert")).toContainText("too large");
  expect(state.writes).toHaveLength(0);
  await expect(page.getByRole("textbox", { name: "Description (optional)", exact: true })).toHaveValue(oversized);
  expect(await browserValues(page)).not.toContain(oversized);
});

test("Ideas fixture: explicit brand creation preserves its original source after later idea edits", async ({ page }, testInfo) => {
  const original = idea(); original.content.details.audience = "Local workers"; original.content.details.solution = "Seasonal lunches";
  const state = await accountFixtures(page, [original]);
  await openIdea(page);
  await page.getByRole("button", { name: "Create brand", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectId}$`));
  await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toBeVisible();
  await expectProjectLabel(page, "Quiet kitchen fixture");
  expect(state.sources.get(projectId)).toMatchObject({ link: { ideaId, ideaRevision: 1, projectId }, content: original.content });
  expect(state.projects.get(projectId)?.context).toMatchObject({ offering: "Seasonal lunches", knownAudience: "Local workers", reformulationConfirmed: false, competitorReviewComplete: false, selectedName: null });
  const source = structuredClone(state.sources.get(projectId));
  const projectContext = structuredClone(state.projects.get(projectId)!.context);
  expect(Object.keys(state.writes[0]!.body).sort()).toEqual(["expectedRevision", "requestKey"]);
  const navigationToggle = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await navigationToggle.isVisible()) await navigationToggle.click();
  await page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Ideas", exact: true }).click();
  const originalIdea = page.getByRole("link", { name: /Quiet kitchen fixture/ });
  await expect(originalIdea).toHaveAttribute("href", `/ideas/${ideaId}`);
  await originalIdea.click();
  await expect(page.getByRole("link", { name: "Open created brand", exact: true })).toHaveAttribute("href", `/brands/account/${projectId}`);
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Edited idea title fixture");
  await expectSavedVersion(page, 3);
  await expect(page.getByLabel("Save status", { exact: true })).toHaveText("Saved");
  expect(state.ideas.get(ideaId)?.content.title).toBe("Edited idea title fixture");
  await page.getByRole("link", { name: "Open created brand", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectId}$`));
  await expectProjectLabel(page, "Quiet kitchen fixture");
  await expect(page.locator("main")).not.toContainText("Edited idea title fixture");
  expect(state.sources.get(projectId)).toEqual(source);
  expect(state.projects.get(projectId)?.context).toEqual(projectContext);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: testInfo.outputPath("idea-brand-source.png"), fullPage: true, scale: "css" });
});

test("Ideas fixture: uncertain brand creation retries its original key without creating twice", async ({ page }) => {
  const state = await accountFixtures(page); state.loseBrandResponse = true;
  await openIdea(page);
  await page.getByRole("button", { name: "Create brand", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByRole("button", { name: "Retry creating brand", exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  await page.getByRole("button", { name: "Retry creating brand", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectId}$`));
  expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
  expect(state.projects.size).toBe(1);
});

test("Ideas fixture: expiration hides private edits and verified same-account recovery retains them", async ({ page }) => {
  const state = await accountFixtures(page);
  await openIdea(page);
  state.patchStatus = 401;
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Private expiration recovery fixture");
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveCount(0);
  expect(await browserValues(page)).not.toContain("Private expiration recovery fixture");
  state.patchStatus = 200;
  await clickAccountAction(page, "Check account");
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Private expiration recovery fixture");
});

test("Ideas fixture: a changed account cannot see a pending save or the previous owner's edits", async ({ page }) => {
  const state = await accountFixtures(page);
  let release!: () => void; let start!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { start = resolve; });
  await page.route(`**/api/ideas/${ideaId}`, async route => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON(); start(); await wait;
    await reply(route, { idea: { ...idea(), revision: 2, content: body.content } });
  });
  await openIdea(page);
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Owner A delayed private save fixture");
  await requested;
  state.owner = ownerB;
  await clickAccountAction(page, "Check account");
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveCount(0);
  release();
  await expect(page.locator("main")).not.toContainText("Owner A delayed private save fixture");
  state.owner = ownerA;
  await clickAccountAction(page, "Check account");
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Quiet kitchen fixture");
});

test("Ideas fixture: pending sign-out masks data and fences a late brand response", async ({ page }) => {
  const state = await accountFixtures(page);
  let release!: () => void; let start!: () => void; let finishSignOut!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { start = resolve; });
  const signOut = new Promise<void>(resolve => { finishSignOut = resolve; });
  await page.route(`**/api/ideas/${ideaId}/brand`, async route => {
    const body = route.request().postDataJSON(); start(); await wait;
    const link: Link = { id: fixtureId(888), ownerId: ownerA, ideaId, ideaRevision: 1, projectId, requestKey: body.requestKey, createdAt: when };
    await reply(route, { idea: { ...idea(), revision: 2, content: { ...content(), state: "used" }, links: [link] }, link });
  });
  await page.route("**/api/auth/sign-out", async route => { await signOut; state.sessionStatus = 401; await reply(route, { authenticated: false }); });
  await openIdea(page);
  await page.getByRole("button", { name: "Create brand", exact: true }).click(); await requested;
  await clickAccountAction(page, "Sign out");
  await page.getByRole("button", { name: "Discard edits and sign out", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveCount(0);
  release();
  await expect(page).toHaveURL(new RegExp(`/ideas/${ideaId}$`));
  finishSignOut();
  await expect(page.getByRole("link", { name: "Sign in", exact: true }).first()).toBeVisible();
});

test("Ideas fixture: unsaved idea edits participate in account sign-out confirmation", async ({ page }) => {
  const state = await accountFixtures(page); state.patchStatus = 503;
  await openIdea(page);
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Private sign-out confirmation fixture");
  await clickAccountAction(page, "Sign out");
  await expect(page.getByRole("dialog", { name: "Sign out with unsaved account edits?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Private sign-out confirmation fixture");
});

test("Ideas fixture: internal navigation and failed sign-out preserve same-owner edits", async ({ page }) => {
  const state = await accountFixtures(page); state.patchStatus = 503;
  await openIdea(page);
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Private navigation recovery fixture");
  await page.getByRole("link", { name: "Back to ideas", exact: true }).click();
  await page.getByRole("link", { name: /Quiet kitchen fixture/ }).click();
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Private navigation recovery fixture");
  await page.route("**/api/auth/sign-out", route => reply(route, {}, 503));
  await clickAccountAction(page, "Sign out");
  await page.getByRole("button", { name: "Discard edits and sign out", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("Private navigation recovery fixture");
  await clickAccountAction(page, "Check account");
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Private navigation recovery fixture");
});

test("Ideas fixture: the native title form supports keyboard capture", async ({ page }) => {
  const state = await accountFixtures(page, []);
  await page.goto("/ideas");
  await page.getByRole("button", { name: "Add idea", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Idea title", exact: true });
  await title.fill("Keyboard capture fixture");
  await title.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/ideas/${ideaId}$`));
  expect(state.writes).toHaveLength(1);
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Keyboard capture fixture");
});

test("Ideas fixture: a transient initial read has an explicit retry without losing retained edits", async ({ page }) => {
  const state = await accountFixtures(page); state.patchStatus = 503;
  await openIdea(page);
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Retained read recovery fixture");
  await page.getByRole("link", { name: "Back to ideas", exact: true }).click();
  let failRead = true;
  await page.route(`**/api/ideas/${ideaId}`, route => failRead ? reply(route, {}, 503) : route.fallback());
  await page.getByRole("link", { name: /Quiet kitchen fixture/ }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("unavailable");
  failRead = false;
  await page.getByRole("button", { name: "Try loading idea again", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveValue("Retained read recovery fixture");
});

test("Ideas fixture: unavailable optional source metadata does not block the owned guided brand editor", async ({ page }) => {
  const state = await accountFixtures(page);
  await page.route(`**/api/projects/${projectId}/idea-source`, route => reply(route, {}, 503));
  await openIdea(page);
  await page.getByRole("button", { name: "Create brand", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectId}$`));
  expect(await page.evaluate(async id => (await fetch(`/api/projects/${id}/idea-source`, { cache: "no-store" })).status, projectId)).toBe(503);
  await page.reload();
  const composer = page.getByRole("textbox", { name: "Message Embel", exact: true });
  await expect(composer).toBeEditable();
  await composer.fill("Continue shaping the saved brand");
  await expect(composer).toHaveValue("Continue shaping the saved brand");
  await expect(page.getByRole("log", { name: "Conversation", exact: true })).toBeVisible();
  await expectProjectLabel(page, "Quiet kitchen fixture");
  expect(state.sources.get(projectId)?.link).toMatchObject({ ideaId, ideaRevision: 1, projectId });
  expect(state.writes).toHaveLength(1);
});

test("Ideas fixture: unverified, foreign and mismatched resources never enter private controls", async ({ page }) => {
  const state = await accountFixtures(page);
  state.sessionStatus = 401;
  await page.goto("/ideas");
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign in", exact: true }).first()).toBeVisible();
  state.sessionStatus = 200;
  await page.getByLabel("Account menu", { exact: true }).click();
  await clickAccountAction(page, "Check account");
  await page.getByLabel("Account menu", { exact: true }).press("Escape");
  await page.getByRole("button", { name: "Add idea", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toBeVisible();
  await page.route(`**/api/ideas/${ideaId}`, route => reply(route, { idea: idea(ideaB, ownerA, "Wrong resource private fixture") }));
  await page.goto(`/ideas/${ideaId}`);
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("Wrong resource private fixture");
});

test("Ideas fixture: a verified account can capture a title without completing a brief", async ({ page }) => {
  await emptyAccount(page);
  await page.goto("/ideas");
  await page.getByRole("button", { name: "Add idea", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Idea title", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Description (optional)", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save idea", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save idea", exact: true })).toBeDisabled();
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));

test("idea read recovery: retry stays local and returns focus without restarting account", async ({ page }, info) => {
  const state = await accountFixtures(page); let reads = 0, sessions = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/session") sessions++; });
  await page.route(`**/api/ideas/${ideaId}`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    reads++;
    if (reads === 1) return reply(route, {}, 503);
    return route.fallback();
  });
  await page.goto(`/ideas/${ideaId}`);
  const retry = page.getByRole("button", { name: "Try loading idea again", exact: true });
  await expect(retry).toBeVisible(); const initialSessions = sessions;
  await retry.focus(); await page.keyboard.press("Enter");
  const heading = page.getByRole("heading", { level: 1, name: "Quiet kitchen fixture." });
  await expect(heading).toBeVisible(); await expect(heading).toBeFocused();
  expect(reads).toBe(2); expect(sessions).toBe(initialSessions); expect(state.writes).toEqual([]);
  await expect(page.getByRole("textbox", { name: "Description (optional)", exact: true })).toHaveValue("A private fixture for seasonal lunches.");
  await page.screenshot({ path: info.outputPath("idea-local-read-retry.png") });
});
