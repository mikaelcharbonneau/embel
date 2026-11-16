import { expect, test, type Page, type Route } from "@playwright/test";
import { checkNormalAccount, refocusWindow, signedOutInvite } from "./account-check";

// Read-only synthetic fixtures. Reference names are never seeded into application data.
// Projects is account-only since 96ef9f1; browser drafts appear only through explicit recovery.
const owner = "aaaaaaaa-7777-4777-8777-777777777777";
const id = (n: number) => `cccccccc-7777-4777-8777-${String(n).padStart(12, "0")}`;
const at = "2026-10-10T16:00:00Z";
const names = ["Forma", "Northline", "Morrow", "Sunday", "Aster", "Kin"];
type Row = {
  id: string;
  owner_id: string;
  title: string;
  scope: string;
  current_revision: number;
  created_at: string;
  deleted_at: null;
  deletion_requested_at: null;
  deletion_state: "active";
  lifecycle_version: number;
};
function row(n: number, title: string, scope: string = "complete_brand", hoursAgo = 0, ownerId = owner): Row {
  return {
    id: id(n),
    owner_id: ownerId,
    title,
    scope,
    current_revision: 1,
    created_at: new Date(Date.parse(at) - hoursAgo * 3_600_000).toISOString(),
    deleted_at: null,
    deletion_requested_at: null,
    deletion_state: "active",
    lifecycle_version: 0,
  };
}
const rows = () => names.map((title, n) => row(n + 1, title, "complete_brand", [2, 5, 24, 48, 72, 96][n]));
const card = (page: Page, n: number) => page.locator(`.project-card[data-project-id="${id(n)}"]`);
async function reply(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
async function fixture(page: Page) {
  const state = { owner, sessionStatus: 200, pageStatus: 200, projects: [] as Row[], writes: [] as string[] };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      state.writes.push(path);
      return reply(route, {}, 405);
    }
    if (path === "/api/session")
      return reply(
        route,
        state.sessionStatus === 200 ? { user: { id: state.owner } } : { error: "Synthetic signed-out fixture" },
        state.sessionStatus,
      );
    if (path === "/api/projects/page")
      return reply(route, { ownerId: state.owner, items: state.projects, nextCursor: null }, state.pageStatus);
    return reply(route, {}, 404);
  });
  return state;
}

