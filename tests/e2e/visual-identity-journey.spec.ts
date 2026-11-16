import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Download, type Page } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import sharp from "sharp";
import {
  createVisualJourneyFixture,
  assetsUrl,
  conceptsUrl,
  directionsUrl,
  ownerId,
  projectId,
} from "../fixtures/visual-identity-journey";
import { checkNormalAccount } from "./account-check";
import { captureUiEvidence } from "./ui-evidence";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function downloadedBytes(download: Download): Promise<Buffer> {
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path!);
}
/** The Brand guidelines preview is a frame that never runs scripts. Playwright's own page instrumentation is
 * refused there too, and the browser reports each refusal as a console error; nothing of the app's is involved. */
const appConsoleErrors = (health: { consoleErrors: string[] }) =>
  health.consoleErrors.filter((text) => !text.startsWith("Blocked script execution in 'about:srcdoc'"));
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
// Logo and Creative direction are steps of the brand conversation: the work area shows the step, the chat tells
// what is happening and Send in the reply box moves on.
const directionsInConversation = `/brands/account/${projectId}?view=strategy#journey-directions`;
const step = (page: Page) => page.getByRole("region", { name: "Creative direction", exact: true });
const replyBox = (page: Page) => page.getByRole("form", { name: "Reply", exact: true });
/** A finished Identity step, folded into the chat as one answer that opens to offer "Change …". */
const identityAnswer = (page: Page, question: string) =>
  page
    .locator('[data-journey-section="identity"] details')
    .filter({ has: page.locator(".e-answer__question", { hasText: new RegExp(`^${question}$`, "u") }) });
const direction = (page: Page, number: number) =>
  step(page).getByRole("article", { name: new RegExp(`^Direction ${number}: `, "u") });
const boards = (page: Page) => step(page).getByRole("img", { name: "Saved Identity board for Cedar", exact: true });
const choose = (page: Page, number: number) =>
  direction(page, number).getByRole("button", { name: /^(Choose|Chosen)$/u });
async function loadBoards(page: Page, count: number) {
  for (let number = 1; number <= count; number++) {
    await direction(page, number).scrollIntoViewIfNeeded();
    await expect(
      direction(page, number).getByRole("img", { name: "Saved Identity board for Cedar", exact: true }),
    ).toBeVisible();
  }
}
/** Opens Creative direction and starts the one round with a deliberate click. */
async function startDirections(page: Page, f: ReturnType<typeof createVisualJourneyFixture>) {
  await page.goto(directionsUrl);
  await expect(page).toHaveURL(directionsInConversation);
  await step(page).getByRole("button", { name: "Create three directions", exact: true }).click();
  await expect.poll(() => f.admissions.length).toBe(1);
}

test("a complete brand without saved Logo stages keeps the Strategy entry", async ({ page }) => {
  const f = createVisualJourneyFixture({ standalone: true }),
    health = await f.setup(page);
  f.project.scope = "complete_brand";
  for (const stage of Object.keys(f.workspace.stages) as Array<keyof typeof f.workspace.stages>) {
    f.workspace.stages[stage] = null;
    f.workspace.heads.stageRevisions[stage] = 0;
  }
  await page.goto(`/brands/account/${projectId}`);
  await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/brands/account/${projectId}?view=strategy#journey-strategy`);
  expect(f.mutations).toHaveLength(0);
  expect(health.pageErrors).toEqual([]);
});

test("the old board address opens Creative direction in the conversation without starting generation", async ({
  page,
}) => {
  const f = createVisualJourneyFixture({ voiceFinished: true }),
    health = await f.setup(page);
  await page.goto(`/brands/account/${projectId}/brand-board`);
  await expect(page).toHaveURL(directionsInConversation);
  await expect(step(page).getByRole("heading", { name: "Creative direction", exact: true })).toBeAttached();
  await expect(step(page).getByRole("button", { name: "Create three directions", exact: true })).toBeEnabled();
  // The chosen logo is the folded Logo answer in the chat, with its picture.
  await expect(
    identityAnswer(page, "Logo").getByRole("img", { name: "Chosen logo concept", exact: true }),
  ).toBeVisible();
  await expect(replyBox(page).getByRole("button", { name: "Continue to Assets", exact: true })).toBeDisabled();
  expect(f.admissions).toHaveLength(0);
  expect(f.mutations).toHaveLength(0);
  await fits(page);
  expect(health.pageErrors).toEqual([]);
});

