import { expectProjectCanvas } from "./project-canvas-contract";
import { captureUiEvidence } from "./ui-evidence";
import { expect, test } from "@playwright/test";
import { logoFixtureId as id } from "../fixtures/logo-creation";
import { checkNormalAccount } from "./account-check";
import { setupSavedVectorEditor as setup, source } from "../fixtures/logo-vector-editor-ui";
const projectId = source.input.projectId, base = `/api/projects/${projectId}/logo`, url = `/brands/account/${projectId}/logo/vector`;

test("unapproved vector reload shows original comparison and requires explicit acceptance", async ({ page }) => {
  const f = await setup(page); await expect(page.getByRole("img", { name: "Original concept", exact: true })).toBeVisible(); expect(f.posts).toHaveLength(0);
  const continueToIdentity = page.getByRole("link", { name: "Continue to Identity directions", exact: true });
  await expect(continueToIdentity).toHaveCount(0);
  await page.reload(); await expect(page.getByRole("button", { name: "Accept this vector", exact: true })).toBeEnabled(); expect(f.posts).toHaveLength(0);
  await page.getByRole("button", { name: "Accept this vector", exact: true }).click(); await expect.poll(() => f.posts.length).toBe(1); await expect(page.getByRole("heading", { name: "Approved logo", exact: true })).toBeVisible();
  await expect(continueToIdentity).toBeVisible(); await expect(continueToIdentity).toHaveAttribute("href", `/brands/account/${projectId}/logo/directions`);
  await page.reload(); await expect(continueToIdentity).toBeVisible(); expect(f.posts).toHaveLength(1);
  await continueToIdentity.scrollIntoViewIfNeeded();
});
test("keyboard manual edit waits for Save and retains an immutable new candidate", async ({ page }) => {
  const f = await setup(page); const rotation = page.getByRole("spinbutton", { name: "Component rotation", exact: true }); await expect(rotation).toBeEnabled(); await rotation.fill("15"); await rotation.press("Enter");
  await expect(page.getByText("Unsaved vector change", { exact: true })).toBeVisible(); expect(f.posts).toHaveLength(0); await page.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1); await expect(rotation).toHaveValue("15"); await expect(page.getByRole("button", { name: "Save edit", exact: true })).toBeDisabled(); expect(f.posts[0]!.path).toBe(`${base}/edits`); expect(f.workspace.approvedLogo).toBeNull();
});
test("lost edit acknowledgement retains and checks the exact request without resending", async ({ page }) => {
  const f = await setup(page); f.lose = true; const rotation = page.getByRole("spinbutton", { name: "Component rotation", exact: true }); await expect(rotation).toBeEnabled(); await rotation.fill("10"); await rotation.press("Enter"); await page.getByRole("button", { name: "Save edit", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check original request", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Check original request", exact: true }).click();
  await expect.poll(() => f.requestReads).toBeGreaterThan(0); await expect(rotation).toHaveValue("10"); expect(f.posts).toHaveLength(1);
});
test("same-owner refresh retains unsaved vector intent and account switch hides private geometry", async ({ page }) => {
  const f = await setup(page), rotation = page.getByRole("spinbutton", { name: "Component rotation", exact: true }); await expect(rotation).toBeEnabled(); await rotation.fill("12"); await rotation.press("Enter");
  await expect(page).toHaveTitle(/Embel/u);
  await expect(page).toHaveURL(url);
  const reads = f.sessionReads;
  await checkNormalAccount(page); await expect.poll(() => f.sessionReads).toBeGreaterThan(reads);
  await expect(page.getByText("Unsaved vector change", { exact: true })).toBeVisible(); await expect(rotation).toHaveValue("12"); expect(f.posts).toHaveLength(0);
  f.owner = id(999); await checkNormalAccount(page);
  await expect(page.getByRole("img", { name: "Vector candidate", exact: true })).toHaveCount(0); await expect(page.getByRole("img", { name: "Original concept", exact: true })).toHaveCount(0);
  await expect(page.getByText("Unsaved vector change", { exact: true })).toHaveCount(0);
  expect(f.posts).toHaveLength(0); expect(f.mutations).toEqual([]);
  expect(f.browserHealth.pageErrors).toEqual([]); expect(f.browserHealth.consoleErrors).toEqual([]);
});
test("review then restore creates an explicit new current selection and fits the viewport", async ({ page }) => {
  const f = await setup(page), rotation = page.getByRole("spinbutton", { name: "Component rotation", exact: true }); await expect(rotation).toBeEnabled(); await rotation.fill("8"); await rotation.press("Enter"); await page.getByRole("button", { name: "Save edit", exact: true }).click(); await expect(rotation).toHaveValue("8");
  await page.getByRole("button", { name: "Review vector version 1", exact: true }).click(); await expect(page.getByRole("button", { name: "Restore this version", exact: true })).toBeEnabled(); expect(f.posts).toHaveLength(1);
  await page.getByRole("button", { name: "Restore this version", exact: true }).click(); await expect.poll(() => f.posts.length).toBe(2); await expect(rotation).toHaveValue("0"); expect(f.posts[1]!.path).toBe(`${base}/restore`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));

test("identity directions and brand files retain usable unavailable states without creating work", async ({ page }, info) => {
  const f = await setup(page);
  for (const [stage, title] of [["directions", "Identity directions"], ["deliverables", "Brand files"]]) {
    await page.goto(`/brands/account/${projectId}/logo/${stage}`);
    await expect(page.getByRole("heading", { name: title, level: 1, exact: true })).toBeVisible();
    await expectProjectCanvas(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.screenshot({ path: info.outputPath(`${stage}-unavailable.png`), fullPage: true, scale: "css" });
    expect(f.posts).toHaveLength(0);
  }
});
