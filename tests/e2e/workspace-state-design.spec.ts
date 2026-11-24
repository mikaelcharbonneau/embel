import { expectProjectCanvas } from "./project-canvas-contract";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { accountProjectSchema } from "../../src/domain/project-api";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { syntheticLogoWorkspace } from "../fixtures/logo-creation";
import { captureUiEvidence } from "./ui-evidence";

const ownerId = "aaaaaaaa-1111-4111-8111-111111111111";
const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
const privateTitle = "Synthetic private account project with a long retained title";
const brandName = "Kitchen";
const projectRoute = `/brands/account/${projectId}`;
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
    scope: "complete_brand",
    current_revision: 1,
    created_at: "2026-10-15T10:00:00Z",
    context: { description: "Synthetic saved project context", selectedName: brandName },
  });
  const workspace = logoWorkspaceV2Schema.parse({ ...syntheticLogoWorkspace(), ownerId, projectId });
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
                  : path === `/api/projects/${projectId}/strategy`
                    ? {
                        availability: { status: "unavailable", operations: [], reason: "worker_unavailable" },
                        jobs: [],
                      }
                    : path === `/api/projects/${projectId}/generations`
                      ? { runs: [] }
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

// The saved brand's conversation renders only for the verified owner.
const conversation = (page: Page) => page.getByRole("region", { name: "Brand conversation", exact: true });
// The neutral frame a brand page shows while the account or the project is read.
const opening = (page: Page) => page.getByRole("main").getByRole("status", { name: "Opening your brand", exact: true });

