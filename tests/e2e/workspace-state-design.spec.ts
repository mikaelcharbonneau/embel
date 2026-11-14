import { expectProjectCanvas } from "./project-canvas-contract";
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
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type FixtureState = Awaited<ReturnType<typeof fixture>>;
const fixtures = new WeakMap<Page, FixtureState>();

test.beforeEach(async ({ page }, info) => {
  await page.setViewportSize(
    info.project.name === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 },
  );
});

test.afterEach(async ({ page }, info) => {
  const state = fixtures.get(page);
  if (!state) return;
  state.sessionGate?.release();
  state.projectGate?.release();
  await info.attach("read-only-workspace-fixture", {
    body: Buffer.from(
      JSON.stringify(
        {
          fixture: "Synthetic local account; no live data, providers, microphone or API mutations",
          route: page.url(),
          viewport: page.viewportSize(),
          requests: state.requests,
          blockedExternal: state.blockedExternal,
          unknownReads: state.unknownReads,
          pageErrors: state.pageErrors,
          consoleErrors: state.consoleErrors,
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
  expect(state.writes).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

/** All account records are synthetic and parsed by the production contracts.
 * Holding intercepted reads does not contact a database, provider or auth service. */
async function fixture(page: Page, held = false, failedProject = false) {
  const state = {
    session: "ready" as "ready" | "signed_out",
    failedProject,
    sessionGate: held ? deferred() : null,
    projectGate: held ? deferred() : null,
    requests: [] as { path: string; method: string }[],
    writes: [] as string[],
    blockedExternal: [] as string[],
    unknownReads: [] as string[],
    pageErrors: [] as string[],
    consoleErrors: [] as string[],
  };
  fixtures.set(page, state);
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") state.consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    const counters = { submits: 0, voiceStarts: 0 };
    Object.defineProperty(window, "__workspaceStateFixture", { value: counters });
    document.addEventListener(
      "submit",
      (event) => {
        counters.submits++;
        event.preventDefault();
      },
      true,
    );
    // A local unavailable adapter prevents an actual speech availability or mic check.
    class UnavailableSpeechRecognition extends EventTarget {
      processLocally = true;
      static async available() {
        return "unavailable";
      }
      start() {
        counters.voiceStarts++;
        throw new Error("Synthetic voice start is forbidden");
      }
      stop() {
        /* No microphone exists in this fixture. */
      }
      abort() {
        /* No microphone exists in this fixture. */
      }
    }
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: UnavailableSpeechRecognition });
  });
  const project = accountProjectSchema.parse({
    id: projectId,
    owner_id: ownerId,
    title: privateTitle,
    scope: "visual_identity_only",
    current_revision: 1,
    created_at: "2026-10-15T10:00:00Z",
    context: { description: "Synthetic saved project context", selectedName: "Kitchen" },
  });
  const workspace = logoWorkspaceV2Schema.parse({ ...syntheticLogoWorkspace(), ownerId, projectId });
  const direction = visualDirectionOverviewSchema.parse({
    inspiration: {
      ownerId,
      projectId,
      projectTitle: privateTitle,
      projectScope: project.scope,
      projectRevision: 1,
      catalogVersion: INSPIRATION_CATALOG_VERSION,
      selectionRevision: 0,
      choices: [],
    },
    current: {
      id: "cccccccc-1111-4111-8111-111111111111",
      ownerId,
      projectId,
      revision: 1,
      projectRevision: 1,
      selectionRevision: 0,
      catalogVersion: INSPIRATION_CATALOG_VERSION,
      guidance: { character: privateGuidance, colors: "", typography: "", graphics: "" },
      references: [],
      reviewedAt: "2026-10-15T10:00:00Z",
    },
    history: [],
    hasEarlierHistory: false,
    stale: false,
  });
  const logo = `/api/projects/${projectId}/logo`;
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (url.hostname !== "127.0.0.1") {
      state.blockedExternal.push(request.url());
      return route.abort("blockedbyclient");
    }
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
      return route.fulfill(
        state.failedProject
          ? { status: 503, json: { error: "Synthetic project read unavailable" } }
          : { json: { project } },
      );
    }
    const body =
      path === "/api/account/profile"
        ? {
            profile: {
              ownerId,
              email: "workspace-fixture@example.invalid",
              revision: 0,
              updatedAt: null,
              values: { fullName: "Synthetic account", timeZone: "America/Toronto", dateFormat: "friendly" },
            },
          }
        : path === "/api/projects/page"
          ? { ownerId, items: [], nextCursor: null }
          : path === "/api/home/attachments/capability"
            ? { ownerId, policy: null, reason: "Synthetic file storage is unavailable." }
            : path === "/api/strategy"
              ? { availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } }
              : path === logo
                ? workspace
                : path === `${logo}/references` || path === `${logo}/inputs/requests`
                  ? { ownerId, projectId, items: [], nextCursor: null }
                  : path === `${logo}/fonts` || path === `${logo}/fonts/catalog`
                    ? []
                    : path === `/api/projects/${projectId}/visual-direction`
                      ? direction
                      : null;
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
  const { shell } = await expectProjectCanvas(page);
  return [{ selector: ".project-workspace", ...shell }];
}

function expectSameFrame(before: Awaited<ReturnType<typeof frame>>, after: Awaited<ReturnType<typeof frame>>) {
  expect(after.map((row) => row.selector)).toEqual(before.map((row) => row.selector));
  for (let index = 0; index < before.length; index++)
    for (const coordinate of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(before[index]![coordinate] - after[index]![coordinate]),
        `${before[index]!.selector} ${coordinate}`,
      ).toBeLessThanOrEqual(1);
    }
}

