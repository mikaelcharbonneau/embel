// Dedicated synthetic React/UI regression; local files and zero provider requests.
import { build } from "esbuild";
import { createServer } from "node:http";
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(".tmp/handles-adapter-race");
await mkdir(output, { recursive: true });
await build({ entryPoints: ["tests/features/handles-workspace/adapter-race-preview.tsx"], bundle: true, outfile: `${output}/preview.js`, platform: "browser", jsx: "automatic", define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' }, tsconfig: "tsconfig.json" });
const tokens = await readFile("src/styles/tokens.css", "utf8");
await writeFile(`${output}/preview.html`, `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${tokens}</style><link rel="stylesheet" href="./preview.css"></head><body><main id="root"></main><script src="./preview.js"></script></body></html>`);
const browser = await chromium.launch({ headless: true, executablePath: process.env.FLUID_E2E_BROWSER_EXECUTABLE || undefined });
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const files = { "/preview.html": ["preview.html", "text/html"], "/preview.js": ["preview.js", "text/javascript"], "/preview.css": ["preview.css", "text/css"] };
  const file = files[pathname];
  if (!file) { response.writeHead(404); response.end(); return; }
  try { response.writeHead(200, { "Content-Type": file[1] }); response.end(await readFile(`${output}/${file[0]}`)); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const errors = [], remoteRequests = [], scenarios = [];
try {
  for (const action of ["Disconnect fixture adapter", "Replace fixture adapter"]) {
    const page = await browser.newPage(); page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => { const asset = new URL(route.request().url()).pathname.match(/^\/handles\/([a-z-]+\.svg)$/); if (asset) return route.fulfill({ contentType: "image/svg+xml", body: await readFile(`public/handles/${asset[1]}`) }); if (!route.request().url().startsWith(url)) { remoteRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
    await page.goto(`${url}preview.html`);
    await page.getByRole("tab", { name: "Search", exact: true }).click();
    await page.getByLabel("Business handles", { exact: true }).fill("Morrow");
    await page.getByLabel("Prefixes", { exact: true }).fill("");
    await page.getByLabel("Suffixes", { exact: true }).fill("");
    await page.getByRole("checkbox", { name: "X", exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "LinkedIn", exact: true }).uncheck();
    await page.getByRole("button", { name: "Build comparison", exact: true }).click();
    await page.getByRole("button", { name: "Check platforms", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.handlesRace.snapshot())).toEqual([{ adapter: "A", platform: "instagram", aborted: false }]);
    await page.getByRole("button", { name: action, exact: true }).click();
    // This is a prop replacement, not a workspace remount: the pending old request must abort.
    await expect.poll(() => page.evaluate(() => window.handlesRace.snapshot())).toEqual([{ adapter: "A", platform: "instagram", aborted: true }]);
    await page.evaluate(() => window.handlesRace.settle("A"));
    expect(await page.evaluate(() => window.handlesRace.snapshot())).toEqual([{ adapter: "A", platform: "instagram", aborted: true }]);
    await expect(page.getByText("Confirmed available", { exact: true })).toHaveCount(0);
    await expect(page.getByText("To check", { exact: true })).toHaveCount(3);
    await expect(page.locator(".handles-evidence summary").filter({ hasText: "(1)" })).toHaveCount(0);
    if (action.startsWith("Disconnect")) await expect(page.getByRole("button", { name: "Check platforms", exact: true })).toBeDisabled();
    else await expect(page.getByRole("button", { name: "Check platforms", exact: true })).toBeEnabled();
    if (action.startsWith("Replace")) {
      await page.getByRole("button", { name: "Check platforms", exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.handlesRace.snapshot().map(request => `${request.adapter}:${request.platform}`))).toEqual(["A:instagram", "B:instagram"]);
      await page.evaluate(() => window.handlesRace.settle("B"));
      await expect.poll(() => page.evaluate(() => window.handlesRace.snapshot().map(request => `${request.adapter}:${request.platform}`))).toEqual(["A:instagram", "B:instagram", "B:tiktok", "B:youtube"]);
      await expect(page.getByText("Confirmed available", { exact: true })).toHaveCount(3);
      await page.getByRole("tab", { name: "History", exact: true }).click();
      await expect(page.getByText("Start recorded. Completion and availability are not inferred.")).toHaveCount(2);
      await expect(page.getByText("Confirmed available", { exact: true })).toHaveCount(0);

    }
    scenarios.push({ action, passed: true, requests: await page.evaluate(() => window.handlesRace.snapshot()) });
    await page.close();
  }
  {
    const page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", async route => { const asset = new URL(route.request().url()).pathname.match(/^\/handles\/([a-z-]+\.svg)$/); if (asset) return route.fulfill({ contentType: "image/svg+xml", body: await readFile(`public/handles/${asset[1]}`) }); if (!route.request().url().startsWith(url)) { remoteRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
    await page.clock.install();
    await page.goto(`${url}preview.html`);
    await page.getByRole("button", { name: "Deadline fixture adapter", exact: true }).click();
    await page.getByRole("tab", { name: "Search", exact: true }).click();
    await page.getByLabel("Business handles", { exact: true }).fill("Morrow");
    await page.getByLabel("Prefixes", { exact: true }).fill("");
    await page.getByLabel("Suffixes", { exact: true }).fill("");
    await page.getByRole("checkbox", { name: "X", exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "LinkedIn", exact: true }).uncheck();
    await page.getByRole("button", { name: "Build comparison", exact: true }).click();
    await page.getByRole("checkbox", { name: "Choose @morrow on instagram for bundle", exact: true }).check();
    await page.getByRole("button", { name: "Check platforms", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.handlesRace.snapshot())).toEqual([{ adapter: "T", platform: "tiktok", aborted: false }]);
    await page.clock.fastForward(15_001);
    await expect(page.getByRole("alert")).toContainText("timed out");
    await expect(page.getByRole("button", { name: "Check platforms", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save bundle", exact: true })).toBeEnabled();
    await expect(page.getByText("Confirmed available", { exact: true })).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => window.handlesRace.snapshot())).toEqual([{ adapter: "T", platform: "tiktok", aborted: true }]);
    await page.evaluate(() => window.handlesRace.settle("T"));
    await expect(page.getByText("Confirmed available", { exact: true })).toHaveCount(1);
    await expect(page.getByText("To check", { exact: true })).toHaveCount(2);
    await page.getByRole("button", { name: "Check platforms", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.handlesRace.snapshot().length)).toBe(2);
    await page.getByRole("button", { name: "Stop checks", exact: true }).click();
    await expect(page.getByRole("button", { name: "Check platforms", exact: true })).toBeEnabled();
    scenarios.push({ action: "Deadline retains partial evidence, fences late response and permits retry", passed: true });
    await page.close();
  }
  expect(errors).toEqual([]); expect(remoteRequests).toEqual([]);
  await writeFile(`${output}/verification.json`, JSON.stringify({ passed: true, scenarios, errors, remoteRequests, syntheticFixture: true }, null, 2));
  console.log(JSON.stringify({ passed: true, scenarios: scenarios.length, output }, null, 2));
} catch (error) { console.error("Browser runtime errors:", errors); throw error; } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