/** Nothing of the saved brand is on the page: not its name, its title or its conversation. */
async function expectMasked(page: Page) {
  await expect(page.getByText(privateTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("banner")).not.toContainText(brandName);
  await expect(page.getByRole("main")).not.toContainText(brandName);
  await expect(conversation(page)).toHaveCount(0);
}

test("Home attach and dictate buttons preserve the prompt and say honestly when files can't be added", async ({
  page,
}, info) => {
  const state = await fixture(page);
  await page.goto("/");
  const prompt = page.getByRole("textbox", { name: "Your prompt", exact: true });
  await expect(prompt).toBeEditable();
  await prompt.fill(promptText);
  const composer = page.locator(".home-composer"),
    attach = composer.getByRole("button", { name: "Add files or images", exact: true });
  // The raw file field is never shown; with no storage it is disabled and the button gives the reason,
  // in the service's own words, below the buttons and inside the box.
  const fileInput = composer.locator('input[type="file"]');
  await expect(fileInput).toBeDisabled();
  await expect(fileInput).toBeHidden();
  await attach.focus();
  await attach.press("Enter");
  const note = composer.getByRole("status");
  await expect(note).toHaveText("Synthetic file storage is unavailable.");
  const send = (await page.locator(".composer-send-icon").boundingBox())!,
    noteBox = (await note.boundingBox())!;
  expect(noteBox.y).toBeGreaterThanOrEqual(send.y + send.height);
  await captureState(page, info, "files-availability");
  await expect(attach).toBeFocused();
  await expect(prompt).toHaveValue(promptText);

  // Dictation is one press away; it is not started here (the fixture has no microphone).
  await expect(composer.getByRole("button", { name: "Dictate your prompt", exact: true })).toBeEnabled();
  await prompt.click();
  await expect(prompt).toBeFocused();
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
});

test("a brand page stays neutral until its owner is verified and hides the brand when the account is lost", async ({
  page,
}, info) => {
  const state = await fixture(page, true);
  const projectReads = () => state.requests.filter((row) => row.path === `/api/projects/${projectId}`).length;
  try {
    await page.goto(projectRoute);
    await expect.poll(() => state.requests.some((row) => row.path === "/api/session")).toBe(true);
    // While the account is checked, the page says it is opening; the account button names the check.
    await expect(opening(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Account menu, checking your account", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /sign in/iu })).toHaveCount(0);
    await expectMasked(page);
    expect(projectReads()).toBe(0);
    await captureState(page, info, "account-checking");
    state.sessionGate!.release();
    state.sessionGate = null;
    await expect.poll(projectReads).toBeGreaterThan(0);
    // The same neutral frame while the brand itself is read.
    await expect(opening(page)).toBeVisible();
    await expectMasked(page);
    state.projectGate!.release();
    state.projectGate = null;
    await expect(conversation(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: brandName, exact: true, level: 1 })).toBeVisible();
    await expect(opening(page)).toHaveCount(0);
    await expectProjectCanvas(page);
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
    // A routine tab-return check keeps the verified brand in place until the session answers.
    await expect(conversation(page)).toBeVisible();
    await expect(opening(page)).toHaveCount(0);
    state.sessionGate.release();
    state.sessionGate = null;
    await expect(
      page.getByRole("main").getByRole("heading", { name: "Sign in to open this brand", exact: true }),
    ).toBeVisible();
    await expectMasked(page);
    // The tab no longer names the brand either.
    await expect(page).not.toHaveTitle(new RegExp(brandName, "u"));
    await captureState(page, info, "account-masked");
    expect(state.writes).toEqual([]);
  } finally {
    state.sessionGate?.release();
    state.projectGate?.release();
  }
});

test("the Home attach note keeps the prompt with reduced motion", async ({ page }) => {
  await fixture(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await page.goto("/");
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    const prompt = page.getByRole("textbox", { name: "Your prompt", exact: true });
    await prompt.fill(promptText);
    const attach = page.locator(".home-composer").getByRole("button", { name: "Add files or images", exact: true });
    await attach.focus();
    await attach.press("Enter");
    await expect(page.locator(".home-composer").getByRole("status")).toBeVisible();
    await expect(attach).toBeFocused();
    await expect(prompt).toHaveValue(promptText);
  } finally {
    await page.emulateMedia({ reducedMotion: null });
  }
});

test("a brand whose first read fails offers one way to try again, and opens once the read works", async ({
  page,
}, info) => {
  const state = await fixture(page, true, true);
  try {
    await page.goto(projectRoute);
    state.sessionGate!.release();
    state.sessionGate = null;
    await expect(opening(page)).toBeVisible();
    state.projectGate!.release();
    state.projectGate = null;
    const failure = page.getByRole("main").getByRole("alert");
    await expect(failure.getByRole("heading", { name: "We couldn’t open this brand", exact: true })).toBeVisible();
    // Said once: the page's own error stands in for the notice strip, and the app's navigation is back.
    await expect(page.getByText("We couldn’t check this brand’s latest save. Your work is kept.")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Main navigation", exact: true })).toBeVisible();
    await expect(failure.getByRole("link", { name: "Back to Projects", exact: true })).toHaveAttribute(
      "href",
      "/brands",
    );
    await expectMasked(page);
    const retry = failure.getByRole("button", { name: "Try again", exact: true });
    await expect(retry).toBeEnabled();
    await retry.focus();
    await expect(retry).toBeFocused();
    await captureState(page, info, "project-read-failed");
    state.failedProject = false;
    await retry.press("Enter");
    await expect(conversation(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "We couldn’t open this brand", exact: true })).toHaveCount(0);
    expect(state.writes).toEqual([]);
  } finally {
    state.sessionGate?.release();
    state.projectGate?.release();
  }
});

test("a brand whose re-read fails after coming back offers Try again and returns once the read works", async ({
  page,
}, info) => {
  const state = await fixture(page);
  await page.goto(projectRoute);
  await expect(conversation(page)).toBeVisible();
  // Leaving and coming back inside the app reads the brand again; this time the read fails.
  await page.getByRole("link", { name: "Embel home", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).toBeVisible();
  state.failedProject = true;
  await page.goBack();
  const failure = page.getByRole("main").getByRole("alert");
  await expect(failure.getByRole("heading", { name: "We couldn’t open this brand", exact: true })).toBeVisible();
  // Said once: the page's own error stands in for the notice strip.
  await expect(page.getByText("We couldn’t check this brand’s latest save. Your work is kept.")).toHaveCount(0);
  const retry = failure.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeEnabled();
  await captureState(page, info, "retained-project-read-error");
  state.failedProject = false;
  await retry.click();
  await expect(conversation(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: brandName, exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "We couldn’t open this brand", exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
