// Synthetic account consumer checks; never the shared browser or a real backend.
import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = `${root}.tmp/domains-account-preview`;
await mkdir(output, { recursive: true });
await build({ entryPoints: [`${root}tests/features/domain-workspace/account-preview.tsx`], outdir: output, bundle: true, jsx: "automatic", platform: "browser", loader: { ".woff2": "file" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" }, logLevel: "warning" });
const server = createServer(async (request, response) => {
  if (/^\/[A-Za-z0-9_-]+\.woff2$/.test(request.url ?? "")) { response.setHeader("content-type", "font/woff2"); response.end(await readFile(`${output}${request.url}`)); }
  else if (request.url?.startsWith("/account-preview.js") || request.url?.startsWith("/account-preview.css")) {
    const extension = request.url.startsWith("/account-preview.js") ? "js" : "css";
    response.setHeader("content-type", extension === "js" ? "application/javascript" : "text/css"); response.end(await readFile(`${output}/account-preview.${extension}`));
  } else { response.setHeader("content-type", "text/html"); response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Domains account synthetic fixture</title><link rel="stylesheet" href="/account-preview.css"></head><body><div id="root"></div><script src="/account-preview.js"></script></body></html>'); }
});
await new Promise(resolve => server.listen(Number(process.env.FLUID_DOMAINS_FIXTURE_PORT ?? 0), "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.FLUID_TEST_CHROMIUM_EXECUTABLE ? { executablePath: process.env.FLUID_TEST_CHROMIUM_EXECUTABLE } : {}) });
const owner = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const projectId = "55555555-5555-4555-8555-555555555555";
const draft = (input = "North Star") => ({ version: 1, input, extensions: ["com", "io"], candidates: input === "North Star" ? ["northstar.com", "northstar.io"] : [] });
const workspace = (ownerId = owner, input = "North Star") => ({ id: ownerId === owner ? "33333333-3333-4333-8333-333333333333" : "66666666-6666-4666-8666-666666666666", ownerId, tool: "domains", revision: 1, payload: draft(input), imports: [], createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z" });
const source = { projectId, projectRevision: 7, projectTitle: "Synthetic saved project", name: "Owned Name", selectionId: "77777777-7777-4777-8777-777777777777", candidateId: "88888888-8888-4888-8888-888888888888", origin: "naming_selection" };
const results = [], errors = [], requests = [];
const caseFilter = process.env.FLUID_DOMAINS_ACCOUNT_CASE;
let externalRequests = 0;
const reply = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const input = page => page.getByRole("textbox", { name: "Keywords or domains" });
const save = page => page.getByRole("button", { name: "Save draft", exact: true });
async function edit(page, value) { await input(page).fill(value); await page.getByRole("button", { name: "Generate candidates", exact: true }).click(); }
async function run(name, task) {
  if (caseFilter && !name.includes(caseFilter)) return;
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(`${name}: ${error.message}`));
  const fixture = { owner, workspaces: new Map([[owner, workspace()], [other, workspace(other, "Other Account Name")]]), source: structuredClone(source), puts: [], onGet: null, onPut: null, onImport: null };
  fixture.persist = async (route, body) => {
    const current = fixture.workspaces.get(fixture.owner);
    if (body.expectedRevision !== (current?.revision ?? 0)) return reply(route, { error: "Synthetic CAS conflict" }, 409);
    const next = { ...(current ?? workspace(fixture.owner)), revision: body.expectedRevision + 1, payload: body.payload,
      imports: body.imports.map(selector => { assert.equal(selector.projectId, source.projectId); assert.equal(selector.projectRevision, source.projectRevision); return structuredClone(source); }) };
    fixture.workspaces.set(fixture.owner, next); await reply(route, { ownerId: fixture.owner, workspace: next });
  };
  await page.route("**/*", async route => {
    const request = route.request(), parsed = new URL(request.url());
    if (parsed.origin !== url) { externalRequests++; return route.abort("blockedbyclient"); }
    if (!parsed.pathname.startsWith("/api/")) return route.continue();
    requests.push({ path: parsed.pathname, method: request.method() });
    if (parsed.pathname === "/api/session") return reply(route, { user: { id: fixture.owner } });
    if (parsed.pathname === "/api/workspaces/imports") {
      assert.equal(parsed.searchParams.get("projectId"), projectId);
      return fixture.onImport ? fixture.onImport(route) : reply(route, { ownerId: fixture.owner, source: fixture.source });
    }
    assert.equal(parsed.pathname, "/api/workspaces/domains", "No provider or unrelated API may be requested");
    if (request.method() === "GET") return fixture.onGet ? fixture.onGet(route) : reply(route, { ownerId: fixture.owner, workspace: fixture.workspaces.get(fixture.owner) ?? null });
    assert.equal(request.method(), "PUT");
    const body = request.postDataJSON(); fixture.puts.push(body);
    assert.deepEqual(Object.keys(body).sort(), ["expectedRevision", "imports", "payload", "requestKey"]);
    assert.deepEqual(Object.keys(body.payload).sort(), ["candidates", "extensions", "input", "version"]);
    return fixture.onPut ? fixture.onPut(route, body) : fixture.persist(route, body);
  });
  try { await task(page, fixture); results.push(name); console.log(`PASS ${name}`); }
  catch (error) { console.error(JSON.stringify({ name, page: await page.locator("body").innerText(), errors, requests }, null, 2)); throw error; }
  finally { await page.close(); }
}
try {
  await run("owned prepared draft loads with unknown availability and unavailable registrar", async page => {
    await page.goto(url); await input(page).waitFor();
    assert.equal(await input(page).inputValue(), "North Star");
    assert.equal(await page.getByText("Not checked", { exact: true }).count(), 2);
    await page.getByRole("button", { name: "Details for northstar.com", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Check availability for northstar.com" }).isDisabled(), true);
    assert.equal(await save(page).isDisabled(), true);
    // Saved-result promotion was already connected before this visual update.
    assert.equal(await page.getByRole("button", { name: "Create brand from northstar.com" }).isEnabled(), true);
    await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `${output}/domains-account-desktop.png`, fullPage: true });
  });
  await run("manual edit clears prior candidates, saves CAS and reloads prepared draft", async (page, fixture) => {
    await page.goto(url); await input(page).fill("New Name");
    assert.equal(await page.getByRole("heading", { name: "northstar.com", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Generate candidates", exact: true }).click(); await save(page).click();
    await page.getByText("Saved to account · version 2", { exact: true }).waitFor();
    assert.equal(fixture.puts[0].expectedRevision, 1); assert.deepEqual(fixture.puts[0].payload.candidates, ["newname.com", "newname.io"]);
    await page.reload(); await page.getByRole("heading", { name: "newname.com", exact: true }).waitFor();
    assert.equal(await input(page).inputValue(), "New Name"); assert.equal(await page.getByText("Not checked", { exact: true }).count(), 2);
  });
  await run("explicit saved-name import keeps frozen provenance and saves selectors only", async (page, fixture) => {
    await page.goto(url); await input(page).waitFor();
    assert.equal(fixture.puts.length, 0); await page.getByRole("button", { name: "Import saved name", exact: true }).click();
    await page.getByText("Imported saved sources (1)", { exact: true }).waitFor();
    assert.equal(await input(page).inputValue(), "Owned Name"); assert.equal(await page.getByRole("heading", { name: "northstar.com", exact: true }).count(), 0);
    await page.getByText("Imported saved sources (1)", { exact: true }).click();
    await page.getByText("Saved project version 7 · selected Naming candidate", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Generate candidates", exact: true }).click(); await save(page).click();
    await page.getByText("Saved to account · version 2", { exact: true }).waitFor();
    assert.deepEqual(fixture.puts[0].imports, [{ projectId, projectRevision: 7, selectionId: source.selectionId }]);
    assert.equal(fixture.puts[0].payload.input, "Owned Name");
    fixture.source.name = "Later Name"; fixture.source.projectRevision = 8;
    await page.reload(); await page.getByText("Imported saved sources (1)", { exact: true }).click();
    assert.equal(await input(page).inputValue(), "Owned Name"); await page.getByText("Saved project version 7 · selected Naming candidate", { exact: true }).waitFor();
  });
  await run("preparation error clears when a saved-name import replaces invalid input", async (page, fixture) => {
    await page.goto(url); await edit(page, "bad..com");
    await page.getByRole("alert").waitFor(); assert.match(await page.getByRole("alert").innerText(), /Line 1:/);
    await page.getByRole("button", { name: "Import saved name", exact: true }).click();
    await page.getByText("Imported saved sources (1)", { exact: true }).waitFor();
    assert.equal(await input(page).inputValue(), "Owned Name"); assert.equal(await page.getByRole("alert").count(), 0);
    await page.getByRole("button", { name: "Generate candidates", exact: true }).click();
    assert.equal(await page.getByText("Not checked", { exact: true }).count(), 2); assert.equal(fixture.puts.length, 0);
  });
  await run("preparation error clears after explicit discard loads a valid saved draft", async (page, fixture) => {
    await page.goto(url); await edit(page, "bad..com");
    await page.getByRole("alert").waitFor(); assert.match(await page.getByRole("alert").innerText(), /Line 1:/);
    await page.getByRole("button", { name: "Load saved draft", exact: true }).click();
    await page.getByRole("button", { name: "Discard edits and load saved draft", exact: true }).waitFor();
    assert.equal(await input(page).inputValue(), "bad..com"); assert.equal(await page.getByRole("alert").count(), 1);
    await page.getByRole("button", { name: "Discard edits and load saved draft", exact: true }).click();
    await page.getByText("Saved to account · version 1", { exact: true }).waitFor();
    assert.equal(await input(page).inputValue(), "North Star"); assert.equal(await page.getByRole("alert").count(), 0);
    assert.equal(await page.getByText("Not checked", { exact: true }).count(), 2); assert.equal(fixture.puts.length, 0);
  });
  await run("CAS conflict retains edits until an explicit discard and fresh reload", async (page, fixture) => {
    await page.goto(url); await edit(page, "Unsaved Branch");
    fixture.workspaces.set(owner, { ...workspace(), revision: 2, payload: draft("Newer Saved Name") });
    await save(page).click(); await page.getByRole("alert").waitFor();
    assert.equal(await input(page).inputValue(), "Unsaved Branch"); assert.equal(await input(page).isDisabled(), true);
    await page.getByRole("button", { name: "Load saved draft", exact: true }).click();
    await page.getByRole("button", { name: "Keep edits", exact: true }).click(); assert.equal(await input(page).inputValue(), "Unsaved Branch");
    await page.getByRole("button", { name: "Load saved draft", exact: true }).click();
    await page.getByRole("button", { name: "Discard edits and load saved draft", exact: true }).click();
    await page.getByText("Saved to account · version 2", { exact: true }).waitFor(); assert.equal(await input(page).inputValue(), "Newer Saved Name");
  });
  await run("uncertain save freezes editing and exact retry retains the original request key", async (page, fixture) => {
    fixture.onPut = async (route, body) => fixture.puts.length === 1 ? route.abort("failed") : fixture.persist(route, body);
    await page.goto(url); await edit(page, "Retained Intent"); await save(page).click();
    await page.getByRole("button", { name: "Retry save", exact: true }).waitFor(); assert.equal(await input(page).isDisabled(), true);
    await page.getByRole("button", { name: "Retry save", exact: true }).click(); await page.getByText("Saved to account · version 2", { exact: true }).waitFor();
    assert.deepEqual(fixture.puts[0], fixture.puts[1]); assert.equal(await input(page).isEnabled(), true);
  });
  await run("expired session hides unsaved input and same-owner recovery and remount retain it", async page => {
    await page.goto(url); await edit(page, "Private Unsaved Name");
    await page.getByRole("button", { name: "Expire fixture session", exact: true }).click();
    await page.getByText("No verified account session. Sign in to view your account projects.", { exact: true }).waitFor();
    assert.equal(await input(page).count(), 0); assert.equal(await page.getByText("Private Unsaved Name", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Recheck fixture account", exact: true }).click(); await input(page).waitFor();
    assert.equal(await input(page).inputValue(), "Private Unsaved Name");
    await page.getByRole("button", { name: "Unmount account workspace", exact: true }).click();
    await page.getByRole("button", { name: "Remount account workspace", exact: true }).click(); await input(page).waitFor();
    assert.equal(await input(page).inputValue(), "Private Unsaved Name"); assert.equal(await save(page).isEnabled(), true);
  });
  await run("owner change clears prior drafts and fences a delayed import", async (page, fixture) => {
    let release;
    fixture.onImport = async route => { await new Promise(resolve => { release = resolve; }); await reply(route, { ownerId: owner, source }).catch(() => undefined); };
    await page.goto(url); await edit(page, "Owner One Secret");
    await page.getByRole("checkbox", { name: "Select owneronesecret.com", exact: true }).check();
    await page.getByRole("button", { name: "Import saved name", exact: true }).click();
    await page.getByText("Account request in progress…", { exact: true }).waitFor();
    fixture.owner = other;
    await page.getByRole("button", { name: "Recheck fixture account", exact: true }).click(); await input(page).waitFor();
    release(); await page.waitForTimeout(50);
    assert.equal(await input(page).inputValue(), "Other Account Name");
    await page.getByText("0 selected", { exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "owneronesecret.com", exact: true }).count(), 0); assert.equal(await page.getByText("Imported saved sources (1)", { exact: true }).count(), 0);
    assert.equal(await save(page).isDisabled(), true);
  });
  for (const kind of ["foreign", "malformed"]) await run(`${kind} account response fails closed with no editable payload`, async (page, fixture) => {
    fixture.onGet = route => reply(route, kind === "foreign" ? { ownerId: other, workspace: workspace(other) } : { ownerId: owner, workspace: { ...workspace(), payload: { ...draft(), orders: [] } } });
    await page.goto(url); await page.getByRole("alert").waitFor(); assert.equal(await input(page).count(), 0); assert.equal(await save(page).isDisabled(), true);
    await page.getByText("Account draft unavailable", { exact: true }).waitFor(); assert.equal(await page.getByText("New account draft · not saved yet", { exact: true }).count(), 0);
  });
  await run("mobile account controls wrap and keep manual search keyboard-accessible", async page => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url); await input(page).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await input(page).focus(); await page.keyboard.press("Tab"); assert.equal(await page.getByRole("button", { name: "Generate candidates", exact: true }).evaluate(element => element === document.activeElement), true);
    await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `${output}/domains-account-mobile.png`, fullPage: true });
  });
  assert.deepEqual(errors, []); assert.equal(externalRequests, 0);
  await writeFile(`${output}/browser-evidence${caseFilter ? "-focused" : ""}.json`, JSON.stringify({ syntheticOnly: true, productionSessionWiringTested: false, ...(caseFilter ? { caseFilter } : {}), browserVersion: browser.version(), loopbackPort: server.address().port, externalRequests, requests, results, pageErrors: errors }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
