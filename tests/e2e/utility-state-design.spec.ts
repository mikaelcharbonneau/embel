import { expect, test, type Locator, type Page } from "@playwright/test";
import { standaloneWorkspaceSchema } from "../../src/domain/standalone-workspaces";
import { standaloneCapabilitiesSchema } from "../../src/domain/standalone-live-checks";
import { standalonePayloadCodec as domainCodec } from "../../src/features/domain-workspace/account-codec";
import { standalonePayloadCodec as handlesCodec } from "../../src/features/handles-workspace/account-codec";
import { domainDraftSchema, emptyDomainDraft } from "../../src/features/domain-workspace/draft";
import { emptyHandlesSearch, emptyHandlesState } from "../../src/features/handles-workspace/domain";
import { captureUiEvidence } from "./ui-evidence";

const ownerId = "ab000000-0000-4000-8000-000000000001";
const when = "2026-10-20T00:00:00Z";
const domain = "syntheticbrand.com";
const longDomain = "averylongsyntheticdomainnameforresponsiverowvalidation.com";
type Fixture = { requests: Array<{ path: string; method: string }>; forbidden: string[]; external: string[]; errors: string[] };
const fixtures = new WeakMap<Page, Fixture>();

test.beforeEach(async ({ page }, info) => {
  await page.setViewportSize(info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
});
test.afterEach(async ({ page }, info) => {
  const fixture = fixtures.get(page);
  if (!fixture) return;
  // View navigation must remain read-only beyond the existing 600 ms autosave delay.
  await page.waitForTimeout(800);
  await info.attach("utility-fixture-requests", { body: Buffer.from(JSON.stringify(fixture, null, 2)), contentType: "application/json" });
  expect(fixture.forbidden).toEqual([]); expect(fixture.external).toEqual([]); expect(fixture.errors).toEqual([]);
  await captureUiEvidence(page, info);
});

/** Only synthetic GET envelopes are supplied. Writes and all external requests are blocked. */
async function install(page: Page, options: { preparedDomains?: boolean; preparedHandles?: boolean } = {}) {
  const fixture: Fixture = { requests: [], forbidden: [], external: [], errors: [] }; fixtures.set(page, fixture);
  page.on("pageerror", error => fixture.errors.push(error.message));
  const domains = standaloneWorkspaceSchema(domainCodec).parse({ id: "ab000000-0000-4000-8000-000000000002", ownerId, tool: "domains", revision: 1,
    payload: options.preparedDomains ? domainDraftSchema.parse({ version: 1, input: `${domain}\n${longDomain}`, extensions: ["com"], candidates: [domain, longDomain], shortlistedDomains: [domain] }) : emptyDomainDraft(),
    imports: [], createdAt: when, updatedAt: when });
  const handles = standaloneWorkspaceSchema(handlesCodec).parse({ id: "ab000000-0000-4000-8000-000000000003", ownerId, tool: "handles", revision: 1,
    payload: options.preparedHandles ? { ...emptyHandlesState(), search: { ...emptyHandlesSearch(), names: "syntheticbrand", title: "syntheticbrand" } } : emptyHandlesState(),
    imports: [], createdAt: when, updatedAt: when });
  const capabilities = standaloneCapabilitiesSchema.parse({ ownerId, domains: options.preparedDomains ? "namecom" : "unavailable", youtube: false, euipo: false });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.hostname !== "127.0.0.1") { fixture.external.push(request.url()); return route.abort("blockedbyclient"); }
    if (!path.startsWith("/api/")) return route.continue();
    fixture.requests.push({ path, method });
    if (method !== "GET") { fixture.forbidden.push(`${method} ${path}`); return route.fulfill({ status: 403, json: { error: "Writes and provider checks are forbidden in this read-only fixture" } }); }
    const body = path === "/api/session" ? { user: { id: ownerId } }
      : path === "/api/workspaces/domains" ? { ownerId, workspace: options.preparedDomains ? domains : null }
      : path === "/api/workspaces/handles" ? { ownerId, workspace: options.preparedHandles ? handles : null }
      : path === "/api/standalone-checks" ? capabilities
      : path === "/api/projects/page" || path === "/api/names" ? { ownerId, items: [], nextCursor: null }
      : path === "/api/names/workspace" ? { ownerId, workspace: null }
      : path === "/api/account/profile" ? { profile: { ownerId, email: null, revision: 0, updatedAt: null, values: { fullName: "", timeZone: "UTC", dateFormat: "iso" } } }
      : undefined;
    if (body === undefined) { fixture.forbidden.push(`${method} ${path}`); return route.fulfill({ status: 404, json: { error: "Unexpected utility fixture read" } }); }
    return route.fulfill({ json: body });
  });
  return fixture;
}

