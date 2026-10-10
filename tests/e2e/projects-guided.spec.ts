import { expect, test, type Page, type Route } from "@playwright/test";
import { accountProjectDraft } from "../../src/components/workspace/project-draft-adapter";
import { contextSnapshotSchema } from "../../src/domain/projects";

// Read-only synthetic fixtures. Reference names are never seeded into application data.
const owner = "aaaaaaaa-7777-4777-8777-777777777777";
const id = (n: number) => `cccccccc-7777-4777-8777-${String(n).padStart(12, "0")}`;
const at = "2026-10-10T16:00:00Z";
const names = ["Forma", "Northline", "Morrow", "Sunday", "Aster", "Kin"];
const descriptions = ["Considered furniture for everyday living.", "An outdoor clothing brand built for the long way.", "Everyday skincare with a quieter point of view.", "A neighborhood bakery, warm from the start.", "A thoughtful florist for everyday gestures.", "A coworking space for independent minds."];
const scopes = ["complete_brand", "naming_only", "complete_brand", "complete_brand", "visual_identity_only", "complete_brand"] as const;
function drafts() {
  return names.map((title, n) => ({ ...accountProjectDraft({ id: id(n + 1), owner_id: owner, title, scope: scopes[n]!, current_revision: 1, created_at: at, context: contextSnapshotSchema.parse({ description: descriptions[n] }) }),
    stage: ["positioning", "review", "audience", "description", "description", "competitors"][n], updatedAt: new Date(Date.parse(at) - [2, 5, 24, 48, 72, 96][n]! * 3_600_000).toISOString() }));
}
async function reply(route: Route, body: unknown, status = 200) { await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function fixture(page: Page) {
  const state = { owner, sessionStatus: 401, pageStatus: 200, projects: [] as { id: string; owner_id: string; title: string; scope: string; current_revision: number; created_at: string }[], writes: [] as string[] };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") { state.writes.push(path); return reply(route, {}, 405); }
    if (path === "/api/session") return reply(route, state.sessionStatus === 200 ? { user: { id: state.owner } } : { error: "Synthetic signed-out fixture" }, state.sessionStatus);
    if (path === "/api/projects/page") return reply(route, { ownerId: state.owner, items: state.projects, nextCursor: null }, state.pageStatus);
    return reply(route, {}, 404);
  });
  return state;
}
async function seed(page: Page) { const stored = JSON.stringify({ version: 1, drafts: drafts() }); await page.addInitScript(stored => localStorage.setItem("fluid.local-drafts.v1", stored), stored); return stored; }

test("Projects reference: populated geometry, native artwork and real draft continuation", async ({ page }, info) => {
  const state = await fixture(page), stored = await seed(page); await page.clock.install({ time: new Date(at) }); await page.goto("/brands");
  await expect(page.getByRole("heading", { name: "Projects.", exact: true })).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(6);
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByRole("link", { name: "Projects", exact: true })).toHaveAttribute("aria-current", "page");
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Close navigation", exact: true }).click();
  await expect(page.getByRole("link", { name: "New project", exact: true })).toHaveAttribute("href", "/brands/new");
  await expect(page.locator(".project-card").first()).toContainText("Positioning");
  await expect(page.locator(".project-card").first()).toContainText("Updated 2 hours ago");
  await expect(page.getByRole("link", { name: "Continue Forma (browser draft)", exact: true })).toHaveAttribute("href", `/brands/${id(1)}`);
  if (info.project.name === "desktop") {
    const grid = await page.locator(".projects-grid").boundingBox(), card = await page.locator(".project-card").first().boundingBox();
    expect(grid?.x).toBe(256); expect(grid?.y).toBe(280); expect(grid?.width).toBe(1008); expect(card?.width).toBe(324); expect(card?.height).toBe(264);
  }
  await page.getByText("Filter", { exact: true }).click();
  const panel = await page.locator(".projects-control[open] .projects-control-panel").boundingBox(); expect(panel!.x).toBeGreaterThanOrEqual(0); expect(panel!.x + panel!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByLabel("Filter projects by scope").press("Escape");
  const artwork = await page.locator(".projects-page img").evaluateAll(images => images.map(image => { const i = image as HTMLImageElement; return { src: i.getAttribute("src"), width: i.width, height: i.height, natural: i.naturalWidth }; }));
  expect(artwork.every(image => image.src?.startsWith("/projects/") && image.width === image.height && image.width === image.natural)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: info.outputPath("projects-populated.png"), fullPage: true, scale: "css" });
  expect(await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"))).toBe(stored); expect(state.writes).toEqual([]);
});

