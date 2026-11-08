import { expect, test, type Page } from "@playwright/test";
import { logoFixtureId as id } from "../fixtures/logo-creation";
import { syntheticRefinementWorkspaceHttp } from "../fixtures/logo-refinement-workspace-http";
import { accountProjectSchema } from "../../src/domain/project-api";
const rasterId = id(503), selectedRaster = { kind: "refinement" as const, rasterRevisionId: rasterId };
type NetworkAudit = { externalAttempts: string[]; cspViolations: { blockedURI: string; effectiveDirective: string }[]; pageErrors: string[]; readyMs: number[];
  captures: { name: string; fullPage: boolean; width: number; height: number; scrollWidth: number; scrollHeight: number; devicePixelRatio: number }[]; captureWarnings: string[] };
const audits = new WeakMap<Page, NetworkAudit>();
test.beforeEach(async ({ page, baseURL }) => {
  const appOrigin = new URL(baseURL!).origin;
  const audit: NetworkAudit = { externalAttempts: [], cspViolations: [], pageErrors: [], readyMs: [], captures: [], captureWarnings: [] }; audits.set(page, audit);
  page.on("request", request => { const url = new URL(request.url()); if (["http:", "https:"].includes(url.protocol) && url.origin !== appOrigin) audit.externalAttempts.push(request.url()); });
  page.on("pageerror", error => audit.pageErrors.push(error.message));
  await page.exposeFunction("recordLogoFixtureCspViolation", (violation: NetworkAudit["cspViolations"][number]) => audit.cspViolations.push(violation));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", event => {
    void (window as unknown as Window & { recordLogoFixtureCspViolation: (violation: { blockedURI: string; effectiveDirective: string }) => Promise<unknown> })
      .recordLogoFixtureCspViolation({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
  }));
});
test.afterEach(async ({ page }, info) => {
  const audit = audits.get(page)!;
  await info.attach("logo-network-boundary", { body: JSON.stringify(audit, null, 2), contentType: "application/json" });
  expect(audit.externalAttempts).toEqual([]); expect(audit.cspViolations).toEqual([]); expect(audit.pageErrors).toEqual([]);
});
async function savedWorkspaceReady(page: Page, startedAt: number) {
  // History loads independently. A visible history card is not proof that the
  // saved workspace, stage payloads and reference snapshot have been hydrated.
  // The brief lives in the closed Logo brief and history sheet; its saved value proves hydration.
  await expect(page.getByRole("textbox", { name: "Brand name", includeHidden: true })).toHaveValue("Élan & Co");
  audits.get(page)!.readyMs.push(Date.now() - startedAt);
}
async function reloadSavedWorkspace(page: Page) {
  const startedAt = Date.now(); await page.reload({ waitUntil: "domcontentloaded" }); await savedWorkspaceReady(page, startedAt);
}
async function fixture(page: Page, preexisting = false) {
  const state = await syntheticRefinementWorkspaceHttp(preexisting);
  // The fixture's self-only CSP blocks external traffic. Only synthetic API
  // traffic is intercepted; local documents and assets go directly to server.
  await page.route(`${new URL(page.url() === "about:blank" ? test.info().project.use.baseURL! : page.url()).origin}/api/**`, async route => {
    const target = new URL(route.request().url());
    if (target.pathname === `/api/projects/${state.workspace.projectId}`) {
      const project = accountProjectSchema.parse({ id: state.workspace.projectId, owner_id: state.owner, title: "Synthetic Élan project", scope: "visual_identity_only", current_revision: 1, created_at: "2026-10-07T00:00:00Z", context: { description: "Synthetic brand brief", selectedName: "Élan & Co" } });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project }) });
    }
    try {
      const response = await state.fetcher(target.pathname + target.search, { method: route.request().method(), body: route.request().postData() });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    } catch { await route.abort("failed"); }
  });
  const startedAt = Date.now();
  await page.goto(`/brands/account/${state.workspace.projectId}/logo`, { waitUntil: "domcontentloaded" });
  await savedWorkspaceReady(page, startedAt);
  return state;
}

const card = (page: Page) => page.locator(`[data-refinement-id="${rasterId}"]`);
const select = (page: Page) => page.getByRole("button", { name: `Select image refinement ${rasterId}`, exact: true });
// Saved refinements, selection recovery and vector conversion live in the
// "Saved versions and options" sheet inside the Logo brief and history dialog.
async function openSavedWork(page: Page) {
  const saved = page.getByRole("dialog", { name: "Saved versions and options", exact: true });
  if (await saved.isVisible()) return saved;
  const context = page.getByRole("dialog", { name: "Logo brief and history", exact: true });
  if (!await context.isVisible()) await page.getByRole("button", { name: "Logo brief and history", exact: true }).click();
  await context.getByRole("button", { name: "Saved versions and options", exact: true }).click();
  await expect(saved).toBeVisible(); return saved;
}
// The optional vector conversion shows its estimate automatically; no other quote may be requested.
const generationQuotes = (f: Awaited<ReturnType<typeof fixture>>) => f.quotes.filter(quote => quote.operation !== "vectorize");
async function closeSheets(page: Page) {
  for (let open = await page.locator("dialog[open]").count(); open > 0; open--) await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
}

