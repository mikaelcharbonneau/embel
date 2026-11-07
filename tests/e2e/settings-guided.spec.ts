import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const other = "bbbbbbbb-1111-4111-8111-111111111111";
const labels = ["Account", "Usage"];
async function open(page: Page, authenticated = false, fullName = "", path = "/settings") {
  const paths: { path: string; method: string }[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    paths.push({ path, method: request.method() });
    if (path === "/api/session" && authenticated) return route.fulfill({ json: { user: { id: owner } } });
    if (path === "/api/account/profile" && authenticated) return route.fulfill({ json: { profile: { ownerId: owner, email: "settings-fixture@example.invalid", revision: 0, updatedAt: null, values: { fullName, timeZone: "America/Toronto", dateFormat: "friendly" } } } });
    return route.fulfill({ status: 401, json: { error: "Synthetic signed-out fixture" } });
  });
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Settings.", exact: true })).toBeVisible();
  return { paths, errors };
}
async function tab(page: Page, label: string) { await page.getByRole("tab", { name: label, exact: true }).click(); }
const usageStatus = (page: Page) => page.locator('.recorded-usage [role="status"]').first();

test("Account and Usage are the only tabs, use honest states and trigger no mutations", async ({ page }) => {
  const state = await open(page);
  await expect(page.getByRole("tab")).toHaveText(labels);
  await expect(page.getByLabel("Full name", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Unavailable");
  for (const label of labels) {
    await tab(page, label);
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", await page.getByRole("tab", { name: label, exact: true }).getAttribute("id") as string);
    await expect(page.getByRole("tab", { name: label, exact: true })).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (label === "Account") await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    else await expect(page.getByRole("tabpanel").locator(".sg-save")).toHaveCount(0);
    await expect(page.getByText("Not available yet", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "View unavailable features", exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "View recorded usage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "ChatGPT on this Mac", exact: true })).toHaveCount(0);
  expect(state.paths.every(request => request.path === "/api/session" && request.method === "GET")).toBe(true);
  expect(state.errors).toEqual([]);
});

test("old category links open Account", async ({ page }) => {
  await open(page, false, "", "/settings?category=security");
  await expect(page.getByRole("tab", { name: "Account", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Account");
});

test("keyboard navigation wraps and exposes one tab stop", async ({ page }) => {
  await open(page);
  const account = page.getByRole("tab", { name: "Account", exact: true }), usage = page.getByRole("tab", { name: "Usage", exact: true });
  await account.focus(); await page.keyboard.press("ArrowLeft"); await expect(usage).toBeFocused();
  await page.keyboard.press("ArrowRight"); await expect(account).toBeFocused();
  await page.keyboard.press("End"); await expect(usage).toBeFocused();
  await page.keyboard.press("Home"); await expect(account).toBeFocused();
  expect(await page.locator('[role="tab"][tabindex="0"]').count()).toBe(1);
  await page.keyboard.press("ArrowRight"); await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Usage");
});

test("Account sign-out reuses browser sign-out and keeps a failed sign-out visible until retry", async ({ page }) => {
  await open(page, true);
  let status = 503, calls = 0;
  await page.route("**/api/auth/sign-out", route => {
    calls++; expect(route.request().method()).toBe("POST"); expect(route.request().postDataJSON()).toEqual({});
    return route.fulfill({ status, json: status === 200 ? { authenticated: false } : { error: "Synthetic failure" } });
  });
  const controls = page.locator(".sg-content .auth-account-access");
  await expect(controls.locator(".preview-badge")).toBeHidden();
  await controls.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Sign-out couldn't be confirmed" })).toBeVisible();
  await expect(controls.getByRole("button", { name: "Retry sign-out", exact: true })).toBeVisible();
  expect(calls).toBe(1);
  status = 200; await controls.getByRole("button", { name: "Retry sign-out", exact: true }).click();
  await expect(controls.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  expect(calls).toBe(2);
  await tab(page, "Usage");
  await expect(page.getByText("Sign in to see your usage.", { exact: true })).toBeVisible();
});

test("usage retries real read failures, marks unrecorded counts and rejects foreign ownership", async ({ page }) => {
  const state = await open(page, true);
  let mode = "failure";
  await page.route("**/api/usage", route => {
    if (mode === "failure") return route.fulfill({ status: 503, body: "synthetic hidden detail" });
    return route.fulfill({ json: { ownerId: mode === "foreign" ? other : owner, limit: 20, entries: [
      { id: "cccccccc-1111-4111-8111-111111111111", operation: "naming.generate", completedAt: "2026-10-10T20:00:00Z", tokens: null },
      { id: "cccccccc-2222-4111-8111-111111111111", operation: "strategy.competitors", completedAt: "2026-10-09T20:00:00Z", tokens: { inputTokens: 1200, outputTokens: 345, totalTokens: 1545 } },
    ] } });
  });
  await tab(page, "Usage");
  await expect(page.getByRole("alert").filter({ hasText: "Usage couldn’t be loaded" })).toBeVisible();
  await expect(page.getByText("synthetic hidden detail")).toHaveCount(0);
  mode = "success"; await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const usage = page.getByRole("region", { name: "Recent requests", exact: true });
  await expect(usage.getByRole("columnheader")).toHaveText(["Step", "Date", "Tokens used"]);
  await expect(usage.getByRole("row", { name: /Voice · Name/ })).toContainText("—");
  await expect(usage.getByRole("row", { name: /Strategy · Competitors/ })).toContainText("1,545");
  await expect(usage.getByText("— Not recorded for this request.", { exact: true })).toBeVisible();
  await expect(usage.getByText("2 requests · at least 1,545 tokens used", { exact: true })).toBeVisible();
  await expect(usage.getByText("Usage loaded.", { exact: true })).toHaveClass("sr-only");
  await expect(usage.getByText(/Input tokens|Total tokens|Unknown|Billing/)).toHaveCount(0);
  mode = "foreign"; await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".recorded-usage-entry")).toHaveCount(0);
  await expect(page.getByText("Sign in to see your usage.", { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("artwork, shared type, card shape and content width stay consistent", async ({ page }, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const folder = new URL("../../public/settings/", import.meta.url);
  for (const name of await readdir(folder)) {
    const expected = await readFile(new URL(name, folder)), response = await page.request.get(`/settings/${name}`);
    expect(response.status()).toBe(200);
    expect(createHash("sha256").update(await response.body()).digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"));
  }
  await page.evaluate(() => document.fonts.ready);
  if (info.project.name === "desktop") {
    const profile = (await page.getByRole("region", { name: "Profile", exact: true }).boundingBox())!;
    expect(profile.x).toBeGreaterThanOrEqual(0); expect(profile.x + profile.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(profile.width).toBeLessThanOrEqual(1056);
    const preferences = (await page.getByRole("region", { name: "Preferences", exact: true }).boundingBox())!;
    expect(preferences.x).toBe(profile.x); expect(preferences.width).toBe(profile.width); expect(preferences.y).toBeGreaterThan(profile.y + profile.height);
    const appearance = await page.getByRole("region", { name: "Profile", exact: true }).evaluate(element => ({ family: getComputedStyle(element).fontFamily, border: getComputedStyle(element).borderTopWidth, radius: getComputedStyle(element).borderTopLeftRadius }));
    expect(appearance.family).toContain("Geist"); expect(appearance.border).toBe("1px"); expect(appearance.radius).toBe("16px");
    const input = await page.getByLabel("Full name", { exact: true }).evaluate(element => getComputedStyle(element).borderTopLeftRadius);
    expect(input).toBe("12px");
  }
  // Switching tabs keeps every tab in place: the active one does not change weight.
  const before = await page.getByRole("tab").evaluateAll(tabs => tabs.map(tab => tab.getBoundingClientRect().x));
  await tab(page, "Usage");
  expect(await page.getByRole("tab").evaluateAll(tabs => tabs.map(tab => tab.getBoundingClientRect().x))).toEqual(before);
  for (const label of labels) {
    await tab(page, label);
    await page.screenshot({ path: info.outputPath(`${label.toLowerCase()}.png`), fullPage: true });
  }
});

test("a response from the previous account generation cannot reveal usage after re-verification", async ({ page }) => {
  await open(page, true);
  let resolve!: () => void;
  const gate = new Promise<void>(yes => { resolve = yes; });
  let started = false;
  await page.route("**/api/usage", async route => {
    started = true; await gate;
    await route.fulfill({ json: { ownerId: owner, limit: 20, entries: [{ id: "dddddddd-1111-4111-8111-111111111111", operation: "naming.generate", completedAt: "2026-10-10T20:00:00Z", tokens: { inputTokens: 123456, outputTokens: 1, totalTokens: 123457 } }] } }).catch(() => {});
  });
  await tab(page, "Usage");
  await expect.poll(() => started).toBe(true);
  await expect(usageStatus(page)).toHaveText("Loading usage…");
  await page.route("**/api/session", route => route.fulfill({ status: 401, json: { error: "Synthetic session expired" } }));
  // The production revalidator runs when the window regains focus.
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
  await expect(page.getByText("Sign in to see your usage.", { exact: true })).toBeVisible();
  resolve();
  await expect(page.locator(".recorded-usage-entry")).toHaveCount(0);
  await expect(page.getByText("123,457", { exact: true })).toHaveCount(0);
});

async function captureHierarchy(page: Page, info: TestInfo, category: string) {
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector("#main-content")?.scrollTo(0, 0); });
  const filename = `${info.project.name}-settings-${category}.png`;
  const bytes = await page.screenshot({ path: info.outputPath(filename), fullPage: true, scale: "css" });
  const directory = process.env.FLUID_UI_EVIDENCE;
  if (!directory) return;
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, filename), bytes);
  await writeFile(join(directory, filename.replace(/\.png$/, ".json")), JSON.stringify({ fixture: "Synthetic account and usage records; read-only checks", route: new URL(page.url()).pathname, category, viewport: page.viewportSize(), screenshot: filename }, null, 2));
}

test("Settings shows editable account options first and loads usage on demand", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const longName = "Synthetic account ".repeat(5).trim();
  const state = await open(page, true, longName);
  await expect(page.getByLabel("Full name", { exact: true })).toHaveValue(longName);
  await expect(page.getByLabel("Full name", { exact: true })).toBeEditable();
  await expect(page.getByLabel("Email address", { exact: true })).not.toBeEditable();
  await expect(page.getByText("You sign in with this email.", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Time zone", exact: true })).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "Time zone", exact: true })).toHaveValue("America/Toronto");
  await expect(page.getByRole("combobox", { name: "Time zone", exact: true }).locator("option:checked")).toHaveText("Toronto — Eastern Time");
  await expect(page.getByRole("combobox", { name: "Date format", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await expect(page.getByText("Account connection", { exact: true })).toHaveCount(0);
  await captureHierarchy(page, info, "account");
  let usageReads = 0;
  await page.route("**/api/usage", route => {
    usageReads++;
    return route.fulfill({ json: { ownerId: owner, limit: 20, entries: [{ id: "cccccccc-1111-4111-8111-111111111111", operation: "naming.generate", completedAt: "2026-10-10T20:00:00Z", tokens: null }] } });
  });
  expect(usageReads).toBe(0);
  await tab(page, "Usage");
  const usage = page.getByRole("region", { name: "Recent requests", exact: true });
  await expect(usage.getByRole("row", { name: /Voice · Name/ })).toBeVisible();
  expect(usageReads).toBe(1);
  const row = await usage.locator(".recorded-usage-entry").first().elementHandle();
  await captureHierarchy(page, info, "usage");
  await tab(page, "Account"); await tab(page, "Usage");
  expect(await row!.evaluate(element => element.isConnected)).toBe(true);
  expect(state.paths.every(request => request.method === "GET")).toBe(true); expect(state.errors).toEqual([]);
});
