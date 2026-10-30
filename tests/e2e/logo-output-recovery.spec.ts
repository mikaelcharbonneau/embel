/** Ordinary application screens with synthetic API records and private image bytes.
 * These checks do not sign in to a real account or dispatch provider work. */
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { directionFixture, id, ownerId, projectId, fontBytes } from "../features/identity-directions/fixtures";
import { syntheticLogoWorkspace, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
import { syntheticConversionInput } from "../features/logo-vector/raster-fixtures";
import { visualOverview } from "../fixtures/visual-direction";
import { DEFAULT_PROFILE_VALUES } from "../../src/domain/account-profile";
import { accountProjectSchema } from "../../src/domain/project-api";
import { logoWorkspaceV2Schema, logoStageRevisionSchema } from "../../src/domain/logo-workspace";
import { identityDirectionsOverviewSchema } from "../../src/domain/logo-directions";
import { logoDeliverablesOverviewSchema, logoVariantSetSchema } from "../../src/domain/logo-deliverables";
import { logoCostQuoteSchema, logoOperationSchema } from "../../src/domain/logo-jobs";
import { captureUiEvidence } from "./ui-evidence";

async function setup(page: Page, stage: "directions" | "deliverables") {
  const saved = directionFixture(), font = saved.fonts[0]!, foundation = syntheticLogoWorkspace(), source = syntheticResolvedLogoConcept();
  const rescope = <T,>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll(foundation.ownerId, ownerId).replaceAll(foundation.projectId, projectId));
  const brief = rescope(source.brief), references = rescope(source.referenceSnapshot), base = `/api/projects/${projectId}/logo`;
  const approval = { id: id(92), ownerId, projectId, directionSelectionId: id(91), approvedLogoId: saved.currentApprovedLogo!.id, consistencyHash: "a".repeat(64), approvedAt: brief.createdAt };
  const png = syntheticConversionInput("combination").source.bytes, hash = createHash("sha256").update(png).digest("hex");
  const set = logoVariantSetSchema.parse({ id: id(200), ownerId, projectId, approvedLogoId: saved.currentApprovedLogo!.id, directionApprovalId: approval.id, createdAt: brief.createdAt,
    items: [{ id: id(201), role: "primary", colorway: "black", clearSpace: 10, minimumDigitalSize: null, applicability: { status: "applicable" }, reviewStatus: "review_required", renderHash: "a".repeat(64),
      documentAsset: { ownerId, projectId, assetId: id(202), versionId: id(203), contentHash: "a".repeat(64) },
      preview: { id: id(204), reference: { ownerId, projectId, assetId: id(205), versionId: id(206), contentHash: hash },
        verification: { status: "verified", contentHash: hash, mimeType: "image/png", byteLength: png.length, checkedAt: brief.createdAt }, purpose: "brand_asset", sourceReceiptId: id(207), rightsEvidenceId: null, publicationState: "committed" } }] });
  const workspace = logoWorkspaceV2Schema.parse({ ...rescope(foundation), approvedLogo: saved.currentApprovedLogo,
    heads: { ...foundation.heads, projectRevision: 1, workspaceRevision: 3, stageRevisions: { ...foundation.heads.stageRevisions, brief_references: 1, vector: 1, deliverables: stage === "deliverables" ? 1 : 0 } },
    stages: { ...foundation.stages, brief_references: { stage: "brief_references", id: brief.id, revision: 1 }, vector: { stage: "vector", id: id(5), revision: 1 }, deliverables: stage === "deliverables" ? { stage: "deliverables", id: id(90), revision: 1 } : null },
    capabilities: { ...foundation.capabilities, save: { status: "available" }, upload: { status: "available" } } });
  const vector = logoStageRevisionSchema.parse({ ...brief, id: id(5), stage: "vector", payload: { vectorRevisionId: id(4), approvalId: id(3) } });
  const deliverables = logoStageRevisionSchema.parse({ ...brief, id: id(90), stage: "deliverables", payload: { variantSetId: set.id, exportManifestIds: [] } });
  const overview = identityDirectionsOverviewSchema.parse({ ...saved, directions: [], palettes: [], typography: [], graphics: [], fonts: [] });
  const files = logoDeliverablesOverviewSchema.parse({ ownerId, projectId, logoApproval: saved.currentApprovedLogo, directionApproval: approval, variantSets: [set], variantReviews: [], exports: [], exportRequests: [], nextCursor: null, nextRequestCursor: null });
  const project = accountProjectSchema.parse({ id: projectId, owner_id: ownerId, title: "Synthetic continuation project", scope: "visual_identity_only", current_revision: 1, created_at: brief.createdAt, context: { description: "Local continuation check", selectedName: "Northline" } });
  const state = { fonts: [] as typeof saved.fonts, writes: [] as string[], previewReads: 0, pageErrors: [] as string[] };
  page.on("pageerror", error => state.pageErrors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    if (url.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    if (!path.startsWith("/api/")) return route.continue();
    if (method !== "GET") state.writes.push(path);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === `/api/assets/${id(206)}/preview`) {
      state.previewReads++;
      return state.previewReads === 1 ? json({}, 503) : route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(png) });
    }
    if (path === `${base}/fonts/imports`) { state.fonts = [font]; return json(font); }
    if (path === `${base}/quotes`) {
      const request = route.request().postDataJSON();
      return json(logoCostQuoteSchema.parse({ id: id(100), ownerId, projectId, request, expected: request.expected, inputHash: "a".repeat(64), policyIdentity: "b".repeat(64), handlerVersion: "synthetic-directions-v1", provider: "synthetic", model: "synthetic-directions", engine: null,
        estimatedCostMicrousd: 10000, maxCostMicrousd: 25000, externalProviderCostMicrousd: null, expiresAt: "2099-01-01T00:00:00Z", conceptPlan: null, targetSlotIds: [] }));
    }
    const observed = Date.now();
    const body = path === "/api/session" ? { user: { id: ownerId } }
      : path === "/api/account/profile" ? { profile: { ownerId, email: "continuation@example.invalid", revision: 0, updatedAt: null, values: DEFAULT_PROFILE_VALUES } }
      : path === `/api/projects/${projectId}` ? { project }
      : path === `/api/projects/${projectId}/visual-direction` ? visualOverview({ ownerId, projectId })
      : path === base ? workspace : path === `${base}/directions` ? overview : path === `${base}/deliverables` ? files
      : path === `${base}/stages/brief_references/revisions/${brief.id}` ? brief
      : path === `${base}/reference-snapshots/${references.id}` ? references
      : path === `${base}/stages/vector/revisions/${vector.id}` ? vector
      : path === `${base}/stages/deliverables/revisions/${deliverables.id}` ? deliverables
      : path === `${base}/fonts` ? state.fonts
      : path === `${base}/fonts/catalog` ? [{ id: "geist-upright", family: font.family, mimeType: "font/ttf", byteLength: fontBytes().length, rights: font.rights, conditions: ["Synthetic reviewed catalog record"], reservedFontNames: [] }]
      : path === `${base}/references` || path === `${base}/inputs/requests` ? { ownerId, projectId, items: [], nextCursor: null }
      : path === `${base}/capabilities` ? { ownerId, projectId, observedAt: new Date(observed).toISOString(), operations: Object.fromEntries(logoOperationSchema.options.map(operation => [operation, operation === "identity.logo_directions" || operation === "identity.logo_export" ? { status: "available", expiresAt: new Date(observed + 30_000).toISOString() } : { status: "unavailable" }])) }
      : null;
    return json(body ?? {}, body ? 200 : 503);
  });
  await page.goto(`/brands/account/${projectId}/logo/${stage}`);
  return state;
}

