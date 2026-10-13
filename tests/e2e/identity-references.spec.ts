import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page, type Route } from "@playwright/test";
import { identityReferenceEntrySchema, identityReferenceQuerySchema, identityReferencesOverviewSchema, setReferenceReactionResponseSchema, setReferenceReactionSchema, type IdentityReferenceEntry, type IdentityReferenceQuery } from "../../src/domain/identity-references";
import { accountProjectSchema, type AccountProject } from "../../src/domain/project-api";
import { contextSnapshotSchema, type ProjectScope } from "../../src/domain/projects";

// All images, accounts and responses below are synthetic local fixtures. No discovery,
// provider, database or storage service is contacted or represented as working.
const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId = id(1), projectId = id(2), otherOwner = id(999), base = `/api/projects/${projectId}/identity/references`, url = `/brands/account/${projectId}/identity`;
const when = "2026-10-04T12:00:00Z";
function syntheticPng(variant: number) {
  const size = 240, data = Buffer.alloc(size * (size * 3 + 1));
  const palettes = [[[248, 235, 220], [213, 85, 58], [74, 64, 47]], [[230, 236, 224], [83, 111, 84], [236, 169, 57]], [[234, 230, 237], [98, 83, 121], [195, 115, 130]], [[236, 231, 219], [39, 71, 92], [131, 175, 163]]];
  const palette = palettes[variant % palettes.length]!;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const circle = (x - 120) ** 2 + (y - 105) ** 2 < 62 ** 2, stripe = y > 180 && y < 191 && x > 52 && x < 188;
    const color = circle ? palette[1]! : stripe ? palette[2]! : palette[0]!;
    for (let c = 0; c < 3; c++) data[y * (size * 3 + 1) + 1 + x * 3 + c] = color[c]!;
  }
  function chunk(type: string, bytes: Buffer) { const payload = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff; for (const value of payload) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); payload.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out; }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(data)), chunk("IEND", Buffer.alloc(0))]);
}
const images = Array.from({ length: 4 }, (_, index) => syntheticPng(index));
const labels = ["Warm forms · fixture", "Quiet geometry · fixture", "Editorial rhythm · fixture", "Open composition · fixture", "Soft contrast · fixture", "Structured color · fixture"];
const project = (scope: ProjectScope = "complete_brand"): AccountProject => accountProjectSchema.parse({ id: projectId, owner_id: ownerId, title: "Synthetic identity project", scope, current_revision: 1, created_at: when, context: contextSnapshotSchema.parse({ description: "A synthetic identity brief with no reviewed strategy and no name." }) });
function entry(n: number): IdentityReferenceEntry { return identityReferenceEntrySchema.parse({ reference: { id: id(10 + n), ownerId, projectId, createdAt: new Date(Date.parse(when) - n * 1000).toISOString(), media: { ownerId, projectId, assetId: id(100 + n), versionId: id(200 + n), contentHash: createHash("sha256").update(images[n % 4]!).digest("hex"), purpose: "reference_media", mimeType: "image/png" }, source: "user_supplied", attribution: { label: labels[n] ?? `Reference ${n} · fixture`, creator: "Synthetic local image", sourceUrl: n === 0 ? "https://reference.example.invalid/fixture" : null, rightsNote: "Synthetic image used only for local interface tests." }, relevantElements: n === 0 ? ["logo", "colors"] : n === 1 ? ["typography", "composition"] : ["logo", "typography", "colors", "graphics", "images", "composition"], tags: n % 2 ? ["geometric", "quiet"] : ["soft", "warm"] }, reaction: { ownerId, projectId, referenceId: id(10 + n), revision: 0, ensemble: false, elements: [], updatedAt: null } }); }
type Fixture = { owner: string; sessionStatus: number; project: AccountProject; rows: IdentityReferenceEntry[]; revision: number; reads: IdentityReferenceQuery[]; writes: { id: string; body: ReturnType<typeof setReferenceReactionSchema.parse> }[]; pageSize: number; readStatus: number; previewStatus: number; corrupt: boolean; tagsComplete: boolean; extraTags: string[]; lostWrite: boolean; writeStatus: number; holdRead: number; heldRead: (() => Promise<void>) | null; holdWrite: number; heldWrite: (() => Promise<void>) | null; projectPatchStatus: number; holdProjectPatch: boolean; heldProjectPatch: (() => Promise<void>) | null; previewBytes: Buffer | null };
async function setup(page: Page, existing?: Fixture) {
  const fixture: Fixture = existing ?? { owner: ownerId, sessionStatus: 200, project: project(), rows: Array.from({ length: 6 }, (_, index) => entry(index)), revision: 0, reads: [], writes: [], pageSize: 40, readStatus: 200, previewStatus: 200, corrupt: false, tagsComplete: true, extraTags: [], lostWrite: false, writeStatus: 200, holdRead: 0, heldRead: null, holdWrite: 0, heldWrite: null, projectPatchStatus: 200, holdProjectPatch: false, heldProjectPatch: null, previewBytes: null };
  const json = async (route: Route, value: unknown, status = 200) => { try { await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) }); } catch { /* A fenced request may have been aborted by the browser. */ } };
  await page.route("**/api/**", async route => {
    const request = route.request(), parsed = new URL(request.url()), path = parsed.pathname;
    if (path === "/api/auth/sign-out") { fixture.sessionStatus = 401; return json(route, { authenticated: false }); }
    if (path === "/api/session") return json(route, { user: { id: fixture.owner } }, fixture.sessionStatus);
    if (path === `/api/projects/${projectId}`) {
      if (fixture.owner !== ownerId) return json(route, {}, 404);
      if (request.method() === "GET") return json(route, { project: fixture.project });
      const body = request.postDataJSON();
      if (fixture.projectPatchStatus !== 200) return json(route, {}, fixture.projectPatchStatus);
      fixture.project = { ...fixture.project, title: body.title, context: contextSnapshotSchema.parse(body.context), current_revision: fixture.project.current_revision + 1 };
      const response = { revision: { owner_id: ownerId, project_id: projectId, revision: fixture.project.current_revision, context: fixture.project.context, input_hash: "fixture-only", created_at: when } };
      if (fixture.holdProjectPatch) { fixture.heldProjectPatch = () => json(route, response); return; } return json(route, response);
    }
    if (path === `/api/projects/${projectId}/strategy`) return json(route, { availability: { status: "unavailable", operations: [], reason: "runtime_disabled" }, jobs: [] });
    if (path === base && request.method() === "GET") {
      const query = identityReferenceQuerySchema.parse({ limit: Number(parsed.searchParams.get("limit") ?? 40), excludedTags: parsed.searchParams.getAll("excludedTag"), ...(parsed.searchParams.has("cursor") ? { cursor: JSON.parse(parsed.searchParams.get("cursor")!) } : {}) }); fixture.reads.push(query);
      if (fixture.readStatus !== 200) return json(route, {}, fixture.readStatus);
      const all = fixture.rows.filter(row => !row.reference.tags.some(tag => query.excludedTags.includes(tag))), start = query.cursor ? all.findIndex(row => row.reference.id === query.cursor!.referenceId) + 1 : 0;
      const items = all.slice(start, start + Math.min(query.limit, fixture.pageSize)), last = items.at(-1)?.reference;
      const response = identityReferencesOverviewSchema.parse({ ownerId, projectId, query, referenceRevision: fixture.revision, selectedReferenceCount: fixture.rows.filter(row => row.reaction.ensemble || row.reaction.elements.length).length, feed: { status: "unavailable", reason: "reference_source_unconfigured" }, availableTags: [...new Set([...fixture.extraTags, ...fixture.rows.flatMap(row => row.reference.tags), ...query.excludedTags])], tagsComplete: fixture.tagsComplete, references: { items, nextCursor: last && start + items.length < all.length ? { projectId, createdAt: last.createdAt, referenceId: last.id, excludedTags: query.excludedTags } : null } });
      if (fixture.corrupt && response.references.items[0]) response.references.items[0].reference.media.ownerId = otherOwner;
      if (fixture.holdRead === fixture.reads.length) { fixture.heldRead = () => json(route, response); return; } return json(route, response);
    }
    if (path.startsWith(`${base}/`) && request.method() === "PATCH") {
      const referenceId = path.split("/").at(-1)!, body = setReferenceReactionSchema.parse(request.postDataJSON()); fixture.writes.push({ id: referenceId, body });
      const row = fixture.rows.find(row => row.reference.id === referenceId)!;
      if (fixture.writeStatus !== 200) return json(route, {}, fixture.writeStatus);
      if (row.reaction.revision !== body.expectedRevision) return json(route, {}, 409);
      row.reaction = { ...row.reaction, revision: row.reaction.revision + 1, ensemble: body.ensemble, elements: body.elements, updatedAt: when }; fixture.revision += 1;
      const response = setReferenceReactionResponseSchema.parse({ ownerId, projectId, referenceRevision: fixture.revision, selectedReferenceCount: fixture.rows.filter(row => row.reaction.ensemble || row.reaction.elements.length).length, entry: row });
      if (fixture.lostWrite) { fixture.lostWrite = false; return route.abort("failed"); }
      if (fixture.holdWrite === fixture.writes.length) { fixture.heldWrite = () => json(route, response); return; } return json(route, response);
    }
    if (path.endsWith("/preview")) { const versionId = path.split("/").at(-2)!, index = Number(versionId.slice(-12)) - 200; return route.fulfill({ status: fixture.previewStatus, contentType: "image/png", body: fixture.previewBytes ?? images[index % 4]! }); }
    return json(route, {}, 503);
  });
  return fixture;
}
const card = (page: Page, index = 0) => page.getByRole("article", { name: labels[index], exact: true });
async function ready(page: Page) { await page.goto(url); await expect(card(page)).toBeVisible(); }
async function openElements(page: Page, index = 0) { const control = card(page, index).getByRole("button", { name: new RegExp(`^(Show|Hide) elements for`) }); if (await control.getAttribute("aria-expanded") !== "true") { await control.focus(); await control.press("Enter"); } await expect(card(page, index).getByRole("group", { name: /^Elements in/ })).toBeVisible(); }
async function rename(page: Page) { await page.getByRole("button", { name: "Rename project", exact: true }).click(); await page.getByRole("textbox", { name: "Project label", exact: true }).fill("Unsaved private identity brief"); await page.getByRole("textbox", { name: "Project label", exact: true }).press("Enter"); }
async function waitWrite(page: Page, fixture: Fixture, count: number) { await expect.poll(() => fixture.writes.length).toBe(count); await expect(page.getByText("Saving…", { exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "Check references", exact: true })).toBeEnabled(); }
async function trackUrls(page: Page) { await page.addInitScript(() => { const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL); Object.assign(window, { referenceUrls: [] as string[], revokedReferenceUrls: [] as string[] }); URL.createObjectURL = blob => { const url = create(blob); (window as unknown as { referenceUrls: string[] }).referenceUrls.push(url); return url; }; URL.revokeObjectURL = url => { (window as unknown as { revokedReferenceUrls: string[] }).revokedReferenceUrls.push(url); revoke(url); }; }); }

