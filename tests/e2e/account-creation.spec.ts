import { expect, test, type Page } from "@playwright/test";

// Every API and external destination is intercepted. No account or email is created.
const owner = "aaaaaaaa-2222-4222-8222-222222222222";
const email = "signup-fixture@example.invalid";
const password = "inert signup fixture password";

async function fixtures(page: Page) {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const state = { authenticated: false, signupCount: 0, resendCount: 0, signInCount: 0, sessionReads: 0,
    privateWrites: 0, hold: false, signupStatus: 200, resendStatus: 200,
    signupReply: { authenticated: false, confirmationRequired: true } as unknown };
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (url.pathname === "/api/session") {
      state.sessionReads++;
      return state.authenticated ? reply({ user: { id: owner } }) : reply({}, 401);
    }
    if (url.pathname === "/api/auth/sign-up") {
      state.signupCount++;
      expect(request.postDataJSON()).toEqual({ email, password });
      if (state.hold) await pending;
      return reply(state.signupReply, state.signupStatus);
    }
    if (url.pathname === "/api/auth/resend-confirmation") {
      state.resendCount++;
      expect(request.postDataJSON()).toEqual({ email });
      return reply(state.resendStatus === 200 ? { authenticated: false, confirmationRequired: true }
        : { error: { message: "Provider detail must never be displayed" } }, state.resendStatus);
    }
    if (url.pathname === "/api/auth/sign-in") {
      state.signInCount++;
      expect(request.postDataJSON()).toEqual({ email, password });
      state.authenticated = true;
      return reply({ authenticated: true });
    }
    if (request.method() !== "GET") state.privateWrites++;
    if (!state.authenticated) return reply({}, 401);
    if (url.pathname === "/api/projects/page") return reply({ ownerId: owner, items: [], nextCursor: null });
    if (url.pathname === "/api/projects") return reply({ projects: [] });
    if (url.pathname === "/api/strategy") return reply({ availability: { status: "unavailable", reason: "worker_unavailable", operations: [] } });
    return reply({}, 503);
  });
  return { state, release };
}

async function fillSignup(page: Page, confirmationPassword = password) {
  const form = page.getByRole("form", { name: "Create account", exact: true });
  await expect(form.getByLabel("Email", { exact: true })).toBeEnabled();
  await form.getByLabel("Email", { exact: true }).fill(email);
  await form.getByLabel("Password", { exact: true }).fill(password);
  await form.getByLabel("Confirm password", { exact: true }).fill(confirmationPassword);
  await form.getByRole("button", { name: "Create account", exact: true }).click();
  return form;
}

test.beforeEach(() => {
  test.skip(process.env.FLUID_TEST_CONFIGURED_AUTH !== "1", "Configured server; provider responses remain intercepted fixtures.");
});

