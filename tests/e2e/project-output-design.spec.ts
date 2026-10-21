import { expectProjectCanvas } from "./project-canvas-contract";
import { expect, test, type Page } from "@playwright/test";
import { directionFixture, id, ownerId, projectId } from "../features/identity-directions/fixtures";
import { syntheticLogoWorkspace, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
import { accountProjectSchema } from "../../src/domain/project-api";
import { logoWorkspaceV2Schema, logoStageRevisionSchema } from "../../src/domain/logo-workspace";
import { identityDirectionsOverviewSchema } from "../../src/domain/logo-directions";
import { logoDeliverablesOverviewSchema } from "../../src/domain/logo-deliverables";
import { captureUiEvidence } from "./ui-evidence";

const browserErrors = new WeakMap<Page, { pageErrors: string[]; consoleErrors: string[]; fixtureUnavailableEndpoints: string[] }>();
test.beforeEach(async ({ page }) => {
  await page.setViewportSize(page.viewportSize()!.width <= 760 ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const errors = { pageErrors: [] as string[], consoleErrors: [] as string[], fixtureUnavailableEndpoints: [] as string[] }; browserErrors.set(page, errors);
  page.on("pageerror", error => errors.pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.consoleErrors.push(message.text()); });
});
test.afterEach(async ({ page }, info) => {
  const errors = browserErrors.get(page)!;
  await info.attach("fixture-browser-errors", { body: Buffer.from(JSON.stringify(errors, null, 2)), contentType: "application/json" });
  expect(errors.pageErrors).toEqual([]);
});

// Original local fixture records only. No provider, database, storage or export call.
async function setup(page: Page, approvedLogo = true, scope: "visual_identity_only" | "naming_only" = "visual_identity_only", approvedIdentity = false) {
  let overview = directionFixture();
  if (approvedIdentity) {
    const direction = overview.directions[0]!;
    const selectedComponents = { id: id(91), ownerId, projectId, approvedLogoId: direction.approvedLogoId, inputRevisions: direction.inputRevisions, paletteVersionId: direction.paletteVersionId, typographyVersionId: direction.typographyVersionId, graphicsVersionId: direction.graphicsVersionId, sourceDirectionIds: [direction.id], consistency: { hash: "a".repeat(64), status: "pass", checks: [], warnings: [], blockingReasons: [] } };
    overview = identityDirectionsOverviewSchema.parse({ ...overview, selection: selectedComponents, approval: { id: id(92), ownerId, projectId, directionSelectionId: selectedComponents.id, approvedLogoId: direction.approvedLogoId, consistencyHash: selectedComponents.consistency.hash, approvedAt: "2026-10-15T10:00:00Z" } });
  }
  const foundation = syntheticLogoWorkspace(), source = syntheticResolvedLogoConcept();
  const rescope = <T,>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(foundation.ownerId, ownerId).replaceAll(foundation.projectId, projectId));
  const brief = rescope(source.brief), references = rescope(source.referenceSnapshot);
  const workspace = logoWorkspaceV2Schema.parse({ ...rescope(foundation), approvedLogo: approvedLogo ? overview.currentApprovedLogo : null,
    heads: { ...foundation.heads, projectRevision: 1, workspaceRevision: 3, stageRevisions: { ...foundation.heads.stageRevisions, brief_references: 1, vector: 1, directions: 1 } },
    stages: { ...foundation.stages, brief_references: { stage: "brief_references", id: brief.id, revision: 1 }, vector: { stage: "vector", id: id(5), revision: 1 }, directions: { stage: "directions", id: id(90), revision: 1 } },
    capabilities: { ...foundation.capabilities, save: { status: "available" } },
  });
  const stage = logoStageRevisionSchema.parse({ ...brief, id: id(90), stage: "directions", payload: { directionIds: overview.directions.map(row => row.id), selectionId: overview.selection?.id ?? null, approvalId: overview.approval?.id ?? null } });
  const vectorStage = logoStageRevisionSchema.parse({ ...brief, id: id(5), stage: "vector", payload: { vectorRevisionId: id(4), approvalId: approvedLogo ? id(3) : null } });
  const project = accountProjectSchema.parse({ id: projectId, owner_id: ownerId, title: "Synthetic identity project", scope, current_revision: 1, created_at: brief.createdAt, context: { description: "Synthetic saved context", selectedName: "Élan & Co" } });
  const files = logoDeliverablesOverviewSchema.parse({ ownerId, projectId, logoApproval: approvedLogo ? overview.currentApprovedLogo : null, directionApproval: overview.approval, variantSets: [], variantReviews: [], exports: [], exportRequests: [], nextCursor: null, nextRequestCursor: null });
  const writes: string[] = [], base = `/api/projects/${projectId}/logo`;
  await page.route("**/*", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (url.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    if (!path.startsWith("/api/")) return route.continue();
    if (route.request().method() !== "GET") writes.push(path);
    const body = path === "/api/session" ? { user: { id: ownerId } } : path === "/api/projects/page" ? { ownerId, items: [], nextCursor: null } : path === `/api/projects/${projectId}` ? { project }
      : path === base ? workspace : path === `${base}/directions` ? overview : path === `${base}/deliverables` ? files
      : path === `${base}/stages/brief_references/revisions/${brief.id}` ? brief
      : path === `${base}/reference-snapshots/${references.id}` ? references
      : path === `${base}/stages/directions/revisions/${stage.id}` ? stage
      : path === `${base}/stages/vector/revisions/${vectorStage.id}` ? vectorStage
      : path === `${base}/fonts` ? overview.fonts : null;
    if (!body && !browserErrors.get(page)!.fixtureUnavailableEndpoints.includes(path)) browserErrors.get(page)!.fixtureUnavailableEndpoints.push(path);
    await route.fulfill({ status: body ? 200 : 503, contentType: "application/json", body: JSON.stringify(body ?? {}) });
  });
  return writes;
}

