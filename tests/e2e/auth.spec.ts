import { expect, test, type Page, type Route } from "@playwright/test";
import { accountProjectSchema, accountProjectSummarySchema, updateProjectInputSchema } from "../../src/domain/project-api";
import { accountProjectPageSchema } from "../../src/domain/project-pages";
import { contextSnapshotSchema } from "../../src/domain/projects";

// Synthetic same-origin responses only. These tests never authenticate against a live provider.
const ownerId = "aaaaaaaa-2222-4222-8222-222222222222";
const projectId = "11111111-3333-4333-8333-333333333333";
const when = "2026-10-02T10:00:00Z";
const storageKey = "fluid.local-drafts.v1";
const privateTitle = "Private auth fixture";
const project = accountProjectSchema.parse({
  id: projectId, owner_id: ownerId, title: privateTitle, scope: "naming_only", current_revision: 1, created_at: when,
  context: contextSnapshotSchema.parse({ description: "A local account fixture used to verify sign-out behavior.", intake: { step: "description" } }),
});
const projectPage = accountProjectPageSchema.parse({ ownerId, items: [{
  ...accountProjectSummarySchema.parse(project), deleted_at: null, deletion_requested_at: null, deletion_state: "active", lifecycle_version: 0,
}], nextCursor: null });
const browserWorkspace = JSON.stringify({ version: 1, drafts: [{
  id: "33333333-4444-4444-8444-444444444444", title: "Browser auth fixture", scope: "naming_only",
  description: "A separate browser draft used only for this local test.", activity: "", offering: "", knownAudience: "", suppliedName: "", namingNotes: "", identityNotes: "",
  segments: [], stage: "description", audienceReviewedAt: null, createdAt: when, updatedAt: when, example: false,
}] });

async function reply(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
}

async function fixtures(page: Page) {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  let releaseSignIn!: () => void;
  let signInStarted!: () => void;
  const pendingSignIn = new Promise<void>(resolve => { releaseSignIn = resolve; });
  const signInRequested = new Promise<void>(resolve => { signInStarted = resolve; });
  const state = { sessionStatus: 200, sessionRequests: 0, signInRequests: 0, signOutRequests: 0, projectSaveTitles: [] as string[], signOutStatus: 200, malformed: false, hold: false, released: false, holdSignIn: false, signInStatus: 200, signInBody: { authenticated: true } as unknown };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") {
      state.sessionRequests++;
      return reply(route, state.sessionStatus === 200 ? { user: { id: ownerId } } : { error: { code: "unauthenticated", message: "Synthetic signed-out fixture" } }, state.sessionStatus);
    }
    if (path === "/api/auth/sign-in") {
      state.signInRequests++;
      expect(request.method()).toBe("POST");
      expect(request.postDataJSON()).toEqual({ email: "auth-fixture@example.invalid", password: " local-fixture-only password " });
      signInStarted();
      if (state.holdSignIn) await pendingSignIn;
      if (state.signInStatus === 200 && JSON.stringify(state.signInBody) === JSON.stringify({ authenticated: true })) state.sessionStatus = 200;
      return reply(route, state.signInBody, state.signInStatus);
    }
    if (path === "/api/auth/sign-out") {
      state.signOutRequests++;
      expect(request.method()).toBe("POST");
      expect(request.postDataJSON()).toEqual({});
      started();
      if (state.hold && !state.released) await pending;
      if (state.signOutStatus !== 200) return reply(route, { error: { code: "integration_unavailable", message: "Synthetic private detail must not be echoed" } }, state.signOutStatus);
      if (state.malformed) return reply(route, { authenticated: true });
      state.sessionStatus = 401;
      return reply(route, { authenticated: false });
    }
    if (state.sessionStatus !== 200) return reply(route, { error: { code: "unauthenticated", message: "Synthetic signed-out fixture" } }, 401);
    if (path === "/api/projects/page") return reply(route, projectPage);
    if (path === "/api/projects") return reply(route, { projects: [accountProjectSummarySchema.parse(project)] });
    if (path === `/api/projects/${projectId}/strategy` && request.method() === "GET") return reply(route, { availability: { status: "unavailable", operations: [], reason: "runtime_disabled" }, jobs: [] });
    if (path === `/api/projects/${projectId}` && request.method() === "GET") return reply(route, { project });
    if (path === `/api/projects/${projectId}` && request.method() === "PATCH") {
      const input = updateProjectInputSchema.parse(request.postDataJSON());
      expect(input.expectedRevision).toBe(project.current_revision);
      expect(input.title).toBeTruthy();
      state.projectSaveTitles.push(input.title!);
      return reply(route, { error: { code: "integration_unavailable", message: "Synthetic save rejection" } }, 503);
    }
    return reply(route, { error: { code: "not_found", message: "Synthetic missing fixture" } }, 404);
  });
  return { state, requested, signInRequested, releaseSignIn, release: () => { state.released = true; release(); } };
}