test("Projects reference: empty state uses original artwork and opens existing creation flows", async ({ page }, info) => {
  await fixture(page); await page.goto("/brands");
  await expect(page.getByRole("heading", { name: "Your projects.", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your first project starts with an idea" })).toBeVisible();
  await expect(page.locator(".projects-toolbar")).toHaveCount(0); await expect(page.locator(".project-card")).toHaveCount(0);
  if (info.project.name === "desktop") await expect(page.locator('.app-mark img[src="/projects/empty-shell-mark.svg"]')).toBeVisible();
  await expect(page.locator('.projects-empty-panel img[src="/projects/empty-projects.svg"]')).toBeVisible();
  if (info.project.name === "desktop") { const panel = await page.locator(".projects-empty-panel").boundingBox(); expect(panel).toMatchObject({ x: 256, y: 212, width: 1008, height: 360 }); }
  await page.screenshot({ path: info.outputPath("projects-empty.png"), fullPage: true, scale: "css" });
  await page.getByRole("link", { name: "Create a brand draft", exact: true }).click();
  await expect(page).toHaveURL(/\/brands\/new$/); await expect(page.getByRole("link", { name: "Create a logo", exact: true })).toHaveAttribute("href", "/brands/logo/new");
});

test("Projects: account copies retain separate destinations and honest summary metadata", async ({ page }) => {
  const state = await fixture(page); state.sessionStatus = 200; state.projects = [{ id: id(1), owner_id: owner, title: "Forma", scope: "complete_brand", current_revision: 3, created_at: at }];
  const stored = await seed(page); await page.goto("/brands"); await expect(page.locator(".project-card")).toHaveCount(7);
  const accountCard = page.locator(".project-card[data-storage=account]"); await expect(accountCard).toContainText("Unavailable"); await expect(accountCard).toContainText("Created"); await expect(accountCard).not.toContainText("Updated");
  await expect(accountCard).toHaveAttribute("href", `/brands/account/${id(1)}`);
  await page.getByText("Filter", { exact: true }).click(); await page.getByLabel("Filter projects by storage").selectOption("account"); await expect(page.locator(".project-card")).toHaveCount(1);
  await page.getByLabel("Filter projects by scope").press("Escape"); await expect(page.locator(".projects-control[open]")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search projects" }).fill("Considered furniture"); await expect(page.locator(".project-card")).toHaveCount(0); await expect(page.getByRole("heading", { name: "No matching projects" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click(); await expect(page.locator(".project-card")).toHaveCount(7); expect(state.writes).toEqual([]); expect(await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"))).toBe(stored);
});

test("Projects: a failed first account page cannot claim an empty account and remains retryable", async ({ page }) => {
  const state = await fixture(page); state.sessionStatus = 200; state.pageStatus = 503; await page.goto("/brands");
  await expect(page.locator("main").getByRole("alert")).toContainText("Account projects could not be loaded"); await expect(page.getByRole("heading", { name: "Your first project starts with an idea" })).toHaveCount(0);
  state.pageStatus = 200; await page.getByRole("button", { name: "Try loading account projects again" }).click(); await expect(page.getByRole("heading", { name: "Your first project starts with an idea" })).toBeVisible(); expect(state.writes).toEqual([]);
});

test("Projects: unavailable account verification and unreadable storage do not claim an empty collection", async ({ page }) => {
  const state = await fixture(page); state.sessionStatus = 503;
  await page.addInitScript(() => localStorage.setItem("fluid.local-drafts.v1", "unreadable synthetic fixture"));
  await page.goto("/brands");
  await expect(page.getByText("Account saving is unavailable. Browser drafts remain available.", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved drafts could not be read.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your first project starts with an idea" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "New project", exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"))).toBe("unreadable synthetic fixture"); expect(state.writes).toEqual([]);
});

test("Projects: verification masks account rows immediately while keeping browser data and filters", async ({ page }) => {
  const state = await fixture(page); state.sessionStatus = 200; state.projects = [{ id: id(20), owner_id: owner, title: "Private owner A", scope: "complete_brand", current_revision: 1, created_at: at }];
  const stored = await seed(page); await page.goto("/brands"); await expect(page.locator(".project-card[data-storage=account]")).toHaveCount(1);
  await page.getByText("Sort", { exact: true }).click(); await page.getByRole("combobox", { name: "Sort projects", exact: true }).selectOption("alphabetical"); await page.getByRole("combobox", { name: "Sort projects", exact: true }).press("Escape");
  let release!: () => void, started!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/session", async route => { started(); await hold; return reply(route, {}, 401); });
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await requested;
  await expect(page.locator(".project-card[data-storage=account]")).toHaveCount(0); await expect(page.locator(".project-card[data-storage=browser]")).toHaveCount(6); await expect(page.locator(".project-card").first()).toContainText("Aster");
  release(); await expect(page.getByText("Private owner A", { exact: true })).toHaveCount(0); expect(await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"))).toBe(stored); expect(state.writes).toEqual([]);
});

test("Projects: a page belonging to another owner is never displayed", async ({ page }) => {
  const state = await fixture(page); state.sessionStatus = 200;
  await page.route("**/api/projects/page?**", async route => reply(route, { ownerId: id(90), items: [{ id: id(91), owner_id: id(90), title: "Other owner's secret", scope: "naming_only", current_revision: 1, created_at: at }], nextCursor: null }));
  await page.goto("/brands"); await expect(page.getByRole("heading", { name: "Your projects.", exact: true })).toBeVisible(); await expect(page.getByText("Other owner's secret", { exact: true })).toHaveCount(0); expect(state.writes).toEqual([]);
});

test("Projects: a delayed account page cannot republish rows after an owner change", async ({ page }) => {
  const state = await fixture(page); state.sessionStatus = 200;
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { started = resolve; });
  let first = true;
  await page.route("**/api/projects/page?**", async route => {
    if (!first) return reply(route, { ownerId: state.owner, items: [], nextCursor: null });
    first = false; started(); await pending;
    return reply(route, { ownerId: owner, items: [{ id: id(99), owner_id: owner, title: "Delayed private owner A", scope: "complete_brand", current_revision: 1, created_at: at }], nextCursor: null });
  });
  await page.goto("/brands"); await requested;
  state.owner = id(90); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Your projects.", exact: true })).toBeVisible();
  release(); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
  await expect(page.locator(".project-card[data-storage=account]")).toHaveCount(0);
  await expect(page.getByText("Delayed private owner A", { exact: true })).toHaveCount(0); expect(state.writes).toEqual([]);
});