test("chosen concept leads to three directions, a saved choice and usable brand assets without vector approval", async ({
  page,
}, info) => {
  test.skip(info.project.name === "mobile", "phone layout is on hold");
  test.setTimeout(90_000);
  const f = createVisualJourneyFixture({ voiceFinished: true }),
    health = await f.setup(page);
  // The Logo step, reopened from its folded answer, with a concept already chosen and no vector approved.
  await page.goto(`/brands/account/${projectId}?view=strategy`);
  await identityAnswer(page, "Logo").locator("summary").click();
  await identityAnswer(page, "Logo").getByRole("button", { name: "Change logo", exact: true }).click();
  expect(f.workspace.approvedLogo).toBeNull();
  expect(f.workspace.stages.vector).toBeNull();
  const originalDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PNG", exact: true }).click();
  const original = await originalDownload;
  expect(original.suggestedFilename()).toBe("cedar-logo.png");
  expect(digest(await downloadedBytes(original))).toBe(digest(f.logoBytes));
  // Send on the chosen logo is the deliberate click: the three directions start on their own, with no estimate
  // and no confirmation.
  await replyBox(page).getByRole("button", { name: "Continue to Creative direction", exact: true }).click();
  await expect(step(page)).toBeVisible();
  await expect.poll(() => f.admissions.length).toBe(1);
  await expect(page.getByText(/Estimated/u)).toHaveCount(0);
  expect(f.admissions[0]).toMatchObject({
    version: 3,
    spendControl: "uncapped",
    sourceLogo: f.sourceLogo.source,
    expectedLogoRevision: f.sourceLogo.selectionRevision,
  });
  expect(f.admissions[0]).not.toHaveProperty("acceptedMaxCostMicrousd");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(step(page).getByText("0 of 3 ready", { exact: true })).toBeVisible();
  f.complete();
  await expect(boards(page)).toHaveCount(3, { timeout: 15_000 });
  await loadBoards(page, 3);
  await expect(step(page).getByRole("button", { name: "Check progress", exact: true })).toHaveCount(0);
  for (const [index, system] of f.systems.entries()) {
    const card = direction(page, index + 1);
    const palette = card.getByRole("list", { name: "Color palette" });
    for (const color of system.components.colors.swatches) {
      await expect(palette.getByTitle(`${color.name} ${color.hex}`, { exact: true })).toBeVisible();
    }
    // The type sample shows the heading face; its name is there for screen readers.
    const heading = system.components.typography.styles.find(
      (style) => style.key === system.applicationDesign.headingStyleKey,
    )!;
    await expect(card.getByText(heading.family, { exact: true })).toBeAttached();
  }
  const toAssets = replyBox(page).getByRole("button", { name: "Continue to Assets", exact: true });
  await expect(toAssets).toBeDisabled();
  await fits(page);
  await page.screenshot({ path: info.outputPath("directions.png"), fullPage: true, scale: "css" });
  await choose(page, 2).click();
  await expect.poll(() => f.selections.length).toBe(1);
  await expect(choose(page, 2)).toHaveAttribute("aria-pressed", "true");
  await expect(step(page).getByRole("button", { name: "Chosen", exact: true })).toHaveCount(1);
  await expect(replyBox(page).getByText(/^Direction: /u)).toBeVisible();
  await expect(toAssets).toBeEnabled();
  const selectedId = f.selection!.systemVersionId;
  expect(selectedId).toBe(f.systems[1]!.id);
  // The saved choice survives a reload and starts nothing: a finished brand opens on its chosen direction.
  await page.reload();
  const brand = page.getByRole("region", { name: "Your brand", exact: true });
  await expect(brand.getByRole("article", { name: /^Chosen direction: /u })).toBeVisible();
  await expect(brand.getByRole("img", { name: "Saved Identity board for Cedar", exact: true })).toBeVisible();
  await expect(step(page)).toHaveCount(0);
  expect(f.selection!.systemVersionId).toBe(selectedId);
  expect(f.admissions).toHaveLength(1);
  await expect(toAssets).toBeEnabled();
  await toAssets.click();
  await expect(page).toHaveURL(assetsUrl);
  const kit = page.getByRole("button", { name: "Download brand kit", exact: true });
  await expect(kit).toBeEnabled();
  await expect(page.getByRole("button", { name: "Create brand assets", exact: true })).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Cedar final brand board", exact: true })).toBeVisible({
    timeout: 45_000,
  });
  await fits(page);
  const boardDownloadPromise = page.waitForEvent("download");
  await page
    .getByRole("region", { name: "Brand assets", exact: true })
    .getByRole("button", { name: "Download PNG: brand board", exact: true })
    .click();
  const boardDownload = await boardDownloadPromise;
  await boardDownload.saveAs(info.outputPath("brand-board.png"));
  expect(boardDownload.suggestedFilename()).toBe("brand-board.png");
  expect(await sharp(await downloadedBytes(boardDownload)).metadata()).toMatchObject({
    format: "png",
    width: 1600,
    height: 2200,
  });
  const downloadPromise = page.waitForEvent("download");
  await kit.click();
  const download = await downloadPromise;
  await download.saveAs(info.outputPath("brand-assets.zip"));
  expect(download.suggestedFilename()).toBe("cedar-brand-assets.zip");
  const files = unzipSync(await downloadedBytes(download));
  expect(Object.keys(files)).toEqual(
    expect.arrayContaining([
      "brand-board.png",
      "logo/logo-original.png",
      "direction/selected-direction.png",
      "social/profile.png",
      "social/post-square.png",
      "social/post-square.svg",
      "social/post-portrait.png",
      "social/post-portrait.svg",
      "social/banner-wide.png",
      "social/banner-wide.svg",
      "social/banner-cover.png",
      "social/banner-cover.svg",
      "guides/colors.json",
      "guides/colors.css",
      "guides/brand-guide.html",
      "README.txt",
    ]),
  );
  expect(files).not.toHaveProperty("logo/logo-vector.svg");
  expect(digest(files["logo/logo-original.png"]!)).toBe(digest(f.logoBytes));
  expect(digest(files["direction/selected-direction.png"]!)).toBe(f.systems[1]!.board.asset.contentHash);
  for (const [name, width, height] of [
    ["brand-board.png", 1600, 2200],
    ["social/profile.png", 1024, 1024],
    ["social/post-square.png", 1080, 1080],
    ["social/post-portrait.png", 1080, 1350],
    ["social/banner-wide.png", 1500, 500],
    ["social/banner-cover.png", 1584, 396],
  ] as const)
    expect(await sharp(files[name]).metadata()).toMatchObject({ format: "png", width, height });
  expect(strFromU8(files["guides/colors.css"]!).toUpperCase()).toContain("#872A43");
  const guide = strFromU8(files["guides/brand-guide.html"]!);
  expect(guide).toContain("Fraunces");
  expect(guide).toContain("Manrope");
  expect(guide).toContain("https://");
  const template = strFromU8(files["social/post-square.svg"]!);
  expect(template).toContain("<text");
  expect(template).toContain("data:image/png;base64,");
  // A fresh visit prepares the same saved files. Hold the source read to ensure
  // the single download click works even before preparation has finished.
  let releaseLogo!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseLogo = resolve;
  });
  const logoPath = `/api/assets/${f.sourceLogo.preview.reference.versionId}/preview`;
  const sourceRead = page.waitForRequest((request) => new URL(request.url()).pathname === logoPath);
  await page.route(`**${logoPath}`, async (route) => {
    await held;
    await route.fallback();
  });
  let reopened: Download;
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await sourceRead;
    await expect(page.getByRole("img", { name: "Cedar final brand board", exact: true })).toHaveCount(0);
    // While the kit is still being prepared its button reads "Preparing brand kit"; a click queues the download.
    const preparing = page.getByRole("button", { name: "Preparing brand kit", exact: true });
    await expect(preparing).toBeEnabled();
    const second = page.waitForEvent("download", { timeout: 45_000 });
    await preparing.click();
    releaseLogo();
    reopened = await second;
  } finally {
    releaseLogo();
  }
  const reopenedFiles = unzipSync(await downloadedBytes(reopened));
  expect(reopened.suggestedFilename()).toBe(download.suggestedFilename());
  const hashes = (contents: Record<string, Uint8Array>) =>
    Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, digest(bytes)]));
  expect(hashes(reopenedFiles)).toEqual(hashes(files));
  expect(f.selection!.systemVersionId).toBe(selectedId);
  expect(f.admissions).toHaveLength(1);
  expect(f.selections).toHaveLength(1);
  expect(f.mutations.every((path) => path.endsWith("/identity/batches") || path.endsWith("/identity/selection"))).toBe(
    true,
  );
  expect(health.pageErrors).toEqual([]);
  expect(appConsoleErrors(health)).toEqual([]);
});

