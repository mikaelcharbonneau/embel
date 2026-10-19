import { expect, test, type Page } from "@playwright/test";
import { accountProjectSchema, type AccountProject } from "../../src/domain/project-api";
import { accountProjectPageSchema } from "../../src/domain/project-pages";
import { projectNamingOverviewSchema } from "../../src/domain/naming-jobs";
import { createEmptyNamesWorkspace, namesWorkspaceSchema } from "../../src/components/naming/local-names";
import { contextSnapshotSchema } from "../../src/domain/projects";
import type { AccountNamesWorkspace } from "../../src/domain/names-workspace";
import { getNamingReadiness } from "../../src/domain/project-naming";

// Entirely intercepted synthetic account/project data; no provider or live database requests.
const owner = "aaaaaaaa-1111-4111-8111-111111111111", other = "dddddddd-1111-4111-8111-111111111111";
const id = (n: number) => `bbbbbbbb-1111-4111-8111-${String(n).padStart(12, "0")}`;
const project = (n: number, ownerId = owner, scope: AccountProject["scope"] = "naming_only") => accountProjectSchema.parse({ id: id(n), owner_id: ownerId, scope, title: `Synthetic project ${n}`, current_revision: 1, created_at: "2026-10-05T12:00:00.000002Z", context: { description: `Synthetic naming brief ${n}.` } });

async function fixture(page: Page) {
  const workspaces = new Map<string, AccountNamesWorkspace>();
  const state = { owner: owner as string | null, projects: [project(3), project(2, owner, "complete_brand"), project(1, owner, "visual_identity_only")], status: 200, next: false, requests: [] as { path: string; method: string }[], delay: null as null | { started: boolean; promise: Promise<void>; release: () => void } };
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    state.requests.push({ path, method: route.request().method() });
    const reply = async (data: unknown, status = 200) => route.fulfill({ contentType: "application/json", status, body: JSON.stringify(data) }).catch(() => undefined);
    if (path === "/api/session") return reply(state.owner ? { user: { id: state.owner } } : {}, state.owner ? 200 : 401);
    if (!state.owner) return reply({}, 401);
    if (path === "/api/projects" && route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      const created = accountProjectSchema.parse({ ...body, id: id(50), owner_id: state.owner, current_revision: 1, created_at: "2026-10-17T12:00:00Z" });
      state.projects.unshift(created); return reply({ project: created }, 201);
    }
    if (path === "/api/names/ai") return reply({ ownerId: state.owner, availability: { status: "unavailable", reason: "local_runtime_required" }, jobs: [], hasMore: false });
    if (path === "/api/names/workspace") {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        workspaces.set(state.owner, { id: id(99), ownerId: state.owner, revision: body.expectedRevision + 1, payload: namesWorkspaceSchema.parse(body.payload), createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" });
      }
      return reply({ ownerId: state.owner, workspace: workspaces.get(state.owner) ?? null });
    }
    if (path === "/api/projects/page") {
      if (state.status !== 200) return reply({}, state.status);
      const rows = url.searchParams.has("cursorId") ? [project(0, state.owner)] : state.projects;
      const frozen = accountProjectPageSchema.parse({ ownerId: state.owner, items: rows.map(item => ({ id: item.id, owner_id: item.owner_id, scope: item.scope, title: item.title, current_revision: item.current_revision, created_at: item.created_at, deleted_at: null, deletion_requested_at: null, deletion_state: "active", lifecycle_version: 0 })), nextCursor: state.next && !url.searchParams.has("cursorId") ? { id: rows.at(-1)!.id, createdAt: rows.at(-1)!.created_at } : null });
      if (state.delay && !state.delay.started) { state.delay.started = true; await state.delay.promise; }
      return reply(frozen);
    }
    const chosen = state.projects.find(item => path === `/api/projects/${item.id}/naming`);
    if (chosen) return reply(projectNamingOverviewSchema.parse({ project: chosen, readiness: getNamingReadiness(chosen.context, chosen.scope), session: null, preferences: null, currentSelection: null, batches: { ownerId: chosen.owner_id, projectId: chosen.id, items: [], nextCursor: null }, candidates: { ownerId: chosen.owner_id, projectId: chosen.id, items: [], nextCursor: null }, availability: { status: "unavailable", operation: "naming.generate", reason: "worker_unavailable" }, jobs: [], screening: { domains: { status: "not_checked", reason: "integration_unavailable" }, handles: { status: "not_checked", reason: "integration_unavailable" }, trademarks: { status: "not_checked", reason: "integration_unavailable" } } }));
    if (path === "/api/names") return reply({ ownerId: state.owner, items: [], nextCursor: null });
    const saved = state.projects.find(item => path === `/api/projects/${item.id}`);
    if (saved) return reply({ project: saved });
    return reply({}, 404);
  });
  return state;
}
async function bridge(page: Page) { await page.getByRole("button", { name: "AI Assistant", exact: true }).click(); await page.getByText("Continue with a saved project", { exact: true }).click(); await expect(page.getByRole("heading", { name: "AI naming assistant" })).toBeVisible(); }
async function open(page: Page) { await page.goto("/names"); await bridge(page); }
const mutations = (state: Awaited<ReturnType<typeof fixture>>) => state.requests.filter(item => item.method !== "GET" && item.path !== "/api/names/workspace");

