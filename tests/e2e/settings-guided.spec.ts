import { test, expect, type Page } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const other = "bbbbbbbb-1111-4111-8111-111111111111";
const labels = ["Account", "Workspace", "AI preferences", "Usage & billing", "Notifications", "Security & privacy", "Integrations"];
async function open(page: Page, authenticated = false) {
  const paths: { path: string; method: string }[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    paths.push({ path, method: request.method() });
    if (path === "/api/session" && authenticated) return route.fulfill({ json: { user: { id: owner } } });
    if (path === "/api/account/profile" && authenticated) return route.fulfill({ json: { profile: { ownerId: owner, email: "settings-fixture@example.invalid", revision: 0, updatedAt: null, values: { fullName: "", timeZone: "America/Toronto", dateFormat: "friendly" } } } });
    if (path === "/api/strategy" && authenticated) return route.fulfill({ json: { availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } } });
    return route.fulfill({ status: 401, json: { error: "Synthetic signed-out fixture" } });
  });
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings.", exact: true })).toBeVisible();
  return { paths, errors };
}
async function tab(page: Page, label: string) { await page.getByRole("tab", { name: label, exact: true }).click(); }

test("all seven categories use honest states and trigger no unsupported mutations", async ({ page }) => {
  const state = await open(page);
  await expect(page.getByLabel("Full name", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Unavailable");
  for (const label of labels) {
    await tab(page, label);
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", await page.getByRole("tab", { name: label, exact: true }).getAttribute("id") as string);
    await expect(page.getByRole("tab", { name: label, exact: true })).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (label !== "Usage & billing") await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  }
  await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(4);
  for (const button of await page.getByRole("button", { name: "Connect", exact: true }).all()) await expect(button).toBeDisabled();
  await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);
  await expect(page.getByText("mikael@example.com", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "ChatGPT on this Mac", exact: true })).toHaveCount(0);
  expect(state.paths.every(request => request.path === "/api/session" && request.method === "GET")).toBe(true);
  expect(state.errors).toEqual([]);
});

test("keyboard navigation wraps, exposes one tab stop and scrolls the active category into view", async ({ page }) => {
  await open(page);
  const account = page.getByRole("tab", { name: "Account", exact: true });
  await account.focus(); await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Integrations", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight"); await expect(account).toBeFocused();
  await page.keyboard.press("End"); await expect(page.getByRole("tab", { name: "Integrations", exact: true })).toBeFocused();
  await page.keyboard.press("Home"); await expect(account).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Workspace", exact: true })).toBeFocused();
  expect(await page.locator('[role="tab"][tabindex="0"]').count()).toBe(1);
  await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Workspace");
});

