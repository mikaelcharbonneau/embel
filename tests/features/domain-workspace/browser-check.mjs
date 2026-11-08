// Dedicated headless synthetic preview, separate from the shared Embel server/browser.
import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = `${root}.tmp/domains-preview`;
await mkdir(output, { recursive: true });
await build({ entryPoints: [`${root}tests/features/domain-workspace/preview.tsx`], outdir: output, bundle: true, jsx: "automatic", platform: "browser", loader: { ".woff2": "file" }, define: { "process.env.NODE_ENV": '"development"' }, logLevel: "warning" });
const server = createServer(async (request, response) => {
  if (/^\/[A-Za-z0-9_-]+\.woff2$/.test(request.url ?? "")) {
    response.setHeader("content-type", "font/woff2"); response.end(await readFile(`${output}${request.url}`));
  } else if (request.url?.startsWith("/preview.js") || request.url?.startsWith("/preview.css")) {
    const extension = request.url.startsWith("/preview.js") ? "js" : "css";
    response.setHeader("content-type", extension === "js" ? "application/javascript" : "text/css");
    response.end(await readFile(`${output}/preview.${extension}`));
  } else { response.setHeader("content-type", "text/html"); response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Domains synthetic fixture</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script src="/preview.js"></script></body></html>'); }
});
await new Promise(resolve => server.listen(Number(process.env.FLUID_DOMAINS_FIXTURE_PORT ?? 0), "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.FLUID_TEST_CHROMIUM_EXECUTABLE ? { executablePath: process.env.FLUID_TEST_CHROMIUM_EXECUTABLE } : {}) });
let page;
const failures = [], results = [];
async function run(name, task) {
  page = await browser.newPage();
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === url ? route.continue() : route.abort("blockedbyclient"));
  page.on("request", request => { assert.equal(new URL(request.url()).origin, url, "Fixture must not call any external service"); });
  try { await task(); results.push(name); console.log(`PASS ${name}`); } finally { await page.close(); }
}
async function replaceNames(page, value) {
  const removals = page.locator('[data-domain-entry] button');
  while (await removals.count()) await removals.first().click();
  await page.getByRole("textbox", { name: "Names or full domains" }).fill(value);
}
async function search(scenario, input = "North Star") {
  await page.goto(`${url}/?scenario=${scenario}`);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await replaceNames(page, input);
  await page.getByRole("button", { name: "Search domains", exact: true }).click();
  const details = page.getByRole("button", { name: "View northstar.com details", exact: true });
  if (await details.count()) await details.click();
}
const check = () => page.getByRole("button", { name: "Check availability for northstar.com", exact: true });
const quote = () => page.getByRole("button", { name: "Request quote for northstar.com", exact: true });
try {
  await run("Guided Browser categories, removable names and filter states preserve the search", async () => {
    await page.goto(url); await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "Edit filters", exact: true }).click();
    await page.getByRole("button", { name: "Creative", exact: true }).click();
    await page.getByRole("searchbox", { name: "Find an extension" }).fill("design");
    assert.equal(await page.getByRole("checkbox", { name: ".studio", exact: true }).count(), 0);
    await page.getByRole("checkbox", { name: ".design", exact: true }).check();
    await page.getByRole("button", { name: "Remove extension .design", exact: true }).click();
    assert.equal(await page.getByRole("checkbox", { name: ".design", exact: true }).isChecked(), false);
    await replaceNames(page, "Alpha, Beta");
    await page.getByRole("button", { name: "Search domains", exact: true }).click();
    assert.equal(await page.locator("[data-domain-entry]").count(), 2);
    assert.equal(await page.getByRole("heading", { name: /^alpha\.|^beta\./ }).count(), 6);
    await page.getByRole("button", { name: "Edit filters", exact: true }).click();
    await page.getByRole("button", { name: "Clear selection", exact: true }).click();
    await page.getByRole("button", { name: "Search domains", exact: true }).click();
    assert.match(await page.getByRole("alert").innerText(), /at least one extension/);
    assert.equal(await page.getByRole("heading", { name: /^alpha\.|^beta\./ }).count(), 0);
  });
  await run("select all respects the draft extension limit without silently truncating", async () => {
    await page.goto(url); await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "All extensions", exact: true }).click();
    await page.getByRole("button", { name: "Select all", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").innerText(), /up to 10/);
    assert.equal(await page.getByRole("group", { name: "Extensions for names", exact: true }).getByRole("checkbox", { checked: true }).count(), 3);
    assert.equal(await page.getByRole("button", { name: /^Remove extension/ }).count(), 3);
  });
  await run("resetting view filters preserves results when their extensions are unchanged", async () => {
    await search("unavailable");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    assert.equal(await page.getByRole("heading", { name: /^northstar\./ }).count(), 3);
    await page.getByRole("button", { name: "Edit filters", exact: true }).click();
    await page.getByRole("textbox", { name: "Names or full domains" }).evaluate(element => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "Cedar\nRiver\n");
      element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await page.getByRole("button", { name: "Search domains", exact: true }).click();
    assert.equal(await page.getByRole("heading", { name: /^cedar\.|^river\./ }).count(), 6);
    assert.equal(await page.locator('[data-domain-entry="Cedar"]').count(), 1);
    assert.equal(await page.locator('[data-domain-entry="River"]').count(), 1);
  });
  await run("only current taken evidence is hidden and expiry restores an unknown row", async () => {
    await page.clock.install(); await search("taken-expiry"); await check().click();
    await page.getByRole("heading", { name: "northstar.com", exact: true }).waitFor({ state: "hidden" });
    await page.clock.runFor(2000);
    await page.getByRole("heading", { name: "northstar.com", exact: true }).waitFor();
    assert.equal(await page.getByLabel("northstar.com availability").innerText(), "Unknown");
    assert.equal(await quote().isDisabled(), true);
  });
  await run("sorting and budgets use verified prices and keep expired unpriced results", async () => {
    await page.clock.install(); await search("sorting");
    for (const domain of ["northstar.com", "northstar.co", "northstar.io"]) {
      const details = page.getByRole("button", { name: `View ${domain} details`, exact: true });
      if (await details.getAttribute("aria-expanded") !== "true") await details.click();
      await page.getByRole("button", { name: `Check availability for ${domain}`, exact: true }).click();
      await page.getByLabel(`${domain} availability`).getByText("Confirmed available").waitFor();
      await page.getByRole("button", { name: `Request quote for ${domain}`, exact: true }).click();
      await page.getByLabel(`Quote for ${domain}`, { exact: true }).waitFor();
    }
    assert.deepEqual(await page.getByRole("heading", { name: /^northstar\./ }).allTextContents(), ["northstar.co", "northstar.io", "northstar.com"]);
    await page.getByRole("button", { name: "Sort by domain", exact: true }).click();
    assert.deepEqual(await page.getByRole("heading", { name: /^northstar\./ }).allTextContents(), ["northstar.co", "northstar.com", "northstar.io"]);
    await page.getByRole("button", { name: "Edit filters", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Maximum", exact: true }).fill("15");
    assert.deepEqual(await page.getByRole("heading", { name: /^northstar\./ }).allTextContents(), ["northstar.co"]);
    await page.clock.runFor(61000);
    assert.equal(await page.getByRole("heading", { name: /^northstar\./ }).count(), 3);
    assert.equal(await page.getByText("Not quoted", { exact: true }).count(), 3);
  });
  await run("unavailable default, unknown candidates and no actionable provider buttons", async () => {
    await page.goto(url); await page.getByRole("heading", { name: "Domain library unavailable" }).waitFor();
    await search("unavailable");
    assert.equal(await page.getByRole("heading", { name: "northstar.com", exact: true }).count(), 1);
    assert.equal(await check().isDisabled(), true); assert.equal(await quote().isDisabled(), true);
    assert.equal(await page.getByText("Unknown", { exact: true }).count(), 3);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${output}/domains-search-desktop.png`, fullPage: true });
  });
  await run("invalid batch blocks candidate construction", async () => {
    await search("unavailable", "valid.com\nhttps://bad.com");
    await page.getByRole("alert").waitFor(); assert.equal(await page.getByRole("heading", { name: "valid.com", exact: true }).count(), 0);
  });
  await run("fresh evidence, quote terms and disabled checkout", async () => {
    await search("ready"); await check().click(); await page.getByText("Confirmed available", { exact: true }).waitFor();
    assert.equal(await quote().isEnabled(), true); await quote().click(); await page.getByRole("heading", { name: "Quote review" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Purchase unavailable" }).isDisabled(), true);
    await page.getByRole("button", { name: "Create brand from northstar.com", exact: true }).click();
    const handoff = JSON.parse(await page.getByLabel("Brand handoff fixture").textContent());
    assert.equal(handoff.domain, "northstar.com"); assert.equal(handoff.check.provider, "Synthetic fixture registrar"); assert.equal(handoff.order, null);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${output}/domains-quote-desktop.png`, fullPage: true });
  });
  await run("mismatched check response remains unknown and retryable", async () => {
    await search("mismatch"); await check().click(); await page.getByRole("alert").waitFor();
    assert.equal(await page.getByText("Confirmed available", { exact: true }).count(), 0); assert.equal(await quote().isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Check again for northstar.com" }).isEnabled(), true);
  });
  await run("transport failure preserves candidates without evidence", async () => {
    await search("error"); await check().click(); await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("heading", { name: "northstar.com", exact: true }).count(), 1); assert.equal(await quote().isDisabled(), true);
  });
  await run("expired availability loses quote eligibility while evidence remains visible", async () => {
    await page.clock.install(); await search("expiry"); await check().click(); await page.getByText("Confirmed available", { exact: true }).waitFor();
    await page.clock.runFor(2000); assert.equal(await quote().isDisabled(), true);
    assert.equal(await page.getByText("Confirmed available", { exact: true }).count(), 0);
  });
  await run("quote expiry is explicit and never enables checkout", async () => {
    await page.clock.install(); await search("quote-expiry"); await check().click(); await page.getByText("Confirmed available", { exact: true }).waitFor(); await quote().click(); await page.getByRole("heading", { name: "Quote review" }).waitFor();
    await page.clock.runFor(2000); await page.getByText("Quote expired. Request a new quote.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Purchase unavailable" }).isDisabled(), true);
  });
  await run("new preparation fences late checks from an earlier search", async () => {
    await search("late"); await check().click(); await replaceNames(page, "changed.com"); await page.getByRole("button", { name: "Search domains", exact: true }).click();
    await page.waitForTimeout(500); assert.equal(await page.getByRole("heading", { name: "northstar.com", exact: true }).count(), 0); assert.equal(await page.getByText("Confirmed available", { exact: true }).count(), 0);
  });
  await run("connection change cancels pending checks and exposes unavailable controls", async () => {
    await search("switch"); await check().click(); await page.getByRole("button", { name: "Disconnect fixture adapter" }).click();
    await page.getByText("Previous request cancelled after a connection change.", { exact: true }).waitFor();
    await page.waitForTimeout(400); assert.equal(await check().isDisabled(), true); assert.equal(await page.getByText("Confirmed available", { exact: true }).count(), 0);
  });
  await run("request deadline releases retry controls and keeps availability unknown", async () => {
    await page.clock.install(); await search("timeout"); await check().click(); await page.clock.runFor(15001); await page.getByText("Request timed out. Try again.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Check again for northstar.com" }).isEnabled(), true); assert.equal(await quote().isDisabled(), true);
  });
  await run("confirmed library excludes paid-but-pending records and supports filtering", async () => {
    await page.goto(`${url}/?scenario=library`); await page.getByText("Registration confirmed at purchase", { exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "northstar.com", exact: true }).count(), 1); await page.getByRole("alert").waitFor();
    await page.getByRole("searchbox", { name: "Search purchased domains" }).fill("absent"); await page.getByRole("heading", { name: "No matching purchased domains" }).waitFor();
  });
  await run("selection exports actual rows and resets when the same search is recreated", async () => {
    await search("ready");
    await page.getByRole("checkbox", { name: "Select northstar.com", exact: true }).check();
    await page.getByText("Result actions · 1 selected", { exact: true }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV", exact: true }).click();
    const download = await downloadPromise;
    const csv = await readFile(await download.path(), "utf8");
    assert.equal(download.suggestedFilename(), "embel-domain-candidates.csv");
    assert.match(csv, /"northstar.com","Not checked",""/);
    assert.doesNotMatch(csv, /"northstar\.(co|io)"/);
    await page.getByRole("button", { name: "Search domains", exact: true }).click();
    await page.getByText("Result actions", { exact: true }).waitFor();
    await page.getByRole("button", { name: "View northstar.com details", exact: true }).click();
    assert.equal(await page.getByRole("checkbox", { name: "Select northstar.com", exact: true }).isChecked(), false);
  });
  await run("bulk checks release on non-cooperative timeout and can be retried or stopped", async () => {
    await page.clock.install(); await search("never");
    await page.getByText("Result actions", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Select all visible domains" }).check();
    await page.getByRole("button", { name: "Check selected domains", exact: true }).dblclick();
    await page.getByRole("button", { name: "Checking selected…", exact: true }).waitFor();
    await page.clock.runFor(15001);
    await page.getByText("Bulk checking stopped after a request timed out. Completed results are retained.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Check selected domains", exact: true }).isEnabled(), true);
    assert.equal(await page.getByText("Confirmed available", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Check selected domains", exact: true }).click();
    await page.getByRole("button", { name: "Stop bulk checking", exact: true }).click();
    await page.getByText("Bulk checking stopped. Completed results are retained.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Check selected domains", exact: true }).isEnabled(), true);
  });
  await run("bulk check results and all-visible selection respect taken filters", async () => {
    await search("taken"); await page.getByText("Result actions", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Select all visible domains" }).check();
    await page.getByRole("button", { name: "Check selected domains", exact: true }).click();
    await page.getByRole("button", { name: "Check selected domains", exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "northstar.com", exact: true }).count(), 0);
    assert.equal(await page.getByText("Confirmed available", { exact: true }).count(), 2);
    await page.getByRole("button", { name: "Clear selected domains", exact: true }).click();
    await page.getByRole("checkbox", { name: "Select all visible domains" }).check();
    const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "Export CSV", exact: true }).click();
    const csv = await readFile(await (await downloadPromise).path(), "utf8");
    assert.doesNotMatch(csv, /northstar.com/); assert.match(csv, /northstar.co/); assert.match(csv, /northstar.io/);
  });
  await run("payment confirmation and reconciliation stay distinct from purchase success", async () => {
    await page.goto(`${url}/?scenario=paid`); await page.getByText("Payment confirmed · registration pending", { exact: true }).waitFor(); await page.getByText("Order needs reconciliation", { exact: true }).waitFor();
    assert.equal(await page.getByText("Registration confirmed", { exact: true }).count(), 0);
  });
  await run("mobile layout and keyboard input remain usable", async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await search("ready"); await check().click(); await page.getByText("Confirmed available", { exact: true }).waitFor(); await quote().click(); await page.getByRole("heading", { name: "Quote review" }).waitFor();
    const overflowing = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth); assert.equal(overflowing, false);
    await page.getByRole("textbox", { name: "Names or full domains" }).focus(); await page.keyboard.press("Tab");
    assert.equal(await page.getByRole("button", { name: "Search domains", exact: true }).evaluate(element => element === document.activeElement), true);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${output}/domains-quote-mobile.png`, fullPage: true });
  });
  assert.deepEqual(failures, []);
  await writeFile(`${output}/browser-evidence.json`, JSON.stringify({ syntheticOnly: true, browserVersion: browser.version(), loopbackPort: server.address().port, externalRequests: 0, results, pageErrors: failures }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
