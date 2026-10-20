import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { accountProjectSchema } from "../../src/domain/project-api";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { INSPIRATION_CATALOG_VERSION } from "../../src/domain/inspiration";
import { visualDirectionOverviewSchema } from "../../src/domain/visual-direction";
import { syntheticLogoWorkspace } from "../fixtures/logo-creation";
import { captureUiEvidence } from "./ui-evidence";

const ownerId = "aaaaaaaa-1111-4111-8111-111111111111";
const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
const privateTitle = "Synthetic private account project with a long retained title";
const privateGuidance = "Synthetic private guidance retained in the saved account workspace.";
const projectRoute = `/brands/account/${projectId}/logo/directions`;
const promptText = "A neighborhood kitchen for seasonal lunches and practical cooking classes.";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

type FixtureState = Awaited<ReturnType<typeof fixture>>;
const fixtures = new WeakMap<Page, FixtureState>();

test.beforeEach(async ({ page }, info) => {
  await page.setViewportSize(info.project.name === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
});

test.afterEach(async ({ page }, info) => {
  const state = fixtures.get(page);
  if (!state) return;
  state.sessionGate?.release(); state.projectGate?.release();
  await info.attach("read-only-workspace-fixture", { body: Buffer.from(JSON.stringify({
    fixture: "Synthetic local account; no live data, providers, microphone or API mutations",
    route: page.url(), viewport: page.viewportSize(), requests: state.requests,
    blockedExternal: state.blockedExternal, unknownReads: state.unknownReads,
    pageErrors: state.pageErrors, consoleErrors: state.consoleErrors,
  }, null, 2)), contentType: "application/json" });
  expect(state.writes).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

/** All account records are synthetic and parsed by the production contracts.
 * Holding intercepted reads does not contact a database, provider or auth service. */
async function fixture(page: Page, held = false, failedProject = false) {
  const state = {
    session: "ready" as "ready" | "signed_out", failedProject,
    sessionGate: held ? deferred() : null, projectGate: held ? deferred() : null,
    requests: [] as { path: string; method: string }[], writes: [] as string[],
    blockedExternal: [] as string[], unknownReads: [] as string[],
    pageErrors: [] as string[], consoleErrors: [] as string[],
  };
  fixtures.set(page, state);
  page.on("pageerror", error => state.pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") state.consoleErrors.push(message.text()); });
  await page.addInitScript(() => {
    const counters = { submits: 0, voiceStarts: 0 };
    Object.defineProperty(window, "__workspaceStateFixture", { value: counters });
    document.addEventListener("submit", event => { counters.submits++; event.preventDefault(); }, true);
    // A local unavailable adapter prevents an actual speech availability or mic check.
    class UnavailableSpeechRecognition extends EventTarget {
      processLocally = true;
      static async available() { return "unavailable"; }
      start() { counters.voiceStarts++; throw new Error("Synthetic voice start is forbidden"); }
      stop() { /* No microphone exists in this fixture. */ }
      abort() { /* No microphone exists in this fixture. */ }
    }
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: UnavailableSpeechRecognition });
  });
  const project = accountProjectSchema.parse({ id: projectId, owner_id: ownerId, title: privateTitle,
    scope: "visual_identity_only", current_revision: 1, created_at: "2026-10-15T10:00:00Z",
    context: { description: "Synthetic saved project context", selectedName: "Kitchen" } });
  const workspace = logoWorkspaceV2Schema.parse({ ...syntheticLogoWorkspace(), ownerId, projectId });
  const direction = visualDirectionOverviewSchema.parse({
    inspiration: { ownerId, projectId, projectTitle: privateTitle, projectScope: project.scope, projectRevision: 1,
      catalogVersion: INSPIRATION_CATALOG_VERSION, selectionRevision: 0, choices: [] },
    current: { id: "cccccccc-1111-4111-8111-111111111111", ownerId, projectId, revision: 1, projectRevision: 1,
      selectionRevision: 0, catalogVersion: INSPIRATION_CATALOG_VERSION,
      guidance: { character: privateGuidance, colors: "", typography: "", graphics: "" }, references: [], reviewedAt: "2026-10-15T10:00:00Z" },
    history: [], hasEarlierHistory: false, stale: false,
  });
  const logo = `/api/projects/${projectId}/logo`;
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.hostname !== "127.0.0.1") { state.blockedExternal.push(request.url()); return route.abort("blockedbyclient"); }
    if (!path.startsWith("/api/")) return route.continue();
    state.requests.push({ path, method: request.method() });
    if (request.method() !== "GET") {
      state.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { error: "This read-only fixture rejects writes" } });
    }
    if (path === "/api/session") {
      await state.sessionGate?.promise;
      return route.fulfill(state.session === "ready" ? { json: { user: { id: ownerId } } } : { status: 401, json: {} });
    }
    if (path === `/api/projects/${projectId}`) {
      await state.projectGate?.promise;
      return route.fulfill(state.failedProject ? { status: 503, json: { error: "Synthetic project read unavailable" } } : { json: { project } });
    }
    const body = path === "/api/account/profile" ? { profile: { ownerId, email: "workspace-fixture@example.invalid", revision: 0, updatedAt: null,
      values: { fullName: "Synthetic account", timeZone: "America/Toronto", dateFormat: "friendly" } } }
      : path === "/api/projects/page" ? { ownerId, items: [], nextCursor: null }
      : path === "/api/home/attachments/capability" ? { ownerId, policy: null, reason: "Synthetic file storage is unavailable." }
      : path === "/api/strategy" ? { availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } }
      : path === logo ? workspace
      : path === `${logo}/references` || path === `${logo}/inputs/requests` ? { ownerId, projectId, items: [], nextCursor: null }
      : path === `${logo}/fonts` || path === `${logo}/fonts/catalog` ? []
      : path === `/api/projects/${projectId}/visual-direction` ? direction : null;
    if (body === null) state.unknownReads.push(path);
    return route.fulfill({ status: body === null ? 503 : 200, json: body ?? { error: "Unconfigured synthetic read" } });
  });
  return state;
}

