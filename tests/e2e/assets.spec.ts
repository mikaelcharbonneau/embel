import { captureUiEvidence } from "./ui-evidence";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";
import { assetDetailSchema, assetLibraryPageSchema, assetLibraryQuerySchema, assetRevisionFreshness, assetVersionDetailSchema, isAssetRetained, type AssetDetail, type AssetLibraryItem, type AssetLibraryQuery, type AssetRecord, type AssetVersionDetail } from "../../src/domain/asset-library";

// Synthetic account fixtures. These tests do not call a provider, database or storage service.
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId = id(1), otherOwner = id(999);
const realPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=", "base64");
const hash = createHash("sha256").update(realPng).digest("hex");
const timestamp = (n: number) => `2026-10-04T12:${String(n).padStart(2, "0")}:00Z`;
const project = (n: number, title = n === 2 ? "Lumen Studio" : "Morrow Works") => ({ id: id(n), owner_id: ownerId, title, scope: "complete_brand" as const, current_revision: 2, created_at: timestamp(0) });
const version = (asset: AssetRecord, n: number, format = "png", metadataOnly = false): AssetVersionDetail => assetVersionDetailSchema.parse({ ownerId, projectId: asset.projectId, assetId: asset.id, versionId: id(Number(asset.id.slice(-12)) * 10 + n), contentHash: hash, versionNumber: n, inputRevision: n === 3 ? 2 : 1, inputHash: "a".repeat(64), createdAt: timestamp(n), mimeType: ({ png: "image/png", svg: "image/svg+xml", pdf: "application/pdf", jpeg: "image/jpeg" } as Record<string, string>)[format], format, provenance: { status: "legacy_unverified" }, vectorStatus: "unverified", licenseStatus: "unverified", fileState: metadataOnly ? "metadata_only" : "unverified", fileVerification: null, freshness: assetRevisionFreshness(n === 3 ? 2 : 1, 2) });
function entry(n: number, flags: Partial<AssetRecord> = {}, format = "png"): AssetDetail {
  const asset: AssetRecord = { id: id(n), ownerId, projectId: id(n % 2 ? 2 : 3), kind: ["", "Primary mark", "Color guide", "Wordmark", "Packaging", "Exploration", "Secondary mark"][n - 9]!, purpose: "legacy_unknown", createdAt: timestamp(n), versionCount: 3, liked: false, saved: false, retentionRevision: 0, usage: { active: false, legacy: false }, selectionRevision: 1, currentSelection: { id: id(500 + n), ownerId, projectId: id(n % 2 ? 2 : 3), assetId: id(n), versionId: id(n * 10 + 3), reason: "selected", createdAt: timestamp(5), receipt: { status: "legacy_unverified" } }, ...flags };
  const versions = [version(asset, 3, format, format === "pdf"), version(asset, 2, "svg"), version(asset, 1)];
  return assetDetailSchema.parse({ asset, project: project(n % 2 ? 2 : 3), selectedVersion: versions[0], versions: { ownerId, projectId: asset.projectId, assetId: asset.id, format: null, items: versions, totalCount: versions.length, nextCursor: null } });
}
function model() { return [entry(10, { liked: true }), entry(11, { saved: true }, "pdf"), entry(12, { usage: { active: true, legacy: false } }, "svg"), entry(13, { usage: { active: false, legacy: true } }), entry(14), entry(15, { liked: true, saved: true })].reverse(); }
function libraryItem(detail: AssetDetail, query: AssetLibraryQuery): AssetLibraryItem | null {
  const matching = detail.versions.items.filter(row => !query.format || row.format === query.format);
  if (query.format && !matching.length) return null;
  const items = matching.slice(0, 4), last = items.at(-1)!;
  return { asset: detail.asset, project: detail.project, selectedVersion: detail.selectedVersion, displayedVersion: detail.selectedVersion && (!query.format || detail.selectedVersion.format === query.format) ? detail.selectedVersion : items[0] ?? null, matchingVersions: { ...detail.versions, format: query.format ?? null, items, totalCount: matching.length, nextCursor: matching.length > items.length ? { createdAt: last.createdAt, versionId: last.versionId, assetId: detail.asset.id, projectId: detail.asset.projectId, format: query.format ?? null } : null } };
}
type Fixture = { rows: AssetDetail[]; reads: number; mutationBodies: unknown[]; detailPageSize: number; pageSize: number; owner: string; listStatus: number; previewStatus: number; fileStatus: number; holdRead: number; held: (() => Promise<void>) | null; corrupt: boolean; selectionStatus: number; lostRetention: boolean; projectsStatus: number };
async function setup(page: Page, existing?: Fixture) {
  const fixture: Fixture = existing ?? { rows: model(), reads: 0, mutationBodies: [], detailPageSize: 40, pageSize: 40, owner: ownerId, listStatus: 200, previewStatus: 200, fileStatus: 404, holdRead: 0, held: null, corrupt: false, selectionStatus: 200, lostRetention: false, projectsStatus: 200 };
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    if (url.pathname === "/api/session") return json(route, { user: { id: fixture.owner } });
    if (url.pathname === "/api/projects") return json(route, { projects: [project(2), project(3)] }, fixture.projectsStatus);
    if (/\/preview$/.test(url.pathname)) return route.fulfill({ status: fixture.previewStatus, contentType: "image/png", body: fixture.previewStatus === 200 ? realPng : "Unavailable synthetic file" });
    if (/\/download$/.test(url.pathname)) return json(route, { error: { code: "file_unavailable", message: "Synthetic private failure must not be rendered" } }, fixture.fileStatus);
    if (url.pathname === "/api/assets") {
      fixture.reads += 1;
      if (fixture.listStatus !== 200) return json(route, { error: { code: "unavailable" } }, fixture.listStatus);
      const query = assetLibraryQuerySchema.parse({ ...Object.fromEntries(url.searchParams), limit: Number(url.searchParams.get("limit") ?? 40), ...(url.searchParams.has("cursor") ? { cursor: JSON.parse(url.searchParams.get("cursor")!) } : {}) });
      const all = fixture.rows.filter(row => (!query.projectId || row.project.id === query.projectId) && (query.tab === "all_generations" || isAssetRetained(row.asset))).map(row => libraryItem(row, query)).filter((row): row is AssetLibraryItem => row !== null);
      const start = query.cursor ? all.findIndex(row => row.asset.id === query.cursor!.assetId) + 1 : 0;
      const items = all.slice(start, start + fixture.pageSize), last = items.at(-1)?.asset;
      const response = assetLibraryPageSchema.parse({ ownerId, query, items, nextCursor: last && start + items.length < all.length ? { createdAt: last.createdAt, assetId: last.id, tab: query.tab, projectId: query.projectId ?? null, format: query.format ?? null } : null });
      const body = structuredClone(response);
      if (fixture.corrupt && body.items[0]) body.items[0].matchingVersions.items[0] = { ...body.items[0].matchingVersions.items[0]!, ownerId: otherOwner };
      if (fixture.holdRead === fixture.reads) { fixture.held = () => json(route, body); return; }
      return json(route, body);
    }
    const match = url.pathname.match(/^\/api\/assets\/library\/([^/]+)(?:\/(retention|selection))?$/);
    if (match) {
      const index = fixture.rows.findIndex(row => row.asset.id === match[1]), row = fixture.rows[index];
      if (!row) return json(route, {}, 404);
      if (method === "GET") {
        const cursor = url.searchParams.get("cursor"), start = cursor ? row.versions.items.findIndex(item => item.versionId === JSON.parse(cursor).versionId) + 1 : 0;
        const items = row.versions.items.slice(start, start + fixture.detailPageSize), last = items.at(-1)!;
        return json(route, assetDetailSchema.parse({ ...row, versions: { ...row.versions, items, nextCursor: start + items.length < row.versions.totalCount ? { createdAt: last.createdAt, versionId: last.versionId, assetId: row.asset.id, projectId: row.asset.projectId, format: null } : null } }));
      }
      const body = route.request().postDataJSON(); fixture.mutationBodies.push(body);
      if (match[2] === "retention") {
        if (body.expectedRetentionRevision !== row.asset.retentionRevision) return json(route, {}, 409);
        const next = { ...row, asset: { ...row.asset, liked: body.liked, saved: body.saved, retentionRevision: row.asset.retentionRevision + 1 } }; fixture.rows[index] = next;
        if (fixture.lostRetention) { fixture.lostRetention = false; return route.abort("failed"); }
        return json(route, { asset: next.asset, project: next.project });
      }
      if (fixture.selectionStatus !== 200) return json(route, {}, fixture.selectionStatus);
      const chosen = row.versions.items.find(version => version.versionId === body.versionId)!;
      if (body.expectedSelectionRevision !== row.asset.selectionRevision || body.expectedProjectRevision !== row.project.current_revision || (chosen.freshness.status === "stale" && !body.acceptStaleBasis)) return json(route, {}, 409);
      const next = assetDetailSchema.parse({ ...row, asset: { ...row.asset, selectionRevision: row.asset.selectionRevision + 1, currentSelection: { ...row.asset.currentSelection!, id: id(800 + fixture.mutationBodies.length), versionId: chosen.versionId, reason: "restored", receipt: { status: "recorded", projectRevision: row.project.current_revision, acceptedStaleBasis: body.acceptStaleBasis, previousSelectionId: row.asset.currentSelection!.id } } }, selectedVersion: chosen }); fixture.rows[index] = next;
      return json(route, next);
    }
    return json(route, { error: { code: "integration_unavailable" } }, 503);
  });
  return fixture;
}
const openPrimary = (page: Page) => page.getByRole("button", { name: "Open Primary mark from Morrow Works", exact: true });
async function ready(page: Page) { await page.goto("/assets"); await expect(page.getByRole("tab", { name: "My selection", exact: true })).toHaveAttribute("aria-selected", "true"); await expect(openPrimary(page)).toBeVisible(); }