test("Projects: account cards keep their name and destination, and search only hides cards", async ({ page }) => {
  const state = await fixture(page);
  state.projects = rows();
  await page.goto("/brands");
  await expect(page.getByRole("heading", { name: "Projects", level: 1, exact: true })).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(6);
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation", exact: true })
      .getByRole("link", { name: "Projects", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "New project", exact: true })).toHaveAttribute("href", "/");
  // Projects and Home share one card: a preview, the name and its link. Newest first.
  const first = page.locator(".project-card").first();
  await expect(first).toContainText("Forma");
  await expect(first).not.toContainText("Updated");
  await expect(first).not.toContainText("Complete brand");
  await expect(card(page, 1).getByRole("link")).toHaveAttribute("href", `/brands/account/${id(1)}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  // A search only hides the cards it does not match; clearing it shows them again with no new read.
  const search = page.getByRole("searchbox", { name: "Search projects", exact: true });
  await search.fill("north");
  await expect(page.locator(".project-card:visible")).toHaveCount(1);
  await expect(card(page, 2)).toBeVisible();
  await search.fill("Unmatched synthetic title");
  await expect(page.locator(".project-card:visible")).toHaveCount(0);
  await expect(page.locator("main").getByRole("status")).toContainText("No projects match “Unmatched synthetic title”");
  await page.locator("main").getByRole("status").getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(page.locator(".project-card:visible")).toHaveCount(6);
  await expect(search).toHaveValue("");
  expect(state.writes).toEqual([]);
});

test("Projects: an empty account shows no toolbar and one way to start a project", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/brands");
  await expect(page.getByRole("heading", { name: "Projects", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No projects yet", exact: true })).toBeVisible();
  await expect(page.locator(".projects-toolbar")).toHaveCount(0);
  await expect(page.locator(".project-card")).toHaveCount(0);
  const start = page.getByRole("link", { name: "New project", exact: true });
  await expect(start).toHaveCount(1);
  await start.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test("Projects: a failed first account page cannot claim an empty account and remains retryable", async ({ page }) => {
  const state = await fixture(page);
  state.pageStatus = 503;
  await page.goto("/brands");
  await expect(page.locator("main").getByRole("alert")).toContainText("Your projects couldn’t be loaded");
  await expect(page.getByRole("heading", { name: "No projects yet", exact: true })).toHaveCount(0);
  state.pageStatus = 200;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "No projects yet", exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test("Projects: unavailable account verification and unreadable storage do not claim an empty collection", async ({
  page,
}) => {
  const state = await fixture(page);
  state.sessionStatus = 503;
  await page.addInitScript(() => localStorage.setItem("fluid.local-drafts.v1", "unreadable synthetic fixture"));
  await page.goto("/brands");
  await expect(page.locator("main").getByRole("alert")).toContainText("Account saving is unavailable.");
  await expect(page.locator("main").getByRole("button", { name: "Check account", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No projects yet", exact: true })).toHaveCount(0);
  await expect(page.locator(".projects-toolbar")).toHaveCount(0);
  state.sessionStatus = 200;
  state.projects = [row(1, "Forma")];
  await page.locator("main").getByRole("button", { name: "Check account", exact: true }).click();
  await expect(card(page, 1)).toBeVisible();
  await expect(page.getByText("Recovery data on this device couldn’t be read.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"))).toBe("unreadable synthetic fixture");
  expect(state.writes).toEqual([]);
});

test("Projects: a session that ended hides account rows at once and signing back in keeps the sort", async ({
  page,
}) => {
  const state = await fixture(page);
  state.projects = [row(20, "Private owner A"), ...rows()];
  await page.goto("/brands");
  await expect(page.locator(".project-card")).toHaveCount(7);
  await page.getByRole("button", { name: "Sort projects", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Alphabetical", exact: true }).click();
  await expect(page.locator(".project-card").first()).toContainText("Aster");
  await expect(page).toHaveURL(/[?&]sort=alphabetical$/);
  // The app checks the account by itself when the window regains focus; a signed-in menu has no "Check account".
  state.sessionStatus = 401;
  await refocusWindow(page);
  await expect(signedOutInvite(page)).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(0);
  await expect(page.getByText("Private owner A", { exact: true })).toHaveCount(0);
  await expect(page.locator(".projects-toolbar")).toHaveCount(0);
  state.sessionStatus = 200;
  await checkNormalAccount(page);
  await expect(page.locator(".project-card")).toHaveCount(7);
  await expect(page.locator(".project-card").first()).toContainText("Aster");
  expect(state.writes).toEqual([]);
});

test("Projects: a page belonging to another owner is never displayed", async ({ page }) => {
  const state = await fixture(page);
  await page.route("**/api/projects/page?**", async (route) =>
    reply(route, {
      ownerId: id(90),
      items: [row(91, "Other owner's secret", "complete_brand", 0, id(90))],
      nextCursor: null,
    }),
  );
  // A foreign-owner page invalidates the verified session instead of rendering it.
  await page.goto("/brands");
  await expect(signedOutInvite(page)).toBeVisible();
  await expect(page.getByText("Other owner's secret", { exact: true })).toHaveCount(0);
  await expect(page.locator(".project-card")).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("Projects: a delayed account page cannot republish rows after an owner change", async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>((resolve) => {
      release = resolve;
    }),
    requested = new Promise<void>((resolve) => {
      started = resolve;
    });
  let first = true;
  await page.route("**/api/projects/page?**", async (route) => {
    if (!first) return reply(route, { ownerId: state.owner, items: [], nextCursor: null });
    first = false;
    started();
    await pending;
    return reply(route, { ownerId: owner, items: [row(99, "Delayed private owner A")], nextCursor: null });
  });
  await page.goto("/brands");
  await requested;
  state.owner = id(90);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Projects", level: 1, exact: true })).toBeVisible();
  release();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  await expect(page.locator(".project-card[data-storage=account]")).toHaveCount(0);
  await expect(page.getByText("Delayed private owner A", { exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
