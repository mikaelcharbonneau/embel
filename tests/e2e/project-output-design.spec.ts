import { expect, test, type Page } from "@playwright/test";
import { directionFixture, id, ownerId, projectId } from "../features/identity-directions/fixtures";
import { syntheticLogoWorkspace, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
import { accountProjectSchema } from "../../src/domain/project-api";
import { logoWorkspaceV2Schema, logoStageRevisionSchema } from "../../src/domain/logo-workspace";
import { logoDeliverablesOverviewSchema } from "../../src/domain/logo-deliverables";

// Original local fixture records only. No provider, database, storage or export call.
async function setup(page: Page) {
  const overview = directionFixture(), foundation = syntheticLogoWorkspace(), source = syntheticResolvedLogoConcept();
  const rescope = <T,>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(foundation.ownerId, ownerId).replaceAll(foundation.projectId, projectId));
  const brief = rescope(source.brief), references = rescope(source.referenceSnapshot);
  const workspace = logoWorkspaceV2Schema.parse({ ...rescope(foundation), approvedLogo: overview.currentApprovedLogo,
    heads: { ...foundation.heads, projectRevision: 1, workspaceRevision: 3, stageRevisions: { ...foundation.heads.stageRevisions, brief_references: 1, vector: 1, directions: 1 } },
    stages: { ...foundation.stages, brief_references: { stage: "brief_references", id: brief.id, revision: 1 }, vector: { stage: "vector", id: id(5), revision: 1 }, directions: { stage: "directions", id: id(90), revision: 1 } },
    capabilities: { ...foundation.capabilities, save: { status: "available" } },
  });
  const stage = logoStageRevisionSchema.parse({ ...brief, id: id(90), stage: "directions", payload: { directionIds: overview.directions.map(row => row.id), selectionId: null, approvalId: null } });
  const vectorStage = logoStageRevisionSchema.parse({ ...brief, id: id(5), stage: "vector", payload: { vectorRevisionId: id(4), approvalId: id(3) } });
  const project = accountProjectSchema.parse({ id: projectId, owner_id: ownerId, title: "Synthetic identity project", scope: "visual_identity_only", current_revision: 1, created_at: brief.createdAt, context: { description: "Synthetic saved context", selectedName: "Élan & Co" } });
  const files = logoDeliverablesOverviewSchema.parse({ ownerId, projectId, logoApproval: overview.currentApprovedLogo, directionApproval: null, variantSets: [], variantReviews: [], exports: [], exportRequests: [], nextCursor: null, nextRequestCursor: null });
  const writes: string[] = [], base = `/api/projects/${projectId}/logo`;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") writes.push(path);
    const body = path === "/api/session" ? { user: { id: ownerId } } : path === `/api/projects/${projectId}` ? { project }
      : path === base ? workspace : path === `${base}/directions` ? overview : path === `${base}/deliverables` ? files
      : path === `${base}/stages/brief_references/revisions/${brief.id}` ? brief
      : path === `${base}/reference-snapshots/${references.id}` ? references
      : path === `${base}/stages/directions/revisions/${stage.id}` ? stage
      : path === `${base}/stages/vector/revisions/${vectorStage.id}` ? vectorStage
      : path === `${base}/fonts` ? overview.fonts : null;
    await route.fulfill({ status: body ? 200 : 503, contentType: "application/json", body: JSON.stringify(body ?? {}) });
  });
  return writes;
}

test("project design: three saved directions keep actual components and Files keeps approval gates", async ({ page }, info) => {
  const writes = await setup(page);
  await page.goto(`/brands/account/${projectId}/logo/directions`);
  await expect(page.getByRole("heading", { name: "Build the whole identity", exact: true })).toBeVisible();
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
  await page.goto(`/brands/account/${projectId}/logo/deliverables`);
  await expect(page.getByRole("heading", { name: "Your brand, ready to use", exact: true })).toBeVisible();
  await expect(page.getByText("No completed exports yet. Earlier requests and partial files remain available above.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare variants", exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: info.outputPath("project-files.png"), fullPage: true });
});