async function captureState(page: Page, info: TestInfo, state: string) {
  await page.evaluate(() => document.fonts.ready);
  await captureUiEvidence(page, { ...info, title: `${info.title} ${state}` });
}

async function frame(page: Page) {
  const selectors = [".project-workspace-header", ".project-stage-navigation", ".project-workspace > .logo-journey-navigation", ".project-workspace-content"] as const;
  const boxes = [];
  for (const selector of selectors) {
    const row = page.locator(selector); await expect(row).toHaveCount(1); await expect(row).toBeVisible();
    const box = (await row.boundingBox())!; expect(box.width).toBeGreaterThan(0); expect(box.height).toBeGreaterThan(0);
    boxes.push({ selector, ...box });
  }
  await expect(page.getByRole("navigation", { name: "Project stages", exact: true })).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Logo and identity pages", exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  return boxes;
}

function expectSameFrame(before: Awaited<ReturnType<typeof frame>>, after: Awaited<ReturnType<typeof frame>>) {
  expect(after.map(row => row.selector)).toEqual(before.map(row => row.selector));
  for (let index = 0; index < before.length; index++) for (const coordinate of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(before[index]![coordinate] - after[index]![coordinate]), `${before[index]!.selector} ${coordinate}`).toBeLessThanOrEqual(1);
  }
}

async function expectChecking(page: Page, reason: string) {
  await expect(page.locator(".project-workspace-title")).toHaveText("Project");
  await expect(page.getByText("Unsaved project edits", { exact: true })).toHaveCount(0);
  const stages = page.getByRole("navigation", { name: "Project stages", exact: true });
  await expect(stages.getByRole("link", { name: "Strategy", exact: true })).toBeVisible();
  for (const button of await stages.getByRole("button").all()) { await expect(button).toBeDisabled(); await expect(button).toHaveAttribute("title", reason); }
  const pages = page.getByRole("navigation", { name: "Logo and identity pages", exact: true });
  await expect(pages.getByRole("button")).toHaveCount(6);
  for (const button of await pages.getByRole("button").all()) { await expect(button).toBeDisabled(); await expect(button).toHaveAttribute("title", reason); }
  await expect(pages.getByRole("button", { name: "Identity directions", exact: true })).toHaveAttribute("aria-current", "page");
}