async function settled(page: Page, route: "/domains" | "/handles") {
  await page.goto(route);
  await expect(page.getByRole("region", { name: route === "/domains" ? "Domain workspace" : "Handle workspace", exact: true }).getByRole("status", { name: "", exact: true })).toHaveText(/^(Saved|Changes save automatically)$/);
  await expect.poll(() => fixtures.get(page)!.requests.some(request => request.path === "/api/standalone-checks")).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("Geist");
}
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width); }
async function actionHeight(action: Locator) { expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44); }
async function capture(page: Page, filename: string) { await page.screenshot({ path: test.info().outputPath(filename), fullPage: true, scale: "css" }); }

test("Domains actual page: empty views and contained keyboard filters stay read-only", async ({ page }) => {
  await install(page); await settled(page, "/domains");
  const views = page.getByRole("navigation", { name: "Domain views", exact: true });
  const search = page.getByRole("region", { name: "Domain search workspace", exact: true });
  expect((await views.boundingBox())!.y).toBeLessThan((await search.boundingBox())!.y);
  for (const view of ["Search", "Shortlist", "Library"]) await actionHeight(views.getByRole("button", { name: view, exact: true }));
  await actionHeight(page.getByRole("button", { name: "Search domains", exact: true }));
  const filters = page.getByRole("region", { name: "Domain search filters", exact: true });
  const trigger = page.getByRole("button", { name: "Edit filters", exact: true });
  await expect(filters).toBeHidden(); await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.focus(); await trigger.press("Enter"); await expect(filters).toBeVisible();
  await trigger.press("Escape");
  await expect(filters).toBeHidden(); await expect(trigger).toBeFocused();
  await trigger.press("Enter"); await expect(filters).toBeVisible();
  const body = filters.locator('[class*="filterBody"]');
  expect((await body.boundingBox())!.height).toBeLessThanOrEqual(Math.min(440, page.viewportSize()!.height * .55) + 1);
  expect(await body.evaluate(element => getComputedStyle(element).overflowY)).toBe("auto");
  await filters.getByRole("button", { name: "Technology", exact: true }).click();
  await filters.getByRole("searchbox", { name: "Find an extension", exact: true }).fill("ai");
  await filters.getByRole("button", { name: "Done", exact: true }).click();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(filters.getByRole("button", { name: "Technology", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(filters.getByRole("searchbox", { name: "Find an extension", exact: true })).toHaveValue("ai");
  await filters.getByRole("searchbox", { name: "Find an extension", exact: true }).press("Escape");
  await expect(trigger).toBeFocused(); await expect(filters).toBeHidden();
  await capture(page, "domains-empty-search.png");
  await views.getByRole("button", { name: "Shortlist", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No shortlisted domains yet", exact: true })).toBeVisible();
  await views.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Domain library unavailable", exact: true })).toBeVisible();
  await noOverflow(page);
});

test("Domains actual page: prepared names expose human registrar labels and unknown evidence", async ({ page }) => {
  await install(page, { preparedDomains: true }); await settled(page, "/domains");
  const views = page.getByRole("navigation", { name: "Domain views", exact: true });
  const results = page.getByRole("region", { name: "Domain results", exact: true });
  expect((await views.boundingBox())!.y).toBeLessThan((await results.boundingBox())!.y);
  for (const name of [domain, longDomain]) {
    const status = page.getByRole("status", { name: `${name} availability`, exact: true });
    await expect(status).toHaveText("Unknown");
    const summary = status.locator("..");
    await expect(summary).toHaveText("Unknown · Name.com"); await expect(summary).not.toContainText("namecom_core");
    const row = results.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(row.getByText("Not quoted", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: `View ${name} details`, exact: true })).toHaveText("Details");
    await expect(row.getByRole("button", { name: `Add ${name} to shortlist`, exact: true }).or(row.getByRole("button", { name: `Remove ${name} from shortlist`, exact: true }))).toBeVisible();
  }
  const detail = page.getByRole("button", { name: `View ${domain} details`, exact: true });
  await detail.focus(); await detail.press("Enter");
  await expect(detail).toHaveAttribute("aria-expanded", "true"); await expect(detail).toBeFocused();
  const expandedRow = results.getByRole("listitem").filter({ has: page.getByRole("heading", { name: domain, exact: true }) });
  await expect(expandedRow.getByText("Not checked yet.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Request quote for ${domain}`, exact: true })).toBeDisabled();
  await detail.press("Enter");
  await views.getByRole("button", { name: "Shortlist (1)", exact: true }).click();
  await expect(page.getByRole("heading", { name: domain, exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: `${domain} availability`, exact: true })).toHaveText("Unknown");
  await views.getByRole("button", { name: "Search", exact: true }).click();
  await noOverflow(page); await capture(page, "domains-prepared-unknown.png");
});

test("Handles actual page: empty library and keyboard views expose supported local work", async ({ page }) => {
  await install(page); await settled(page, "/handles");
  const tabs = page.getByRole("tablist", { name: "Handles workspace", exact: true });
  await expect(page.getByText("Embel drafts handle options for each platform. It doesn’t check whether they’re taken yet.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check handles", exact: true })).toHaveCount(0);
  await expect(tabs.getByRole("tab", { name: "History", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Build comparison", exact: true })).toBeDisabled();
  await actionHeight(page.getByRole("button", { name: "Build comparison", exact: true }));
  for (const tab of ["Search", "Library", "Saved"]) await actionHeight(tabs.getByRole("tab", { name: tab, exact: true }));
  const search = tabs.getByRole("tab", { name: "Search", exact: true });
  await search.focus(); await search.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Library", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Keep your handles together", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export library CSV", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Search library", { exact: true })).toHaveCount(0);
  await actionHeight(page.getByRole("button", { name: "Compare handles", exact: true }));
  await tabs.getByRole("tab", { name: "Library", exact: true }).press("ArrowRight");
  await expect(page.getByRole("heading", { name: "No saved searches yet", exact: true })).toBeVisible();
  await tabs.getByRole("tab", { name: "Saved", exact: true }).press("ArrowRight");
  await expect(search).toBeFocused();
  await tabs.getByRole("tab", { name: "Search", exact: true }).press("End");
  await tabs.getByRole("tab", { name: "Saved", exact: true }).press("Home");
  await expect(search).toBeFocused(); await noOverflow(page); await capture(page, "handles-empty-search.png");
});

test("Handles actual page: saved configuration previews locally without checks or draft edits", async ({ page }) => {
  await install(page, { preparedHandles: true }); await settled(page, "/handles");
  const preview = page.getByRole("region", { name: "Handles preview", exact: true });
  const comparison = page.getByRole("button", { name: "Build comparison", exact: true });
  await expect(comparison).toBeEnabled(); await actionHeight(comparison);
  await expect(preview).toContainText("@syntheticbrand");
  await expect(preview).toContainText("handle option");
  await expect(preview).not.toContainText("not connected");
  await expect(page.getByRole("button", { name: "Check handles", exact: true })).toHaveCount(0);
  if (page.viewportSize()!.width <= 900) {
    const summary = page.getByLabel("Candidate preview summary", { exact: true });
    await expect(summary).toContainText("@syntheticbrand");
    await page.getByRole("heading", { name: "Prefixes & suffixes", exact: true }).scrollIntoViewIfNeeded();
    await expect(summary).toBeInViewport();
    const link = summary.getByRole("link", { name: "View preview", exact: true });
    await link.focus(); await link.press("Enter");
    await expect(preview).toBeFocused(); await expect(preview).toBeInViewport();
  } else {
    const controls = (await page.locator(".handles-controls-column").boundingBox())!, bounds = (await preview.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(controls.x + controls.width);
    expect(Math.abs(bounds.y - controls.y)).toBeLessThanOrEqual(1);
  }
  await noOverflow(page); await page.evaluate(() => window.scrollTo(0, 0)); await capture(page, "handles-saved-configuration-preview.png");
});
