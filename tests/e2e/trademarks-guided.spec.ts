import { test, expect, type Page } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createTrademarkDraft, type TrademarkDraft } from "../../src/features/trademark-workspace/domain";
import { standalonePayloadCodec } from "../../src/features/trademark-workspace/account-codec";
import { saveStandaloneWorkspaceInputSchema, standaloneWorkspaceSchema, type SaveStandaloneWorkspaceInput, type StandaloneWorkspace } from "../../src/domain/standalone-workspaces";
import { captureUiEvidence } from "./ui-evidence";

const ownerId = "aaaaaaaa-1111-4111-8111-111111111111";
const workspaceId = "cccccccc-1111-4111-8111-111111111111";
const when = "2026-10-20T00:00:00Z";
type AccountFixture = {
  saved: StandaloneWorkspace<TrademarkDraft> | null; failNextSave: boolean;
  puts: SaveStandaloneWorkspaceInput[]; acknowledged: StandaloneWorkspace<TrademarkDraft>[];
  requests: Array<{ path: string; method: string }>; forbidden: string[]; failures: string[];
};
const fixtures = new WeakMap<Page, AccountFixture>();
test.beforeEach(async ({ page }, info) => {
  await page.setViewportSize(info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
});
test.afterEach(async ({ page }, info) => {
  const fixture = fixtures.get(page);
  if (!fixture) return;
  await info.attach("trademark-fixture-api", { body: Buffer.from(JSON.stringify(fixture, null, 2)), contentType: "application/json" });
  expect(fixture.forbidden).toEqual([]); expect(fixture.failures).toEqual([]);
  expect(fixture.requests.filter(request => request.path === "/api/standalone-checks" && request.method !== "GET")).toEqual([]);
  await captureUiEvidence(page, info);
});

/** Actual account editor with owner-validated, in-memory persistence; no registry calls. */
async function authenticated(page: Page, initial: StandaloneWorkspace<TrademarkDraft> | null = null) {
  const fixture: AccountFixture = { saved: initial ? standaloneWorkspaceSchema(standalonePayloadCodec).parse(initial) : null,
    failNextSave: false, puts: [], acknowledged: [], requests: [], forbidden: [], failures: [] };
  fixtures.set(page, fixture);
  const receipts = new Map<string, StandaloneWorkspace<TrademarkDraft>>();
  page.on("pageerror", error => fixture.failures.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.hostname !== "127.0.0.1") { fixture.forbidden.push(request.url()); return route.abort("blockedbyclient"); }
    if (!path.startsWith("/api/")) return route.continue();
    fixture.requests.push({ path, method });
    if (path === "/api/workspaces/trademarks" && method === "PUT") {
      expect(request.headers()["x-embel-account"]).toBe(ownerId);
      const input = saveStandaloneWorkspaceInputSchema.parse(request.postDataJSON());
      const payload = standalonePayloadCodec.schema.parse(input.payload); fixture.puts.push(input);
      expect(input.imports).toEqual([]);
      const receipt = receipts.get(input.requestKey);
      if (receipt) return route.fulfill({ json: { ownerId, workspace: receipt } });
      if (fixture.failNextSave) { fixture.failNextSave = false; return route.fulfill({ status: 409, json: { error: "Synthetic revision conflict" } }); }
      expect(input.expectedRevision).toBe(fixture.saved?.revision ?? 0);
      fixture.saved = standaloneWorkspaceSchema(standalonePayloadCodec).parse({ id: workspaceId, ownerId, tool: "trademarks", revision: input.expectedRevision + 1,
        payload, imports: [], createdAt: fixture.saved?.createdAt ?? when, updatedAt: when });
      receipts.set(input.requestKey, fixture.saved); fixture.acknowledged.push(fixture.saved);
      return route.fulfill({ json: { ownerId, workspace: fixture.saved } });
    }
    if (method !== "GET") { fixture.forbidden.push(`${method} ${path}`); return route.fulfill({ status: 403, json: { error: "Unexpected fixture write or provider lookup" } }); }
    const body = path === "/api/session" ? { user: { id: ownerId } }
      : path === "/api/workspaces/trademarks" ? { ownerId, workspace: fixture.saved }
      : path === "/api/standalone-checks" ? { ownerId, domains: "unavailable", youtube: false, euipo: false }
      : path === "/api/projects/page" || path === "/api/names" ? { ownerId, items: [], nextCursor: null }
      : path === "/api/names/workspace" ? { ownerId, workspace: null }
      : path === "/api/account/profile" ? { profile: { ownerId, email: null, revision: 0, updatedAt: null, values: { fullName: "", timeZone: "UTC", dateFormat: "iso" } } }
      : undefined;
    if (body === undefined) { fixture.forbidden.push(`${method} ${path}`); return route.fulfill({ status: 404, json: { error: "Unexpected synthetic read" } }); }
    return route.fulfill({ json: body });
  });
  await page.goto("/trademarks");
  await expect(page.getByRole("tab", { name: "Search", exact: true })).toHaveAttribute("aria-selected", "true");
  return fixture;
}
async function fillTab(page: Page) { await page.getByRole("tab", { name: "Details", exact: true }).click(); }
async function saved(page: Page, fixture: AccountFixture, name: string) {
  await expect.poll(() => fixture.saved?.payload.markName).toBe(name);
  await expect(page.getByLabel("Save status", { exact: true }).getByRole("status")).toHaveText("Saved");
}

