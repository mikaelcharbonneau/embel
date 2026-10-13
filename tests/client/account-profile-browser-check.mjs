// Dedicated synthetic browser harness. No shared .next build or live APIs.
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = process.env.FLUID_PROFILE_EVIDENCE ?? "/workspace/scratch/fluid-functional-workstreams-20261013/profile-preferences/browser";
await mkdir(output, { recursive: true });
await build({ entryPoints: [`${root}tests/client/account-profile-preview.tsx`], outdir: output, bundle: true, jsx: "automatic", platform: "browser", external: ["/settings/*"], loader: { ".woff2": "file" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" }, logLevel: "warning" });
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  try {
    if (path === "/account-profile-preview.js" || path === "/account-profile-preview.css" || /^\/[A-Za-z0-9_-]+\.woff2$/.test(path)) {
      response.setHeader("content-type", path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "font/woff2");
      response.end(await readFile(`${output}${path}`));
    } else if (/^\/settings\/[a-z-]+\.svg$/.test(path)) { response.setHeader("content-type", "image/svg+xml"); response.end(await readFile(`${root}public${path}`)); }
    else { response.setHeader("content-type", "text/html"); response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Profile synthetic fixture</title><link rel="stylesheet" href="/account-profile-preview.css"></head><body><div id="root"></div><script src="/account-profile-preview.js"></script></body></html>'); }
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.FLUID_TEST_CHROMIUM_EXECUTABLE || "/usr/bin/chromium" });
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const record = (ownerId = owner) => ({ ownerId, email: `${ownerId === owner ? "a" : "b"}@example.invalid`, revision: 1, updatedAt: "2026-10-13T00:00:00Z", values: { fullName: ownerId === owner ? "Synthetic profile A" : "Synthetic profile B", timeZone: "America/Toronto", dateFormat: "friendly" } });
const results = [], errors = [], external = [];
try {
  for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }], ["narrow", { width: 320, height: 740 }]]) {
    const context = await browser.newContext({ viewport, timezoneId: "America/Toronto" });
    const page = await context.newPage(); page.setDefaultTimeout(10_000); page.on("pageerror", error => errors.push(error.message));
    let account = owner, saved = record(), writes = 0;
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: account } } });
      if (url.pathname === "/api/auth/sign-out") return route.fulfill({ json: { authenticated: false } });
      assert.equal(url.pathname, "/api/account/profile", "Profile interactions make no provider requests");
      if (request.method() === "GET") return route.fulfill({ json: { profile: saved } });
      assert.equal(request.method(), "PATCH"); writes++;
      const input = request.postDataJSON(); assert.deepEqual(Object.keys(input).sort(), ["expectedRevision", "values"]);
      if (input.expectedRevision !== saved.revision) return route.fulfill({ status: 409, json: { error: { code: "conflict" } } });
      saved = { ...saved, revision: saved.revision + 1, values: input.values };
      return route.fulfill({ json: { profile: saved } });
    });
    await page.goto(origin); await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Synthetic profile A");
    await expect(page.getByLabel("Email address", { exact: true })).toHaveAttribute("readonly", "");
    await page.getByLabel("Full name", { exact: true }).fill("Renée Example");
    await page.getByLabel("Time zone", { exact: true }).selectOption("Asia/Tokyo");
    await page.getByLabel("Date format", { exact: true }).selectOption("iso");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Profile and date preferences saved" })).toBeVisible();
    await expect(page.locator("[data-profile-name]")).toHaveText("Renée Example");
    await expect(page.getByRole("region", { name: "Activity date fixture" })).toHaveText("2026-10-13");
    await page.reload(); await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Renée Example");
    assert.equal(writes, 1); await expect(page.getByLabel("Time zone", { exact: true })).toHaveValue("Asia/Tokyo");
    // A concurrent session is shown before the user elects to retain their edits.
    await page.getByLabel("Full name", { exact: true }).fill("My retained edit");
    saved = { ...saved, revision: saved.revision + 1, values: { ...saved.values, fullName: "Other session edit" } };
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("changed in another session");
    await page.getByRole("button", { name: "Check saved settings", exact: true }).click();
    await expect(page.getByRole("region", { name: "Settings changed in another session" })).toContainText("Other session edit");
    await page.getByRole("button", { name: "Keep my edits", exact: true }).click();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Profile and date preferences saved" })).toBeVisible();
    assert.equal(saved.values.fullName, "My retained edit");
    await page.getByLabel("Full name", { exact: true }).fill("Private unsaved edit");
    await page.getByRole("tab", { name: "Workspace", exact: true }).click(); await page.getByRole("tab", { name: "Account", exact: true }).click();
    await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Private unsaved edit");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Sign out with unsaved account edits?" })).toBeVisible();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    account = other; saved = record(other); await page.getByRole("button", { name: "Recheck fixture account" }).click();
    await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Synthetic profile B");
    await expect(page.locator("[data-profile-name]")).toHaveText("Synthetic profile B");
    assert.equal(await page.getByText("Private unsaved edit", { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
    results.push({ name, checks: "save, visible date preference, reload, conflict, tab retention, sign-out confirmation, owner replacement, overflow", writes });
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await writeFile(`${output}/receipt.json`, JSON.stringify({ fixture: true, liveBackend: false, results, errors, externalRequests: external.length }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results, errors, externalRequests: external.length }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
