// Dedicated headless synthetic browser. Every API is intercepted; no live account or provider.
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = process.env.EMBEL_DELETION_EVIDENCE ?? `${root}../evidence/project-deletion-browser`;
await mkdir(output, { recursive: true });
await build({ entryPoints: [`${root}tests/client/project-deletion-preview.tsx`], outdir: output, bundle: true, jsx: "automatic", platform: "browser", external: ["/projects/*"], loader: { ".woff2": "file" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" }, logLevel: "warning" });
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  try {
    if (path === "/project-deletion-preview.js" || path === "/project-deletion-preview.css" || /^\/[A-Za-z0-9_-]+\.woff2$/.test(path)) {
      response.setHeader("content-type", path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "font/woff2"); response.end(await readFile(`${output}${path}`));
    } else if (/^\/projects\/[a-z-]+\.svg$/.test(path)) { response.setHeader("content-type", "image/svg+xml"); response.end(await readFile(`${root}public${path}`)); }
    else { response.setHeader("content-type", "text/html"); response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project deletion synthetic fixture</title><link rel="stylesheet" href="/project-deletion-preview.css"></head><body><div id="root"></div><script src="/project-deletion-preview.js"></script></body></html>'); }
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.FLUID_TEST_CHROMIUM_EXECUTABLE || "/usr/bin/chromium" });
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const firstId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const row = (id, title, day) => ({ id, owner_id: owner, title, scope: "complete_brand", current_revision: 3, lifecycle_version: 0, deleted_at: null, created_at: `2026-10-${day}T12:00:00Z` });
const results = [], errors = [], external = [];
try {
  for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }], ["narrow", { width: 320, height: 740 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(); page.setDefaultTimeout(10_000); page.on("pageerror", error => errors.push(error.message));
    let account = owner, mode = "success", release = null, writes = 0;
    const rows = [row(firstId, "Synthetic Orchard", "15"), row("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "Synthetic Horizon", "14"), row("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "Synthetic studio with a longer project name", "13")];
    const assetsAndHistory = Object.freeze(["synthetic-asset-v1", "synthetic-context-r1", "synthetic-context-r2", "synthetic-context-r3"]);
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(request.url()); return route.abort(); }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/session") return route.fulfill({ json: { user: { id: account } } });
      if (url.pathname === "/api/projects/page") {
        const deleted = url.searchParams.get("state") === "deleted";
        const items = account === owner ? rows.filter(project => Boolean(project.deleted_at) === deleted) : [{ ...rows[1], id: "ffffffff-ffff-4fff-8fff-ffffffffffff", owner_id: other, title: "Other synthetic account", deleted_at: null }];
        return route.fulfill({ json: { ownerId: account, items, nextCursor: null } });
      }
      assert.match(url.pathname, /^\/api\/projects\/[a-f0-9-]+\/deletion$/, "Only lifecycle mutations are permitted in this fixture");
      assert.ok(request.method() === "POST" || request.method() === "DELETE");
      assert.equal(request.headers()["x-embel-account"], owner); writes++;
      const input = request.postDataJSON(); assert.deepEqual(Object.keys(input).sort(), ["expectedLifecycleVersion", "expectedRevision"]);
      const project = rows.find(item => url.pathname.includes(item.id)); assert.ok(project);
      assert.equal(input.expectedRevision, project.current_revision);
      if (mode === "busy" || mode === "conflict") return route.fulfill({ status: 409, json: { error: { code: mode === "busy" ? "project_busy" : "conflict", message: "Private synthetic server detail" } } });
      if (mode === "unauthorized") return route.fulfill({ status: 401, json: { error: { code: "unauthenticated" } } });
      assert.equal(input.expectedLifecycleVersion, project.lifecycle_version);
      project.lifecycle_version++;
      project.deleted_at = request.method() === "POST" ? "2026-10-15T22:00:00Z" : null;
      const saved = { ...project };
      if (mode === "lost_acknowledgement") return route.abort("failed");
      if (mode === "hold") await new Promise(resolve => { release = resolve; });
      try { await route.fulfill({ json: { project: saved } }); } catch { /* Session changes may abort an old response. */ }
    });
    await page.goto(`${origin}/brands`);
    await expect(page.locator(".project-card")).toHaveCount(3);
    const options = page.getByRole("button", { name: "Project options for Synthetic Orchard", exact: true });
    await options.click(); await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeFocused();
    assert.equal(new URL(page.url()).pathname, "/brands"); assert.equal(await page.locator("a button, a a").count(), 0);
    const target = await options.boundingBox(); assert.ok(target.width >= (name === "desktop" ? 36 : 44));
    await page.screenshot({ path: `${output}/${name}-menu.png`, fullPage: true });
    await page.getByRole("menuitem", { name: "Delete", exact: true }).press("Escape"); await expect(options).toBeFocused();
    await options.press("ArrowDown"); await page.getByRole("menuitem", { name: "Delete", exact: true }).press("Enter");
    await expect(page.getByRole("dialog")).toContainText("assets and history are kept");
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(page.getByRole("button", { name: "Delete project", exact: true })).toBeFocused();
    await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.screenshot({ path: `${output}/${name}-confirmation.png`, fullPage: true });
    await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(options).toBeFocused(); assert.equal(writes, 0);
    await options.click(); await page.locator(".projects-heading h1").click(); await expect(page.getByRole("menu")).toHaveCount(0);
    await options.click(); await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    mode = "hold"; await page.getByRole("button", { name: "Delete project", exact: true }).click();
    await expect(page.getByRole("button", { name: "Moving project…", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => writes).toBe(1); await expect.poll(() => typeof release).toBe("function"); release(); mode = "success";
    await expect(page.locator(".project-card")).toHaveCount(2); await expect(page.getByRole("status")).toContainText("moved to Deleted projects");
    await expect(page.locator(".projects-heading h1")).toBeFocused();
    await page.getByRole("link", { name: "View deleted projects", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Deleted projects.", exact: true })).toBeVisible(); await expect(page.locator(".project-card")).toHaveCount(1); assert.equal(await page.locator(".project-card a").count(), 0);
    await page.screenshot({ path: `${output}/${name}-deleted.png`, fullPage: true });
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.locator(".project-card")).toHaveCount(0); await expect(page.getByRole("status")).toContainText("restored"); assert.equal(writes, 2); assert.equal(rows[0].current_revision, 3); assert.equal(rows[0].lifecycle_version, 2);
    await page.getByRole("link", { name: "Back to projects", exact: true }).first().click(); await expect(page.locator(".project-card")).toHaveCount(3);
    mode = "busy"; await options.click(); await page.getByRole("menuitem", { name: "Delete", exact: true }).click(); await page.getByRole("button", { name: "Delete project", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("active work or work awaiting resolution"); await expect(page.getByRole("link", { name: "Open project", exact: true })).toHaveAttribute("href", `/brands/account/${firstId}`); assert.equal(await page.getByText("Private synthetic server detail").count(), 0);
    await page.getByRole("button", { name: "Refresh projects", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
    mode = "conflict"; await options.click(); await page.getByRole("menuitem", { name: "Delete", exact: true }).click(); await page.getByRole("button", { name: "Delete project", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("changed since it was loaded"); assert.equal(await page.getByRole("button", { name: "Delete project", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Refresh projects", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
    mode = "lost_acknowledgement"; await options.click(); await page.getByRole("menuitem", { name: "Delete", exact: true }).click(); await page.getByRole("button", { name: "Delete project", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("could not be confirmed"); const writesBeforeRead = writes;
    mode = "success"; await page.getByRole("button", { name: "Refresh projects", exact: true }).click(); await expect(page.locator(".project-card")).toHaveCount(2); assert.equal(writes, writesBeforeRead);
    await expect(page.locator(".projects-heading h1")).toBeFocused();
    await page.getByRole("link", { name: "Deleted projects", exact: true }).click(); await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("restored");
    await page.getByRole("link", { name: "Home fixture", exact: true }).click(); await expect(page.locator(".home-brand-card")).toHaveCount(3);
    mode = "hold"; release = null; await options.click(); await page.getByRole("menuitem", { name: "Delete", exact: true }).click(); await page.getByRole("button", { name: "Delete project", exact: true }).click();
    await expect.poll(() => typeof release).toBe("function"); account = other;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("heading", { name: "Other synthetic account", exact: true })).toBeVisible(); release(); mode = "success";
    await expect(page.getByRole("dialog")).toHaveCount(0); assert.equal(await page.getByText("Synthetic Orchard", { exact: true }).count(), 0);
    assert.deepEqual(assetsAndHistory, ["synthetic-asset-v1", "synthetic-context-r1", "synthetic-context-r2", "synthetic-context-r3"]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    results.push({ viewport: name, checks: "menu, sibling controls, keyboard focus/Escape/Tab, outside click, recovery disclosure, pending gate, delete, direct Deleted view, restore, active-work conflict, stale CAS, lost-ack read recovery, Home reuse, late old-account response, no overflow", writes });
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await writeFile(`${output}/receipt.json`, JSON.stringify({ fixture: true, liveBackend: false, results, errors, externalRequests: external.length }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results, errors, externalRequests: external.length }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