test("search prepares manual research without inventing a match or sending a registry request", async ({ page }) => {
  const fixture = await authenticated(page);
  await expect(page.getByText("Not prepared yet", { exact: true })).toBeVisible();
  await page.getByLabel("Mark name", { exact: true }).fill("Synthetic Morrow");
  await page.getByLabel("Requested territories", { exact: true }).fill("Canada");
  await page.getByLabel("Goods and services", { exact: true }).fill("Synthetic coffee services");
  await page.getByRole("button", { name: "Prepare search", exact: true }).click();
  await expect(page.getByText("Ready to search", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Search the official registries", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Include similar names", exact: true }).uncheck();
  await expect(page.getByText("Not prepared yet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Prepare search", exact: true }).click();
  await page.getByLabel("Mark name", { exact: true }).fill("Changed query");
  await expect(page.getByText("Not prepared yet", { exact: true })).toBeVisible();
  await saved(page, fixture, "Changed query");
  expect(fixture.saved?.payload.territories).toEqual(["Canada"]);
  expect(fixture.requests.filter(request => request.path === "/api/standalone-checks").every(request => request.method === "GET")).toBe(true);
  expect(fixture.forbidden).toEqual([]);
});

test("keyboard tabs retain the draft and clearly bound Library and History", async ({ page }) => {
  const fixture = await authenticated(page);
  await page.getByLabel("Mark name", { exact: true }).fill("Synthetic retained name");
  await page.getByLabel("Requested territories", { exact: true }).fill("Canada\nFrance");
  await saved(page, fixture, "Synthetic retained name");
  const search = page.getByRole("tab", { name: "Search", exact: true });
  await search.focus(); await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Details", exact: true })).toBeFocused();
  await expect(page.getByLabel("Requested territories", { exact: true })).toHaveValue("Canada\nFrance");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Summary", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Synthetic retained name", exact: true })).toBeVisible();
  await expect(page.getByText(`Version ${fixture.saved!.revision} · saved`, { exact: true })).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Save history", exact: true })).toBeFocused();
  await expect(page.getByText("Everything is saved.", { exact: true })).toBeVisible();
  await page.keyboard.press("Home");
  await expect(search).toBeFocused();
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("Synthetic retained name");
  await page.reload();
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("Synthetic retained name");
  await expect(page.getByLabel("Requested territories", { exact: true })).toHaveValue("Canada\nFrance");
});

test("invalid territory input keeps the previous draft and remains editable", async ({ page }) => {
  await authenticated(page);
  await page.getByLabel("Requested territories", { exact: true }).fill("Kept territory");
  await page.getByLabel("Requested territories", { exact: true }).fill(Array(21).fill("Too many").join("\n"));
  await expect(page.getByRole("alert").filter({ hasText: "previous input has been kept" })).toBeVisible();
  await expect(page.getByLabel("Requested territories", { exact: true })).toHaveValue("Kept territory");
  await fillTab(page);
  await expect(page.getByLabel("Requested territories", { exact: true })).toHaveValue("Kept territory");
  await expect(page.getByText("1 of 6 sections filled", { exact: true })).toBeVisible();
});