test("assistant entry: a new brief opens the current project Naming conversation without legacy generation", async ({ page }) => {
  const state = await fixture(page); await page.goto("/names");
  await page.getByRole("button", { name: "AI Assistant", exact: true }).click();
  await page.getByRole("textbox", { name: "What are you naming?", exact: true }).fill("A synthetic naming brief for a new neighborhood studio.");
  await page.getByRole("button", { name: "Continue to Naming", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${id(50)}/naming$`));
  await expect(page.getByRole("complementary", { name: "Naming conversation", exact: true })).toBeVisible();
  await expect(page.getByText("Which approaches would you like to explore?", { exact: true })).toBeVisible();
  expect(mutations(state)).toEqual([{ path: "/api/projects", method: "POST" }]);
  expect(state.projects[0]).toMatchObject({ scope: "naming_only", context: { description: "A synthetic naming brief for a new neighborhood studio." } });
});

test("Home Name: saves its brief and opens the same current Naming conversation without Strategy research", async ({ page }) => {
  const state = await fixture(page); await page.goto("/");
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill("A synthetic naming brief submitted from Home.");
  await page.getByRole("button", { name: "Project scope: Brand", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Name", exact: true }).click();
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${id(50)}/naming$`));
  await expect(page.getByRole("complementary", { name: "Naming conversation", exact: true })).toBeVisible();
  await expect(page.getByText("Which approaches would you like to explore?", { exact: true })).toBeVisible();
  expect(mutations(state)).toEqual([{ path: "/api/projects", method: "POST" }]);
  expect(state.projects[0]!.context.intake.guidedInterview).toBeUndefined();
});