for (const scope of ["complete_brand", "visual_identity_only"] as const) test(`references fixture: ${scope} opens the grid before strategy or a name`, async ({ page }) => {
  const fixture = await setup(page); fixture.project = project(scope); await ready(page);
  await expect(page.getByRole("heading", { name: "Identity", exact: true })).toBeVisible(); await expect(page.getByRole("region", { name: "Brand references" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toHaveCount(0); await expect(page.getByRole("article")).toHaveCount(6); expect(fixture.writes).toHaveLength(0);
});
test("references fixture: an unavailable source preserves real persisted references and independent likes", async ({ page }) => {
  const fixture = await setup(page); await ready(page); await expect(page.getByText("Reference discovery is not connected. Your saved references remain available.", { exact: true })).toBeVisible();
  await openElements(page); await card(page).getByRole("button", { name: "Logo", exact: true }).click(); await waitWrite(page, fixture, 1); await openElements(page); await card(page).getByRole("button", { name: "Colors", exact: true }).click(); await waitWrite(page, fixture, 2);
  const ensemble = card(page).getByRole("button", { name: /^Ensemble for/ }); await expect(ensemble).toHaveAttribute("aria-pressed", "false"); await ensemble.click(); await waitWrite(page, fixture, 3); await ensemble.click(); await waitWrite(page, fixture, 4);
  expect(fixture.writes.map(write => write.body)).toEqual([{ expectedRevision: 0, ensemble: false, elements: ["logo"] }, { expectedRevision: 1, ensemble: false, elements: ["logo", "colors"] }, { expectedRevision: 2, ensemble: true, elements: ["logo", "colors"] }, { expectedRevision: 3, ensemble: false, elements: ["logo", "colors"] }]);
  await page.getByRole("heading", { name: "Build a visual starting point", exact: true }).focus(); await expect(card(page).getByLabel(/^Saved choices for/)).toContainText("Logo"); await expect(card(page).getByLabel(/^Saved choices for/)).toContainText("Colors"); await expect(page.getByText("1 reference selected in this project", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("Warm forms");
});
test("references fixture: naming-only links explicit scope expansion without reading references", async ({ page }) => {
  const fixture = await setup(page); fixture.project = project("naming_only"); await page.goto(url);
  await expect(page.getByRole("heading", { name: "Expand this project to start Identity" })).toBeVisible(); await expect(page.getByRole("link", { name: "Open project", exact: true })).toHaveAttribute("href", `/brands/account/${projectId}`);
  await expect(page.getByRole("region", { name: "Brand references" })).toHaveCount(0); expect(fixture.reads).toHaveLength(0); expect(fixture.writes).toHaveLength(0);
});
test("references fixture: empty source is honest and failed reads are not empty success", async ({ page }) => {
  const fixture = await setup(page); fixture.rows = []; fixture.readStatus = 503; await page.goto(url);
  await expect(page.getByRole("region", { name: "Brand references" }).getByRole("alert")).toContainText("unavailable"); await expect(page.getByText("No saved references yet", { exact: true })).toHaveCount(0);
  fixture.readStatus = 200; await page.getByRole("button", { name: "Check references again" }).click(); await expect(page.getByRole("heading", { name: "No saved references yet" })).toBeVisible(); await expect(page.getByText("Reference discovery is not connected. No sample references have been added to your project.", { exact: true })).toBeVisible();
});
test("references fixture: keyboard disclosure exposes only relevant elements", async ({ page }) => {
  await setup(page); await ready(page); await page.getByRole("heading", { name: "Build a visual starting point", exact: true }).focus();
  const disclosure = card(page).getByRole("button", { name: /^(Show|Hide) elements for Warm forms · fixture$/ }); await disclosure.focus(); await disclosure.press("Enter");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true"); await disclosure.press("Tab"); await expect(card(page).getByRole("button", { name: "Logo", exact: true })).toBeFocused();
  await expect(card(page).getByRole("button", { name: "Typography", exact: true })).toHaveCount(0); await expect(card(page).getByRole("button", { name: "Colors", exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("references fixture: touch-style disclosure remains independently operable", async ({ page }) => {
  await setup(page); await ready(page); const disclosure = card(page).getByRole("button", { name: /elements for Warm forms/ }); await disclosure.dispatchEvent("click"); await expect(disclosure).toHaveAttribute("aria-expanded", "true"); await disclosure.dispatchEvent("click"); await expect(disclosure).toHaveAttribute("aria-expanded", "false");
});
test("references fixture: actual tags filter the server page and incomplete suggestions are labeled", async ({ page }) => {
  const fixture = await setup(page); fixture.tagsComplete = false; await ready(page); await page.getByText("Exclude tags", { exact: true }).click(); await expect(page.getByText("These suggestions are incomplete. More tags may appear as references load.", { exact: true })).toBeVisible(); await page.getByRole("checkbox", { name: "warm", exact: true }).check();
  await expect(card(page)).toHaveCount(0); await expect(page.getByRole("article")).toHaveCount(3); expect(fixture.reads.at(-1)!.excludedTags).toEqual(["warm"]); await expect(page.getByRole("button", { name: "Include warm again" })).toBeVisible(); await page.getByRole("button", { name: "Clear exclusions" }).click(); await expect(page.getByRole("article")).toHaveCount(6);
});
test("references fixture: held and failed filter reads clear old rows and continuation", async ({ page }) => {
  const fixture = await setup(page); fixture.pageSize = 2; await ready(page); fixture.holdRead = fixture.reads.length + 1;
  await page.getByText("Exclude tags", { exact: true }).click(); await page.getByRole("checkbox", { name: "warm", exact: true }).check(); await expect.poll(() => fixture.heldRead).not.toBeNull(); await expect(page.getByRole("article")).toHaveCount(0); await expect(page.getByRole("button", { name: "Load more references" })).toHaveCount(0); await fixture.heldRead!(); await expect(page.getByRole("article")).toHaveCount(2);
  fixture.readStatus = 503; await page.getByRole("button", { name: "Clear exclusions" }).click(); await expect(page.getByRole("region", { name: "Brand references" }).getByRole("alert")).toContainText("unavailable"); await expect(page.getByRole("article")).toHaveCount(0); fixture.readStatus = 200; await page.getByRole("button", { name: "Check references again" }).click(); await expect(card(page)).toBeVisible();
});
test("references fixture: pagination retains both loaded pages after a page-two reaction", async ({ page }) => {
  const fixture = await setup(page); fixture.pageSize = 2; await ready(page); await page.getByRole("button", { name: "Load more references" }).click(); await expect(page.getByRole("article")).toHaveCount(4);
  await card(page, 2).getByRole("button", { name: /^Ensemble for/ }).click(); await waitWrite(page, fixture, 1); await expect(page.getByRole("article")).toHaveCount(4); await expect(card(page, 2).getByRole("button", { name: /^Ensemble for/ })).toHaveAttribute("aria-pressed", "true"); expect(fixture.reads.at(-1)!.cursor?.referenceId).toBe(id(11));
});
test("references fixture: pages from different aggregate revisions cannot be combined", async ({ page }) => {
  const fixture = await setup(page); fixture.pageSize = 2; await ready(page); fixture.revision = 1; await page.getByRole("button", { name: "Load more references" }).click(); await expect(page.getByRole("region", { name: "Brand references" }).getByRole("alert")).toContainText("could not be loaded"); await expect(page.getByRole("article")).toHaveCount(2);
  await page.getByRole("button", { name: "Check references again" }).click(); await expect(page.getByRole("button", { name: "Check references", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Load more references" }).click(); await expect(page.getByRole("article")).toHaveCount(4);
});
test("references fixture: late old reads cannot roll back a successful reaction", async ({ page }) => {
  const fixture = await setup(page); await ready(page); fixture.holdRead = fixture.reads.length + 1; await page.getByRole("button", { name: "Check references", exact: true }).click(); await expect.poll(() => fixture.heldRead).not.toBeNull();
  await card(page).getByRole("button", { name: /^Ensemble for/ }).click(); await waitWrite(page, fixture, 1); await fixture.heldRead!(); await expect(card(page).getByRole("button", { name: /^Ensemble for/ })).toHaveAttribute("aria-pressed", "true"); await expect(page.getByText("1 reference selected in this project", { exact: true })).toBeVisible();
});
test("references fixture: independent out-of-order writes keep authoritative aggregate counts", async ({ page }) => {
  const fixture = await setup(page); await ready(page); fixture.holdWrite = 1; await card(page).getByRole("button", { name: /^Ensemble for/ }).click(); await expect.poll(() => fixture.heldWrite).not.toBeNull();
  await card(page, 1).getByRole("button", { name: /^Ensemble for/ }).click(); await expect(page.getByText("2 references selected in this project", { exact: true })).toBeVisible(); await fixture.heldWrite!(); await waitWrite(page, fixture, 2); await expect(page.getByText("2 references selected in this project", { exact: true })).toBeVisible(); await expect(card(page).getByRole("button", { name: /^Ensemble for/ })).toHaveAttribute("aria-pressed", "true");
});
test("references fixture: lost successful response is checked without replaying the write", async ({ page }) => {
  const fixture = await setup(page); fixture.lostWrite = true; await ready(page); await card(page).getByRole("button", { name: /^Ensemble for/ }).click(); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toBeVisible(); await expect(card(page).getByRole("button", { name: /^Ensemble for/ })).toBeDisabled();
  await page.getByRole("button", { name: "Check latest choices" }).click(); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toHaveCount(0); await expect(card(page).getByRole("button", { name: /^Ensemble for/ })).toHaveAttribute("aria-pressed", "true"); expect(fixture.writes).toHaveLength(1);
});
test("references fixture: conflicts preserve pending choices until explicit resolution", async ({ page }) => {
  const fixture = await setup(page); await ready(page); fixture.rows[0]!.reaction = { ...fixture.rows[0]!.reaction, ensemble: true, revision: 1, updatedAt: when }; fixture.revision = 1;
  await openElements(page); await card(page).getByRole("button", { name: "Logo", exact: true }).click(); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toBeVisible(); await page.getByRole("button", { name: "Check latest choices" }).click(); await expect(page.getByText("Your choices: Logo.", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Save my choices" })).toBeVisible(); expect(fixture.writes).toHaveLength(1);
  await page.getByRole("button", { name: "Save my choices" }).click(); await waitWrite(page, fixture, 2); expect(fixture.writes[1]!.body).toEqual({ expectedRevision: 1, ensemble: false, elements: ["logo"] });
});
test("references fixture: recovery checks the exact page even after filters hide its row", async ({ page }) => {
  const fixture = await setup(page); fixture.pageSize = 2; fixture.lostWrite = true; await ready(page); await page.getByRole("button", { name: "Load more references" }).click(); await card(page, 2).getByRole("button", { name: /^Ensemble for/ }).click(); await expect(page.getByRole("heading", { name: "Pending choices · Editorial rhythm · fixture" })).toBeVisible();
  await page.getByText("Exclude tags", { exact: true }).click(); await page.getByRole("checkbox", { name: "warm", exact: true }).check(); await expect(card(page, 2)).toHaveCount(0); await page.getByRole("button", { name: "Check latest choices" }).click(); await expect(page.getByRole("heading", { name: "Pending choices · Editorial rhythm · fixture" })).toHaveCount(0); expect(fixture.reads.at(-1)).toMatchObject({ excludedTags: [], cursor: { referenceId: id(11), excludedTags: [] } }); expect(fixture.writes).toHaveLength(1);
});
test("references fixture: same-owner session rechecks retain unconfirmed choices privately", async ({ page }) => {
  const fixture = await setup(page); fixture.lostWrite = true; await ready(page); await card(page).getByRole("button", { name: /^Ensemble for/ }).click(); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect(card(page)).toBeVisible(); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toBeVisible(); await page.getByRole("button", { name: "Check latest choices" }).click(); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toHaveCount(0); expect(fixture.writes).toHaveLength(1);
});
test("references fixture: owner changes revoke previews and hide previous-owner intent", async ({ page }) => {
  const fixture = await setup(page); await trackUrls(page); fixture.lostWrite = true; await ready(page); await expect.poll(() => page.evaluate(() => (window as unknown as { referenceUrls: string[] }).referenceUrls.length)).toBeGreaterThan(0); await card(page).getByRole("button", { name: /^Ensemble for/ }).click(); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toBeVisible();
  fixture.owner = otherOwner; await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect(page.getByRole("article")).toHaveCount(0); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toHaveCount(0); await expect.poll(() => page.evaluate(() => { const value = window as unknown as { referenceUrls: string[]; revokedReferenceUrls: string[] }; return value.referenceUrls.every(url => value.revokedReferenceUrls.includes(url)); })).toBe(true);
  fixture.owner = ownerId; await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect(card(page)).toBeVisible(); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toHaveCount(0);
});
test("references fixture: invalid nested ownership never renders the reference", async ({ page }) => {
  const fixture = await setup(page); fixture.corrupt = true; await page.goto(url); await expect(page.getByRole("region", { name: "Brand references" }).getByRole("alert")).toContainText("could not be verified"); await expect(page.getByRole("article")).toHaveCount(0);
});
test("references fixture: failed bytes stay unavailable and source URLs are never auto-fetched", async ({ page }) => {
  const fixture = await setup(page); fixture.previewStatus = 404; const outbound: string[] = []; page.on("request", request => { if (request.url().includes("reference.example.invalid")) outbound.push(request.url()); }); await ready(page); await expect(card(page).getByText("Reference preview unavailable", { exact: true })).toBeVisible(); await card(page).getByText("Attribution", { exact: true }).click(); await expect(card(page).getByRole("link", { name: "View source" })).toHaveAttribute("rel", "noopener noreferrer"); await expect(card(page).getByText("Attribution does not verify usage rights.", { exact: true })).toBeVisible(); expect(outbound).toHaveLength(0); fixture.previewStatus = 200; await card(page).getByRole("button", { name: "Retry preview" }).click(); await expect(card(page).getByRole("img")).toBeVisible();
});
test("references fixture: decoded image failure immediately releases its private blob", async ({ page }) => {
  const fixture = await setup(page); await trackUrls(page); fixture.previewBytes = Buffer.from("not a decodable raster"); fixture.rows.forEach(row => row.reference.media.contentHash = createHash("sha256").update(fixture.previewBytes!).digest("hex")); await ready(page);
  await expect(card(page).getByText("Reference preview unavailable", { exact: true })).toBeVisible(); await expect.poll(() => page.evaluate(() => { const value = window as unknown as { referenceUrls: string[]; revokedReferenceUrls: string[] }; return value.referenceUrls.length > 0 && value.referenceUrls.every(url => value.revokedReferenceUrls.includes(url)); })).toBe(true);
});
for (const scope of ["complete_brand", "visual_identity_only"] as const) test(`references fixture: saved ${scope} editor navigation opens Identity before readiness`, async ({ page }) => {
  const fixture = await setup(page); fixture.project = project(scope); await page.goto(`/brands/account/${projectId}`); await page.getByRole("link", { name: "Open Identity", exact: true }).click(); await expect(card(page)).toBeVisible(); await expect(page.getByRole("textbox", { name: "Message Embel", exact: true })).toHaveCount(0);
});
test("references fixture: editor dirty busy and conflict states fence Identity navigation", async ({ page }) => {
  const fixture = await setup(page); await page.goto(`/brands/account/${projectId}`); await rename(page); await expect(page.getByRole("button", { name: "Open Identity", exact: true })).toBeDisabled(); await expect(page.getByText("Save your edits before opening Identity.", { exact: true })).toBeVisible();
  fixture.holdProjectPatch = true; await page.getByRole("button", { name: "Save changes", exact: true }).click(); await expect.poll(() => fixture.heldProjectPatch).not.toBeNull(); await expect(page.getByRole("button", { name: "Open Identity", exact: true })).toBeDisabled(); await fixture.heldProjectPatch!(); await expect(page.getByRole("link", { name: "Open Identity", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rename project", exact: true }).click(); await page.getByRole("textbox", { name: "Project label", exact: true }).fill("Second private change"); await page.getByRole("textbox", { name: "Project label", exact: true }).press("Enter"); fixture.projectPatchStatus = 409; await page.getByRole("button", { name: "Save changes", exact: true }).click(); await expect(page.getByText("Resolve the saved-version conflict before opening Identity.", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Open Identity", exact: true })).toBeDisabled();
});
test("references fixture: returning to the direct route keeps dirty project memory guarded", async ({ page }) => {
  const fixture = await setup(page); await ready(page); const readCount = fixture.reads.length; await page.getByRole("link", { name: "Back to project", exact: true }).click(); await rename(page); await page.goBack(); await expect(page.getByRole("heading", { name: "Save project changes first" })).toBeVisible(); await expect(page.getByRole("article")).toHaveCount(0); expect(fixture.reads).toHaveLength(readCount);
  await page.getByRole("link", { name: "Return to project" }).click(); await expect(page.getByRole("heading", { name: "Unsaved private identity brief", exact: true })).toBeVisible();
});
test("references fixture: long attribution and tags stay in the viewport", async ({ page }) => {
  const fixture = await setup(page); fixture.rows[0]!.reference.attribution.label = "LongUnbrokenSyntheticAttribution".repeat(7); fixture.rows[0]!.reference.tags = ["長".repeat(80)]; await page.goto(url); await expect(page.getByRole("article")).toHaveCount(6); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.getByText("Exclude tags", { exact: true }).click(); await page.getByRole("searchbox", { name: "Find a tag" }).fill("長"); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("references fixture: stable desktop and mobile visual evidence", async ({ page }, info) => {
  const fixture = await setup(page); fixture.rows[0]!.reaction = { ...fixture.rows[0]!.reaction, revision: 1, elements: ["logo", "colors"], updatedAt: when }; fixture.revision = 1; await ready(page);
  for (let index = 0; index < fixture.rows.length; index++) { await card(page, index).scrollIntoViewIfNeeded(); await expect(card(page, index).getByRole("img")).toBeVisible(); }
  await page.getByRole("heading", { name: "Build a visual starting point", exact: true }).focus(); await page.evaluate(() => scrollTo(0, 0)); await mkdir(".tmp/identity-assets/reference-ui-evidence", { recursive: true }); await page.screenshot({ path: `.tmp/identity-assets/reference-ui-evidence/references-grid-${info.project.name}.png`, fullPage: true });
  await page.screenshot({ path: `.tmp/identity-assets/reference-ui-evidence/references-viewport-${info.project.name}.png` });
  await openElements(page); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: `.tmp/identity-assets/reference-ui-evidence/references-controls-${info.project.name}.png`, fullPage: true });
  await card(page).screenshot({ path: `.tmp/identity-assets/reference-ui-evidence/references-controls-card-${info.project.name}.png` });
});

test("references fixture: oversized Unicode filter intent stays visible and recoverable", async ({ page }) => {
  const fixture = await setup(page); const tags = Array.from({ length: 50 }, (_, index) => "界".repeat(78) + String(index).padStart(2, "0")); fixture.rows[5]!.reference.tags = tags; await ready(page);
  await card(page).getByRole("button", { name: /^Ensemble for/ }).click(); await waitWrite(page, fixture, 1); await page.getByText("Exclude tags", { exact: true }).click();
  for (const tag of tags.slice(0, 46)) { await page.getByRole("searchbox", { name: "Find a tag" }).fill(tag); await page.getByRole("checkbox", { name: tag, exact: true }).check(); }
  await expect(page.getByRole("region", { name: "Brand references" }).getByRole("alert")).toContainText("This filter request is too large"); await expect(page.getByRole("article")).toHaveCount(0); expect(fixture.reads.length).toBeLessThan(48);
  await expect(page.getByRole("button", { name: `Include ${tags[45]} again`, exact: true })).toBeVisible(); await page.getByRole("button", { name: "Clear exclusions" }).click(); await expect(card(page)).toBeVisible(); await expect(card(page).getByRole("button", { name: /^Ensemble for/ })).toHaveAttribute("aria-pressed", "true"); expect(fixture.writes).toHaveLength(1);
});
test("references fixture: invalid route identifiers do not read private references", async ({ page }) => {
  const fixture = await setup(page); await page.goto("/brands/account/not-a-project/identity"); await expect(page.getByRole("heading", { name: "Project not found" })).toBeVisible(); expect(fixture.reads).toHaveLength(0); expect(fixture.writes).toHaveLength(0);
});

test("references fixture: tag menu Escape returns focus and pointer outside dismisses", async ({ page }) => {
  await setup(page); await ready(page); const trigger = page.locator(".identity-reference-tags summary"); await trigger.click(); await page.getByRole("searchbox", { name: "Find a tag" }).focus(); await page.keyboard.press("Escape"); await expect(trigger).toBeFocused(); await expect(page.getByRole("searchbox", { name: "Find a tag" })).toBeHidden(); await trigger.click(); await page.getByRole("heading", { name: "Identity", exact: true }).click(); await expect(page.getByRole("searchbox", { name: "Find a tag" })).toBeHidden();
});

test("references fixture: confirmed sign-out clears pending intent before the same owner returns", async ({ page }) => {
  const fixture = await setup(page); fixture.lostWrite = true; await ready(page); await card(page).getByRole("button", { name: /^Ensemble for/ }).click(); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(0); await expect.poll(() => fixture.sessionStatus).toBe(401); await expect(page.getByText("No verified account session. Sign in to view your account projects.", { exact: true })).toBeVisible();
  fixture.sessionStatus = 200; await page.getByRole("button", { name: "Check account", exact: true }).click(); await expect(card(page)).toBeVisible(); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toHaveCount(0);
});
test("references fixture: an intent whose original page shifted can be explicitly discarded", async ({ page }) => {
  const fixture = await setup(page); fixture.pageSize = 2; fixture.writeStatus = 503; await ready(page); await card(page).getByRole("button", { name: /^Ensemble for/ }).click(); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toBeVisible();
  fixture.rows.unshift(...[100, 101].map(number => { const row = entry(number); row.reference.createdAt = new Date(Date.parse(when) + (102 - number) * 1000).toISOString(); return row; })); await page.getByRole("button", { name: "Check latest choices" }).click(); await expect(page.getByRole("button", { name: "Discard pending choices", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discard pending choices", exact: true }).click(); await expect(page.getByRole("heading", { name: "Pending choices · Warm forms · fixture" })).toHaveCount(0); await expect(page.getByRole("article", { name: "Reference 100 · fixture", exact: true })).toBeVisible(); expect(fixture.writes).toHaveLength(1);
});
test("references fixture: refreshed loaded pages follow returned cursors after insertion", async ({ page }) => {
  const fixture = await setup(page); fixture.pageSize = 2; await ready(page); await page.getByRole("button", { name: "Load more references" }).click(); await expect(page.getByRole("article")).toHaveCount(4);
  fixture.rows.unshift(...[100, 101].map(number => { const row = entry(number); row.reference.createdAt = new Date(Date.parse(when) + (102 - number) * 1000).toISOString(); return row; })); await page.getByRole("button", { name: "Check references", exact: true }).click(); await expect(page.getByRole("button", { name: "Check references", exact: true })).toBeEnabled();
  await expect(page.getByRole("article", { name: "Reference 100 · fixture", exact: true })).toBeVisible(); await expect(card(page)).toBeVisible(); await expect(card(page, 1)).toBeVisible(); await expect(card(page, 2)).toHaveCount(0);
  await page.getByRole("button", { name: "Load more references" }).click(); await expect(page.getByRole("article")).toHaveCount(6); await expect(card(page, 2)).toBeVisible(); await expect(card(page, 3)).toBeVisible();
});

test("references fixture: server header limits keep exclusions removable", async ({ page }) => {
  const fixture = await setup(page); await ready(page); fixture.readStatus = 431; await page.getByText("Exclude tags", { exact: true }).click(); await page.getByRole("checkbox", { name: "warm", exact: true }).check();
  await expect(page.getByRole("region", { name: "Brand references" }).getByRole("alert")).toContainText("This filter request is too large"); await expect(page.getByRole("button", { name: "Include warm again" })).toBeVisible(); fixture.readStatus = 200; await page.getByRole("button", { name: "Clear exclusions" }).click(); await expect(card(page)).toBeVisible();
});