async function openBriefEditor(page: Page) {
  const menu = page.locator(".workspace-account-menu");
  if (await menu.count() && await menu.getAttribute("open") !== null) await menu.locator("summary").click();
  const editor = page.getByRole("dialog", { name: "Edit current brief", exact: true });
  if (!await editor.isVisible()) await page.getByRole("button", { name: "Edit brief", exact: true }).click();
  await expect(editor).toBeVisible();
}

async function openAccount(page: Page) {
  // Generic project links resume the next saved step; the brief editor lives in Strategy.
  await page.goto(`/brands/account/${projectId}?view=strategy`);
  await openBriefEditor(page);
  await expect(page.getByRole("textbox", { name: "Project label", exact: true })).toHaveValue(privateTitle);
}

async function rename(page: Page, title: string) {
  const editor = page.getByRole("dialog", { name: "Edit current brief", exact: true });
  const label = editor.getByRole("textbox", { name: "Project label", exact: true });
  await expect(label).toBeEditable();
  await label.fill(title);
  // Wait for the explicit failed autosave, rather than racing the debounce.
  await expect(editor.getByRole("status")).toHaveText("Changes not saved");
  await expect(label).not.toBeEditable();
  await expect(editor.getByText("Close this editor to check and retry the original save.", { exact: true })).toBeVisible();
}