async function checkGlobalNavigation(page: Page) {
  const mobile = page.viewportSize()!.width <= 760;
  const trigger = page.getByRole("button", { name: mobile ? "Open navigation" : "Expand navigation", exact: true });
  await expect(trigger).toBeVisible();
  const box = await trigger.boundingBox();
  await trigger.focus(); await page.keyboard.press("Enter");
  if (mobile) {
    const menu = page.getByRole("dialog", { name: "Navigation", exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button", { name: "Close navigation", exact: true })).toBeFocused();
    await page.keyboard.press("Tab"); await expect(menu.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape"); await expect(menu).not.toBeVisible(); await expect(trigger).toBeFocused();
  } else {
    const collapse = page.getByRole("button", { name: "Collapse navigation", exact: true });
    await expect(collapse).toHaveAttribute("aria-expanded", "true");
    await collapse.press("Enter"); await expect(trigger).toHaveAttribute("aria-expanded", "false");
    const account = page.locator(".workspace-account-menu > summary");
    await account.focus(); await page.keyboard.press("Enter");
    await expect(page.locator(".workspace-account-menu")).toHaveAttribute("open", "");
    await page.keyboard.press("Tab"); await expect(page.locator(".workspace-account-menu :focus")).toHaveCount(1);
    await page.keyboard.press("Escape"); await expect(page.locator(".workspace-account-menu")).not.toHaveAttribute("open", ""); await expect(account).toBeFocused();
  }
  return box!;
}

async function expectFirstViewport(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull(); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
}

async function resetCaptureScroll(page: Page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const element of document.querySelectorAll("#main-content, .project-workspace-content")) element.scrollTop = 0;
  });
}