test("assistant bridge: choose projects, readiness and reload never enqueue", async ({ page }, info) => {
  const state = await fixture(page); await open(page);
  await expect(page.getByLabel("Account project")).toBeVisible();
  await expect(page.getByLabel("Account project").locator("option")).toHaveCount(3);
  await page.getByLabel("Account project").selectOption(id(3));
  await expect(page.getByRole("link", { name: "Open project Naming" })).toHaveAttribute("href", `/brands/account/${id(3)}/naming`);
  await page.getByLabel("Account project").selectOption(id(2));
  await expect(page.getByRole("link", { name: "Open project Naming" })).toHaveAttribute("href", `/brands/account/${id(2)}/naming`);
  await page.screenshot({ path: info.outputPath("assistant-projects.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Open project Naming" }).click();
  await expect(page.getByText("Strategy needs review", { exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Naming conversation", includeHidden: true })).toContainText("Review Strategy to continue the Naming conversation.");
  await expect(page.getByRole("region", { name: "Naming choices", includeHidden: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Start exploring|Continue exploring/, includeHidden: true })).toHaveCount(0);
  await page.reload(); await expect(page.getByText("Strategy needs review", { exact: true })).toBeVisible();
  expect(mutations(state)).toEqual([]);
  await open(page); await page.getByLabel("Account project").selectOption(id(3));
  await page.getByRole("link", { name: "Open project Naming" }).click();
  await expect(page.getByRole("complementary", { name: "Naming conversation" })).toBeVisible();
  await page.getByText("Saved project context", { exact: true }).click();
  await expect(page.getByText("Synthetic naming brief 3.", { exact: true })).toBeVisible();
  expect(mutations(state)).toEqual([]);
});

test("assistant bridge: signed-out Names gates all normal tools", async ({ page }) => {
  const state = await fixture(page); state.owner = null;
  await page.goto("/names");
  await expect(page.getByText("Sign in to keep your names, workshop, and history together.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Account project")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "AI Assistant", exact: true })).toHaveCount(0);
  expect(state.requests.filter(item => item.path === "/api/projects/page")).toEqual([]);
  expect(mutations(state)).toEqual([]);
});

test("assistant bridge: account switch clears selection and delayed private replies", async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  state.delay = { started: false, promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
  await open(page); await expect.poll(() => state.delay!.started).toBe(true);
  state.owner = other; state.projects = [project(8, other)];
  if (!await page.getByRole("button", { name: "Check account", exact: true }).isVisible()) await page.getByLabel("Account menu", { exact: true }).click();
  await page.getByRole("button", { name: "Check account", exact: true }).click();
  await bridge(page);
  await expect(page.getByLabel("Account project").locator("option")).toHaveCount(2);
  state.delay.release();
  await expect(page.getByLabel("Account project").locator("option")).toHaveCount(2);
  await expect(page.getByLabel("Account project").locator("option").last()).toContainText("Synthetic project 8");
  await page.getByLabel("Account project").selectOption(id(8));
  state.owner = owner; state.projects = [project(3)];
  if (!await page.getByRole("button", { name: "Check account", exact: true }).isVisible()) await page.getByLabel("Account menu", { exact: true }).click();
  await page.getByRole("button", { name: "Check account", exact: true }).click();
  await bridge(page);
  await expect(page.getByRole("link", { name: "Open project Naming" })).toHaveCount(0);
  await expect(page.getByLabel("Account project").locator("option").last()).toContainText("Synthetic project 3");
  expect(mutations(state)).toEqual([]);
});

test("assistant bridge: pagination retry and refresh preserve explicit choice", async ({ page }) => {
  const state = await fixture(page); state.next = true;
  await open(page); await page.getByLabel("Account project").selectOption(id(3));
  state.status = 503; await page.getByRole("button", { name: "Load more projects", exact: true }).click();
  await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText("Your loaded projects remain available.");
  await expect(page.getByRole("link", { name: "Open project Naming" })).toHaveAttribute("href", `/brands/account/${id(3)}/naming`);
  state.status = 200; await page.getByRole("button", { name: "Try loading projects again" }).click();
  await expect(page.getByLabel("Account project").locator("option")).toHaveCount(4);
  await page.getByLabel("Search loaded projects").fill("project 0");
  await expect(page.getByLabel("Account project").locator("option")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Open project Naming" })).toHaveCount(0);
  await page.getByLabel("Search loaded projects").fill("");
  await page.getByRole("button", { name: "Refresh project list" }).click();
  await expect(page.getByLabel("Account project").locator("option")).toHaveCount(3);
  expect(mutations(state)).toEqual([]);
});

test("assistant bridge: one library keeps unowned browser backups separate from account content", async ({ page }) => {
  const state = await fixture(page);
  const browser = createEmptyNamesWorkspace();
  browser.candidates.push({ source: { id: id(9), value: "Synthetic browser name", origin: "manual", history: [], createdAt: "2026-10-05T12:00:00.000Z" }, context: contextSnapshotSchema.parse({ description: "Browser-only captured brief" }), runId: null, explanation: "Added manually", favorite: true, saved: true });
  browser.ui.comparisonIds = [id(9)]; browser.ui.compareOpen = true;
  const raw = JSON.stringify(namesWorkspaceSchema.parse(browser));
  await page.addInitScript(value => localStorage.setItem("fluid.names.v1", value), raw);
  await open(page);
  await expect(page.getByText("Synthetic browser name", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Comparison tray")).toHaveCount(0);
  await page.getByRole("button", { name: "Open names library" }).click();
  await expect(page.getByRole("region", { name: "Account names library" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Account library", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Browser library", exact: true })).toHaveCount(0);
  await expect(page.getByText("Synthetic browser name", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fluid.names.v1")!).candidates)).toEqual(browser.candidates);
  expect(mutations(state)).toEqual([]);
});