async function openAccountSettings(page: Page) {
  const editor = page.getByRole("dialog", { name: "Edit current brief", exact: true });
  if (await editor.isVisible()) {
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await expect(editor).not.toBeVisible();
  }
  await revealAccountMenu(page);
  await page.getByRole("link", { name: "Account settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await revealAccountMenu(page);
}

async function returnToProject(page: Page) {
  // Client history preserves the session provider and its owner-bound draft.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectId}\\?view=strategy`));
}

async function verifyProjectAccount(page: Page) {
  // Account settings is intentionally hidden until the session is verified.
  // Signed out, the pill shows Sign in and Create account and returning to the
  // tab checks again; after a failed check, the account menu offers Check
  // account. Either way the current page keeps its draft.
  const menu = page.locator(".workspace-account-menu");
  if (await page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true }).count()) {
    await triggerAutomaticRefresh(page);
    await expect(menu).toHaveCount(1);
  } else {
    await revealAccountMenu(page);
    await expect(menu.getByRole("link", { name: "Account settings", exact: true })).toHaveCount(0);
    await menu.getByRole("button", { name: "Check account", exact: true }).click();
  }
  await revealAccountMenu(page);
  await expect(menu.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectId}\\?view=strategy`));
  await openBriefEditor(page);
}

async function revealAccountMenu(page: Page) {
  const menu = page.locator(".workspace-account-menu");
  if (await menu.count() && await menu.getAttribute("open") === null) await menu.locator("summary").click();
}

async function triggerAutomaticRefresh(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

test("auth fixture: unconfigured sign-in stays accessible and does not accept credentials", async ({ page }, testInfo) => {
  test.skip(process.env.FLUID_TEST_CONFIGURED_AUTH === "1", "This assertion checks an intentionally unconfigured build.");
  const { state } = await fixtures(page);
  state.sessionStatus = 401;
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Embel" })).toBeVisible();
  await expect(page.getByText("Sign-in is unavailable right now.", { exact: false })).toBeVisible();
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  await expect(form).toHaveAttribute("method", "post");
  await expect(form).toHaveAttribute("action", "/api/auth/sign-in");
  await expect(form.getByLabel("Email", { exact: true })).toBeDisabled();
  await expect(form.getByLabel("Password", { exact: true })).toBeDisabled();
  await expect(form.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "current-password");
  await expect(form.getByLabel("Password", { exact: true })).toHaveAttribute("maxlength", "1024");
  await expect(form.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Create account", exact: true })).toHaveAttribute("href", "/sign-up");
  await expect(page.getByRole("link", { name: "Forgot password", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("sign-in-unconfigured.png"), fullPage: true, scale: "css", style: "nextjs-portal { visibility: hidden; }" });
  await page.getByRole("link", { name: "Return to Home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await revealAccountMenu(page);
});

test("auth fixture: pending sign-in blocks refresh and sign-out across internal navigation", async ({ page }) => {
  test.skip(process.env.FLUID_TEST_CONFIGURED_AUTH !== "1", "Run against the inert configured build with intercepted fixture responses.");
  const fixture = await fixtures(page);
  fixture.state.sessionStatus = 401;
  fixture.state.holdSignIn = true;
  await page.clock.install();
  await page.goto("/sign-in");
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  await expect(form.getByLabel("Email", { exact: true })).toBeEnabled();
  await form.getByLabel("Email", { exact: true }).fill("auth-fixture@example.invalid");
  await form.getByLabel("Password", { exact: true }).fill(" local-fixture-only password ");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await fixture.signInRequested;
  const sessionCount = fixture.state.sessionRequests;
  await page.clock.fastForward(30_001);
  await expect(page.getByRole("status").filter({ hasText: "Sign-in is taking longer than expected." })).toBeVisible();
  // A focus verification would now see a ready account, but must not run while
  // the earlier cookie-mutating response can still arrive.
  fixture.state.sessionStatus = 200;
  await triggerAutomaticRefresh(page);
  expect(fixture.state.sessionRequests).toBe(sessionCount);
  await revealAccountMenu(page);
  await expect(page.getByRole("banner").getByRole("button", { name: "Signing in…", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^(Check|Checking) account(?:…)?$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
  const pendingPassword = form.getByLabel("Password", { exact: true });
  await expect(pendingPassword).toHaveValue(" local-fixture-only password ");
  const detachedPassword = await pendingPassword.elementHandle();
  await page.getByRole("link", { name: "Return to Home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await detachedPassword?.evaluate(element => (element as HTMLInputElement).value)).toBe("");
  await revealAccountMenu(page);
  await expect(page.getByRole("banner").getByRole("button", { name: "Signing in…", exact: true })).toBeDisabled();
  await triggerAutomaticRefresh(page);
  expect(fixture.state.sessionRequests).toBe(sessionCount);
  expect(fixture.state.signOutRequests).toBe(0);
  await expect(page.getByText(privateTitle, { exact: true })).toHaveCount(0);
  fixture.releaseSignIn();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: privateTitle, exact: true, level: 3 })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await triggerAutomaticRefresh(page);
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByText(privateTitle, { exact: true })).toHaveCount(0);
  expect(fixture.state.signInRequests).toBe(1);
  expect(fixture.state.signOutRequests).toBe(1);
});

test("auth fixture: configured sign-in retains only transient retries, rejects unsafe replies and preserves browser drafts", async ({ page }, testInfo) => {
  test.skip(process.env.FLUID_TEST_CONFIGURED_AUTH !== "1", "Run against the inert configured build with intercepted fixture responses.");
  const fixture = await fixtures(page);
  fixture.state.sessionStatus = 401;
  await page.addInitScript(({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value); }, { key: storageKey, value: browserWorkspace });
  await page.goto("/sign-in");
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  const email = form.getByLabel("Email", { exact: true });
  const password = form.getByLabel("Password", { exact: true });
  await expect(email).toBeEnabled();
  await expect(email).toHaveAttribute("maxlength", "320");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("sign-in-configured.png"), fullPage: true, scale: "css", style: "nextjs-portal { visibility: hidden; }" });
  const submit = async () => {
    await email.fill("auth-fixture@example.invalid");
    await password.fill(" local-fixture-only password ");
    await form.getByRole("button", { name: "Sign in", exact: true }).click();
  };
  fixture.state.holdSignIn = true;
  fixture.state.signInStatus = 401;
  fixture.state.signInBody = { error: { code: "invalid_credentials", message: "Synthetic private detail must not be echoed" } };
  await submit();
  await fixture.signInRequested;
  await expect(form.getByRole("button", { name: "Signing in…", exact: true })).toBeDisabled();
  await expect(password).toHaveValue(" local-fixture-only password ");
  await form.dispatchEvent("submit");
  expect(fixture.state.signInRequests).toBe(1);
  fixture.state.holdSignIn = false;
  fixture.releaseSignIn();
  await expect(form.getByRole("alert")).toContainText("We couldn't sign you in with those details");
  await expect(password).toHaveValue("");
  await expect(page.getByText("Synthetic private detail must not be echoed", { exact: true })).toHaveCount(0);
  let retryRetainedCredentials = false;
  for (const response of [
    { status: 429, body: { error: { code: "auth_rate_limited", message: "Synthetic detail" } }, expected: "Too many sign-in attempts" },
    { status: 503, body: { error: { code: "integration_unavailable", message: "Synthetic detail" } }, expected: "Sign-in is unavailable right now" },
    { status: 403, body: { error: { code: "forbidden_origin", message: "Synthetic detail" } }, expected: "This sign-in request couldn't be verified" },
    { status: 422, body: { error: { code: "invalid_input", message: "Synthetic detail" } }, expected: "Check your email and password" },
    { status: 413, body: { error: { code: "body_too_large", message: "Synthetic detail" } }, expected: "Check your email and password" },
    { status: 200, body: { authenticated: false }, expected: "The sign-in response couldn't be verified" },
    { status: 200, body: { authenticated: true, unexpected: "field" }, expected: "The sign-in response couldn't be verified" },
  ]) {
    fixture.state.signInStatus = response.status;
    fixture.state.signInBody = response.body;
    const previousRequests = fixture.state.signInRequests;
    if (retryRetainedCredentials) {
      // Retry the unchanged masked fields through an explicit click, without retyping.
      await form.getByRole("button", { name: "Sign in", exact: true }).click();
    } else await submit();
    await expect(form.getByRole("alert")).toContainText(response.expected);
    expect(fixture.state.signInRequests).toBe(previousRequests + 1);
    retryRetainedCredentials = response.status === 503;
    await expect(password).toHaveValue(retryRetainedCredentials ? " local-fixture-only password " : "");
    if (retryRetainedCredentials) {
      await triggerAutomaticRefresh(page);
      expect(fixture.state.signInRequests).toBe(previousRequests + 1);
    }
    await expect(page).toHaveURL(/\/sign-in$/);
  }
  fixture.state.signInStatus = 200;
  fixture.state.signInBody = { authenticated: true };
  await submit();
  await expect(page).toHaveURL(/\/brands$/);
  await revealAccountMenu(page);
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  expect(fixture.state.signInRequests).toBe(9);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(browserWorkspace);
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain("auth-fixture@example.invalid");
  expect(stored).not.toContain(" local-fixture-only password ");
  expect(page.url()).not.toContain("auth-fixture");
});

test("auth fixture: sign-out confirms unsaved edits, fences pending requests and retains drafts after failure", async ({ page }) => {
  const fixture = await fixtures(page);
  fixture.state.hold = true;
  fixture.state.signOutStatus = 503;
  await openAccount(page);
  await rename(page, "Unsaved auth recovery fixture");
  await openAccountSettings(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sign out with unsaved account edits?", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
  expect(fixture.state.signOutRequests).toBe(0);
  await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
  await returnToProject(page);
  await openBriefEditor(page);
  await expect(page.getByRole("textbox", { name: "Project label", exact: true })).toHaveValue("Unsaved auth recovery fixture");
  await openAccountSettings(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const sessionCount = fixture.state.sessionRequests;
  await dialog.getByRole("button", { name: "Discard edits and sign out", exact: true }).click();
  await fixture.requested;
  await expect(page.getByRole("button", { name: "Signing out…", exact: true })).toBeDisabled();
  await revealAccountMenu(page);
  await expect(page.getByRole("button", { name: /^(Check|Checking) account(?:…)?$/ })).toBeDisabled();
  await triggerAutomaticRefresh(page);
  expect(fixture.state.sessionRequests).toBe(sessionCount);
  await returnToProject(page);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  expect(fixture.state.signOutRequests).toBe(1);
  fixture.release();
  await expect(page.getByRole("alert").filter({ hasText: "Sign-out couldn't be confirmed" })).toBeVisible();
  await expect(page.getByText("Synthetic private detail must not be echoed", { exact: true })).toHaveCount(0);
  await triggerAutomaticRefresh(page);
  expect(fixture.state.sessionRequests).toBe(sessionCount);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await verifyProjectAccount(page);
  await expect(page.getByRole("textbox", { name: "Project label", exact: true })).toHaveValue("Unsaved auth recovery fixture");
  await expect(page.getByRole("textbox", { name: "Project label", exact: true })).not.toBeEditable();
  expect(fixture.state.signOutRequests).toBe(1);
  expect(fixture.state.projectSaveTitles).toEqual(["Unsaved auth recovery fixture"]);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
});

test("auth fixture: confirmed sign-out clears private buffers and preserves browser drafts", async ({ page }) => {
  const fixture = await fixtures(page);
  await page.addInitScript(({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value); }, { key: storageKey, value: browserWorkspace });
  await openAccount(page);
  await rename(page, "Unsaved auth discard fixture");
  await openAccountSettings(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard edits and sign out", exact: true }).click();
  await expect(page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await returnToProject(page);
  await expect(page.getByText("Sign in to see and save your work.", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(browserWorkspace);
  fixture.state.sessionStatus = 200;
  await verifyProjectAccount(page);
  await expect(page.getByRole("textbox", { name: "Project label", exact: true })).toHaveValue(privateTitle);
  await expect(page.getByRole("textbox", { name: "Project label", exact: true })).toBeEditable();
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(browserWorkspace);
  expect(fixture.state.signOutRequests).toBe(1);
  expect(fixture.state.projectSaveTitles).toEqual(["Unsaved auth discard fixture"]);
});

test("auth fixture: malformed sign-out success never clears an unsaved account draft", async ({ page }) => {
  const fixture = await fixtures(page);
  fixture.state.malformed = true;
  await openAccount(page);
  await rename(page, "Unverified logout fixture");
  await openAccountSettings(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard edits and sign out", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Sign-out couldn't be confirmed" })).toBeVisible();
  await returnToProject(page);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await verifyProjectAccount(page);
  await expect(page.getByRole("textbox", { name: "Project label", exact: true })).toHaveValue("Unverified logout fixture");
  await expect(page.getByRole("textbox", { name: "Project label", exact: true })).not.toBeEditable();
  expect(fixture.state.signOutRequests).toBe(1);
  expect(fixture.state.projectSaveTitles).toEqual(["Unverified logout fixture"]);
});