test("original artwork is unchanged and research coverage stays beside its contained action", async ({ page }, info) => {
  await authenticated(page);
  const folder = new URL("../../public/trademarks/", import.meta.url);
  const files = await readdir(folder);
  expect(files.length).toBe(16);
  for (const name of files) {
    const expected = await readFile(new URL(name, folder));
    const response = await page.request.get(`/trademarks/${name}`);
    expect(response.status()).toBe(200);
    expect(createHash("sha256").update(await response.body()).digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"));
  }
  if (info.project.name === "desktop") {
    // The floating navigation uses AppMark. Page-specific legacy shell SVGs
    // remain byte-checked above, not mounted here.
    const mark = page.getByRole("navigation", { name: "Main navigation", exact: true }).locator('img[src="/embel-mark.svg"]');
    // The original SVG is 1276px intrinsically; AppMark renders it at 28px.
    await expect(mark).toBeVisible(); await expect.poll(() => mark.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1276);
    expect((await mark.boundingBox())!.width).toBe(28); expect((await mark.boundingBox())!.height).toBe(28);
    for (const label of ["Home", "Projects", "Library"]) await expect(page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: label, exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation", exact: true }).locator("summary")).toHaveAttribute("aria-current", "page");
    const search = page.locator('img[src="/trademarks/search.svg"]');
    await expect(search).toBeVisible(); await expect.poll(() => search.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(24);
    expect((await search.boundingBox())!.width).toBe(24); expect((await search.boundingBox())!.height).toBe(24);
  }
  await page.evaluate(() => document.fonts.ready);
  if (info.project.name === "desktop") {
    const form = (await page.locator(".tm-search-form").boundingBox())!;
    const workspace = (await page.locator(".tm-workspace").boundingBox())!;
    expect(form.x).toBe(workspace.x + 40); expect(form.width).toBe(workspace.width - 80);
    const action = (await page.getByRole("button", { name: "Prepare search", exact: true }).boundingBox())!;
    const coverage = (await page.locator(".tm-coverage").boundingBox())!;
    expect(action.x).toBeGreaterThanOrEqual(form.x); expect(action.x + action.width).toBeLessThanOrEqual(form.x + form.width);
    expect(coverage.y).toBeGreaterThanOrEqual(action.y + action.height);
    expect(coverage.y - (action.y + action.height)).toBeLessThanOrEqual(24);
    expect(coverage.y + coverage.height).toBeLessThanOrEqual(form.y + form.height);
    expect((await page.locator(".tm-empty").boundingBox())!.height).toBe(196);
  }
  await page.screenshot({ path: info.outputPath("search.png"), fullPage: true });
  await fillTab(page);
  if (info.project.name === "desktop") {
    expect((await page.locator(".tm-editor").boundingBox())!.width).toBe(656);
    expect((await page.locator(".tm-checklist").boundingBox())!.width).toBe(328);
    expect((await page.locator(".tm-editor > .tm-section").first().boundingBox())!.height).toBe(346);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: info.outputPath("fill.png"), fullPage: true });
});

test("320px Search and Fill keep forms, disclosures and recovery controls reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await authenticated(page);
  await page.getByRole("button", { name: "Prepare search", exact: true }).click();
  await fillTab(page);
  await page.getByRole("button", { name: "More details", exact: true }).click();
  const details = page.getByRole("dialog", { name: "More details", exact: true });
  await details.getByLabel("Owner contact", { exact: true }).fill("Synthetic contact");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await details.getByRole("button", { name: "Close", exact: true }).click(); await expect(details).toBeHidden();
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Export draft preview", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("mobile trademark inputs precede the detailed checklist", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile", "Mobile layout regression");
  await authenticated(page); await fillTab(page);
  const field = page.locator(".tm-editor input").first(), checklist = page.locator(".tm-checklist");
  await expect(field).toBeVisible();
  expect((await field.boundingBox())!.y).toBeLessThan((await checklist.boundingBox())!.y);
  expect((await field.boundingBox())!.y).toBeLessThan(page.viewportSize()!.height);
});

test("account autosave receipts, unsaved revision history and explicit conflict recovery stay tied to actual data", async ({ page }) => {
  const fixture = await authenticated(page, { id: workspaceId, ownerId, tool: "trademarks", revision: 2,
    payload: createTrademarkDraft("Saved fixture"), imports: [], createdAt: when, updatedAt: when });
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("Saved fixture");
  fixture.failNextSave = true;
  await page.getByLabel("Mark name", { exact: true }).fill("Unsaved fixture");
  await expect(page.getByText("This workspace changed elsewhere. Your changes are retained. Choose which version to keep.", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Save history", exact: true }).click();
  await expect(page.getByText(/Version 2 · saved/)).toBeVisible();
  await expect(page.getByText("Your latest edits aren’t saved yet.", { exact: true })).toBeVisible();
  expect(fixture.puts).toHaveLength(1); expect(fixture.acknowledged).toHaveLength(0);
  await page.getByRole("button", { name: "Use saved version", exact: true }).click();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await fillTab(page);
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("Unsaved fixture");
  await page.getByRole("button", { name: "Save my changes instead", exact: true }).click();
  await saved(page, fixture, "Unsaved fixture");
  expect(fixture.saved!.revision).toBe(3); expect(fixture.puts).toHaveLength(2); expect(fixture.acknowledged).toHaveLength(1);
  fixture.failNextSave = true;
  await page.getByLabel("Mark name", { exact: true }).fill("Discarded fixture");
  await expect(page.getByRole("button", { name: "Use saved version", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use saved version", exact: true }).click();
  await page.getByRole("button", { name: "Replace my changes", exact: true }).click();
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("Unsaved fixture");
  await page.getByRole("tab", { name: "Save history", exact: true }).click();
  await expect(page.getByText(/Version 3 · saved/)).toBeVisible();
  await expect(page.getByText("Everything is saved.", { exact: true })).toBeVisible();
  expect(fixture.saved!.payload.markName).toBe("Unsaved fixture"); expect(fixture.acknowledged).toHaveLength(1);
  await page.reload();
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("Unsaved fixture");
});