test("refine_reload_select_vectorize_uses_retained_raster", async ({ page }) => {
  const f = await fixture(page); const composer = page.getByRole("form", { name: "Logo concept changes" });
  await composer.getByRole("textbox", { name: "Describe a change to this logo" }).fill("Simplify the silhouette");
  // No cost is shown; one deliberate click starts the request once it is ready.
  await expect(composer.getByRole("button", { name: "Refine", exact: true })).toBeEnabled();
  expect(f.admissions).toHaveLength(0); await composer.getByRole("button", { name: "Refine", exact: true }).click();
  await expect.poll(() => f.admissions.length).toBe(1);
  // A refinement that completes in this session becomes the selected logo; reload must retain that raster.
  await expect(composer.getByText("Your refined logo is ready on its card.", { exact: true })).toBeVisible();
  await expect.poll(() => f.selections.map(selection => selection.source)).toEqual([selectedRaster]);
  await reloadSavedWorkspace(page); const saved = await openSavedWork(page);
  await expect(card(page)).toBeVisible(); await expect(card(page).getByRole("img", { name: "Image preview of saved logo refinement" })).toBeVisible();
  expect(f.detailReads).toContain(rasterId); expect(f.workspace.stages.refinements).not.toBeNull(); expect(f.workspace.approvedLogo).toBeNull();
  await expect(select(page)).toHaveAttribute("aria-pressed", "true"); expect(f.selections).toHaveLength(1);
  // Optional vector conversion prepares the retained raster without starting another request.
  await expect.poll(() => f.quotes.at(-1)).toMatchObject({ operation: "vectorize", source: selectedRaster });
  await expect(saved.getByRole("button", { name: "Convert to vector", exact: true })).toBeEnabled(); expect(f.admissions).toHaveLength(1);
  expect(JSON.stringify(f.batch)).toBe(f.originalBatch); expect(f.raster.preview!.reference.contentHash).not.toBe(f.batch.slots[0]!.acceptedPreview!.reference.contentHash);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reloadSavedWorkspace(page); await openSavedWork(page); await expect(select(page)).toHaveAttribute("aria-pressed", "true"); expect(f.admissions).toHaveLength(1);
});

test("completed refinements remain inspectable and selectable with image generation unavailable", async ({ page }) => {
  const f = await fixture(page, true); f.imageAvailable = false; const saved = await openSavedWork(page); await saved.getByRole("button", { name: "Refresh operation availability" }).click();
  await expect(select(page)).toBeEnabled(); await select(page).click(); await expect(select(page)).toHaveAttribute("aria-pressed", "true");
  await expect(saved.getByRole("button", { name: "Refine selected image refinement" })).toBeDisabled();
  await expect(card(page)).toContainText("Confirmed charge: $0.10"); await expect(card(page)).toContainText("Vector conversion and approval follow separately");
  expect(f.admissions).toHaveLength(0); expect(f.workspace.approvedLogo).toBeNull();
});

test("unconfirmed selection checks then retries the exact body and key without image generation", async ({ page }) => {
  const f = await fixture(page, true); f.loseSelection = true; const saved = await openSavedWork(page); await expect(select(page)).toBeEnabled(); await select(page).click();
  await expect(saved.getByRole("button", { name: "Check my choice", exact: true })).toBeVisible(); const original = structuredClone(f.selections[0]);
  await saved.getByRole("button", { name: "Check my choice", exact: true }).click(); expect(f.selections).toHaveLength(1);
  await saved.getByRole("button", { name: "Save my choice again", exact: true }).click(); await expect(select(page)).toHaveAttribute("aria-pressed", "true");
  expect(f.selections).toEqual([original, original]); expect(f.admissions).toHaveLength(0); expect(generationQuotes(f)).toHaveLength(0);
});

test("draft changes keep refinement history visible while preventing selection", async ({ page }) => {
  const f = await fixture(page, true); await openSavedWork(page); await expect(select(page)).toBeEnabled(); await closeSheets(page);
  await page.getByRole("button", { name: "Logo brief and history", exact: true }).click(); await page.getByRole("textbox", { name: "What the business does" }).fill("Keep my unsaved change");
  const saved = await openSavedWork(page); await expect(select(page)).toBeDisabled(); await expect(card(page)).toBeVisible(); await saved.getByRole("button", { name: "Refresh saved image refinements" }).click();
  await expect(page.getByRole("textbox", { name: "What the business does", includeHidden: true })).toHaveValue("Keep my unsaved change"); expect(f.selections).toHaveLength(0); expect(f.admissions).toHaveLength(0);
});

test("saved concept and refinement comparison keeps selection and previous versions", async ({ page }, info) => {
  const f = await fixture(page, true); await openSavedWork(page);
  await page.getByRole("button", { name: `Compare image refinement ${rasterId} with source`, exact: true }).click(); await closeSheets(page);
  const comparison = page.getByRole("region", { name: "Compare saved logos" });
  await expect(comparison.getByRole("img")).toHaveCount(2);
  await expect(comparison.getByRole("img").first()).toBeVisible();
  await expect(comparison.getByRole("img").last()).toBeVisible();
  expect(f.selections).toHaveLength(0); expect(generationQuotes(f)).toHaveLength(0); expect(f.admissions).toHaveLength(0);
  // The concept gallery hides per-card compare controls; the two-item limit still disables adding a third.
  await expect(page.getByRole("button", { name: "Compare concept 2", exact: true, includeHidden: true })).toBeDisabled();
  await comparison.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("logo-version-comparison.png"), fullPage: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await comparison.getByRole("button", { name: "Use comparison version 2", exact: true }).click();
  await openSavedWork(page); await expect(select(page)).toHaveAttribute("aria-pressed", "true");
  expect(f.selections[0]?.source).toEqual(selectedRaster); expect(JSON.stringify(f.batch)).toBe(f.originalBatch);
  expect(generationQuotes(f)).toHaveLength(0); expect(f.admissions).toHaveLength(0);
  await reloadSavedWorkspace(page); await openSavedWork(page); await expect(select(page)).toHaveAttribute("aria-pressed", "true");
});