test("naming-only direct visual routes omit project bars and retain output prerequisites", async ({ page }, info) => {
  const writes = await setup(page, false, "naming_only");
  await page.goto(`/brands/account/${projectId}/logo/directions`);
  await expect(page.getByRole("heading", { name: "Identity directions", level: 1, exact: true })).toBeVisible();
  await expectProjectCanvas(page);
  await expect(page.getByRole("heading", { name: "Start with an approved logo", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve identity", exact: true })).toHaveCount(0);
  const back = page.getByRole("link", { name: "Back to project", exact: true });
  await expect(back).toHaveAttribute("href", `/brands/account/${projectId}`); await back.focus(); await expect(back).toBeFocused();
  expect(writes).toEqual([]); await resetCaptureScroll(page); await captureUiEvidence(page, info);
});

test("project design: three saved directions keep actual components and Files keeps approval gates", async ({ page }, info) => {
  const writes = await setup(page);
  await page.goto("/brands");
  const collectionTrigger = await checkGlobalNavigation(page);
  await page.goto(`/brands/account/${projectId}/logo/directions`);
  await expect(page.getByRole("heading", { name: "Identity directions", level: 1, exact: true })).toBeVisible();
  await expect(page.locator("h2.project-output-inner-heading")).not.toBeInViewport();
  const directionTrigger = await checkGlobalNavigation(page);
  // Thin borders may place a centered control on a half CSS pixel.
  for (const coordinate of ["x", "y", "width", "height"] as const) expect(Math.abs(directionTrigger[coordinate] - collectionTrigger[coordinate])).toBeLessThanOrEqual(1);
  await expectProjectCanvas(page);
  for (const number of [1, 2, 3]) await expect(page.getByRole("heading", { name: `Synthetic direction ${number}`, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Component choices" })).toBeVisible();
  if (page.viewportSize()!.width > 760) {
    const canvas = await page.locator(".project-direction-workspace > .project-workbench-canvas").boundingBox();
    const dock = await page.locator(".project-direction-workspace > .project-dock").boundingBox();
    expect(dock!.width).toBe(340); expect(dock!.x).toBeGreaterThanOrEqual(canvas!.x + canvas!.width - 1);
  }
  await expect(page.getByRole("button", { name: "Approve identity", exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: info.outputPath("project-directions.png"), fullPage: true });
  // An unapproved identity has no contextual Files entry. Exercise its direct
  // prerequisite route here; the approved-fixture test below verifies the entry link.
  await page.goto(`/brands/account/${projectId}/logo/deliverables`);
  await expect(page.getByRole("heading", { name: "Brand files", level: 1, exact: true })).toBeVisible();
  await expect(page.locator("h2.project-output-inner-heading")).not.toBeInViewport();
  const fileTrigger = await checkGlobalNavigation(page);
  for (const coordinate of ["x", "y", "width", "height"] as const) expect(Math.abs(fileTrigger[coordinate] - collectionTrigger[coordinate])).toBeLessThanOrEqual(1);
  await info.attach("navigation-trigger-geometry", { body: Buffer.from(JSON.stringify({ viewport: page.viewportSize(), collectionTrigger, directionTrigger, fileTrigger }, null, 2)), contentType: "application/json" });
  await expectProjectCanvas(page);
  await expect(page.getByRole("heading", { name: "Approve an identity direction", exact: true })).toBeVisible();
  const review = page.getByRole("link", { name: "Review identity direction", exact: true });
  await expect(review).toHaveAttribute("href", `/brands/account/${projectId}/logo/directions`);
  await expectFirstViewport(page, `a[href="/brands/account/${projectId}/logo/directions"]`);
  await expect(page.getByText("No completed exports yet. Earlier requests and partial files remain available above.", { exact: true })).toBeVisible();
  const preparation = page.locator("details").filter({ has: page.locator("summary", { hasText: /^Preview formats and export options$/ }) });
  await expect(preparation).not.toHaveAttribute("open", "");
  const summary = preparation.locator(":scope > summary"); await summary.focus(); await summary.press("Enter");
  await expect(preparation).toHaveAttribute("open", ""); await expect(summary).toBeFocused();
  await expect(page.getByRole("button", { name: "Prepare variants", exact: true })).toBeDisabled();
  await page.keyboard.press("Tab"); await expect(preparation.locator("select")).toBeFocused();
  await summary.focus(); await summary.press("Enter"); await expect(preparation).not.toHaveAttribute("open", ""); await expect(summary).toBeFocused();
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await resetCaptureScroll(page);
  await page.screenshot({ path: info.outputPath("project-files.png"), fullPage: true });
  await captureUiEvidence(page, info);
});

for (const stage of ["directions", "deliverables"] as const) test(`project ${stage}: missing vector approval is the first visible next step`, async ({ page }, info) => {
  const writes = await setup(page, false);
  await page.goto(`/brands/account/${projectId}/logo/${stage}`);
  const prerequisite = page.getByRole("heading", { name: "Start with an approved logo", exact: true });
  await expect(prerequisite).toBeVisible();
  const review = page.getByRole("link", { name: "Review vector logo", exact: true });
  await expect(review).toHaveAttribute("href", `/brands/account/${projectId}/logo/vector`);
  await expectFirstViewport(page, `a[href="/brands/account/${projectId}/logo/vector"]${stage === "directions" ? ":not(.text-link)" : ""}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(writes).toEqual([]); await resetCaptureScroll(page); await captureUiEvidence(page, info);
  await review.focus(); await expect(review).toBeFocused();
});


test("approved identity keeps the existing keyboard route to brand files after bar removal", async ({ page }, info) => {
  const writes = await setup(page, true, "visual_identity_only", true);
  await page.goto(`/brands/account/${projectId}/logo/directions`);
  const files = page.getByRole("link", { name: "Review brand files", exact: true });
  await expect(files).toBeVisible(); await expect(files).toHaveAttribute("href", `/brands/account/${projectId}/logo/deliverables`);
  await expectProjectCanvas(page);
  await files.focus(); await files.press("Enter");
  await expect(page).toHaveURL(`/brands/account/${projectId}/logo/deliverables`);
  await expect(page.getByRole("heading", { name: "Brand files", level: 1, exact: true })).toBeVisible();
  await expectProjectCanvas(page); expect(writes).toEqual([]); await captureUiEvidence(page, info);
});
