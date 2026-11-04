import { expect, test, type Page, type Route } from "@playwright/test";

// Read-only synthetic fixtures. Reference names are never seeded into application data.
// Projects is account-only since 96ef9f1; browser drafts appear only through explicit recovery.
const owner = "aaaaaaaa-7777-4777-8777-777777777777";
const id = (n: number) => `cccccccc-7777-4777-8777-${String(n).padStart(12, "0")}`;
const at = "2026-10-10T16:00:00Z";
const names = ["Forma", "Northline", "Morrow", "Sunday", "Aster", "Kin"];
const scopes = ["complete_brand", "naming_only", "complete_brand", "complete_brand", "visual_identity_only", "complete_brand"] as const;
type Row = { id: string; owner_id: string; title: string; scope: string; current_revision: number; created_at: string; deleted_at: null; deletion_requested_at: null; deletion_state: "active"; lifecycle_version: number };
function row(n: number, title: string, scope: string = "complete_brand", hoursAgo = 0, ownerId = owner): Row {
  return { id: id(n), owner_id: ownerId, title, scope, current_revision: 1, created_at: new Date(Date.parse(at) - hoursAgo * 3_600_000).toISOString(), deleted_at: null, deletion_requested_at: null, deletion_state: "active", lifecycle_version: 0 };
}
const rows = () => names.map((title, n) => row(n + 1, title, scopes[n], [2, 5, 24, 48, 72, 96][n]));
const card = (page: Page, n: number) => page.locator(`.project-card[data-project-id="${id(n)}"]`);
async function reply(route: Route, body: unknown, status = 200) { await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }
async function fixture(page: Page) {
  const state = { owner, sessionStatus: 200, pageStatus: 200, projects: [] as Row[], writes: [] as string[] };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") { state.writes.push(path); return reply(route, {}, 405); }
    if (path === "/api/session") return reply(route, state.sessionStatus === 200 ? { user: { id: state.owner } } : { error: "Synthetic signed-out fixture" }, state.sessionStatus);
    if (path === "/api/projects/page") return reply(route, { ownerId: state.owner, items: state.projects, nextCursor: null }, state.pageStatus);
    return reply(route, {}, 404);
  });
  return state;
}
async function checkAccount(page: Page) {
  const menu = page.locator(".workspace-account-menu");
  if (await menu.getAttribute("open") === null) await menu.locator("summary").click();
  await page.locator(".workspace-account-panel").getByRole("button", { name: "Check account", exact: true }).click();
}

test("Projects reference: populated geometry, native artwork and saved project continuation", async ({ page }, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
  const state = await fixture(page); state.projects = rows(); await page.clock.install({ time: new Date(at) }); await page.goto("/brands");
  await expect(page.getByRole("heading", { name: "Projects.", exact: true })).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(6);
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByRole("link", { name: "Projects", exact: true })).toHaveAttribute("aria-current", "page");
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Close navigation", exact: true }).click();
  await expect(page.getByRole("link", { name: "New project", exact: true })).toHaveAttribute("href", "/brands/new");
  await expect(page.locator(".project-card").first()).toContainText("Forma");
  await expect(page.locator(".project-card").first()).toContainText("Complete brand");
  await expect(page.locator(".project-card").first()).toContainText("Created 2 hours ago");
  await expect(card(page, 1).getByRole("link")).toHaveAttribute("href", `/brands/account/${id(1)}`);
  if (info.project.name === "desktop") {
    const grid = await page.locator(".projects-grid").boundingBox(), first = await page.locator(".project-card").first().boundingBox();
    // Cards use the shared Home/Projects card (8db2bf1, e04add0) inside the original grid.
    expect(grid?.x).toBe(256); expect(grid?.y).toBe(280); expect(grid?.width).toBe(1008); expect(first?.width).toBe(324); expect(first?.height).toBe(272);
  }
  await page.getByText("Filter", { exact: true }).click();
  const panel = await page.locator(".projects-control[open] .projects-control-panel").boundingBox(); expect(panel!.x).toBeGreaterThanOrEqual(0); expect(panel!.x + panel!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByLabel("Filter projects by scope").press("Escape");
  const artwork = await page.locator(".projects-page img").evaluateAll(images => images.map(image => { const i = image as HTMLImageElement; return { src: i.getAttribute("src"), width: i.width, height: i.height, natural: i.naturalWidth }; }));
  expect(artwork.every(image => image.src?.startsWith("/projects/") && image.width === image.height && image.width === image.natural)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: info.outputPath("projects-populated.png"), fullPage: true, scale: "css" });
  expect(state.writes).toEqual([]);
});