test("adding a project font makes direction generation available without a manual refresh", async ({ page }) => {
  const state = await setup(page, "directions"), generate = page.getByRole("button", { name: "Generate 3 directions", exact: true });
  await expect(generate).toBeDisabled(); await expect(page.getByText("No owned fonts with reviewed commercial-use and display permissions are available.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add Geist upright", exact: true }).click();
  await expect(page.getByText("Reviewed free-commercial font saved to this project.", { exact: true })).toBeVisible();
  await expect(generate).toBeEnabled();
  expect(state.writes.filter(path => path.endsWith("/fonts/imports"))).toHaveLength(1);
  expect(state.writes.filter(path => path.endsWith("/requests"))).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await generate.scrollIntoViewIfNeeded();
});

test("a temporary variant preview failure has a working retry without losing the saved variant", async ({ page }, info) => {
  const state = await setup(page, "deliverables"), checkbox = page.getByRole("checkbox", { name: "I checked spelling, edges and spacing.", exact: true });
  await expect(page.getByRole("button", { name: "Retry preview", exact: true })).toBeVisible(); await expect(checkbox).toBeDisabled();
  await page.getByRole("button", { name: "Refresh saved work", exact: true }).click(); await expect(checkbox).toBeDisabled(); expect(state.previewReads).toBe(1);
  await page.getByRole("button", { name: "Retry preview", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("variant-preview-retry.png"), fullPage: true, scale: "css" });
  await page.getByRole("button", { name: "Retry preview", exact: true }).click();
  await expect(page.getByRole("img", { name: "primary logo, black", exact: true })).toBeVisible();
  await expect(checkbox).toBeEnabled(); await expect(checkbox).not.toBeChecked(); await checkbox.check();
  await expect(page.getByRole("button", { name: "Save visual review", exact: true })).toBeEnabled();
  expect(state.previewReads).toBe(2); expect(state.writes).toEqual([]); expect(state.pageErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));