async function expectNoProjectBars(page: Page) {
  await expectProjectCanvas(page);
  await expect(page.getByText("Unsaved project edits", { exact: true })).toHaveCount(0);
}

// The page-level account notice; the account menu repeats the same text in its own identity row.
const accountNotice = (page: Page) => page.getByRole("main").locator(":is(.e-message, .e-empty)");
// The saved logo and its directions render only for the verified owner.
const ownedDirections = (page: Page) => page.getByRole("region", { name: "Chosen logo", exact: true });

async function expectMasked(page: Page) {
  await expect(page.getByText(privateTitle, { exact: true })).toHaveCount(0);
  await expect(page.locator(".project-output-page")).toHaveCount(0);
  await expect(ownedDirections(page)).toHaveCount(0);
}

test("Home input disclosures preserve prompt and honest availability", async ({ page }, info) => {
  const state = await fixture(page);
  await page.goto("/");
  const prompt = page.getByRole("textbox", { name: "Your prompt", exact: true });
  await expect(prompt).toBeEditable();
  await prompt.fill(promptText);
  const files = page.locator(".home-files-popover"),
    trigger = files.locator(":scope > summary");
  const panel = files.getByRole("region", { name: "Add files or images", exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  await expect(files).toHaveAttribute("open", "");
  await expect(panel.getByRole("status")).toHaveText(
    "File attachments are currently unavailable. You can keep writing your prompt.",
  );
  const send = (await page.locator(".composer-send-icon").boundingBox())!,
    filePanel = (await panel.boundingBox())!;
  expect(filePanel.y).toBeGreaterThanOrEqual(send.y + send.height);
  if (info.project.name === "mobile") {
    // Phones: attach, dictate and send share a row; the scope switch takes the next row.
    const scopeBox = (await page.getByRole("group", { name: "What to create", exact: true }).boundingBox())!;
    expect(scopeBox.y).toBeGreaterThanOrEqual(send.y + send.height);
    expect(filePanel.width).toBeGreaterThan(page.viewportSize()!.width * 0.8);
  }
  const fileInput = panel.locator('input[type="file"]');
  await expect(fileInput).toBeDisabled();
  await expect(fileInput).toHaveAttribute("hidden", "");
  await expect(fileInput).toBeHidden();
  // Availability details open as a dialog from the files panel and return focus to their trigger.
  const availabilityTrigger = panel.getByRole("button", { name: "Availability details", exact: true });
  const availability = page.getByRole("dialog", { name: "Availability details", exact: true });
  await expect(availabilityTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(availability).toHaveCount(0);
  await availabilityTrigger.focus();
  await availabilityTrigger.press("Enter");
  await expect(availability).toBeVisible();
  await expect(availability.getByText("Synthetic file storage is unavailable.", { exact: true })).toBeVisible();
  await availability.getByRole("button", { name: "Close", exact: true }).press("Enter");
  await expect(availability).toHaveCount(0);
  await expect(availabilityTrigger).toBeFocused();
  await expect(files).toHaveAttribute("open", "");
  await trigger.focus();
  await trigger.press("Enter");
  await expect(files).not.toHaveAttribute("open", "");
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await prompt.focus();
  await page.keyboard.press("Escape");
  await expect(files).not.toHaveAttribute("open", "");
  await expect(trigger).toBeFocused();
  await expect(prompt).toHaveValue(promptText);
  await trigger.press("Enter");
  await prompt.click();
  await expect(files).not.toHaveAttribute("open", "");
  await expect(prompt).toBeFocused();

  // Scope is one radio group: arrow keys move the choice, and only the three
  // supported project scopes are offered.
  const scope = page.getByRole("group", { name: "What to create", exact: true }),
    options = scope.getByRole("radio");
  await expect(options).toHaveCount(3);
  expect(await scope.locator("label").allTextContents()).toEqual(["Complete brand", "Name only", "Visual identity"]);
  await expect(options.nth(0)).toBeChecked();
  await options.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(options.nth(1)).toBeChecked();
  await expect(options.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(options.nth(0)).toBeChecked();
  const voice = page.locator(".home-voice-popover"),
    voiceTrigger = voice.locator(":scope > summary");
  await voiceTrigger.focus();
  await voiceTrigger.press("Enter");
  await expect(voice.getByRole("button", { name: "Start voice input", exact: true })).toBeDisabled();
  await prompt.focus();
  await page.keyboard.press("Escape");
  await expect(voice).not.toHaveAttribute("open", "");
  await expect(voiceTrigger).toBeFocused();
  await expect(prompt).toHaveValue(promptText);
  expect(state.writes).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __workspaceStateFixture: { submits: number; voiceStarts: number } })
          .__workspaceStateFixture,
    ),
  ).toEqual({ submits: 0, voiceStarts: 0 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await trigger.click();
  await availabilityTrigger.click();
  await captureState(page, info, "files-availability");
});

test("project frame stays stable through verification and account loss", async ({ page }, info) => {
  const state = await fixture(page, true);
  try {
    await page.goto(projectRoute);
    await expect.poll(() => state.requests.some((row) => row.path === "/api/session")).toBe(true);
    await expect(accountNotice(page)).toHaveText("Checking your account…");
    await expectNoProjectBars(page);
    await expectMasked(page);
    expect(state.requests.some((row) => row.path === `/api/projects/${projectId}`)).toBe(false);
    const accountChecking = await frame(page);
    await captureState(page, info, "account-checking");
    state.sessionGate!.release();
    state.sessionGate = null;
    await expect.poll(() => state.requests.some((row) => row.path === `/api/projects/${projectId}`)).toBe(true);
    await expectNoProjectBars(page);
    const projectChecking = await frame(page);
    expectSameFrame(accountChecking, projectChecking);
    state.projectGate!.release();
    state.projectGate = null;
    await expect(ownedDirections(page)).toBeVisible();
    const verified = await frame(page);
    expectSameFrame(accountChecking, verified);
    await info.attach("project-frame-geometry", {
      body: Buffer.from(
        JSON.stringify({ viewport: page.viewportSize(), accountChecking, projectChecking, verified }, null, 2),
      ),
      contentType: "application/json",
    });
    await captureState(page, info, "verified");
    // Existing production visibilitychange handling rechecks only the synthetic GET session.
    state.session = "signed_out";
    state.sessionGate = deferred();
    const previousReads = state.requests.filter((row) => row.path === "/api/session").length;
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect
      .poll(() => state.requests.filter((row) => row.path === "/api/session").length)
      .toBeGreaterThan(previousReads);
    // A routine tab-return check keeps the verified workspace in place until the session answers (11eae67).
    await expect(accountNotice(page)).toHaveCount(0);
    await expect(ownedDirections(page)).toBeVisible();
    expectSameFrame(verified, await frame(page));
    state.sessionGate.release();
    state.sessionGate = null;
    await expect(
      accountNotice(page).getByText("No verified account session. Sign in to view your account projects.", {
        exact: true,
      }),
    ).toBeVisible();
    await expectNoProjectBars(page);
    await expectMasked(page);
    expectSameFrame(verified, await frame(page));
    await captureState(page, info, "account-masked");
    expect(state.writes).toEqual([]);
  } finally {
    state.sessionGate?.release();
    state.projectGate?.release();
  }
});

test("Home disclosure dismissal preserves prompt with temporary reduced motion", async ({ page }) => {
  await fixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await page.goto("/");
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    const prompt = page.getByRole("textbox", { name: "Your prompt", exact: true });
    await prompt.fill(promptText);
    const files = page.locator(".home-files-popover"),
      trigger = files.locator(":scope > summary");
    await trigger.focus();
    await trigger.press("Enter");
    await expect(files).toHaveAttribute("open", "");
    await prompt.focus();
    await page.keyboard.press("Escape");
    await expect(files).not.toHaveAttribute("open", "");
    await expect(trigger).toBeFocused();
    await expect(prompt).toHaveValue(promptText);
  } finally {
    await page.emulateMedia({ reducedMotion: null });
  }
});

test("failed project read keeps actionable recovery without project bars", async ({ page }, info) => {
  const state = await fixture(page, true, true);
  try {
    await page.goto(projectRoute);
    state.sessionGate!.release();
    state.sessionGate = null;
    const checking = await frame(page);
    state.projectGate!.release();
    state.projectGate = null;
    const notice = page
      .getByRole("alert")
      .filter({ hasText: "The saved project could not be verified. Your existing work is kept." });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("button", { name: "Check saved project", exact: true })).toBeEnabled();
    await expectNoProjectBars(page);
    const failed = await frame(page);
    // The explicit read-error notice occupies real content space; the shell keeps its bounds.
    expectSameFrame(checking.slice(0, 3), failed.slice(0, 3));
    const retry = notice.getByRole("button", { name: "Check saved project", exact: true });
    await retry.focus();
    await expect(retry).toBeFocused();
    expect(state.writes).toEqual([]);
    await captureState(page, info, "project-read-failed");
  } finally {
    state.sessionGate?.release();
    state.projectGate?.release();
  }
});

