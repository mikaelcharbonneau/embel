import { expect, test, type Page, type Route } from "@playwright/test";
import { jobActivitySchema, type JobActivity, type JobActivityEntry } from "../../src/domain/job-activity";

// Synthetic owned API fixtures only. Every API request is intercepted; these
// tests never authenticate, dispatch work or mutate a live account.
const ownerId = "aaaaaaaa-6666-4666-8666-666666666666";
const otherOwnerId = "bbbbbbbb-6666-4666-8666-666666666666";
const when = "2026-10-04T10:00:00Z";
const uuid = (index: number) => `cccccccc-6666-4666-8666-${String(index).padStart(12, "0")}`;
const titles = { naming: "Synthetic naming in progress", review: "Synthetic strategy needs review", completed: "Synthetic naming completed", partial: "Synthetic strategy partial" };

function entry(index: number, projectTitle: string, operation: JobActivityEntry["operation"], state: JobActivityEntry["state"], owner = ownerId): JobActivityEntry {
  return { id: uuid(index), ownerId: owner, projectId: uuid(index + 100), projectTitle, operation, state,
    progress: state === "running" ? 37 : state === "succeeded" ? 100 : 0, createdAt: when,
    finishedAt: state === "succeeded" || state === "partial" ? when : null };
}
function activity(owner = ownerId): JobActivity {
  return jobActivitySchema.parse({ ownerId: owner,
    active: [entry(1, titles.naming, "naming.generate", "running", owner), entry(2, titles.review, "strategy.competitors", "needs_reconciliation", owner)],
    recent: [entry(3, titles.completed, "naming.generate", "succeeded", owner), entry(4, titles.partial, "strategy.positioning", "partial", owner)],
  });
}
function emptyActivity(owner = ownerId): JobActivity { return { ownerId: owner, active: [], recent: [] }; }
async function reply(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
}
type HeldReply = { ready: boolean; settled: boolean; pending: Promise<void>; release: () => void };
type FixtureState = {
  sessionOwner: string | null; sessionRequests: number; activityRequests: number; status: number; payload: unknown;
  writes: string[]; activityUrls: string[]; delay: HeldReply | null;
};
const states = new WeakMap<Page, FixtureState>();
async function fixtures(page: Page) {
  const state: FixtureState = { sessionOwner: ownerId, sessionRequests: 0, activityRequests: 0, status: 200, payload: activity(), writes: [], activityUrls: [], delay: null };
  states.set(page, state);
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      state.writes.push(`${request.method()} ${path}`);
      return reply(route, { error: { code: "method_not_allowed" } }, 405);
    }
    if (path === "/api/session") {
      state.sessionRequests++;
      return reply(route, state.sessionOwner ? { user: { id: state.sessionOwner } } : { error: { code: "unauthenticated" } }, state.sessionOwner ? 200 : 401);
    }
    if (path === "/api/jobs") {
      state.activityRequests++; state.activityUrls.push(request.url());
      const payload = structuredClone(state.payload), status = state.status, held = state.delay;
      state.delay = null;
      if (held) {
        held.ready = true;
        await held.pending;
        try { await reply(route, payload, status); }
        catch { /* A closed or replaced dialog may already have aborted this held request. */ }
        finally { held.settled = true; }
        return;
      }
      return reply(route, payload, status);
    }
    if (path === "/api/projects") return reply(route, { projects: [] });
    // Following an owned activity link exercises real app navigation, with no
    // project-data fixture or live read implied by this activity-only suite.
    return reply(route, { error: { code: "not_found" } }, 404);
  });
  return { state, holdNext() {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const held = { ready: false, settled: false, pending, release };
    state.delay = held;
    return held;
  } };
}
const dialog = (page: Page) => page.getByRole("dialog", { name: "Generation activity", exact: true });
const trigger = (page: Page) => page.getByRole("button", { name: "Activity", exact: true });
async function openAccountMenu(page: Page) {
  const menu = page.locator(".workspace-account-menu");
  await expect(menu.locator("summary")).toBeVisible();
  if (!await menu.evaluate(element => (element as HTMLDetailsElement).open)) await menu.getByLabel("Account menu", { exact: true }).click();
}
async function openPage(page: Page) { await page.goto("/ideas"); await openAccountMenu(page); await expect(trigger(page)).toBeVisible(); }
async function openActivity(page: Page) { await trigger(page).click(); await expect(dialog(page)).toBeVisible(); }
async function settleRendering(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }

