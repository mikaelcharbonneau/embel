// Dedicated browser with real review/session components; intercepted local APIs.
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = process.env.FLUID_IDENTITY_EVIDENCE ?? "/workspace/scratch/fluid-integration-20261013/identity/browser";
await mkdir(output, { recursive: true });
const timings = { bundleMs: 0, launchMs: 0, viewports: [] }, bundleStarted = performance.now();
await build({ entryPoints: [`${root}tests/client/visual-direction-preview.tsx`], outdir: output, bundle: true, jsx: "automatic", platform: "browser", loader: { ".woff2": "file" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" }, logLevel: "warning" });
timings.bundleMs = performance.now() - bundleStarted;
const server = createServer(async (request, response) => {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'");
  const path = new URL(request.url, "http://localhost").pathname;
  try {
    if (["/visual-direction-preview.js", "/visual-direction-preview.css"].includes(path) || /^\/[A-Za-z0-9_-]+\.woff2$/.test(path)) {
      response.setHeader("content-type", path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "font/woff2"); response.end(await readFile(`${output}${path}`));
    } else { response.setHeader("content-type", "text/html"); response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Visual direction local fixture</title><link rel="stylesheet" href="/visual-direction-preview.css"></head><body><div id="root"></div><script src="/visual-direction-preview.js"></script></body></html>'); }
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
const launchStarted = performance.now();
const browser = await chromium.launch({ headless: true, executablePath: process.env.FLUID_TEST_CHROMIUM_EXECUTABLE || "/usr/bin/chromium" });
timings.launchMs = performance.now() - launchStarted;
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ownerB = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const design = JSON.parse(await readFile(`${root}src/domain/inspiration-catalog.json`, "utf8"))[0];
function fixture(ownerId = ownerA) {
  const guidance = { character: ownerId === ownerA ? "Clear and warm" : "Other account direction", colors: "Strong contrast", typography: "Readable at small sizes", graphics: "Simple repeating shapes" };
  const references = [{ referenceId: design.id, brand: design.brand, creator: design.creator, description: design.description, sourceUrl: design.sourceUrl, contentHash: design.contentHash, ensemble: false, elements: ["colors"] }];
  return { inspiration: { ownerId, projectId, projectTitle: "Local visual direction fixture", projectScope: "complete_brand", projectRevision: 1, catalogVersion: "2026-10-13.1", selectionRevision: 1, choices: [{ ownerId, projectId, referenceId: design.id, revision: 1, ensemble: false, elements: ["colors"], updatedAt: "2026-10-13T12:00:00Z" }] }, current: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ownerId, projectId, revision: 1, projectRevision: 1, selectionRevision: 1, catalogVersion: "2026-10-13.1", guidance, references, reviewedAt: "2026-10-13T12:01:00Z" }, history: [], hasEarlierHistory: false, stale: false };
}
const results = [], errors = [], external = [], failedRequests = [], consoleErrors = [], cspViolations = [], pendingRequests = new Set();
let activePage = null, activeName = "startup";
try {
  for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }], ["narrow", { width: 320, height: 740 }]]) {
    const context = await browser.newContext({ viewport, timezoneId: "America/Toronto" }), page = await context.newPage();
    activePage = page; activeName = name;
    page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(30000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("request", request => { pendingRequests.add(request); const url = new URL(request.url()); if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) external.push(request.url()); });
    page.on("requestfinished", request => pendingRequests.delete(request));
    page.on("requestfailed", request => { pendingRequests.delete(request); failedRequests.push({ url: request.url(), error: request.failure()?.errorText }); });
    await page.exposeFunction("recordVisualFixtureCspViolation", violation => cspViolations.push({ viewport: name, ...violation }));
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", event => {
      void window.recordVisualFixtureCspViolation({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    }));
    let owner = ownerA, saved = fixture(), writes = 0, loseNext = false;
    await page.route(`${origin}/api/**`, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: owner } } });
      if (url.pathname === "/api/auth/sign-out") return route.fulfill({ json: { authenticated: false } });
      assert.equal(url.pathname, `/api/projects/${projectId}/visual-direction`, "Review never calls a provider or changes a logo");
      if (request.method() === "GET") return route.fulfill({ json: saved });
      assert.equal(request.method(), "POST"); writes++; const input = request.postDataJSON();
      assert.deepEqual(Object.keys(input).sort(), ["catalogVersion", "expectedProjectRevision", "expectedRevision", "expectedSelectionRevision", "guidance"]);
      if (input.expectedRevision !== saved.current.revision || input.expectedSelectionRevision !== saved.inspiration.selectionRevision) return route.fulfill({ status: 409, json: { error: { code: "conflict" } } });
      const current = saved.current, revision = current.revision + 1;
      saved = { ...saved, stale: false, current: { ...current, id: `dddddddd-dddd-4ddd-8ddd-${String(revision).padStart(12, "0")}`, revision, selectionRevision: saved.inspiration.selectionRevision, guidance: input.guidance }, history: [current, ...saved.history] };
      if (loseNext) { loseNext = false; return route.abort(); }
      return route.fulfill({ json: saved });
    });
    const started = performance.now(), viewportTiming = { name, navigationMs: 0, firstReadyFieldMs: 0, reloadMs: 0 };
    timings.viewports.push(viewportTiming);
    await page.goto(origin, { waitUntil: "domcontentloaded" }); viewportTiming.navigationMs = performance.now() - started;
    await expect(page.getByRole("textbox", { name: "Overall character", exact: true })).toHaveValue("Clear and warm");
    viewportTiming.firstReadyFieldMs = performance.now() - started; assert.equal(writes, 0);
    for (const label of ["Overall character", "Color guidance", "Typography guidance", "Graphic rules"]) {
      const field = page.getByRole("textbox", { name: label, exact: true });
      await expect(field).toHaveAccessibleName(label);
      assert.equal(await field.evaluate(element => element.labels?.length > 0), true);
    }
    await expect(page.getByText("Logo concepts use your saved logo brief and uploaded references.", { exact: false })).toBeVisible();
    await page.getByRole("textbox", { name: "Overall character", exact: true }).fill("Friendly precision"); await page.getByRole("button", { name: "Review and save direction", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("reviewed and saved"); assert.equal(saved.current.guidance.character, "Friendly precision");
    const reloadStarted = performance.now(); await page.reload({ waitUntil: "domcontentloaded" }); viewportTiming.reloadMs = performance.now() - reloadStarted; await expect(page.getByRole("textbox", { name: "Overall character", exact: true })).toHaveValue("Friendly precision"); assert.equal(writes, 1);
    await page.getByRole("textbox", { name: "Color guidance", exact: true }).fill("Retained blue guidance");
    saved = { ...saved, stale: true, inspiration: { ...saved.inspiration, selectionRevision: 2 } };
    await page.getByRole("button", { name: "Review and save direction", exact: true }).click(); await expect(page.getByRole("alert")).toContainText("changed");
    await page.getByRole("button", { name: "Check saved direction", exact: true }).click(); await expect(page.getByText("The saved starting point changed", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Keep my words for review", exact: true }).click(); await page.getByRole("button", { name: "Review and save direction", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("reviewed and saved"); assert.equal(saved.current.selectionRevision, 2);
    loseNext = true; await page.getByRole("textbox", { name: "Graphic rules", exact: true }).fill("Wide margins and subtle dots"); await page.getByRole("button", { name: "Review and save direction", exact: true }).click();
    await expect(page.getByRole("button", { name: "Check saved direction", exact: true })).toBeEnabled(); const attempted = writes;
    await page.getByRole("button", { name: "Check saved direction", exact: true }).click(); await expect(page.getByRole("status")).toContainText("confirmed"); assert.equal(writes, attempted);
    await page.getByRole("textbox", { name: "Overall character", exact: true }).fill("Private unsaved guidance"); await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Sign out with unsaved account edits?" })).toBeVisible(); await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    owner = ownerB; saved = fixture(owner); await page.getByRole("button", { name: "Recheck fixture account" }).click(); await expect(page.getByRole("textbox", { name: "Overall character", exact: true })).toHaveValue("Other account direction");
    assert.equal(await page.getByText("Private unsaved guidance", { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
    results.push({ name, writes, checks: "explicit save, cross-session restoration, immutable history, inspiration conflict, lost-save recovery, sign-out guard, owner fence, no overflow" }); await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(cspViolations, []);
  await writeFile(`${output}/receipt.json`, JSON.stringify({ localFixture: true, liveProvider: false, results, timings, errors, externalRequests: 0, cspViolations }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results, timings, cspViolations }, null, 2));
} catch (cause) {
  const details = { viewport: activeName, error: String(cause), timings, errors, consoleErrors, cspViolations, external, failedRequests, pendingRequests: [...pendingRequests].map(request => ({ url: request.url(), resourceType: request.resourceType(), method: request.method() })), aria: activePage && !activePage.isClosed() ? await activePage.locator("body").ariaSnapshot({ timeout: 1000 }).catch(() => "ARIA unavailable") : "Page closed", body: activePage && !activePage.isClosed() ? await activePage.locator("body").innerText({ timeout: 1000 }).catch(() => "Body unavailable") : "Page closed" };
  await writeFile(`${output}/${activeName}-failure.json`, JSON.stringify(details, null, 2));
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: `${output}/${activeName}-failure.png`, fullPage: true, timeout: 5000 }).catch(() => undefined);
  throw cause;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