test("Send on a Logo step opened from the old Logo address continues to Creative direction", async ({ page }) => {
  const f = createVisualJourneyFixture({ voiceFinished: true });
  await f.setup(page);
  await page.goto(conceptsUrl);
  await expect(page).toHaveURL(`/brands/account/${projectId}?view=strategy#journey-logo`);
  await expect(page.getByRole("region", { name: "Logo concepts", exact: true })).toBeVisible();
  await replyBox(page).getByRole("button", { name: "Continue to Creative direction", exact: true }).click();
  await expect(step(page)).toBeVisible();
  await expect.poll(() => f.admissions.length).toBe(1);
});

test("lost generation acknowledgement checks the original request and keeps a partial board usable", async ({
  page,
}, info) => {
  test.skip(info.project.name === "mobile", "phone layout is on hold");
  const f = createVisualJourneyFixture({ voiceFinished: true });
  f.loseAdmission = true;
  const health = await f.setup(page);
  await startDirections(page, f);
  await expect(
    page.getByText("The generation request could not be confirmed. Check the original request before trying again.", {
      exact: true,
    }),
  ).toBeVisible();
  // Nothing else can be started while the first request is unconfirmed.
  await expect(step(page).getByRole("button", { name: "More directions", exact: true })).toBeDisabled();
  const original = structuredClone(f.admissions[0]);
  const check = step(page).getByRole("button", { name: "Check progress", exact: true });
  await expect(check).toBeEnabled();
  await check.click();
  await expect(page.getByText(/could not be confirmed/u)).toHaveCount(0);
  await expect(step(page).getByText("0 of 3 ready", { exact: true })).toBeVisible();
  await page.reload();
  await expect(step(page).getByText("0 of 3 ready", { exact: true })).toBeVisible();
  expect(f.admissions).toEqual([original]);
  f.complete(1, "partial");
  await expect(step(page).getByText("1 of 3 ready", { exact: true })).toBeVisible({ timeout: 15_000 });
  await loadBoards(page, 1);
  await expect(boards(page)).toHaveCount(1);
  await expect(step(page).getByText("No board for this direction.", { exact: true })).toHaveCount(2);
  await choose(page, 1).click();
  await expect(choose(page, 1)).toHaveAttribute("aria-pressed", "true");
  await expect(replyBox(page).getByRole("button", { name: "Continue to Assets", exact: true })).toBeEnabled();
  expect(f.admissions).toEqual([original]);
  expect(f.selection!.systemVersionId).toBe(f.systems[0]!.id);
  await fits(page);
  expect(health.pageErrors).toEqual([]);
});