test.afterEach(async ({ page }) => {
  const state = states.get(page);
  state?.delay?.release();
  expect(state?.writes ?? []).toEqual([]);
  expect(state?.activityUrls.every(value => { const url = new URL(value); return url.pathname === "/api/jobs" && !url.search; }) ?? true).toBe(true);
});

test("activity fixture: loads only on explicit open and stops polling after close", async ({ page }) => {
  const { state } = await fixtures(page);
  await page.clock.install(); await openPage(page);
  await page.clock.fastForward(30_000);
  expect(state.activityRequests).toBe(0);
  await expect(dialog(page)).not.toBeVisible();
  await openActivity(page);
  await expect(dialog(page).getByText(titles.naming, { exact: true })).toBeVisible();
  expect(state.activityRequests).toBe(1);
  await dialog(page).getByRole("button", { name: "Close activity", exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  await page.clock.fastForward(30_000);
  expect(state.activityRequests).toBe(1);
});

test("activity fixture: signed-out sessions expose no activity trigger or requests", async ({ page }) => {
  const { state } = await fixtures(page); state.sessionOwner = null;
  await page.clock.install(); await page.goto("/ideas");
  await expect(page.locator(".topbar").getByLabel("Account menu", { exact: true })).toContainText("Sign in");
  await page.clock.fastForward(30_000);
  await expect(trigger(page)).toHaveCount(0);
  expect(state.activityRequests).toBe(0);
});

test("activity fixture: owned active and recent rows have truthful labels and project links", async ({ page }) => {
  await fixtures(page); await openPage(page); await openActivity(page);
  const panel = dialog(page), active = panel.getByRole("region", { name: "Active generations" }), recent = panel.getByRole("region", { name: "Recent generations" });
  await expect(active.getByRole("link", { name: `${titles.naming} Naming`, exact: true })).toHaveAttribute("href", `/brands/account/${uuid(101)}/naming`);
  await expect(active.getByRole("link", { name: `${titles.review} Competitors`, exact: true })).toHaveAttribute("href", `/brands/account/${uuid(102)}?view=strategy`);
  await expect(recent.getByRole("link", { name: `${titles.completed} Naming`, exact: true })).toHaveAttribute("href", `/brands/account/${uuid(103)}/naming`);
  await expect(recent.getByRole("link", { name: `${titles.partial} Positioning`, exact: true })).toHaveAttribute("href", `/brands/account/${uuid(104)}?view=strategy`);
  await expect(active.getByText("Needs review", { exact: true })).toBeVisible();
  await expect(active.getByText("The outcome needs review. This request will not be retried automatically.", { exact: true })).toBeVisible();
  await expect(recent.getByText("Partial results", { exact: true })).toBeVisible();
  await expect(recent.getByText("Request completed", { exact: true })).toBeVisible();
  await expect(panel.getByRole("progressbar", { name: `Naming progress for ${titles.naming}`, exact: true })).toHaveAttribute("value", "37");
  await expect(panel.getByText(/A completed request can contain fewer results than requested/)).toBeVisible();
  await expect(panel.getByRole("button")).toHaveText(["Close activity"]);
});

for (const [title, operation, href] of [
  [titles.naming, "Naming", `/brands/account/${uuid(101)}/naming`],
  [titles.review, "Competitors", `/brands/account/${uuid(102)}?view=strategy`],
] as const) test(`activity fixture: ${operation} link navigates and closes the panel without a mutation`, async ({ page }) => {
  await fixtures(page); await openPage(page); await openActivity(page);
  await dialog(page).getByRole("link", { name: `${title} ${operation}`, exact: true }).click();
  await expect(page).toHaveURL(href);
  await expect(dialog(page)).not.toBeVisible();
});

test("activity fixture: first-read failure is unavailable until a successful explicit retry", async ({ page }) => {
  const { state } = await fixtures(page); state.status = 503; state.payload = { error: { code: "integration_unavailable", message: "Synthetic private service detail" } };
  await openPage(page); await openActivity(page);
  await expect(dialog(page).getByRole("alert")).toContainText("Activity could not be refreshed");
  await expect(dialog(page).getByText("No generation requests in this account yet.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Synthetic private service detail", { exact: true })).toHaveCount(0);
  state.status = 200; state.payload = emptyActivity();
  await dialog(page).getByRole("button", { name: "Check activity again", exact: true }).click();
  await expect(dialog(page).getByText("No generation requests in this account yet.", { exact: true })).toBeVisible();
  await expect(dialog(page).getByRole("alert")).toHaveCount(0);
  expect(state.activityRequests).toBe(2);
});

test("activity fixture: a failed refresh labels retained rows as the last successful check", async ({ page }) => {
  const { state } = await fixtures(page); await page.clock.install(); await openPage(page); await openActivity(page);
  await expect(dialog(page).getByText(titles.naming, { exact: true })).toBeVisible();
  state.status = 503; state.payload = { error: { code: "integration_unavailable" } };
  await page.clock.fastForward(3001);
  await expect(dialog(page).getByRole("alert")).toContainText("Any entries below are from the last successful check.");
  await expect(dialog(page).getByText(titles.naming, { exact: true })).toBeVisible();
  state.status = 200; state.payload = emptyActivity();
  await dialog(page).getByRole("button", { name: "Check activity again", exact: true }).click();
  await expect(dialog(page).getByText("No generation requests in this account yet.", { exact: true })).toBeVisible();
  await expect(dialog(page).getByText(titles.naming, { exact: true })).toHaveCount(0);
});

for (const nextOwner of [otherOwnerId, null]) test(`activity privacy fixture: held old-owner response cannot survive ${nextOwner ? "account replacement" : "session invalidation"}`, async ({ page }) => {
  const fixture = await fixtures(page); await openPage(page);
  const held = fixture.holdNext(); await openActivity(page);
  try {
    await expect.poll(() => held.ready).toBe(true);
    await expect(dialog(page).getByRole("status")).toHaveText("Loading your activity…");
    fixture.state.sessionOwner = nextOwner; fixture.state.payload = emptyActivity(nextOwner ?? ownerId);
    // Model an actual tab departure/return, not a duplicate focus event in
    // an already verified activation. The background check must fence owners
    // without replacing unchanged-account workspaces.
    await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
    await expect.poll(() => fixture.state.sessionRequests).toBeGreaterThan(1);
    if (nextOwner) {
      await expect(trigger(page)).toBeVisible(); await expect(dialog(page)).not.toBeVisible();
      await openActivity(page);
      await expect(dialog(page).getByText("No generation requests in this account yet.", { exact: true })).toBeVisible();
    } else {
      await expect(trigger(page)).toHaveCount(0);
      await expect(page.locator(".topbar").getByLabel("Account menu", { exact: true })).toContainText("Sign in");
    }
    held.release(); await expect.poll(() => held.settled).toBe(true); await settleRendering(page);
    for (const title of Object.values(titles)) await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  } finally { held.release(); }
});

test("activity privacy fixture: a foreign-owner response invalidates the current account", async ({ page }) => {
  const { state } = await fixtures(page); state.payload = activity(otherOwnerId);
  await openPage(page); await trigger(page).click();
  await expect(trigger(page)).toHaveCount(0);
  await expect(page.locator(".topbar").getByLabel("Account menu", { exact: true })).toContainText("Sign in");
  for (const title of Object.values(titles)) await expect(page.getByText(title, { exact: true })).toHaveCount(0);
});

test("activity privacy fixture: malformed nested ownership cannot publish foreign rows", async ({ page }) => {
  const { state } = await fixtures(page); const payload = activity(); payload.active[0]!.ownerId = otherOwnerId; state.payload = payload;
  await openPage(page); await openActivity(page);
  await expect(dialog(page).getByRole("alert")).toContainText("Activity could not be refreshed");
  await expect(dialog(page).getByRole("link")).toHaveCount(0);
  await expect(page.getByText(titles.naming, { exact: true })).toHaveCount(0);
});

test("activity privacy fixture: a 401 clears previously displayed private rows", async ({ page }) => {
  const { state } = await fixtures(page); await page.clock.install(); await openPage(page); await openActivity(page);
  await expect(dialog(page).getByText(titles.naming, { exact: true })).toBeVisible();
  state.status = 401; state.payload = { error: { code: "unauthenticated" } }; state.sessionOwner = null;
  await page.clock.fastForward(3001);
  await expect(trigger(page)).toHaveCount(0);
  await expect(page.locator(".topbar").getByLabel("Account menu", { exact: true })).toContainText("Sign in");
  for (const title of Object.values(titles)) await expect(page.getByText(title, { exact: true })).toHaveCount(0);
  const reads = state.activityRequests; await page.clock.fastForward(30_000); expect(state.activityRequests).toBe(reads);
});

test("activity fixture: closing a held request cannot overwrite a reopened panel", async ({ page }) => {
  const fixture = await fixtures(page); await openPage(page);
  const held = fixture.holdNext(); await openActivity(page);
  try {
    await expect.poll(() => held.ready).toBe(true);
    await dialog(page).getByRole("button", { name: "Close activity", exact: true }).click();
    fixture.state.payload = emptyActivity();
    await openActivity(page);
    await expect(dialog(page).getByText("No generation requests in this account yet.", { exact: true })).toBeVisible();
    held.release(); await expect.poll(() => held.settled).toBe(true); await settleRendering(page);
    await expect(dialog(page).getByText("No generation requests in this account yet.", { exact: true })).toBeVisible();
    await expect(page.getByText(titles.naming, { exact: true })).toHaveCount(0);
  } finally { held.release(); }
});

test("activity accessibility fixture: keyboard navigation stays in the modal and Escape restores the trigger", async ({ page }) => {
  await fixtures(page); await openPage(page);
  await trigger(page).focus(); await trigger(page).press("Enter");
  const close = dialog(page).getByRole("button", { name: "Close activity", exact: true });
  await expect(close).toBeFocused();
  const links = dialog(page).getByRole("link");
  await expect(links).toHaveCount(4);
  expect(await dialog(page).evaluate(element => element.matches(":modal"))).toBe(true);
  // Native modal dialogs make background controls inert. Moving into browser
  // chrome at a Tab boundary is browser behavior, outside this app's focus order.
  await trigger(page).evaluate(element => element.focus()); await expect(close).toBeFocused();
  for (let index = 0; index < 4; index++) { await page.keyboard.press("Tab"); await expect(links.nth(index)).toBeFocused(); }
  for (let index = 2; index >= 0; index--) { await page.keyboard.press("Shift+Tab"); await expect(links.nth(index)).toBeFocused(); }
  await page.keyboard.press("Shift+Tab"); await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).not.toBeVisible(); await expect(trigger(page)).toBeFocused();
  await trigger(page).press("Space"); await expect(close).toBeFocused();
  await close.press("Enter"); await expect(dialog(page)).not.toBeVisible(); await expect(trigger(page)).toBeFocused();
});

test("activity accessibility fixture: long private titles remain inside desktop and mobile viewports", async ({ page }, info) => {
  const { state } = await fixtures(page), payload = activity();
  const title = "SyntheticLongUnbrokenPrivateProject".repeat(5).slice(0, 160);
  payload.active[0] = { ...payload.active[0]!, projectTitle: title, operation: "identity.image" }; state.payload = jobActivitySchema.parse(payload);
  await openPage(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await openActivity(page); await expect(dialog(page).getByText(title, { exact: true })).toBeVisible();
  const box = await dialog(page).boundingBox(), viewport = page.viewportSize()!;
  expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(await dialog(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("generation-activity-long-title.png"), fullPage: true, scale: "css" });
});

for (const initial of [true, false]) test(`activity fixture: a stalled ${initial ? "first read" : "refresh"} offers retry and fences its late response`, async ({ page }) => {
  const { state, holdNext } = await fixtures(page);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.clock.install(); await openPage(page);
  if (!initial) {
    await openActivity(page);
    await expect(dialog(page).getByText(titles.naming, { exact: true })).toBeVisible();
  }
  const held = holdNext();
  if (initial) await openActivity(page);
  else await page.clock.fastForward(3000);
  await expect.poll(() => held.ready).toBe(true);
  await page.clock.fastForward(15_001);
  await expect(dialog(page).getByRole("alert")).toContainText("Activity could not be refreshed");
  if (!initial) await expect(dialog(page).getByText(titles.naming, { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("activity-timeout-recovery.png"), fullPage: true, scale: "css" });
  state.payload = emptyActivity();
  await dialog(page).getByRole("button", { name: "Check activity again", exact: true }).click();
  await expect(dialog(page).getByText("No generation requests in this account yet.", { exact: true })).toBeVisible();
  held.release(); await expect.poll(() => held.settled).toBe(true);
  await expect(dialog(page).getByText(titles.naming, { exact: true })).toHaveCount(0);
  await expect(dialog(page).getByRole("alert")).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Close activity", exact: true }).click();
  const reads = state.activityRequests; await page.clock.fastForward(30_000);
  expect(state.activityRequests).toBe(reads); expect(errors).toEqual([]);
});

// Native close events are queued. An event from a prior dismissal must not
// overwrite a subsequent opening of this persistent dialog element.
test("activity accessibility fixture: a queued native close cannot dismiss a reopened panel", async ({ page }) => {
  await fixtures(page); await openPage(page); await openActivity(page);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).not.toBeVisible();
  await trigger(page).press("Space");
  await expect(dialog(page)).toBeVisible();
  await dialog(page).evaluate(element => element.dispatchEvent(new Event("close")));
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("button", { name: "Close activity", exact: true })).toBeFocused();
});
