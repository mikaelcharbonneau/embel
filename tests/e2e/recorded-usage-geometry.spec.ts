import { expect, test, type Page } from "@playwright/test";
import { captureUiEvidence } from "./ui-evidence";

test.afterEach(async ({ page }, info) => { await captureUiEvidence(page, info); });

// Synthetic account responses only: no credentials, writes or provider calls.
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const date = "2026-10-25T10:00:00Z";
async function install(page: Page, count = 20, longValues = false) {
  const state = { usageReads: 0, sessionReads: 0, holdUsage: false, holdSession: false, forbidden: [] as string[], errors: [] as string[] };
  const releaseUsage: Array<() => void> = [], releaseSession: Array<() => void> = [];
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") { state.forbidden.push(request.url()); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (request.method() !== "GET") { state.forbidden.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === "/api/session") {
      state.sessionReads++;
      if (state.holdSession) await new Promise<void>(resolve => releaseSession.push(resolve));
      return route.fulfill({ json: { user: { id: ownerId } } });
    }
    if (url.pathname === "/api/usage") {
      state.usageReads++;
      if (state.holdUsage) await new Promise<void>(resolve => releaseUsage.push(resolve));
      return route.fulfill({ json: { ownerId, limit: 20, entries: Array.from({ length: count }, (_, i) => ({
        id: `cccccccc-cccc-4ccc-8ccc-${String(i + 1).padStart(12, "0")}`,
        operation: longValues ? "strategy.competitors" : "naming.generate", completedAt: date,
        tokens: { inputTokens: longValues ? Number.MAX_SAFE_INTEGER - 1 : 10, outputTokens: 1, totalTokens: longValues ? Number.MAX_SAFE_INTEGER : 11 },
      })) } });
    }
    if (url.pathname === "/api/account/profile") return route.fulfill({ json: { profile: { ownerId, email: null, revision: 0, updatedAt: null, values: { fullName: "", timeZone: "UTC", dateFormat: "iso" } } } });
    if (url.pathname === "/api/projects/page" || url.pathname === "/api/names") return route.fulfill({ json: { ownerId, items: [], nextCursor: null } });
    if (url.pathname === "/api/names/workspace") return route.fulfill({ json: { ownerId, workspace: null } });
    state.forbidden.push(`GET ${url.pathname}`); return route.fulfill({ status: 404, json: { error: "Unexpected synthetic fixture read" } });
  });
  return { state, releaseUsage: () => { state.holdUsage = false; releaseUsage.splice(0).forEach(release => release()); }, releaseSession: () => { state.holdSession = false; releaseSession.splice(0).forEach(release => release()); } };
}
async function ready(page: Page) {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Usage & billing", exact: true }).click();
  await expect(page.locator(".recorded-usage-notice").first()).toHaveText("Recorded usage loaded.");
  await page.evaluate(() => document.fonts.ready);
}
async function geometry(page: Page) {
  return page.locator(".recorded-usage").evaluate(section => {
    const box = section.getBoundingClientRect();
    return { height: box.height, top: box.top, scroll: window.scrollY };
  });
}

for (const count of [0, 1, 20]) test(`Usage ${count} rows: refresh and tab/focus return retain layout and focus`, async ({ page }) => {
  const fixture = await install(page, count); await ready(page);
  const refresh = page.getByRole("button", { name: "Refresh usage", exact: true });
  await refresh.focus(); const initial = await geometry(page);
  fixture.state.holdUsage = true; await refresh.press("Enter");
  await expect(refresh).toHaveAttribute("aria-disabled", "true");
  expect(await geometry(page)).toEqual(initial); await expect(refresh).toBeFocused();
  await refresh.press("Enter"); expect(fixture.state.usageReads).toBe(2);
  fixture.releaseUsage(); await expect(refresh).toHaveAttribute("aria-disabled", "false");
  expect(await geometry(page)).toEqual(initial); await expect(refresh).toBeFocused();
  // Actual activation events exercise the production session revalidator.
  fixture.state.holdSession = true;
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
  await expect.poll(() => fixture.state.sessionReads).toBeGreaterThanOrEqual(2);
  expect(await geometry(page)).toEqual(initial); await expect(refresh).toBeFocused();
  fixture.releaseSession();
  await page.getByRole("tab", { name: "Workspace", exact: true }).click();
  await page.getByRole("tab", { name: "Usage & billing", exact: true }).click();
  await expect(page.locator(".recorded-usage-notice").first()).toHaveText("Recorded usage loaded.");
  expect((await geometry(page)).height).toBe(initial.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(fixture.state.forbidden).toEqual([]); expect(fixture.state.errors).toEqual([]);
});

test("Usage full page: explicit account verification uses matching public geometry and hides private data", async ({ page }) => {
  const fixture = await install(page); await ready(page);
  const initial = await geometry(page); fixture.state.holdSession = true;
  // Trigger the real explicit-check control without introducing a navigation scroll.
  await page.locator("button.account-check").first().evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator(".recorded-usage-pending-slot")).toHaveCount(20);
  await expect(page.locator(".recorded-usage-entry")).toHaveCount(0);
  await expect(page.locator(".recorded-usage-refresh")).toHaveCount(0);
  expect((await geometry(page)).height).toBe(initial.height);
  expect(await page.locator(".recorded-usage").innerText()).not.toContain("2026-10-25");
  fixture.releaseSession(); await expect(page.locator(".recorded-usage-entry")).toHaveCount(20);
  expect((await geometry(page)).height).toBe(initial.height);
  expect(fixture.state.forbidden).toEqual([]); expect(fixture.state.errors).toEqual([]);
});

test("Usage long values: wrap without clipping and preserve stable ordinary refresh", async ({ page }) => {
  const fixture = await install(page, 1, true); await ready(page);
  await expect(page.locator(".recorded-usage-entry dd").first()).toHaveText("9,007,199,254,740,990");
  const refresh = page.getByRole("button", { name: "Refresh usage", exact: true }); await refresh.focus();
  const initial = await geometry(page); fixture.state.holdUsage = true; await refresh.press("Enter");
  await expect(refresh).toHaveAttribute("aria-disabled", "true"); expect(await geometry(page)).toEqual(initial);
  fixture.releaseUsage(); await expect(refresh).toHaveAttribute("aria-disabled", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await page.locator(".recorded-usage-entry dd").evaluateAll(cells => cells.every(cell => cell.scrollWidth <= cell.clientWidth))).toBe(true);
  expect(fixture.state.forbidden).toEqual([]); expect(fixture.state.errors).toEqual([]);
});