test("assets fixture: default union deduplicates liked, saved, used and legacy use", async ({ page }) => {
  await setup(page); await ready(page);
  await expect(page.getByRole("article")).toHaveCount(5);
  await expect(page.getByText("Used in brand", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Legacy use", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open Exploration from Morrow Works" })).toHaveCount(0);
  await page.getByRole("tab", { name: "All generations", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(6);
  await expect(page.getByRole("button", { name: "Open Exploration from Morrow Works" })).toBeVisible();
  await expect(page.getByText("Image generation is not connected.", { exact: false })).toBeVisible();
});
test("assets fixture: unlike remains saved and does not change brand use or selection", async ({ page }) => {
  const fixture = await setup(page); await ready(page);
  await page.getByRole("button", { name: "Unlike Secondary mark from Lumen Studio", exact: true }).click();
  await expect(page.getByRole("button", { name: "Like Secondary mark from Lumen Studio", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unsave Secondary mark from Lumen Studio", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(fixture.mutationBodies).toEqual([{ expectedRetentionRevision: 0, liked: false, saved: true }]);
  expect(fixture.rows.find(row => row.asset.id === id(15))!.asset.selectionRevision).toBe(1);
});
test("assets fixture: server brand and format filters preserve displayed versus selected versions", async ({ page }) => {
  await setup(page); await ready(page);
  await page.getByRole("combobox", { name: "Brand", exact: true }).selectOption(id(3));
  await page.getByRole("combobox", { name: "File type", exact: true }).selectOption("svg");
  const primary = page.getByRole("article", { name: "Primary mark · Morrow Works", exact: true });
  await expect(primary.getByText("Selected v3", { exact: true })).toBeVisible();
  await expect(primary.getByText("Preview v2", { exact: true })).toBeVisible();
  await expect(primary.getByText("3 versions · 1 SVG", { exact: true })).toBeVisible();
  await primary.getByRole("button", { name: "Save Primary mark from Morrow Works", exact: true }).click();
  await expect(primary.getByText("Preview v2", { exact: true })).toBeVisible();
  await expect(primary.getByRole("img")).toHaveCount(0);
  await openPrimary(page).click();
  await expect(page.getByRole("dialog").getByText("Selected: version 3 · PNG", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Version 2", exact: true })).toBeVisible();
});
test("assets fixture: stale restore needs explicit exact-context acknowledgment", async ({ page }) => {
  const fixture = await setup(page); await ready(page); await openPrimary(page).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Version 1 PNG Earlier context", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Restore this version" })).toBeDisabled();
  await dialog.getByRole("checkbox").check(); await dialog.getByRole("button", { name: "Restore this version" }).click();
  await expect(dialog.getByRole("button", { name: "Selected version", exact: true })).toBeDisabled();
  expect(fixture.mutationBodies[0]).toEqual({ versionId: id(101), expectedProjectRevision: 2, expectedSelectionRevision: 1, acceptStaleBasis: true });
  const row = fixture.rows.find(row => row.asset.id === id(10))!; expect(row.asset.usage).toEqual({ active: false, legacy: false }); expect(row.versions.items).toHaveLength(3);
  await expect(dialog.getByText("Legacy record · provider unverified", { exact: true })).toBeVisible();
  await expect(dialog.getByText("License unverified", { exact: true })).toBeVisible();
});
test("assets fixture: acknowledgment resets when a version changes", async ({ page }) => {
  await setup(page); await ready(page); await openPrimary(page).click(); const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Version 1 PNG Earlier context", exact: true }).click(); await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Version 2 SVG Earlier context", exact: true }).click();
  await expect(dialog.getByRole("checkbox")).not.toBeChecked(); await expect(dialog.getByRole("button", { name: "Restore this version" })).toBeDisabled();
});
test("assets fixture: detail pagination exposes every immutable version", async ({ page }) => {
  const fixture = await setup(page); fixture.detailPageSize = 1; await ready(page); await openPrimary(page).click(); const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("1 of 3", { exact: true })).toBeVisible(); await dialog.getByRole("button", { name: "Load more versions" }).click();
  await expect(dialog.getByText("2 of 3", { exact: true })).toBeVisible(); await dialog.getByRole("button", { name: "Load more versions" }).click();
  await expect(dialog.getByText("3 of 3", { exact: true })).toBeVisible(); await expect(dialog.getByRole("button", { name: "Load more versions" })).toHaveCount(0);
});
test("assets fixture: query-bound library pagination retains its tab and filters", async ({ page }) => {
  const fixture = await setup(page); fixture.pageSize = 2; await page.goto("/assets"); await expect(page.getByRole("article")).toHaveCount(2);
  await page.getByRole("button", { name: "Load more assets", exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(4);
  await page.getByRole("button", { name: "Load more assets", exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Load more assets", exact: true })).toHaveCount(0);
});
test("assets fixture: held filter read clears old rows and cursor", async ({ page }) => {
  const fixture = await setup(page); fixture.pageSize = 2; await page.goto("/assets"); await expect(page.getByRole("article")).toHaveCount(2);
  fixture.holdRead = fixture.reads + 1; await page.getByRole("combobox", { name: "File type", exact: true }).selectOption("pdf");
  await expect(page.getByRole("article")).toHaveCount(0); await expect(page.getByRole("button", { name: "Load more assets", exact: true })).toHaveCount(0);
  await expect.poll(() => fixture.held !== null).toBe(true); await fixture.held!(); await expect(page.getByRole("article")).toHaveCount(1);
});
test("assets fixture: late pre-mutation GET cannot roll back retention", async ({ page }) => {
  const fixture = await setup(page); await ready(page); fixture.holdRead = fixture.reads + 1; await page.getByRole("button", { name: "Check assets", exact: true }).click();
  await expect.poll(() => fixture.held !== null).toBe(true); await page.getByRole("button", { name: "Save Primary mark from Morrow Works", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unsave Primary mark from Morrow Works", exact: true })).toHaveAttribute("aria-pressed", "true");
  await fixture.held!(); await expect(page.getByRole("button", { name: "Unsave Primary mark from Morrow Works", exact: true })).toHaveAttribute("aria-pressed", "true");
});
test("assets fixture: lost retention response requires checking current state before retry", async ({ page }) => {
  const fixture = await setup(page); await ready(page); fixture.lostRetention = true; await page.getByRole("button", { name: "Save Primary mark from Morrow Works", exact: true }).click();
  await expect(page.getByRole("region", { name: "Account asset library" }).getByRole("alert")).toContainText("could not be confirmed"); await expect(page.getByRole("button", { name: "Save Primary mark from Morrow Works", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Check assets again" }).click(); await expect(page.getByRole("button", { name: "Unsave Primary mark from Morrow Works", exact: true })).toBeEnabled(); expect(fixture.mutationBodies).toHaveLength(1);
});
test("assets fixture: selection conflict keeps history and requires a new acknowledgment", async ({ page }) => {
  const fixture = await setup(page); await ready(page); await openPrimary(page).click(); const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Version 1 PNG Earlier context", exact: true }).click(); await dialog.getByRole("checkbox").check(); fixture.selectionStatus = 409;
  await dialog.getByRole("button", { name: "Restore this version" }).click(); await expect(dialog.getByRole("alert")).toContainText("changed");
  await expect(dialog.getByRole("button", { name: "Restore this version" })).toBeDisabled(); fixture.selectionStatus = 200; await dialog.getByRole("button", { name: "Check latest asset" }).click();
  await expect(dialog.getByRole("checkbox")).not.toBeChecked(); await expect(dialog.getByText("3 of 3", { exact: true })).toBeVisible();
});
test("assets fixture: missing download is factual and never reports success", async ({ page }) => {
  await setup(page); await ready(page); await openPrimary(page).click(); const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Check and download" }).click();
  await expect(dialog.getByRole("status")).toContainText("file is unavailable"); await expect(page.getByText("Synthetic private failure must not be rendered")).toHaveCount(0);
  await expect(dialog.getByText("License unverified", { exact: true })).toBeVisible();
});
test("assets fixture: metadata-only file never presents a working download", async ({ page }) => {
  await setup(page); await ready(page); await page.getByRole("button", { name: "Open Color guide from Lumen Studio", exact: true }).click();
  const dialog = page.getByRole("dialog"); await expect(dialog.getByRole("button", { name: "Check and download" })).toBeDisabled(); await expect(dialog.getByText("Metadata only — no stored file", { exact: true })).toBeVisible();
});
test("assets fixture: failed asset read remains retryable without invented empty success", async ({ page }) => {
  const fixture = await setup(page); fixture.listStatus = 503; await page.goto("/assets"); await expect(page.getByRole("region", { name: "Account asset library" }).getByRole("alert")).toContainText("unavailable"); await expect(page.getByText("No saved assets yet", { exact: true })).toHaveCount(0);
  fixture.listStatus = 200; await page.getByRole("button", { name: "Check assets again" }).click(); await expect(openPrimary(page)).toBeVisible();
});
test("assets fixture: failed brand facets do not hide owned library rows", async ({ page }) => {
  const fixture = await setup(page); fixture.projectsStatus = 503; await ready(page); await expect(page.getByText("The brand list could not be loaded.", { exact: false })).toBeVisible(); await expect(page.getByRole("article")).toHaveCount(5);
});
test("assets fixture: invalid nested ownership never renders private rows", async ({ page }) => {
  const fixture = await setup(page); fixture.corrupt = true; await page.goto("/assets"); await expect(page.getByRole("region", { name: "Account asset library" }).getByRole("alert")).toContainText("could not be verified"); await expect(page.getByRole("article")).toHaveCount(0);
});
test("assets fixture: changed account hides and revokes old private previews", async ({ page }) => {
  const fixture = await setup(page); await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL); Object.assign(window, { fixtureUrls: [] as string[], fixtureRevoked: [] as string[] });
    URL.createObjectURL = blob => { const url = create(blob); (window as unknown as { fixtureUrls: string[] }).fixtureUrls.push(url); return url; };
    URL.revokeObjectURL = url => { (window as unknown as { fixtureRevoked: string[] }).fixtureRevoked.push(url); revoke(url); };
  });
  await ready(page); await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureUrls: string[] }).fixtureUrls.length)).toBeGreaterThan(0);
  fixture.owner = otherOwner; fixture.listStatus = 503; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(openPrimary(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => { const w = window as unknown as { fixtureUrls: string[]; fixtureRevoked: string[] }; return w.fixtureUrls.every(url => w.fixtureRevoked.includes(url)); })).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("Primary mark");
});
test("assets fixture: drawer keyboard focus, close return and responsive overflow", async ({ page }) => {
  await setup(page); await ready(page); await openPrimary(page).click(); const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Primary mark", exact: true })).toBeFocused(); await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "Close asset details" })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(openPrimary(page)).toBeFocused();
  await page.getByRole("tab", { name: "My selection", exact: true }).focus(); await page.keyboard.press("ArrowRight"); await expect(page.getByRole("tab", { name: "All generations", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("assets fixture: long names stay within the library and detail viewport", async ({ page }) => {
  const fixture = await setup(page); fixture.rows = fixture.rows.map(row => ({ ...row, asset: { ...row.asset, kind: "ExtraordinaryInternationalIdentityAssetWithoutSpaces" }, project: { ...row.project, title: "Long brand title ".repeat(10) } }));
  await page.goto("/assets"); await expect(page.getByRole("article")).toHaveCount(5); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: /^Open Extraordinary/ }).first().click(); await expect(page.getByRole("dialog")).toBeVisible(); expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});
test("assets fixture: capture stable library and drawer evidence", async ({ page }, info) => {
  await setup(page); await ready(page); await page.getByRole("heading", { name: "Assets", exact: true }).focus(); await page.evaluate(() => scrollTo(0, 0));
  await mkdir(".tmp/identity-assets/ui-evidence", { recursive: true }); await page.screenshot({ path: `.tmp/identity-assets/ui-evidence/assets-library-${info.project.name}.png`, fullPage: true });
  await openPrimary(page).click(); const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Version 1 PNG Earlier context", exact: true }).click();
  await dialog.getByRole("heading", { name: "Primary mark", exact: true }).focus(); await dialog.evaluate(element => element.scrollTo(0, 0));
  await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: `.tmp/identity-assets/ui-evidence/assets-detail-${info.project.name}.png` });
  await dialog.getByRole("button", { name: "Restore this version" }).scrollIntoViewIfNeeded(); await page.screenshot({ path: `.tmp/identity-assets/ui-evidence/assets-detail-controls-${info.project.name}.png` });
});

test("assets fixture: decode failure immediately revokes a private object URL", async ({ page }) => {
  await setup(page); await ready(page);
  const preview = page.getByRole("img", { name: "Secondary mark preview", exact: true }); await expect(preview).toBeVisible();
  const url = await preview.getAttribute("src"); expect(url).toMatch(/^blob:/);
  await preview.dispatchEvent("error");
  await expect(page.getByRole("article", { name: "Secondary mark · Lumen Studio", exact: true }).getByText("Preview unavailable", { exact: true })).toBeVisible();
  expect(await page.evaluate(async source => { try { await fetch(source!); return false; } catch { return true; } }, url)).toBe(true);
});

test("assets fixture: genuine empty views remain distinct from unavailable reads", async ({ page }) => {
  const fixture = await setup(page); fixture.rows = []; await page.goto("/assets");
  await expect(page.getByRole("heading", { name: "No selected assets yet", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Browse all generations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No saved assets yet", exact: true })).toBeVisible();
});
test("assets fixture: zero-version assets and unselected previews are honest", async ({ page }) => {
  const fixture = await setup(page); const empty = fixture.rows.find(row => row.asset.id === id(10))!, unselected = fixture.rows.find(row => row.asset.id === id(15))!;
  fixture.rows = [{ ...empty, asset: { ...empty.asset, currentSelection: null, selectionRevision: 0, versionCount: 0 }, selectedVersion: null, versions: { ...empty.versions, totalCount: 0, items: [] } }, { ...unselected, asset: { ...unselected.asset, currentSelection: null, selectionRevision: 0 }, selectedVersion: null }];
  await ready(page); const first = page.getByRole("article", { name: "Primary mark · Morrow Works", exact: true });
  await expect(first.getByText("No versions yet", { exact: true })).toBeVisible(); await expect(first.getByText("0 versions", { exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "Secondary mark · Lumen Studio", exact: true }).getByText("Preview v3", { exact: true })).toBeVisible();
  await openPrimary(page).click(); await expect(page.getByRole("dialog").getByText("No selected version", { exact: true })).toBeVisible(); await expect(page.getByRole("dialog").getByText("No versions have been saved for this asset.", { exact: true })).toBeVisible();
});
test("assets fixture: removing the last retention flag preserves all generations", async ({ page }) => {
  await setup(page); await ready(page); await page.getByRole("button", { name: "Unlike Primary mark from Morrow Works", exact: true }).click();
  await expect(openPrimary(page)).toHaveCount(0); await page.getByRole("tab", { name: "All generations", exact: true }).click(); await expect(openPrimary(page)).toBeVisible();
});
test("assets fixture: two tabs restore concurrently and the losing choice can be reviewed", async ({ page, context }) => {
  const fixture = await setup(page), other = await context.newPage(); await setup(other, fixture); await ready(page); await ready(other);
  await openPrimary(page).click(); await openPrimary(other).click(); const first = page.getByRole("dialog"), second = other.getByRole("dialog");
  await first.getByRole("button", { name: "Version 1 PNG Earlier context", exact: true }).click(); await first.getByRole("checkbox").check();
  await second.getByRole("button", { name: "Version 2 SVG Earlier context", exact: true }).click(); await second.getByRole("checkbox").check();
  await first.getByRole("button", { name: "Restore this version" }).click(); await expect(first.getByRole("button", { name: "Selected version", exact: true })).toBeDisabled();
  await second.getByRole("button", { name: "Restore this version" }).click(); await expect(second.getByRole("alert")).toContainText("changed");
  await expect(second.getByRole("heading", { name: "Version 2", exact: true })).toBeVisible();
  await second.getByRole("button", { name: "Check latest asset" }).click(); await expect(second.getByText("Selected: version 1 · PNG", { exact: true })).toBeVisible(); await expect(second.getByRole("checkbox")).not.toBeChecked();
  expect(fixture.rows.find(row => row.asset.id === id(10))!.asset.selectionRevision).toBe(2); await other.close();
});
test("assets fixture: metadata auth expiry hides every asset", async ({ page }) => {
  const fixture = await setup(page); await ready(page); fixture.listStatus = 401;
  await page.getByRole("button", { name: "Check assets", exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(0); await expect(page.getByText("No verified account session.", { exact: false })).toBeVisible();
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));