test("saved boards explain unavailable selection and recover without another generation", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "phone layout is on hold");
  const f = createVisualJourneyFixture({ voiceFinished: true }),
    health = await f.setup(page);
  f.savingAvailable = false;
  await startDirections(page, f);
  f.complete();
  await expect(boards(page)).toHaveCount(3, { timeout: 15_000 });
  await loadBoards(page, 3);
  await expect(
    step(page).getByText("Saving your direction is temporarily unavailable. Your boards are saved.", { exact: true }),
  ).toHaveCount(3);
  for (const number of [1, 2, 3]) await expect(choose(page, number)).toBeDisabled();
  expect(f.selections).toHaveLength(0);
  expect(f.admissions).toHaveLength(1);
  f.savingAvailable = true;
  await step(page).getByRole("button", { name: "Check saved choice", exact: true }).click();
  await expect(choose(page, 2)).toBeEnabled();
  expect(f.selections).toHaveLength(0);
  expect(f.admissions).toHaveLength(1);
  await choose(page, 2).click();
  await expect(replyBox(page).getByRole("button", { name: "Continue to Assets", exact: true })).toBeEnabled();
  expect(f.selections).toHaveLength(1);
  expect(f.admissions).toHaveLength(1);
  await fits(page);
  expect(health.pageErrors).toEqual([]);
});

