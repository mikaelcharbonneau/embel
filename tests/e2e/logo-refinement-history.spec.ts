import { expect, test, type Page } from "@playwright/test";
import { logoFixtureId as id } from "../fixtures/logo-creation";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";
import { accountProjectSchema } from "../../src/domain/project-api";
const rasterId = id(503), selectedRaster = { kind: "refinement" as const, rasterRevisionId: rasterId };
async function fixture(page: Page, preexisting = false) {
  const state = await syntheticRefinementWorkspaceHttp(preexisting);
  await page.route("**/*", async route => {
    const target = new URL(route.request().url());
    if (target.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    if (!target.pathname.startsWith("/api/")) return route.continue();
    if (target.pathname === `/api/projects/${state.workspace.projectId}`) {
      const project = accountProjectSchema.parse({ id: state.workspace.projectId, owner_id: state.owner, title: "Synthetic Élan project", scope: "visual_identity_only", current_revision: 1, created_at: "2026-10-07T00:00:00Z", context: { description: "Synthetic brand brief", selectedName: "Élan & Co" } });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project }) });
    }
    try {
      const response = await state.fetcher(target.pathname + target.search, { method: route.request().method(), body: route.request().postData() });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    } catch { await route.abort("failed"); }
  });
  await page.goto(`/brands/account/${state.workspace.projectId}/logo`);
  await expect(page.getByRole("textbox", { name: "Brand name" })).toHaveValue("Élan & Co");
  return state;
}

const card = (page: Page) => page.locator(`[data-refinement-id="${rasterId}"]`);
const select = (page: Page) => page.getByRole("button", { name: `Select image refinement ${rasterId}`, exact: true });

test("refine_reload_select_vectorize_uses_retained_raster", async ({ page }) => {
  const f = await fixture(page); await page.getByRole("textbox", { name: "Revision request for selected image" }).fill("Simplify the silhouette");
  await page.getByRole("button", { name: "Refine selected", exact: true }).click(); await expect(page.getByRole("dialog")).toBeVisible();
  expect(f.admissions).toHaveLength(0); await page.getByRole("button", { name: "Refine this concept", exact: true }).click();
  await expect.poll(() => f.admissions.length).toBe(1); await page.reload();
  await expect(card(page)).toBeVisible(); await expect(card(page).getByRole("img", { name: "Image preview of saved logo refinement" })).toBeVisible();
  expect(f.detailReads).toContain(rasterId); expect(f.workspace.stages.refinements).not.toBeNull(); expect(f.workspace.approvedLogo).toBeNull();
  const trigger = select(page); await expect(trigger).toBeEnabled(); await trigger.focus(); await trigger.press("Enter");
  await expect(trigger).toHaveAttribute("aria-pressed", "true"); expect(f.selections).toHaveLength(1); expect(f.selections[0]?.source).toEqual(selectedRaster);
  await page.getByRole("button", { name: "Review conversion", exact: true }).click(); await expect(page.getByRole("dialog")).toContainText(rasterId);
  expect(f.quotes.at(-1)).toMatchObject({ operation: "vectorize", source: selectedRaster }); expect(f.admissions).toHaveLength(1);
  expect(JSON.stringify(f.batch)).toBe(f.originalBatch); expect(f.raster.preview!.reference.contentHash).not.toBe(f.batch.slots[0]!.acceptedPreview!.reference.contentHash);
  await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: "Review conversion", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload(); await expect(select(page)).toHaveAttribute("aria-pressed", "true"); expect(f.admissions).toHaveLength(1);
});

test("completed refinements remain inspectable and selectable with image generation unavailable", async ({ page }) => {
  const f = await fixture(page, true); f.imageAvailable = false; await page.getByRole("button", { name: "Refresh operation availability" }).click();
  await expect(select(page)).toBeEnabled(); await select(page).click(); await expect(select(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Refine selected image refinement" })).toBeDisabled();
  await expect(card(page)).toContainText("Confirmed charge: $0.10"); await expect(card(page)).toContainText("Vector conversion and approval follow separately");
  expect(f.admissions).toHaveLength(0); expect(f.workspace.approvedLogo).toBeNull();
});

test("unconfirmed selection checks then retries the exact body and key without image generation", async ({ page }) => {
  const f = await fixture(page, true); f.loseSelection = true; await expect(select(page)).toBeEnabled(); await select(page).click();
  await expect(page.getByRole("button", { name: "Check original selection", exact: true })).toBeVisible(); const original = structuredClone(f.selections[0]);
  await page.getByRole("button", { name: "Check original selection", exact: true }).click(); expect(f.selections).toHaveLength(1);
  await page.getByRole("button", { name: "Retry original selection", exact: true }).click(); await expect(select(page)).toHaveAttribute("aria-pressed", "true");
  expect(f.selections).toEqual([original, original]); expect(f.admissions).toHaveLength(0); expect(f.quotes).toHaveLength(0);
});

test("draft changes keep refinement history visible while preventing selection", async ({ page }) => {
  const f = await fixture(page, true); await expect(select(page)).toBeEnabled(); await page.getByRole("textbox", { name: "What the business does" }).fill("Keep my unsaved change");
  await expect(select(page)).toBeDisabled(); await expect(card(page)).toBeVisible(); await page.getByRole("button", { name: "Refresh saved image refinements" }).click();
  await expect(page.getByRole("textbox", { name: "What the business does" })).toHaveValue("Keep my unsaved change"); expect(f.selections).toHaveLength(0); expect(f.admissions).toHaveLength(0);
});


test("project design: concept inspection and Refine route keep selection and require cost review", async ({ page }, info) => {
  const f = await fixture(page, true), originalSelection = JSON.stringify(f.workspace.stages.concepts);
  const initialSelections = f.selections.length;
  await page.getByRole("button", { name: /^Inspect concept/ }).first().click();
  await expect(page.getByRole("region", { name: "Logo inspection" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Logo inspection" }).getByRole("img")).toBeVisible();
  expect(f.selections).toHaveLength(initialSelections); expect(JSON.stringify(f.workspace.stages.concepts)).toBe(originalSelection);
  await page.screenshot({ path: info.outputPath("project-logo-inspection.png"), fullPage: true });
  await page.goto(`/brands/account/${f.workspace.projectId}/logo/editor`);
  await expect(page.getByRole("heading", { name: "Refine a direction", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Revision request for selected image" }).fill("Simplify the silhouette");
  await page.getByRole("button", { name: "Review revision cost", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible(); expect(f.admissions).toHaveLength(0);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Back to concepts", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${f.workspace.projectId}/logo$`));
  expect(f.selections).toHaveLength(initialSelections); expect(f.admissions).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("project-logo-concepts.png"), fullPage: true });
});
