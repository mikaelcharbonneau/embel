import { test, expect, type Page } from "@playwright/test";

// Synthetic same-origin responses only. No provider authentication or account creation.
async function signedOut(page: Page) {
  await page.route("**/api/**", route => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "unauthenticated" } }) }));
}
async function openOverlay(page: Page) {
  const menu = page.locator(".workspace-account-menu");
  if (!(await menu.evaluate(element => (element as HTMLDetailsElement).open))) await menu.locator("summary").click();
  const trigger = menu.getByRole("link", { name: "Sign in", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Sign in to Embel", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close sign-in" })).toBeFocused();
  return { dialog, trigger };
}

test("auth overlay: keyboard, history and backdrop preserve the underlying workspace", async ({ page }, testInfo) => {
  await signedOut(page);
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  const { dialog } = await openOverlay(page);
  await expect(page.locator(".app-shell")).toHaveClass(/concept-settings/);
  await expect(page.getByRole("tab", { name: "Notifications", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "current-password");
  await expect(dialog.getByRole("link", { name: "Create account", exact: true })).toHaveAttribute("href", "/sign-up");
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("sign-in-overlay.png"), scale: "css" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator(".workspace-account-menu > summary")).toBeVisible();
  await expect(page.locator(".workspace-account-menu > summary")).toBeFocused();
  await expect(page.locator(".workspace-account-menu")).not.toHaveAttribute("open", "");
  await page.goForward();
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Notifications", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("auth overlay: closing returns focus to a visible Home opener without changing the prompt", async ({ page }) => {
  await signedOut(page); await page.goto("/");
  const prompt = page.getByRole("textbox", { name: "Your prompt", exact: true });
  await prompt.fill("A neighborhood workshop for learning practical repair skills.");
  const trigger = page.locator(".conversation-start-notice").getByRole("link", { name: "Sign in", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Sign in to Embel", exact: true });
  await expect(dialog).toBeVisible(); await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0); await expect(trigger).toBeVisible(); await expect(trigger).toBeFocused();
  await expect(prompt).toHaveValue("A neighborhood workshop for learning practical repair skills.");
});

test("auth overlay: closed-menu focus restoration works without checkVisibility", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(Element.prototype, "checkVisibility", { configurable: true, value: undefined }); });
  await signedOut(page); await page.goto("/settings");
  const { dialog } = await openOverlay(page);
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  const menu = page.locator(".workspace-account-menu");
  await expect(menu).not.toHaveAttribute("open", "");
  await expect(menu.locator(":scope > summary")).toBeVisible();
  await expect(menu.locator(":scope > summary")).toBeFocused();
});

test("auth overlay: continuation clears the slot; direct visits and reloads use the standalone card", async ({ page }, testInfo) => {
  if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
  await signedOut(page);
  await page.goto("/settings");
  const { dialog } = await openOverlay(page);
  await dialog.getByRole("link", { name: "Return to Home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(dialog).toHaveCount(0);
  await openOverlay(page);
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".app-shell")).toHaveClass(/concept-sign-in/);
  const card = page.locator(".auth-card");
  await expect(card.getByRole("heading", { name: "Sign in to Embel" })).toBeVisible();
  const box = await card.boundingBox();
  if (testInfo.project.name === "desktop") {
    expect(box?.width).toBe(460);
    expect(box?.x).toBe(530);
    // Unavailable-account notice grows the honest card rather than hiding the status.
    expect(box?.y).toBe(176);
  }
  await expect(card.locator('img[src="/auth/card-mark.svg"]')).toHaveAttribute("width", "32");
  await expect(card.locator('img[src="/auth/submit-arrow.svg"]')).toHaveAttribute("width", "17");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("sign-in-page.png"), scale: "css" });
});

test("auth overlay: pending dismissal retains the global cookie-mutation fence and clears passwords", async ({ page }) => {
  test.skip(process.env.FLUID_TEST_CONFIGURED_AUTH !== "1", "Inert configured server with every API intercepted.");
  let authed = false;
  let submissions = 0;
  let sessionReads = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") { sessionReads++; return route.fulfill({ status: authed ? 200 : 401, json: authed ? { user: { id: "aaaaaaaa-2222-4222-8222-222222222222" } } : { error: { code: "unauthenticated" } } }); }
    if (path === "/api/auth/sign-in") {
      submissions++;
      expect(route.request().postDataJSON()).toEqual({ email: "overlay@example.invalid", password: "  inert overlay fixture  " });
      await pending; authed = true;
      return route.fulfill({ json: { authenticated: true } });
    }
    return route.fulfill({ status: 503, json: { error: { code: "integration_unavailable" } } });
  });
  await page.goto("/settings");
  const { dialog } = await openOverlay(page);
  await dialog.getByLabel("Email", { exact: true }).fill("overlay@example.invalid");
  await dialog.getByLabel("Password", { exact: true }).fill("  inert overlay fixture  ");
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect.poll(() => submissions).toBe(1);
  const password = dialog.getByLabel("Password", { exact: true });
  await expect(password).toHaveValue("  inert overlay fixture  ");
  const detachedPassword = await password.elementHandle();
  const before = sessionReads;
  await dialog.getByRole("button", { name: "Close sign-in" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await detachedPassword?.evaluate(element => (element as HTMLInputElement).value)).toBe("");
  await expect(page).toHaveURL(/\/settings$/);
  const accountSummary = page.locator(".workspace-account-menu > summary");
  await expect(accountSummary).toBeVisible();
  await expect(accountSummary).toBeFocused();
  await accountSummary.click();
  await expect(page.locator(".workspace-account-menu").getByRole("button", { name: "Signing in…", exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(sessionReads).toBe(before);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain("overlay@example.invalid");
  expect(storage).not.toContain("inert overlay fixture");
  release();
  await expect(page.locator(".workspace-account-menu").getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  expect(submissions).toBe(1);
});