test("Projects reference: empty state uses original artwork and opens existing creation flows", async ({ page }, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page); await page.goto("/brands");
  await expect(page.getByRole("heading", { name: "Your projects.", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your first project starts with an idea" })).toBeVisible();
  await expect(page.locator(".projects-toolbar")).toHaveCount(0); await expect(page.locator(".project-card")).toHaveCount(0);
  if (info.project.name === "desktop") await expect(page.locator('.app-mark img[src="/embel-mark.svg"]')).toBeVisible();
  await expect(page.locator('.projects-empty-panel img[src="/projects/empty-projects.svg"]')).toBeVisible();
  if (info.project.name === "desktop") { const panel = await page.locator(".projects-empty-panel").boundingBox(); expect(panel).toMatchObject({ x: 256, y: 212, width: 1008, height: 360 }); }
  await page.screenshot({ path: info.outputPath("projects-empty.png"), fullPage: true, scale: "css" });
  await page.getByRole("link", { name: "Create a project", exact: true }).click();
  await expect(page).toHaveURL(/\/brands\/new$/); await expect(page.getByRole("link", { name: "Create a logo", exact: true })).toHaveAttribute("href", "/brands/logo/new");
});

test("Projects: account cards keep their destination, honest summary metadata and filters", async ({ page }) => {
  const state = await fixture(page); state.projects = [row(1, "Forma")];
  await page.goto("/brands"); await expect(page.locator(".project-card")).toHaveCount(1);
  const accountCard = card(page, 1); await expect(accountCard).toContainText("Created"); await expect(accountCard).not.toContainText("Updated");
  await expect(accountCard.getByRole("link")).toHaveAttribute("href", `/brands/account/${id(1)}`);
  await page.getByText("Filter", { exact: true }).click(); await page.getByLabel("Filter projects by scope").selectOption("naming_only"); await expect(page.locator(".project-card")).toHaveCount(0);
  await page.getByLabel("Filter projects by scope").press("Escape"); await expect(page.locator(".projects-control[open]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No matching projects" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click(); await expect(page.locator(".project-card")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Search projects" }).fill("Unmatched synthetic title"); await expect(page.locator(".project-card")).toHaveCount(0); await expect(page.getByRole("heading", { name: "No matching projects" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click(); await expect(page.locator(".project-card")).toHaveCount(1); expect(state.writes).toEqual([]);
});

test("Projects: a failed first account page cannot claim an empty account and remains retryable", async ({ page }) => {
  const state = await fixture(page); state.pageStatus = 503; await page.goto("/brands");
  await expect(page.locator("main").getByRole("alert")).toContainText("Your projects could not be loaded"); await expect(page.getByRole("heading", { name: "Your first project starts with an idea" })).toHaveCount(0);
  state.pageStatus = 200; await page.getByRole("button", { name: "Try loading projects again" }).click(); await expect(page.getByRole("heading", { name: "Your first project starts with an idea" })).toBeVisible(); expect(state.writes).toEqual([]);
});

test("Projects: unavailable account verification and unreadable storage do not claim an empty collection", async ({ page }) => {
  const state = await fixture(page); state.sessionStatus = 503;
  await page.addInitScript(() => localStorage.setItem("fluid.local-drafts.v1", "unreadable synthetic fixture"));
  await page.goto("/brands");
  await expect(page.locator("main").getByRole("status")).toContainText("Account saving is unavailable.");
  await expect(page.locator("main").getByRole("button", { name: "Check account", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your first project starts with an idea" })).toHaveCount(0);
  state.sessionStatus = 200; state.projects = [row(1, "Forma")];
  await page.locator("main").getByRole("button", { name: "Check account", exact: true }).click();
  await expect(card(page, 1)).toBeVisible();
  await expect(page.getByText("Recovery data on this device could not be read. Your account projects remain available.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"))).toBe("unreadable synthetic fixture"); expect(state.writes).toEqual([]);
});

test("Projects: explicit verification masks account rows immediately while keeping filters", async ({ page }) => {
  const state = await fixture(page); state.projects = [row(20, "Private owner A"), ...rows()];
  await page.goto("/brands"); await expect(page.locator(".project-card")).toHaveCount(7);
  await page.getByText("Sort", { exact: true }).click(); await page.getByRole("combobox", { name: "Sort projects", exact: true }).selectOption("alphabetical"); await page.getByRole("combobox", { name: "Sort projects", exact: true }).press("Escape");
  await expect(page.locator(".project-card").first()).toContainText("Aster");
  let release!: () => void, started!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/session", async route => { started(); await hold; return reply(route, {}, 401); });
  // Routine focus revalidation keeps a verified workspace (11eae67); an explicit check fences it at once.
  await checkAccount(page); await requested;
  await expect(page.locator(".project-card")).toHaveCount(0);
  release(); await expect(page.locator("main").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText("Private owner A", { exact: true })).toHaveCount(0);
  await page.unroute("**/api/session"); await checkAccount(page);
  await expect(page.locator(".project-card")).toHaveCount(7); await expect(page.locator(".project-card").first()).toContainText("Aster");
  expect(state.writes).toEqual([]);
});

test("Projects: a page belonging to another owner is never displayed", async ({ page }) => {
  const state = await fixture(page);
  await page.route("**/api/projects/page?**", async route => reply(route, { ownerId: id(90), items: [row(91, "Other owner's secret", "naming_only", 0, id(90))], nextCursor: null }));
  // A foreign-owner page invalidates the verified session instead of rendering it.
  await page.goto("/brands"); await expect(page.locator("main").getByRole("status")).toContainText("No verified account session.");
  await expect(page.getByText("Other owner's secret", { exact: true })).toHaveCount(0); await expect(page.locator(".project-card")).toHaveCount(0); expect(state.writes).toEqual([]);
});

test("Projects: a delayed account page cannot republish rows after an owner change", async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { started = resolve; });
  let first = true;
  await page.route("**/api/projects/page?**", async route => {
    if (!first) return reply(route, { ownerId: state.owner, items: [], nextCursor: null });
    first = false; started(); await pending;
    return reply(route, { ownerId: owner, items: [row(99, "Delayed private owner A")], nextCursor: null });
  });
  await page.goto("/brands"); await requested;
  state.owner = id(90); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Your projects.", exact: true })).toBeVisible();
  release(); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
  await expect(page.locator(".project-card[data-storage=account]")).toHaveCount(0);
  await expect(page.getByText("Delayed private owner A", { exact: true })).toHaveCount(0); expect(state.writes).toEqual([]);
});