async function expectMasked(page: Page) {
  await expect(page.getByText(privateTitle, { exact: true })).toHaveCount(0);
  await expect(page.locator(".project-output-page")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Overall character", exact: true })).toHaveCount(0);
}

test("Home input disclosures preserve prompt and honest availability", async ({ page }, info) => {
  const state = await fixture(page); await page.goto("/");
  const prompt = page.getByRole("textbox", { name: "Your prompt", exact: true });
  await expect(prompt).toBeEditable(); await prompt.fill(promptText);
  const files = page.locator(".home-files-popover"), trigger = files.locator(":scope > summary");
  const panel = files.getByRole("region", { name: "Add files or images", exact: true });
  await trigger.focus(); await trigger.press("Enter"); await expect(files).toHaveAttribute("open", "");
  await expect(panel.getByRole("status")).toHaveText("File attachments are currently unavailable. You can keep writing your prompt.");
  const send = (await page.locator(".composer-send-icon").boundingBox())!, filePanel = (await panel.boundingBox())!;
  expect(filePanel.y).toBeGreaterThanOrEqual(send.y + send.height);
  if (info.project.name === "mobile") {
    const scopeBox = (await page.getByRole("button", { name: "Project scope: Brand", exact: true }).boundingBox())!;
    expect(Math.abs(send.y - scopeBox.y)).toBeLessThanOrEqual(1);
    expect(filePanel.width).toBeGreaterThan(page.viewportSize()!.width * .8);
  }
  const fileInput = panel.locator('input[type="file"]');
  await expect(fileInput).toBeDisabled(); await expect(fileInput).toHaveAttribute("hidden", ""); await expect(fileInput).toBeHidden();
  const availability = panel.locator(".home-attachment-details"), availabilityTrigger = availability.locator("summary");
  await expect(availabilityTrigger).toHaveText("Availability details"); await expect(availability).not.toHaveAttribute("open", "");
  await availabilityTrigger.focus(); await availabilityTrigger.press("Enter"); await expect(availability).toHaveAttribute("open", "");
  await expect(panel.getByText("Synthetic file storage is unavailable.", { exact: true })).toBeVisible();
  await availabilityTrigger.press("Enter"); await expect(availability).not.toHaveAttribute("open", "");
  await trigger.focus(); await trigger.press("Enter"); await expect(files).not.toHaveAttribute("open", ""); await expect(trigger).toBeFocused();
  await trigger.press("Enter"); await prompt.focus(); await page.keyboard.press("Escape");
  await expect(files).not.toHaveAttribute("open", ""); await expect(trigger).toBeFocused(); await expect(prompt).toHaveValue(promptText);
  await trigger.press("Enter"); await prompt.click(); await expect(files).not.toHaveAttribute("open", ""); await expect(prompt).toBeFocused();

  const scope = page.getByRole("button", { name: "Project scope: Brand", exact: true });
  await scope.focus(); await scope.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Project scope", exact: true }), options = menu.getByRole("menuitemradio");
  expect(await options.locator(":scope > span").allTextContents()).toEqual(["Brand", "Name", "System", "Logo", "Font", "Color", "Guide"]);
  await expect(options).toHaveCount(7);
  for (let index = 0; index < 7; index++) {
    if (index < 3) await expect(options.nth(index)).toBeEnabled();
    else await expect(options.nth(index)).toBeDisabled();
  }
  await expect(options.nth(0)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("End"); await expect(options.nth(2)).toBeFocused();
  await page.keyboard.press("ArrowDown"); await expect(options.nth(0)).toBeFocused();
  await page.keyboard.press("Escape"); await expect(menu).toHaveCount(0); await expect(scope).toBeFocused();
  await expect(scope).toHaveAccessibleName("Project scope: Brand");
  const voice = page.locator(".home-voice-popover"), voiceTrigger = voice.locator(":scope > summary");
  await voiceTrigger.focus(); await voiceTrigger.press("Enter");
  await expect(voice.getByRole("button", { name: "Start voice input", exact: true })).toBeDisabled();
  await prompt.focus(); await page.keyboard.press("Escape"); await expect(voice).not.toHaveAttribute("open", ""); await expect(voiceTrigger).toBeFocused();
  await expect(prompt).toHaveValue(promptText); expect(state.writes).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __workspaceStateFixture: { submits: number; voiceStarts: number } }).__workspaceStateFixture)).toEqual({ submits: 0, voiceStarts: 0 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await trigger.click(); await availabilityTrigger.click(); await captureState(page, info, "files-availability");
});