test("a changed logo prevents old directions and prepared files from being presented as current", async ({
  page,
}, info) => {
  test.skip(info.project.name === "mobile", "phone layout is on hold");
  test.setTimeout(90_000);
  const f = createVisualJourneyFixture({ voiceFinished: true });
  await f.setup(page);
  await startDirections(page, f);
  f.complete();
  await expect(boards(page)).toHaveCount(3, { timeout: 15_000 });
  await choose(page, 1).click();
  const toAssets = replyBox(page).getByRole("button", { name: "Continue to Assets", exact: true });
  await expect(toAssets).toBeEnabled();
  await toAssets.click();
  const kit = page.getByRole("button", { name: "Download brand kit", exact: true });
  await expect(kit).toBeEnabled();
  await expect(page.getByRole("img", { name: "Cedar final brand board", exact: true })).toBeVisible({
    timeout: 45_000,
  });
  const downloads: Download[] = [];
  page.on("download", (value) => downloads.push(value));
  f.sourceCurrent = false;
  await kit.click();
  await expect(page.getByRole("region", { name: "Brand assets", exact: true }).getByRole("alert")).toContainText(
    /changed|current|saved direction/u,
  );
  expect(downloads).toHaveLength(0);
  await page.goto(directionsUrl);
  await expect(step(page).getByText("Made for an earlier logo.", { exact: true })).toHaveCount(3);
  for (const number of [1, 2, 3]) {
    await expect(choose(page, number)).toBeDisabled();
    await expect(choose(page, number)).toHaveAttribute("aria-pressed", "false");
  }
  await expect(replyBox(page).getByRole("button", { name: "Continue to Assets", exact: true })).toBeDisabled();
  expect(f.admissions).toHaveLength(1);
  await fits(page);
});

test("account changes clear the former account's private boards", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "phone layout is on hold");
  const f = createVisualJourneyFixture({ voiceFinished: true }),
    health = await f.setup(page);
  await startDirections(page, f);
  f.complete();
  await expect(boards(page)).toHaveCount(3, { timeout: 15_000 });
  await loadBoards(page, 3);
  f.owner = ownerId.replace(/001$/u, "999");
  await checkNormalAccount(page);
  await expect(page.getByRole("img", { name: "Saved Identity board for Cedar", exact: true })).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Chosen logo concept", exact: true })).toHaveCount(0);
  expect(f.admissions).toHaveLength(1);
  expect(f.selections).toHaveLength(0);
  expect(health.pageErrors).toEqual([]);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));
