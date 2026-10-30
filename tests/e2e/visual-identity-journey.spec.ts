import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Download, type Page } from "@playwright/test";
import { unzipSync, strFromU8 } from "fflate";
import sharp from "sharp";
import { createVisualJourneyFixture, assetsUrl, conceptsUrl, directionsUrl, ownerId, projectId } from "../fixtures/visual-identity-journey";
import { checkNormalAccount } from "./account-check";
import { captureUiEvidence } from "./ui-evidence";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function downloadedBytes(download: Download): Promise<Buffer> {
  expect(await download.failure()).toBeNull();
  const path = await download.path(); expect(path).not.toBeNull();
  return readFile(path!);
}
async function checkProgress(page: Page) {
  const button = page.getByRole("button", { name: "Check progress", exact: true });
  await expect(button).toBeEnabled(); await button.click();
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function loadBoards(page: Page, count: number) {
  const cards = page.locator('[aria-label="Direction comparison"] article');
  for (let index = 0; index < count; index++) {
    await cards.nth(index).scrollIntoViewIfNeeded();
    await expect(cards.nth(index).getByRole("img", { name: "Saved Identity board for Cedar", exact: true })).toBeVisible();
  }
}

test("generic project entry resumes the chosen logo before and after scope expansion without writes", async ({ page }) => {
  const f = createVisualJourneyFixture({ standalone: true }), health = await f.setup(page);
  f.project.scope = "visual_identity_only";
  await page.goto(`/brands/account/${projectId}`);
  await expect(page).toHaveURL(conceptsUrl);
  await expect(page.getByRole("link", { name: "Continue to visual directions →", exact: true })).toBeVisible();
  expect(f.mutations).toHaveLength(0);
  // Expansion retains the same context and selected Logo stages. Entry must
  // still resume them even though scope alone now describes a complete brand.
  f.project.scope = "complete_brand"; f.project.current_revision += 1; f.workspace.heads.projectRevision = f.project.current_revision;
  await page.goto(`/brands/account/${projectId}`);
  await expect(page).toHaveURL(conceptsUrl);
  await expect(page.getByRole("link", { name: "Continue to visual directions →", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review Strategy", exact: true })).toHaveAttribute("href", `/brands/account/${projectId}?view=strategy`);
  expect(f.mutations).toHaveLength(0); expect(f.workspace.stages.vector).toBeNull(); expect(f.workspace.approvedLogo).toBeNull();
  await fits(page); expect(health.pageErrors).toEqual([]);
});

test("a project with saved Logo work still allows deliberate Strategy review and return", async ({ page }) => {
  const f = createVisualJourneyFixture({ standalone: true }), health = await f.setup(page);
  f.project.scope = "complete_brand";
  await page.goto(`/brands/account/${projectId}`); await expect(page).toHaveURL(conceptsUrl);
  await page.getByRole("link", { name: "Review Strategy", exact: true }).click();
  await expect(page).toHaveURL(`/brands/account/${projectId}?view=strategy`);
  await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Return to saved work", exact: true }).click();
  await expect(page).toHaveURL(conceptsUrl);
  expect(f.mutations).toHaveLength(0); expect(health.pageErrors).toEqual([]);
});

test("visual-only Logo work keeps explicit project editing and expansion accessible", async ({ page }) => {
  const f = createVisualJourneyFixture({ standalone: true }), health = await f.setup(page);
  f.project.scope = "visual_identity_only";
  await page.goto(`/brands/account/${projectId}`); await expect(page).toHaveURL(conceptsUrl);
  await page.getByRole("link", { name: "Project details", exact: true }).click();
  await expect(page).toHaveURL(`/brands/account/${projectId}?view=strategy`);
  await expect(page.getByRole("button", { name: "Expand to complete brand", exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Return to saved work", exact: true }).click();
  await expect(page).toHaveURL(conceptsUrl);
  expect(f.project.scope).toBe("visual_identity_only"); expect(f.mutations).toHaveLength(0); expect(health.pageErrors).toEqual([]);
});

test("a complete brand without saved Logo stages keeps the Strategy entry", async ({ page }) => {
  const f = createVisualJourneyFixture({ standalone: true }), health = await f.setup(page);
  f.project.scope = "complete_brand";
  for (const stage of Object.keys(f.workspace.stages) as Array<keyof typeof f.workspace.stages>) {
    f.workspace.stages[stage] = null; f.workspace.heads.stageRevisions[stage] = 0;
  }
  await page.goto(`/brands/account/${projectId}`);
  await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/brands/account/${projectId}`);
  expect(f.mutations).toHaveLength(0); expect(health.pageErrors).toEqual([]);
});

test("standalone logo brief opens the new direction flow through the old board URL without starting generation", async ({ page }) => {
  const f = createVisualJourneyFixture({ standalone: true }), health = await f.setup(page);
  expect(f.input.context.description).toBe(""); expect(f.input.context.intake.suppliedName).toBe("");
  expect(f.input.version).toBe(2); expect(f.input.basis.name).toBe("Cedar");
  await page.goto(`/brands/account/${projectId}/brand-board`);
  await expect(page).toHaveURL(directionsUrl);
  await expect(page.getByRole("heading", { name: "Visual direction", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate three directions", exact: true })).toBeEnabled();
  await expect(page.getByRole("img", { name: "Chosen logo concept", exact: true })).toBeVisible();
  expect(f.admissions).toHaveLength(0); expect(f.mutations).toHaveLength(0);
  await fits(page); expect(health.pageErrors).toEqual([]);
});

test("chosen concept leads to three directions, a saved choice and usable brand assets without vector approval", async ({ page }, info) => {
  test.setTimeout(90_000);
  const f = createVisualJourneyFixture(), health = await f.setup(page);
  await page.goto(conceptsUrl);
  const next = page.getByRole("link", { name: "Continue to visual directions →", exact: true });
  await expect(next).toBeVisible(); await expect(next).toHaveAttribute("href", directionsUrl);
  expect(f.workspace.approvedLogo).toBeNull(); expect(f.workspace.stages.vector).toBeNull();
  const originalDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PNG", exact: true }).click();
  const original = await originalDownload;
  expect(original.suggestedFilename()).toBe("cedar-logo.png"); expect(digest(await downloadedBytes(original))).toBe(digest(f.logoBytes));
  await next.click(); await expect(page).toHaveURL(directionsUrl);
  await expect(page.getByRole("img", { name: "Chosen logo concept", exact: true })).toBeVisible();
  const generate = page.getByRole("button", { name: "Generate three directions", exact: true });
  await expect(generate).toBeEnabled(); await expect(page.getByText(/Estimated .*for three directions/u)).toBeVisible();
  expect(f.admissions).toHaveLength(0);
  await generate.click(); await expect.poll(() => f.admissions.length).toBe(1);
  expect(f.admissions[0]).toMatchObject({ version: 3, spendControl: "uncapped", sourceLogo: f.sourceLogo.source, expectedLogoRevision: f.sourceLogo.selectionRevision });
  expect(f.admissions[0]).not.toHaveProperty("acceptedMaxCostMicrousd");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  f.complete(); await checkProgress(page);
  await expect(page.getByText("3 of 3 ready", { exact: true })).toBeVisible();
  await loadBoards(page, 3);
  await expect(page.getByRole("img", { name: "Saved Identity board for Cedar", exact: true })).toHaveCount(3);
  await fits(page);
  await page.getByRole("heading", { name: "Visual direction", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("directions.png"), fullPage: true, scale: "css" });
  await page.getByRole("button", { name: "Choose direction", exact: true }).nth(1).click();
  await expect.poll(() => f.selections.length).toBe(1);
  await expect(page.getByRole("button", { name: "Chosen direction", exact: true })).toHaveCount(1);
  const selectedId = f.selection!.systemVersionId;
  await page.reload(); await expect(page.getByRole("button", { name: "Chosen direction", exact: true })).toHaveCount(1);
  expect(f.selection!.systemVersionId).toBe(selectedId); expect(f.admissions).toHaveLength(1);
  await page.getByRole("link", { name: "Continue to brand assets", exact: true }).click();
  await expect(page).toHaveURL(assetsUrl);
  await page.getByRole("button", { name: "Create brand assets", exact: true }).click();
  await expect(page.getByText("Your brand assets are ready.", { exact: true })).toBeVisible({ timeout: 45_000 });
  await fits(page);
  const boardDownloadPromise = page.waitForEvent("download");
  await page.getByRole("region", { name: "Brand assets", exact: true }).getByRole("button", { name: "Download PNG", exact: true }).first().click();
  const boardDownload = await boardDownloadPromise;
  await boardDownload.saveAs(info.outputPath("brand-board.png"));
  expect(boardDownload.suggestedFilename()).toBe("brand-board.png");
  expect(await sharp(await downloadedBytes(boardDownload)).metadata()).toMatchObject({ format: "png", width: 1600, height: 2200 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download everything", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(info.outputPath("brand-assets.zip"));
  expect(download.suggestedFilename()).toBe("cedar-brand-assets.zip");
  const files = unzipSync(await downloadedBytes(download));
  expect(Object.keys(files)).toEqual(expect.arrayContaining([
    "brand-board.png", "logo/logo-original.png", "direction/selected-direction.png", "social/profile.png",
    "social/post-square.png", "social/post-square.svg", "social/post-portrait.png", "social/post-portrait.svg",
    "social/banner-wide.png", "social/banner-wide.svg", "social/banner-cover.png", "social/banner-cover.svg",
    "guides/colors.json", "guides/colors.css", "guides/brand-guide.html", "README.txt",
  ]));
  expect(files).not.toHaveProperty("logo/logo-vector.svg");
  expect(digest(files["logo/logo-original.png"]!)).toBe(digest(f.logoBytes));
  expect(digest(files["direction/selected-direction.png"]!)).toBe(f.systems[1]!.board.asset.contentHash);
  for (const [name, width, height] of [
    ["brand-board.png", 1600, 2200], ["social/profile.png", 1024, 1024], ["social/post-square.png", 1080, 1080],
    ["social/post-portrait.png", 1080, 1350], ["social/banner-wide.png", 1500, 500], ["social/banner-cover.png", 1584, 396],
  ] as const) expect(await sharp(files[name]).metadata()).toMatchObject({ format: "png", width, height });
  expect(strFromU8(files["guides/colors.css"]!).toUpperCase()).toContain("#872A43");
  const guide = strFromU8(files["guides/brand-guide.html"]!);
  expect(guide).toContain("Fraunces"); expect(guide).toContain("Manrope"); expect(guide).toContain("https://");
  const template = strFromU8(files["social/post-square.svg"]!);
  expect(template).toContain("<text"); expect(template).toContain("data:image/png;base64,");
  expect(f.admissions).toHaveLength(1); expect(f.selections).toHaveLength(1);
  expect(f.mutations.every(path => path.endsWith("/identity/batches") || path.endsWith("/identity/selection"))).toBe(true);
  expect(health.pageErrors).toEqual([]); expect(health.consoleErrors).toEqual([]);
});

test("lost generation acknowledgement checks the original request and keeps a partial board usable", async ({ page }) => {
  const f = createVisualJourneyFixture(); f.loseAdmission = true; const health = await f.setup(page);
  await page.goto(directionsUrl);
  await page.getByRole("button", { name: "Generate three directions", exact: true }).click();
  await expect(page.getByText("Check the existing request before starting another. Saved boards stay available.", { exact: true })).toBeVisible();
  expect(f.admissions).toHaveLength(1); const original = structuredClone(f.admissions[0]);
  await checkProgress(page); await expect(page.getByText("Your directions are queued.", { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText("Your directions are queued.", { exact: true })).toBeVisible();
  expect(f.admissions).toEqual([original]);
  f.complete(1, "partial"); await checkProgress(page);
  await expect(page.getByText("1 of 3 ready", { exact: true })).toBeVisible();
  await loadBoards(page, 1);
  await expect(page.getByRole("img", { name: "Saved Identity board for Cedar", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Choose direction", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Choose direction", exact: true }).click();
  await expect(page.getByRole("link", { name: "Continue to brand assets", exact: true })).toBeVisible();
  expect(f.admissions).toEqual([original]); expect(f.selection!.systemVersionId).toBe(f.systems[0]!.id);
  await fits(page); expect(health.pageErrors).toEqual([]);
});

test("saved boards explain unavailable selection and recover without another generation", async ({ page }) => {
  const f = createVisualJourneyFixture(), health = await f.setup(page);
  await page.goto(directionsUrl);
  await page.getByRole("button", { name: "Generate three directions", exact: true }).click();
  await expect.poll(() => f.admissions.length).toBe(1);
  f.savingAvailable = false; f.complete(); await checkProgress(page);
  await loadBoards(page, 3);
  await expect(page.getByText("Saving your direction is temporarily unavailable. Your boards are saved.", { exact: true })).toHaveCount(3);
  await expect(page.getByText("Checking your saved choice…", { exact: true })).toHaveCount(0);
  for (const button of await page.getByRole("button", { name: "Choose direction", exact: true }).all()) await expect(button).toBeDisabled();
  expect(f.selections).toHaveLength(0); expect(f.admissions).toHaveLength(1);
  f.savingAvailable = true;
  await page.getByRole("button", { name: "Check saved choice", exact: true }).click();
  const choose = page.getByRole("button", { name: "Choose direction", exact: true }).nth(1);
  await expect(choose).toBeEnabled(); expect(f.selections).toHaveLength(0); expect(f.admissions).toHaveLength(1);
  await choose.click();
  await expect(page.getByRole("link", { name: "Continue to brand assets", exact: true })).toBeVisible();
  expect(f.selections).toHaveLength(1); expect(f.admissions).toHaveLength(1);
  await fits(page); expect(health.pageErrors).toEqual([]);
});

test("a changed logo prevents old directions and prepared files from being presented as current", async ({ page }) => {
  test.setTimeout(90_000);
  const f = createVisualJourneyFixture(); await f.setup(page);
  await page.goto(directionsUrl); await page.getByRole("button", { name: "Generate three directions", exact: true }).click();
  await expect.poll(() => f.admissions.length).toBe(1); f.complete(); await checkProgress(page);
  await page.getByRole("button", { name: "Choose direction", exact: true }).first().click();
  await page.getByRole("link", { name: "Continue to brand assets", exact: true }).click();
  await page.getByRole("button", { name: "Create brand assets", exact: true }).click();
  await expect(page.getByText("Your brand assets are ready.", { exact: true })).toBeVisible({ timeout: 45_000 });
  const downloads: Download[] = []; page.on("download", value => downloads.push(value));
  f.sourceCurrent = false;
  await page.getByRole("button", { name: "Download everything", exact: true }).click();
  await expect(page.getByRole("region", { name: "Brand assets", exact: true }).getByRole("alert")).toContainText(/changed|current|saved direction/u);
  expect(downloads).toHaveLength(0);
  await page.goto(directionsUrl);
  await expect(page.getByText("Earlier inputs", { exact: true })).toHaveCount(3);
  for (const button of await page.getByRole("button", { name: "Choose direction", exact: true }).all()) await expect(button).toBeDisabled();
  expect(f.admissions).toHaveLength(1); await fits(page);
});

test("account changes clear the former account's private boards", async ({ page }) => {
  const f = createVisualJourneyFixture(), health = await f.setup(page);
  await page.goto(directionsUrl); await page.getByRole("button", { name: "Generate three directions", exact: true }).click();
  await expect.poll(() => f.admissions.length).toBe(1); f.complete(); await checkProgress(page);
  await loadBoards(page, 3);
  await expect(page.getByRole("img", { name: "Saved Identity board for Cedar", exact: true })).toHaveCount(3);
  f.owner = ownerId.replace(/001$/u, "999"); await checkNormalAccount(page);
  await expect(page.getByRole("img", { name: "Saved Identity board for Cedar", exact: true })).toHaveCount(0);
  await expect(page.getByRole("img", { name: "Chosen logo concept", exact: true })).toHaveCount(0);
  expect(f.admissions).toHaveLength(1); expect(f.selections).toHaveLength(0); expect(health.pageErrors).toEqual([]);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));