test("project frame stays stable through verification and account loss", async ({ page }, info) => {
  const state = await fixture(page, true);
  try {
    await page.goto(projectRoute); await expect.poll(() => state.requests.some(row => row.path === "/api/session")).toBe(true);
    await expect(page.locator(".project-workspace-save")).toHaveText("Checking account…");
    await expectChecking(page, "Checking your account…"); await expectMasked(page);
    expect(state.requests.some(row => row.path === `/api/projects/${projectId}`)).toBe(false);
    const accountChecking = await frame(page); await captureState(page, info, "account-checking");
    state.sessionGate!.release(); state.sessionGate = null;
    await expect.poll(() => state.requests.some(row => row.path === `/api/projects/${projectId}`)).toBe(true);
    await expect(page.locator(".project-workspace-save")).toHaveText("Checking project…");
    await expectChecking(page, "Checking saved project…");
    const projectChecking = await frame(page); expectSameFrame(accountChecking, projectChecking);
    state.projectGate!.release(); state.projectGate = null;
    await expect(page.locator(".project-workspace-title")).toHaveText(privateTitle);
    await expect(page.locator(".project-workspace-save")).toHaveText("Saved project · v1");
    await expect(page.getByRole("textbox", { name: "Overall character", exact: true })).toHaveValue(privateGuidance);
    const verified = await frame(page); expectSameFrame(accountChecking, verified);
    await info.attach("project-frame-geometry", { body: Buffer.from(JSON.stringify({ viewport: page.viewportSize(), accountChecking, projectChecking, verified }, null, 2)), contentType: "application/json" });
    await captureState(page, info, "verified");
    // Existing production visibilitychange handling rechecks only the synthetic GET session.
    state.session = "signed_out"; state.sessionGate = deferred();
    const previousReads = state.requests.filter(row => row.path === "/api/session").length;
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => state.requests.filter(row => row.path === "/api/session").length).toBeGreaterThan(previousReads);
    await expect(page.locator(".project-workspace-save")).toHaveText("Checking account…"); await expectMasked(page);
    expectSameFrame(verified, await frame(page));
    state.sessionGate.release(); state.sessionGate = null;
    await expect(page.locator(".project-workspace-save")).toHaveText("Account not verified");
    await expectChecking(page, "Verify your account before continuing"); await expectMasked(page);
    expectSameFrame(verified, await frame(page)); await captureState(page, info, "account-masked");
    expect(state.writes).toEqual([]);
  } finally { state.sessionGate?.release(); state.projectGate?.release(); }
});

test("Home disclosure dismissal preserves prompt with temporary reduced motion", async ({ page }) => {
  await fixture(page); await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await page.goto("/"); expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    const prompt = page.getByRole("textbox", { name: "Your prompt", exact: true }); await prompt.fill(promptText);
    const files = page.locator(".home-files-popover"), trigger = files.locator(":scope > summary");
    await trigger.focus(); await trigger.press("Enter"); await expect(files).toHaveAttribute("open", "");
    await prompt.focus(); await page.keyboard.press("Escape"); await expect(files).not.toHaveAttribute("open", ""); await expect(trigger).toBeFocused();
    await expect(prompt).toHaveValue(promptText);
  } finally { await page.emulateMedia({ reducedMotion: null }); }
});

test("failed project read keeps navigation and actionable check copy", async ({ page }, info) => {
  const state = await fixture(page, true, true);
  try {
    await page.goto(projectRoute); state.sessionGate!.release(); state.sessionGate = null;
    await expect(page.locator(".project-workspace-save")).toHaveText("Checking project…");
    const checking = await frame(page);
    state.projectGate!.release(); state.projectGate = null;
    await expect(page.locator(".project-workspace-save")).toHaveText("Project not verified");
    const notice = page.getByRole("alert").filter({ hasText: "The saved project could not be verified. Your existing work is kept." });
    await expect(notice).toBeVisible(); await expect(notice.getByRole("button", { name: "Check saved project", exact: true })).toBeEnabled();
    await expectChecking(page, "Check saved project before continuing");
    const failed = await frame(page);
    // The explicit read-error notice occupies content space; navigation rows retain their geometry.
    expectSameFrame(checking.slice(0, 3), failed.slice(0, 3));
    const retry = notice.getByRole("button", { name: "Check saved project", exact: true });
    await retry.focus(); await expect(retry).toBeFocused();
    expect(state.writes).toEqual([]); await captureState(page, info, "project-read-failed");
  } finally { state.sessionGate?.release(); state.projectGate?.release(); }
});