test("retained project read failure keeps its actionable notice without adding project bars", async ({
  page,
}, info) => {
  const state = await fixture(page);
  await page.goto(projectRoute);
  await expect(ownedDirections(page)).toBeVisible();
  await expectProjectCanvas(page);
  state.failedProject = true;
  const reviewLogo = ownedDirections(page).getByRole("link", { name: "Change logo", exact: true });
  await reviewLogo.focus();
  await reviewLogo.press("Enter");
  await expect(page).toHaveURL(`/brands/account/${projectId}/logo`);
  const notice = page
    .getByRole("alert")
    .filter({ hasText: "The saved project could not be verified. Your existing work is kept." });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("button", { name: "Check saved project", exact: true })).toBeEnabled();
  await expectProjectCanvas(page);
  expect(state.writes).toEqual([]);
  await captureState(page, info, "retained-project-read-error");
});

for (const suffix of [
  "",
  "/naming",
  "/inspiration",
  "/logo",
  "/brand-board",
  "/logo/directions",
  "/identity",
  "/logo/deliverables",
]) {
  test(`removed project bars reserve no space on ${suffix || "Strategy"} during account verification`, async ({
    page,
  }, info) => {
    const state = await fixture(page, true);
    try {
      await page.goto(`/brands/account/${projectId}${suffix}`);
      await expect(accountNotice(page)).toHaveText("Checking your account…");
      await expectProjectCanvas(page);
      await expectMasked(page);
      expect(state.requests.some((row) => row.path === `/api/projects/${projectId}`)).toBe(false);
      if (suffix === "/logo" || suffix === "/naming") await captureState(page, info, "bars-absent-account-checking");
    } finally {
      state.sessionGate?.release();
      state.projectGate?.release();
    }
  });
}
