import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = new URL("../../..", import.meta.url).pathname;
const result = await build({ entryPoints: [resolve(root, "tests/features/handles-workspace/account-editor-fixture.tsx")], outfile: "fixture.js", bundle: true, platform: "browser", write: false, define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' }, tsconfig: resolve(root, "tsconfig.json"), plugins: [{ name: "synthetic-account-boundary", setup(build) {
  build.onResolve({ filter: /(?:^@\/components\/workspace\/account-session$)/ }, () => ({ path: resolve(root, "tests/features/handles-workspace/account-session-fixture.tsx") }));
} }] });
const js = result.outputFiles.find(file => file.path.endsWith(".js")).text;
const css = result.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
const ownerA = "00000000-0000-4000-8000-00000000000a", ownerB = "00000000-0000-4000-8000-00000000000b";
const projectId = "00000000-0000-4000-8000-000000000010";
const source = { projectId, projectRevision: 2, projectTitle: "Fixture project", name: "SavedFixture", selectionId: null, candidateId: null, origin: "project_name" };
const at = "2026-10-05T12:00:00.000Z";
const records = new Map(), requests = [], failures = [], errors = [];
let owner = ownerA, badImport = false, nextConflict = false, nextLostSave = false, delayImport = null, releaseImport = null;
const browser = await chromium.launch({ headless: true, executablePath: process.env.FLUID_E2E_BROWSER_EXECUTABLE || undefined });
const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
const page = await context.newPage();
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
const json = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
await page.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.hostname !== "fluid-fixture.test") { failures.push(request.url()); await route.abort(); return; }
  if (url.pathname === "/") { await route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><title>Fixture</title><style>${css} body{font:16px sans-serif;margin:20px}button,input,select{font:inherit}.page{margin:20px 0}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>` }); return; }
  if (url.pathname === "/fixture.js") { await route.fulfill({ contentType: "text/javascript", body: js }); return; }
  if (/^\/handles\/[a-z-]+\.svg$/.test(url.pathname)) { await route.fulfill({ contentType: "image/svg+xml", body: await readFile(resolve(root, `public${url.pathname}`)) }); return; }
  requests.push({ path: url.pathname, method: request.method(), owner, body: request.postDataJSON() });
  if (url.pathname === "/api/workspaces/imports") {
    const responseOwner = owner;
    if (delayImport) { const waiting = delayImport; delayImport = null; await waiting; }
    await json(route, { ownerId: badImport ? ownerB : responseOwner, source }); return;
  }
  const tool = url.pathname.split("/").at(-1);
  if (!['handles', 'trademarks'].includes(tool)) { failures.push(url.pathname); await route.abort(); return; }
  const key = `${owner}:${tool}`;
  if (request.method() === "GET") { await json(route, { ownerId: owner, workspace: records.get(key) ?? null }); return; }
  const input = request.postDataJSON(), previous = records.get(key);
  if (nextConflict || input.expectedRevision !== (previous?.revision ?? 0)) { nextConflict = false; await json(route, { error: { code: "conflict" } }, 409); return; }
  const workspace = { id: "00000000-0000-4000-8000-000000000020", ownerId: owner, tool, revision: input.expectedRevision + 1, payload: input.payload, imports: input.imports.map(() => source), createdAt: previous?.createdAt ?? at, updatedAt: at };
  records.set(key, workspace);
  if (nextLostSave) { nextLostSave = false; await route.abort(); return; }
  await json(route, { ownerId: owner, workspace });
});
const button = text => page.getByRole("button", { name: text, exact: true });
const waitText = text => page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor();
const waitEnabled = async text => { await button(text).waitFor(); await page.waitForFunction(label => [...document.querySelectorAll("button")].some(element => element.textContent === label && !element.disabled && !element.closest("fieldset[disabled]")), text); };
const output = resolve(root, ".tmp/handles-trademarks-account");
const checks = [];
try {
  await page.goto("https://fluid-fixture.test");
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await waitText("Keep your handles together");
  await button("Import saved name").click();
  await waitText("Saved name added");
  await page.getByRole("tab", { name: "Search", exact: true }).click();
  await page.getByLabel("SavedFixtureFixture project", { exact: false }).check();
  await button("Build comparison").click();
  await page.getByLabel("Choose @savedfixture on instagram for bundle", { exact: true }).check();
  await button("Save bundle").click();
  await button("I created this account").click();
  await page.getByLabel("Account URL (optional)").fill("https://instagram.com/savedfixture");
  await button("Record my created account").click();
  await button("Favorite").click();
  await button("Save account draft").click();
  await waitText("Account draft saved · revision 1");
  assert.equal(records.get(`${ownerA}:handles`).payload.bundles[0].entries[0].evidence.length, 0);
  assert.equal(records.get(`${ownerA}:handles`).payload.bundles[0].entries[0].accountCreated.url, "https://instagram.com/savedfixture");
  await page.reload();
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await waitText("Account created · user declared");
  await waitText("Account draft saved · revision 1");
  await button("Favorited").waitFor();
  assert.equal(await page.getByText("Confirmed available", { exact: true }).count(), 0);
  checks.push("Handles: explicit import, bundle/declaration/favorite save and actual page reload retain only user data");

  nextConflict = true;
  await button("Select").click();
  await button("Save account draft").click();
  await waitText("saved draft or imported source changed");
  assert.equal(await button("Selected").isDisabled(), true);
  await button("Load saved draft").click();
  await button("Keep my edits").click();
  assert.equal(await button("Selected").count(), 1);
  await button("Load saved draft").click();
  await button("Discard changes and load saved draft").click();
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await waitEnabled("Select");
  checks.push("CAS conflict retains edits, disables writes, and reload needs explicit discard");

  await page.getByRole("tab", { name: "Search", exact: true }).click();
  await page.getByLabel("Business handles", { exact: true }).fill("Private unsaved comparison");
  owner = ownerB;
  await button("Verify owner B").click();
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await waitText("Keep your handles together");
  assert.equal(await page.getByText("SavedFixture", { exact: true }).count(), 0);
  await page.getByRole("tab", { name: "Search", exact: true }).click();
  assert.equal(await page.getByLabel("Business handles", { exact: true }).inputValue(), "");
  owner = ownerA; await button("Verify owner A").click();
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await waitText("Account created · user declared");
  checks.push("Owner change hides prior private draft and resets transient Handles comparison state");

  await button("Trademarks fixture").click();
  await page.getByLabel("Mark name", { exact: true }).fill("Personal mark");
  await page.getByLabel("Owner address", { exact: true }).fill("Private fixture address");
  await page.getByLabel("Your research notes", { exact: true }).fill("Unverified note");
  await button("Review draft preview").click();
  await page.getByRole("checkbox", { name: "I reviewed these user-entered notes.", exact: false }).check();
  await button("Save account draft").click();
  await waitText("Account draft saved · revision 1");
  await page.reload(); await button("Trademarks fixture").click();
  await waitText("Account draft saved · revision 1");
  assert.equal(await page.getByLabel("Owner address", { exact: true }).inputValue(), "Private fixture address");
  await button("Draft preview").click();
  assert.equal(await page.getByRole("checkbox", { name: "I reviewed these user-entered notes.", exact: false }).isChecked(), true);
  checks.push("Trademark draft and exact informational review marker survive actual page reload");

  await button("Import saved name").click();
  await button("Keep current name").click();
  await button("Import saved name").click();
  await button("Replace mark name").click();
  await waitText("Saved name copied into this draft");
  await button("Dossier").click();
  assert.equal(await page.getByLabel("Mark name", { exact: true }).inputValue(), source.name);
  assert.equal(await page.getByLabel("Owner address", { exact: true }).inputValue(), "Private fixture address");
  await button("Draft preview").click();
  assert.equal(await page.getByRole("checkbox", { name: "I reviewed these user-entered notes.", exact: false }).isChecked(), false);
  checks.push("Trademark explicit replacement preserves owner notes and invalidates review");

  badImport = true;
  await button("Import saved name").click(); await button("Replace mark name").click();
  await waitText("account response could not be verified");
  badImport = false;
  await button("Dossier").click();
  assert.equal(await page.getByLabel("Mark name", { exact: true }).inputValue(), source.name);
  checks.push("Cross-owner imported response is rejected before feature projection");

  delayImport = new Promise(resolve => { releaseImport = resolve; });
  await button("Import saved name").click(); await button("Replace mark name").click();
  owner = ownerB; await button("Verify owner B").click();
  releaseImport();
  await page.getByLabel("Mark name", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Mark name", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Owner address", { exact: true }).inputValue(), "");
  checks.push("Late import completion after account switch cannot populate the new owner draft");

  owner = ownerA; await button("Verify owner A").click();
  await page.getByLabel("Mark name", { exact: true }).fill("Pending save mark");
  await button("Hide account").click();
  await waitText("Account content is hidden");
  assert.equal(await page.getByLabel("Mark name", { exact: true }).count(), 0);
  await button("Verify owner A").click();
  await page.getByLabel("Mark name", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Mark name", { exact: true }).inputValue(), "Pending save mark");
  checks.push("Unverified session hides private controls and same-owner re-verification recovers buffered edits");
  nextLostSave = true;
  await button("Save account draft").click();
  await waitEnabled("Retry same save");
  const first = requests.filter(request => request.path === "/api/workspaces/trademarks" && request.method === "PUT").at(-1).body;
  assert.equal(await page.getByLabel("Mark name", { exact: true }).isDisabled(), true);
  // The fixture deliberately rejects replay at a newer revision. Verify the client
  // still retries the exact original intent and then exposes explicit recovery.
  await button("Retry same save").click();
  await waitText("saved draft or imported source changed");
  const retried = requests.filter(request => request.path === "/api/workspaces/trademarks" && request.method === "PUT").at(-1).body;
  assert.deepEqual(retried, first);
  await button("Load saved draft").click(); await button("Discard changes and load saved draft").click();
  await waitText("Account draft saved · revision 2");
  assert.equal(await page.getByLabel("Mark name", { exact: true }).inputValue(), "Pending save mark");
  checks.push("Lost save acknowledgement preserves exact retry intent and reloads committed data after explicit recovery");

  assert.deepEqual(failures, []);
  const unexpectedErrors = errors.filter(error => !error.includes("Failed to load resource: net::ERR_FAILED") && !error.includes("Failed to load resource: the server responded with a status of 409"));
  assert.deepEqual(unexpectedErrors, []);
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "verification.json"), JSON.stringify({ checks, count: checks.length, externalRequests: failures.length, unexpectedBrowserErrors: unexpectedErrors, scope: "Synthetic route-backed browser fixture, actual client/hook/editors; no live auth/database/provider" }, null, 2));
  console.log(`${checks.length} Handles/Trademarks account checks passed; zero external requests and unexpected browser errors.`);
} catch (error) { console.error("Fixture page on failure:", await page.locator("body").innerText(), errors); throw error; } finally { await context.close(); await browser.close(); }