test("signup: direct form validates passwords and waits for email without inventing a session", async ({ page }, info) => {
  const { state } = await fixtures(page);
  await page.goto("/sign-up");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Create your Embel account", exact: true })).toBeVisible();
  const form = await fillSignup(page, "different inert password");
  await expect(form.getByRole("alert")).toContainText("passwords didn't match");
  await expect(form.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("Confirm password", { exact: true })).toHaveValue("");
  expect(state.signupCount).toBe(0);
  await expect(form.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "new-password");
  await page.screenshot({ path: info.outputPath("signup-form.png"), fullPage: true, scale: "css" });
  await fillSignup(page);
  await expect(page.getByRole("heading", { name: "Check your email", exact: true })).toBeVisible();
  await expect(page.getByText("If this address is eligible", { exact: false })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  expect(state.authenticated).toBe(false);
  expect(state.signupCount).toBe(1);
  expect(state.privateWrites).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain(email);
  expect(stored).not.toContain(password);
  await page.screenshot({ path: info.outputPath("signup-confirmation.png"), fullPage: true, scale: "css" });
  await page.getByRole("button", { name: "Use another email", exact: true }).click();
  await expect(page.getByRole("form", { name: "Create account", exact: true }).getByLabel("Email", { exact: true })).toHaveValue("");
});

test("signup: overlay dismissal retains pending authentication and the underlying workspace", async ({ page }) => {
  const fixture = await fixtures(page);
  fixture.state.hold = true;
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await page.getByLabel("Account menu", { exact: true }).click();
  await page.locator(".workspace-account-menu").getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Create account", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create your Embel account", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveClass(/concept-settings/);
  const form = await fillSignup(page);
  await expect.poll(() => fixture.state.signupCount).toBe(1);
  await expect(form.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("Confirm password", { exact: true })).toHaveValue("");
  await form.dispatchEvent("submit");
  const reads = fixture.state.sessionReads;
  await dialog.getByRole("button", { name: "Close account creation", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Notifications", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(fixture.state.sessionReads).toBe(reads);
  expect(fixture.state.signupCount).toBe(1);
  fixture.release();
  // Route changes close the account menu; reopen it to inspect its actions.
  await page.getByLabel("Account menu", { exact: true }).click();
  await expect(page.locator(".workspace-account-menu").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(fixture.state.sessionReads).toBe(reads);
  expect(fixture.state.privateWrites).toBe(0);
});

test("signup: prompt and scope survive signup, email waiting and subsequent sign-in", async ({ page }) => {
  const { state } = await fixtures(page);
  const prompt = "A neighborhood repair workshop with beginner-friendly classes.";
  await page.goto("/");
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Project scope: Brand", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Name", exact: true }).click();
  await page.getByLabel("Account menu", { exact: true }).click();
  await page.locator(".workspace-account-menu").getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Create account", exact: true }).click();
  await expect(page.getByText("Your prompt is kept while you sign in.", { exact: false })).toBeVisible();
  await fillSignup(page);
  await expect(page.getByRole("heading", { name: "Check your email", exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("link", { name: "Sign in", exact: true }).click();
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  await form.getByLabel("Email", { exact: true }).fill(email);
  await form.getByLabel("Password", { exact: true }).fill(password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).toHaveValue(prompt);
  await expect(page.getByRole("button", { name: "Project scope: Name", exact: true })).toBeVisible();
  expect(state.signupCount).toBe(1);
  expect(state.signInCount).toBe(1);
  expect(state.privateWrites).toBe(0);
});

test("signup: confirmation redirects discard provider URL fragments", async ({ page, baseURL }) => {
  test.skip(process.env.APP_ORIGIN !== baseURL, "Requires this browser server to be the explicitly configured trusted callback origin; route-level redirect security is covered separately.");
  const { state } = await fixtures(page);
  await page.goto("/auth/callback#error=synthetic_provider_error&access_token=synthetic_fragment_only");
  await expect(page).toHaveURL(/\/sign-in\?confirmation=failed#?$/);
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.locator(".auth-card").getByRole("alert")).toContainText("couldn't complete this confirmation link");
  expect(state.signupCount).toBe(0);
  expect(state.resendCount).toBe(0);
  expect(state.privateWrites).toBe(0);
});

test("signup: failed confirmation offers generic bounded-provider resend recovery", async ({ page }) => {
  const { state } = await fixtures(page);
  await page.goto("/sign-in?confirmation=failed");
  await expect(page.locator(".auth-card").getByRole("alert")).toContainText("couldn't complete this confirmation link");
  await page.getByRole("button", { name: "Request another confirmation email", exact: true }).click();
  const form = page.getByRole("form", { name: "Resend confirmation", exact: true });
  state.resendStatus = 429;
  await form.getByLabel("Email", { exact: true }).fill(email);
  await form.getByRole("button", { name: "Resend confirmation", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("Too many account attempts");
  await expect(page.getByText("Provider detail must never be displayed", { exact: true })).toHaveCount(0);
  state.resendStatus = 200;
  await form.getByRole("button", { name: "Resend confirmation", exact: true }).click();
  await expect(form.getByRole("status")).toContainText("If this address is awaiting confirmation");
  await expect(form.getByLabel("Email", { exact: true })).toHaveValue("");
  expect(state.resendCount).toBe(2);
  expect(state.authenticated).toBe(false);
});

test("signup: malformed success keeps account private and preserves a retry path", async ({ page }) => {
  const { state } = await fixtures(page);
  state.signupReply = { authenticated: true, unexpected: "provider detail" };
  await page.goto("/sign-up");
  const form = await fillSignup(page);
  await expect(form.getByRole("alert")).toContainText("account response couldn't be verified");
  await expect(form.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("Confirm password", { exact: true })).toHaveValue("");
  await expect(page).toHaveURL(/\/sign-up$/);
  expect(state.privateWrites).toBe(0);
  state.signupReply = { authenticated: false, confirmationRequired: true };
  await fillSignup(page);
  await expect(page.getByRole("heading", { name: "Check your email", exact: true })).toBeVisible();
});

test("signup: a modal above direct sign-in has distinct accessible controls and clears the earlier password", async ({ page }) => {
  await fixtures(page);
  await page.goto("/sign-in");
  const originalPassword = page.getByRole("form", { name: "Sign in", exact: true }).getByLabel("Password", { exact: true });
  await expect(originalPassword).toBeEnabled();
  await originalPassword.fill(password);
  await page.getByRole("link", { name: "Create account", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create your Embel account", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Email", { exact: true })).toHaveCount(1);
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => {
    const ids = [...document.querySelectorAll(".auth-guided [id]")].map(element => element.id);
    return ids.length === new Set(ids).size;
  })).toBe(true);
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(originalPassword).toHaveValue("");
});
