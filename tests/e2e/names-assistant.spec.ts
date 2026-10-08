import { expect, test, type Page } from "@playwright/test";
import { accountProjectSchema, type AccountProject } from "../../src/domain/project-api";
import { projectNamingOverviewSchema } from "../../src/domain/naming-jobs";
import { createEmptyNamesWorkspace, namesWorkspaceSchema } from "../../src/components/naming/local-names";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { getNamingReadiness } from "../../src/domain/project-naming";

// Entirely intercepted synthetic account/project data; no provider or live database requests.
const owner = "aaaaaaaa-1111-4111-8111-111111111111", other = "dddddddd-1111-4111-8111-111111111111";
const id = (n: number) => `bbbbbbbb-1111-4111-8111-${String(n).padStart(12, "0")}`;
const project = (n: number, ownerId = owner, scope: AccountProject["scope"] = "naming_only") => accountProjectSchema.parse({ id: id(n), owner_id: ownerId, scope, title: `Synthetic project ${n}`, current_revision: 1, created_at: "2026-10-05T12:00:00.000002Z", context: { description: `Synthetic naming brief ${n}.` } });

async function fixture(page: Page) {
  const state = { owner: owner as string | null, projects: [project(3), project(2, owner, "complete_brand"), project(1, owner, "visual_identity_only")], status: 200, next: false, requests: [] as { path: string; method: string }[], delay: null as null | { started: boolean; promise: Promise<void>; release: () => void } };
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    state.requests.push({ path, method: route.request().method() });
    const reply = async (data: unknown, status = 200) => route.fulfill({ contentType: "application/json", status, body: JSON.stringify(data) }).catch(() => undefined);
    if (path === "/api/session") return reply(state.owner ? { user: { id: state.owner } } : {}, state.owner ? 200 : 401);
    if (!state.owner) return reply({}, 401);
    if (path === "/api/projects/page") {
      if (state.status !== 200) return reply({}, state.status);
      const rows = url.searchParams.has("cursorId") ? [project(0, state.owner)] : state.projects;
      const frozen = { ownerId: state.owner, items: rows.map(item => ({ id: item.id, owner_id: item.owner_id, scope: item.scope, title: item.title, current_revision: item.current_revision, created_at: item.created_at })), nextCursor: state.next && !url.searchParams.has("cursorId") ? { id: rows.at(-1)!.id, createdAt: rows.at(-1)!.created_at } : null };
      if (state.delay && !state.delay.started) { state.delay.started = true; await state.delay.promise; }
      return reply(frozen);
    }
    const chosen = state.projects.find(item => path === `/api/projects/${item.id}/naming`);
    if (chosen) return reply(projectNamingOverviewSchema.parse({ project: chosen, readiness: getNamingReadiness(chosen.context, chosen.scope), session: null, preferences: null, currentSelection: null, batches: { ownerId: chosen.owner_id, projectId: chosen.id, items: [], nextCursor: null }, candidates: { ownerId: chosen.owner_id, projectId: chosen.id, items: [], nextCursor: null }, availability: { status: "unavailable", operation: "naming.generate", reason: "worker_unavailable" }, jobs: [], screening: { domains: { status: "not_checked", reason: "integration_unavailable" }, handles: { status: "not_checked", reason: "integration_unavailable" }, trademarks: { status: "not_checked", reason: "integration_unavailable" } } }));
    if (path === "/api/names") return reply({ ownerId: state.owner, items: [], nextCursor: null });
    return reply({}, 404);
  });
  return state;
}
async function open(page: Page) { await page.goto("/names"); await page.getByRole("tab", { name: "AI Assistant" }).click(); await expect(page.getByRole("heading", { name: "AI naming assistant" })).toBeVisible(); }
const mutations = (state: Awaited<ReturnType<typeof fixture>>) => state.requests.filter(item => item.method !== "GET");

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
  await expect(page.getByRole("region", { name: "Naming conversation" })).toHaveCount(0);
  await page.reload(); await expect(page.getByText("Strategy needs review", { exact: true })).toBeVisible();
  expect(mutations(state)).toEqual([]);
  await open(page); await page.getByLabel("Account project").selectOption(id(3));
  await page.getByRole("link", { name: "Open project Naming" }).click();
  await expect(page.getByRole("region", { name: "Naming conversation" })).toBeVisible();
  await expect(page.getByText("Synthetic naming brief 3.", { exact: true })).toBeVisible();
  expect(mutations(state)).toEqual([]);
});

test("assistant bridge: signed-out state and scratch path preserve browser data", async ({ page }) => {
  const state = await fixture(page); state.owner = null;
  await open(page);
  await expect(page.getByText("No verified account session.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Account project")).toHaveCount(0);
  expect(state.requests.filter(item => item.path === "/api/projects/page")).toEqual([]);
  const before = await page.evaluate(() => JSON.stringify(localStorage));
  await page.getByRole("link", { name: "Create naming brief" }).click();
  await expect(page).toHaveURL(/\/brands\/new\?scope=naming_only$/);
  await expect(page.getByRole("radio", { name: "Naming", exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).toBe(before);
  expect(mutations(state)).toEqual([]);
});

test("assistant bridge: account switch clears selection and delayed private replies", async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  state.delay = { started: false, promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
  await open(page); await expect.poll(() => state.delay!.started).toBe(true);
  state.owner = other; state.projects = [project(8, other)];
  await page.getByRole("button", { name: "Check account", exact: true }).click();
  await expect(page.getByLabel("Account project").locator("option")).toHaveCount(2);
  state.delay.release();
  await expect(page.getByLabel("Account project").locator("option")).toHaveCount(2);
  await expect(page.getByLabel("Account project").locator("option").last()).toContainText("Synthetic project 8");
  await page.getByLabel("Account project").selectOption(id(8));
  state.owner = owner; state.projects = [project(3)];
  await page.getByRole("button", { name: "Check account", exact: true }).click();
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

test("assistant bridge: account library is explicit and browser comparison stays separate", async ({ page }) => {
  const state = await fixture(page);
  const browser = createEmptyNamesWorkspace();
  browser.candidates.push({ source: { id: id(9), value: "Synthetic browser name", origin: "manual", history: [], createdAt: "2026-10-05T12:00:00.000Z" }, context: contextSnapshotSchema.parse({ description: "Browser-only captured brief" }), runId: null, explanation: "Added manually", favorite: true, saved: true });
  browser.ui.comparisonIds = [id(9)]; browser.ui.compareOpen = true;
  const raw = JSON.stringify(namesWorkspaceSchema.parse(browser));
  await page.addInitScript(value => localStorage.setItem("fluid.names.v1", value), raw);
  await open(page);
  await expect(page.getByText("Synthetic browser name", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Comparison tray")).toHaveCount(0);
  await expect(page.getByText("Browser workspace ·", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Account naming", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open account names library" }).click();
  await expect(page.getByRole("button", { name: "Account library", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Account names library" })).toBeVisible();
  await page.getByRole("button", { name: "Browser library", exact: true }).click();
  await expect(page.getByLabel("Comparison tray")).toBeVisible();
  await expect(page.getByText("Synthetic browser name", { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fluid.names.v1")!).candidates)).toEqual(browser.candidates);
  expect(mutations(state)).toEqual([]);
});