test("security reuses verified browser sign-out and keeps a failed sign-out hidden until retry", async ({ page }) => {
  await open(page, true); await tab(page, "Security & privacy");
  let status = 503, calls = 0;
  await page.route("**/api/auth/sign-out", route => {
    calls++; expect(route.request().method()).toBe("POST"); expect(route.request().postDataJSON()).toEqual({});
    return route.fulfill({ status, json: status === 200 ? { authenticated: false } : { error: "Synthetic failure" } });
  });
  const controls = page.locator(".sg-content .auth-account-access");
  await controls.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Sign-out couldn't be confirmed" })).toBeVisible();
  await expect(controls.getByRole("button", { name: "Retry sign-out", exact: true })).toBeVisible();
  expect(calls).toBe(1);
  status = 200; await controls.getByRole("button", { name: "Retry sign-out", exact: true }).click();
  await expect(controls.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  expect(calls).toBe(2);
  await tab(page, "Usage & billing");
  await expect(page.getByText("Sign in to view recorded usage.", { exact: true })).toBeVisible();
});

test("legacy recovery is separate from account work and never clears existing device data", async ({ context, page }) => {
  await context.addInitScript(() => {
    localStorage.setItem("fluid.local-drafts.v1", "{synthetic-invalid");
    localStorage.setItem("synthetic-unrelated-store", "keep");
  });
  await open(page, true); await tab(page, "Workspace");
  await expect(page.getByRole("heading", { name: "Recover unsaved work", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Recover projects", exact: true })).toHaveAttribute("href", "/brands?recover=1");
  await expect(page.getByRole("link", { name: "Recover names", exact: true })).toHaveAttribute("href", "/names?recover=1");
  await expect(page.getByRole("button", { name: "Clear drafts", exact: true })).toHaveCount(0);
  await expect(page.getByText("Browser workspace", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "Saved drafts could not be read" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"))).toBe("{synthetic-invalid");
  expect(await page.evaluate(() => localStorage.getItem("synthetic-unrelated-store"))).toBe("keep");
});

test("recorded usage retries real read failures, distinguishes unknown counts and rejects foreign ownership", async ({ page }) => {
  const state = await open(page, true);
  let mode = "failure";
  await page.route("**/api/usage", route => {
    if (mode === "failure") return route.fulfill({ status: 503, body: "synthetic hidden detail" });
    return route.fulfill({ json: { ownerId: mode === "foreign" ? other : owner, limit: 20, entries: [
      { id: "cccccccc-1111-4111-8111-111111111111", operation: "naming.generate", completedAt: "2026-10-10T20:00:00Z", tokens: null },
    ] } });
  });
  await tab(page, "Usage & billing");
  await expect(page.getByRole("alert").filter({ hasText: "Recorded usage could not be loaded" })).toBeVisible();
  await expect(page.getByText("synthetic hidden detail")).toHaveCount(0);
  mode = "success"; await page.getByRole("button", { name: "Check usage again", exact: true }).click();
  await expect(page.getByRole("article", { name: "Naming", exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "Naming", exact: true }).getByText("Unknown", { exact: true })).toHaveCount(3);
  await expect(page.getByText("not an account-wide usage total", { exact: false })).toBeVisible();
  mode = "foreign"; await page.getByRole("button", { name: "Refresh usage", exact: true }).click();
  await expect(page.getByRole("article", { name: "Naming", exact: true })).toHaveCount(0);
  await expect(page.getByText("Sign in to view recorded usage.", { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("original artwork, native geometry and all tab grids match the approved design", async ({ page }, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const folder = new URL("../../public/settings/", import.meta.url);
  const files = await readdir(folder); expect(files.length).toBe(24);
  for (const name of files) {
    const expected = await readFile(new URL(name, folder)), response = await page.request.get(`/settings/${name}`);
    expect(response.status()).toBe(200);
    expect(createHash("sha256").update(await response.body()).digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"));
  }
  await page.evaluate(() => document.fonts.ready);
  if (info.project.name === "desktop") {
    const profile = (await page.getByRole("region", { name: "Profile", exact: true }).boundingBox())!;
    expect(profile.x).toBe(256); expect(profile.y).toBe(281); expect(profile.width).toBe(1008); expect(profile.height).toBe(286);
    const preferences = (await page.getByRole("region", { name: "Preferences", exact: true }).boundingBox())!;
    expect(preferences.height).toBe(398);
    for (const [name, size] of Object.entries({ mark: 28, home: 20, brands: 20, assets: 20, ideas: 20, names: 20, handles: 20, domains: 20, trademarks: 20, settings: 20, expand: 16 })) {
      const image = page.locator(`img[src='/settings/${name}.svg']`).first();
      await expect(image).toBeVisible(); expect((await image.boundingBox())!.width).toBe(size); expect((await image.boundingBox())!.height).toBe(size);
    }
  }
  for (const label of labels) {
    await tab(page, label);
    const grids = ["grid", "workspace-grid", "ai-grid", "billing-grid", "notifications-grid", "security-grid", "integrations-grid"];
    expect(await page.locator(".workspace-main").evaluate(el => getComputedStyle(el).backgroundImage)).toContain(`/settings/${grids[labels.indexOf(label)]}.svg`);
    await page.screenshot({ path: info.outputPath(`${label.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.png`), fullPage: true });
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
  await tab(page, "Usage & billing");
  await expect.poll(() => started).toBe(true);
  await expect(page.getByText("Loading recorded usage…", { exact: true })).toBeVisible();
  await page.route("**/api/session", route => route.fulfill({ status: 401, json: { error: "Synthetic session expired" } }));
  await page.getByLabel("Account menu", { exact: true }).click();
  await page.locator(".workspace-account-panel").getByRole("button", { name: "Check account", exact: true }).click();
  await expect(page.getByText("Sign in to view recorded usage.", { exact: true })).toBeVisible();
  resolve();
  await expect(page.getByRole("article", { name: "Naming", exact: true })).toHaveCount(0);
  await expect(page.getByText("123,456", { exact: true })).toHaveCount(0);
});

test("320px settings keep actions reachable and route styles scoped", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await open(page);
  for (const label of labels) {
    await tab(page, label);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await expect(page.getByRole("tabpanel")).toBeVisible();
  }
  await tab(page, "Security & privacy");
  await expect(page.getByRole("button", { name: "Delete account", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.locator(".mobile-menu").getByRole("link", { name: "Embel home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await page.locator(".concept-settings").count()).toBe(0);
});
