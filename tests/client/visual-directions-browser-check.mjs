// Local, synthetic presentation checks. This never signs in or calls an AI provider.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = `${root}.tmp/visual-directions-preview`;
await mkdir(output, { recursive: true });
await build({ entryPoints: [`${root}tests/fixtures/visual-directions-preview.tsx`], outfile: `${output}/preview.js`, bundle: true, jsx: "automatic", platform: "browser", loader: { ".woff2": "file" }, define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" }, logLevel: "warning" });
const server = createServer(async (request, response) => {
  const path = request.url?.split("?")[0];
  if (path === "/preview.js" || path === "/preview.css" || /^\/[A-Za-z0-9_-]+\.woff2$/.test(path ?? "")) {
    response.setHeader("content-type", path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "font/woff2");
    response.end(await readFile(`${output}${path}`));
  } else {
    response.setHeader("content-type", "text/html");
    response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic directions fixture</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script src="/preview.js"></script></body></html>');
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const browser = await chromium.launch({ headless: true, executablePath: process.env.FLUID_TEST_CHROMIUM_EXECUTABLE || "/usr/bin/chromium" });
const results = [];
try {
  for (const [device, viewport] of [["desktop", { width: 1440, height: 1100 }], ["mobile", { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = []; page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    page.on("console", message => { if (message.type() === "error") { errors.push(message.text()); console.error(message.text()); } });
    for (const state of ["empty", "partial", "complete", "long"]) {
      await page.goto(`http://127.0.0.1:${address.port}/?state=${state}`);
      await page.getByRole("heading", { name: "Visual direction", exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator("article").count(), 3);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${device}/${state} overflows`);
      if (state !== "empty") {
        await page.getByRole("img", { name: "Synthetic board 1", exact: true }).waitFor();
        const expand = page.getByRole("button", { name: /View .* larger/ }).first();
        await expand.click();
        assert.equal(await page.locator("dialog").evaluate(node => node.open), true);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("dialog").evaluate(node => node.open), false);
        assert.equal(await expand.evaluate(node => node === document.activeElement), true);
      }
      if (state === "partial") {
        assert.equal(await page.getByText("2 of 3 ready", { exact: true }).count(), 1);
        await page.getByRole("button", { name: "Choose direction", exact: true }).first().click();
        await page.getByRole("button", { name: "Chosen direction", exact: true }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Create brand assets" }).isEnabled(), true);
      }
      await page.screenshot({ path: `${output}/${device}-${state}.png`, fullPage: true, scale: "css" });
      results.push(`${device}/${state}`);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(JSON.stringify({ checked: results, screenshots: output }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
