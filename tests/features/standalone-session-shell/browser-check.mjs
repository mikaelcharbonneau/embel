// Isolated headless browser; every HTTP response is a synthetic fixture.
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(".tmp/standalone-session-shell");
await mkdir(output, { recursive: true });
await build({ entryPoints: ["tests/features/standalone-session-shell/fixture.tsx"], bundle: true, outfile: `${output}/fixture.js`, platform: "browser", jsx: "automatic", tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "fixture-next-navigation", setup(builder) {
    builder.onResolve({ filter: /^next\/(link|navigation)$/ }, args => ({ path: args.path, namespace: "fixture-next" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture-next" }, args => ({ resolveDir: process.cwd(), contents: args.path === "next/link"
      ? "import * as React from 'react'; export default function Link({href,children,...props}){return React.createElement('a',{href:typeof href==='string'?href:href.pathname,...props},children)}"
      : "export const useRouter=()=>({push(){},replace(){},refresh(){}}); export const usePathname=()=>'/fixture'; export const useSearchParams=()=>new URLSearchParams();" }));
  } }] });
const js = await readFile(`${output}/fixture.js`, "utf8");
const css = (await readFile("src/styles/tokens.css", "utf8")) + (await readFile("src/styles/globals.css", "utf8")).replace(/@import[^;]+;/g, "") + await readFile(`${output}/fixture.css`, "utf8");
const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css} :root{--font-geist-sans:Arial} aside output{display:block;overflow-wrap:anywhere} main{max-width:1200px;margin:auto;padding:16px}</style></head><body><main id="root"></main><script src="/fixture.js"></script></body></html>`;
const origin = "https://fluid-shell.test";
const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-1111-4111-8111-111111111111";
const timestamp = "2026-10-05T10:00:00.000001Z";
const projects = Array.from({ length: 125 }, (_, index) => ({ id: `cccccccc-1111-4111-8111-${String(1000 - index).padStart(12, "0")}`, owner_id: A, scope: "naming_only", title: `Synthetic saved project ${index + 1}`, current_revision: 1, created_at: timestamp }));
const cursor = row => ({ id: row.id, createdAt: row.created_at });
function pageOf(owner, rows, more = false) { return { ownerId: owner, items: rows.map(row => ({ ...row, owner_id: owner })), nextCursor: more ? cursor(rows.at(-1)) : null }; }
function gate() { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; }

const browser = await chromium.launch({ headless: true });
const checks = [];
async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [], unexpected = [], calls = [];
  page.on("pageerror", error => errors.push(error.message));
  const state = { owner: A, sessionStatus: 200, sessionGate: null, signOutStatus: 200, signOutBody: { authenticated: false }, signOutGate: null,
    projectGate: null, projects: (url, owner) => {
      const start = url.searchParams.has("cursorId") ? projects.findIndex(row => row.id === url.searchParams.get("cursorId")) + 1 : 0;
      return { status: 200, body: pageOf(owner, projects.slice(start, start + 50), start + 50 < projects.length) };
    }, workspace: (_url, owner) => ({ status: 200, body: { ownerId: owner, workspace: null } }),
  };
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { unexpected.push(route.request().url()); return route.abort(); }
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "application/javascript", body: js });
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
    calls.push({ path: url.pathname, query: url.search, method: route.request().method() });
    const owner = state.owner;
    if (url.pathname === "/api/session") {
      const status = state.sessionStatus, pending = state.sessionGate;
      if (pending) await pending.wait;
      return route.fulfill({ status, json: status === 200 ? { user: { id: owner } } : { error: "synthetic" } }).catch(() => {});
    }
    if (url.pathname === "/api/auth/sign-out") {
      const status = state.signOutStatus, body = state.signOutBody, pending = state.signOutGate;
      if (pending) await pending.wait;
      return route.fulfill({ status, json: body }).catch(() => {});
    }
    if (url.pathname === "/api/projects/page") {
      const reply = state.projects(url, owner), pending = state.projectGate;
      if (pending) await pending.wait;
      return route.fulfill({ status: reply.status, json: reply.body }).catch(() => {});
    }
    if (url.pathname === "/api/workspaces/imports") return route.fulfill({ json: { ownerId: owner, source: { projectId: url.searchParams.get("projectId"), projectRevision: 1, projectTitle: "Synthetic saved source", name: "Imported Northstar", selectionId: null, candidateId: null, origin: "project_name" } } });
    if (/^\/api\/workspaces\/(domains|handles|trademarks)$/.test(url.pathname) && route.request().method() === "GET") {
      const reply = state.workspace(url, owner); return route.fulfill({ status: reply.status, json: reply.body });
    }
    unexpected.push(`${route.request().method()} ${url.pathname}`);
    return route.abort();
  });
  try {
    await run({ page, state, calls });
    expect(errors).toEqual([]); expect(unexpected).toEqual([]);
    checks.push({ name, passed: true, requests: calls });
    console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: `${output}/failure-${checks.length + 1}.png`, fullPage: true });
    await writeFile(`${output}/failure-${checks.length + 1}.html`, await page.content());
    checks.push({ name, passed: false, error: String(error), pageErrors: errors, unexpected, requests: calls });
    throw error;
  } finally { await context.close(); }
}
const ready = page => expect(page.locator("#session-status")).toHaveText("ready");
const refresh = async page => { await page.getByRole("button", { name: "Fixture check account", exact: true }).click(); await ready(page); };
const snap = page => page.evaluate(() => window.standaloneShellFixture.snapshot());

try {
  await scenario("provider unsaved warning, hidden expiry/check/errors and same-owner recovery", async ({ page, state, calls }) => {
    await page.goto(origin); await ready(page);
    expect(await page.evaluate(() => window.standaloneShellFixture.beforeUnload())).toBe(false);
    await page.evaluate(() => { window.standaloneShellFixture.seed("Private same-owner draft"); window.standaloneShellFixture.remember(); });
    await expect(page.locator("#unsaved")).toHaveText("true");
    expect(await page.evaluate(() => window.standaloneShellFixture.beforeUnload())).toBe(true);
    await page.getByRole("button", { name: "Fixture sign out", exact: true }).click();
    await expect(page.locator("#signout-result")).toContainText("confirmation_required");
    expect(calls.filter(call => call.path === "/api/auth/sign-out")).toHaveLength(0);
    await page.evaluate(() => window.standaloneShellFixture.expire());
    await expect(page.locator("#session-status")).toHaveText("signed_out");
    expect(await snap(page)).toMatchObject({ dirty: true, visible: null });
    expect(await page.evaluate(() => window.standaloneShellFixture.lateSet())).toEqual({ current: false, accepted: false });
    const pending = gate(); state.sessionGate = pending;
    await page.getByRole("button", { name: "Fixture check account", exact: true }).click();
    await expect(page.locator("#session-status")).toHaveText("checking");
    expect(await snap(page)).toMatchObject({ dirty: true, visible: null });
    pending.release(); state.sessionGate = null; await ready(page);
    await expect(page.locator("#visible-draft")).toContainText("Private same-owner draft");
    await expect(page.locator("#same-memory")).toHaveText("true");
    for (const [status, label] of [[503, "unavailable"], [500, "error"], [401, "signed_out"]]) {
      state.sessionStatus = status;
      await page.getByRole("button", { name: "Fixture check account", exact: true }).click();
      await expect(page.locator("#session-status")).toHaveText(label);
      expect(await snap(page)).toMatchObject({ dirty: true, visible: null });
      state.sessionStatus = 200; await refresh(page);
      await expect(page.locator("#visible-draft")).toContainText("Private same-owner draft");
    }
    await page.getByRole("button", { name: "Fixture failed sign in", exact: true }).click();
    await expect(page.locator("#session-status")).toHaveText("error");
    expect(await snap(page)).toMatchObject({ dirty: true, visible: null });
    await refresh(page); await expect(page.locator("#visible-draft")).toContainText("Private same-owner draft");
  });

  await scenario("uncertain save guard, failed logout retention and confirmed logout clearing", async ({ page, state }) => {
    await page.goto(origin); await ready(page);
    await page.evaluate(() => window.standaloneShellFixture.seed("Pending private draft", true));
    expect(await page.evaluate(() => window.standaloneShellFixture.beforeUnload())).toBe(true);
    await page.getByRole("button", { name: "Fixture sign out", exact: true }).click();
    await expect(page.locator("#signout-result")).toContainText("confirmation_required");
    state.signOutStatus = 503;
    await page.getByRole("button", { name: "Fixture discard and sign out", exact: true }).click();
    await expect(page.locator("#session-status")).toHaveText("error");
    expect(await snap(page)).toMatchObject({ dirty: true, visible: null });
    await refresh(page); await expect(page.locator("#visible-draft")).toContainText("Pending private draft");
    state.signOutStatus = 200; state.signOutBody = { authenticated: true };
    await page.getByRole("button", { name: "Fixture discard and sign out", exact: true }).click();
    await expect(page.locator("#session-status")).toHaveText("error");
    expect(await snap(page)).toMatchObject({ dirty: true, visible: null });
    await refresh(page); state.signOutBody = { authenticated: false };
    const pending = gate(); state.signOutGate = pending;
    await page.evaluate(() => window.standaloneShellFixture.remember());
    await page.getByRole("button", { name: "Fixture discard and sign out", exact: true }).click();
    await expect(page.locator("#session-status")).toHaveText("checking");
    expect(await page.evaluate(() => window.standaloneShellFixture.lateSet())).toEqual({ current: false, accepted: false });
    expect(await snap(page)).toMatchObject({ dirty: true, visible: null });
    pending.release(); state.signOutGate = null;
    await expect(page.locator("#session-status")).toHaveText("signed_out");
    expect(await snap(page)).toMatchObject({ dirty: false, visible: null });
    expect(await page.evaluate(() => window.standaloneShellFixture.beforeUnload())).toBe(false);
    await refresh(page); expect(await snap(page)).toMatchObject({ dirty: false, visible: null });
  });

  await scenario("verified owner switch clears and delayed prior-generation results are fenced", async ({ page, state }) => {
    await page.goto(origin); await ready(page);
    await page.evaluate(() => { window.standaloneShellFixture.seed("Owner A private draft"); window.standaloneShellFixture.remember(); });
    const pending = gate(); state.sessionGate = pending;
    await page.getByRole("button", { name: "Fixture check account", exact: true }).click();
    await expect(page.locator("#session-status")).toHaveText("checking");
    state.owner = B; state.sessionGate = null;
    await refresh(page);
    expect(await snap(page)).toMatchObject({ owner: B, dirty: false, visible: null });
    pending.release();
    expect(await page.evaluate(() => window.standaloneShellFixture.lateSet())).toEqual({ current: false, accepted: false });
    expect(await snap(page)).toMatchObject({ owner: B, dirty: false, visible: null });
    state.owner = A; await refresh(page);
    expect(await snap(page)).toMatchObject({ owner: A, dirty: false, visible: null });
  });

  await scenario("picker strict 125-project pagination, explicit selection and continuation retry", async ({ page, state, calls }) => {
    await page.goto(`${origin}/?fixture=picker`); await ready(page);
    const picker = page.getByLabel("Saved project for import", { exact: true });
    await expect(picker.locator("option")).toHaveCount(51);
    await picker.selectOption(projects[4].id);
    await expect(page.locator("#selected-project")).toHaveText(projects[4].id);
    expect(calls.filter(call => call.path.includes("/workspaces/"))).toHaveLength(0);
    const normal = state.projects;
    state.projects = (_url, owner) => ({ status: 200, body: pageOf(owner, projects.slice(40, 90), true) });
    await page.getByRole("button", { name: "Load more saved projects", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Your loaded projects are still available");
    await expect(picker.locator("option")).toHaveCount(51);
    await expect(picker).toHaveValue(projects[4].id);
    state.projects = normal;
    await page.getByRole("button", { name: "Try loading saved projects again", exact: true }).click();
    await expect(picker.locator("option")).toHaveCount(101);
    await page.getByRole("button", { name: "Load more saved projects", exact: true }).click();
    await expect(picker.locator("option")).toHaveCount(126);
    await expect(page.getByText("125 saved projects loaded. End of this listing.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Load more saved projects", exact: true })).toHaveCount(0);
    const pageCalls = calls.filter(call => call.path === "/api/projects/page");
    expect(pageCalls[1].query).toBe(pageCalls[2].query);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${output}/picker-mobile.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  await scenario("picker rejects foreign owners and drops delayed rows after account change", async ({ page, state }) => {
    state.projects = () => ({ status: 200, body: pageOf(B, projects.slice(0, 1)) });
    await page.goto(`${origin}/?fixture=picker`);
    await expect(page.locator("#session-status")).toHaveText("signed_out");
    await expect(page.getByLabel("Saved project for import", { exact: true })).toHaveCount(0);
    const pending = gate(); state.projectGate = pending;
    state.projects = (_url, owner) => ({ status: 200, body: pageOf(owner, [{ ...projects[0], title: owner === A ? "Delayed owner A private title" : "Owner B project" }]) });
    await refresh(page);
    await expect(page.getByText("Loading saved projects…", { exact: true })).toBeVisible();
    state.projectGate = null; state.owner = B; await refresh(page);
    await expect(page.getByLabel("Saved project for import", { exact: true }).locator("option")).toHaveCount(2);
    pending.release();
    await expect(page.getByRole("option", { name: "Owner B project", exact: true })).toHaveCount(1);
    await expect(page.getByText("Delayed owner A private title", { exact: true })).toHaveCount(0);
    state.projects = () => ({ status: 401, body: { error: "synthetic" } });
    await page.getByRole("button", { name: "Fixture check account", exact: true }).click();
    await expect(page.locator("#session-status")).toHaveText("signed_out");
    await expect(page.getByLabel("Saved project for import", { exact: true })).toHaveCount(0);
  });

  for (const tool of ["domains", "handles", "trademarks"]) {
    await scenario(`${tool} real editor wiring, explicit imports and fresh manual expiry fallback`, async ({ page, state, calls }) => {
      state.projects = (_url, owner) => ({ status: 200, body: pageOf(owner, projects.slice(0, 1)) });
      await page.goto(`${origin}/?fixture=tools&tool=${tool}`); await ready(page);
      const picker = page.getByLabel("Saved project for import", { exact: true });
      await expect(picker).toBeEnabled();
      await picker.selectOption(projects[0].id);
      expect(calls.filter(call => call.path === "/api/workspaces/imports")).toHaveLength(0);
      await page.getByRole("button", { name: "Import saved name", exact: true }).click();
      await expect(page.locator("#unsaved")).toHaveText("true");
      expect(calls.filter(call => call.path === "/api/workspaces/imports")).toHaveLength(1);
      expect(calls.filter(call => call.method !== "GET")).toHaveLength(0);
      if (tool === "domains") await expect(page.getByRole("textbox", { name: "Names or full domains", exact: true })).toHaveValue("Imported Northstar");
      if (tool === "trademarks") await expect(page.getByRole("textbox", { name: "Mark name", exact: true })).toHaveValue("Imported Northstar");
      await page.screenshot({ path: `${output}/${tool}-account-desktop.png`, fullPage: true });
      const checking = gate(); state.sessionGate = checking;
      await page.getByRole("button", { name: "Fixture check account", exact: true }).click();
      await expect(page.locator("#session-status")).toHaveText("checking");
      await expect(picker).toHaveCount(0);
      await expect(page.getByText("Imported Northstar", { exact: true })).toHaveCount(0);
      checking.release(); state.sessionGate = null; await ready(page);
      if (tool === "domains") await expect(page.getByRole("textbox", { name: "Names or full domains", exact: true })).toHaveValue("Imported Northstar");
      if (tool === "trademarks") await expect(page.getByRole("textbox", { name: "Mark name", exact: true })).toHaveValue("Imported Northstar");
      await page.evaluate(() => window.standaloneShellFixture.expire());
      await expect(page.locator("#session-status")).toHaveText("signed_out");
      await expect(picker).toHaveCount(0);
      await expect(page.getByText("Imported Northstar", { exact: true })).toHaveCount(0);
      if (tool === "domains") await page.getByRole("button", { name: "Prepare a domain search", exact: true }).click();
      if (tool === "handles") await page.getByRole("tab", { name: "Search", exact: true }).click();
      const field = page.getByRole("textbox", { name: tool === "domains" ? "Names or full domains" : tool === "handles" ? "Names" : "Mark name", exact: true });
      await expect(field).toHaveValue("");
      await field.fill("Independent manual fallback");
      await refresh(page);
      await expect(page.getByLabel("Saved project for import", { exact: true })).toHaveValue("");
      await expect(page.locator("#unsaved")).toHaveText("true");
      if (tool === "domains") await expect(page.getByRole("textbox", { name: "Names or full domains", exact: true })).toHaveValue("Imported Northstar");
      if (tool === "trademarks") await expect(page.getByRole("textbox", { name: "Mark name", exact: true })).toHaveValue("Imported Northstar");
      await expect(page.getByText("Independent manual fallback", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Fixture open names", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Names", exact: true })).toBeVisible();
      await page.getByRole("button", { name: `Fixture open ${tool}`, exact: true }).click();
      await expect(page.locator("#unsaved")).toHaveText("true");
      if (tool === "domains") await expect(page.getByRole("textbox", { name: "Names or full domains", exact: true })).toHaveValue("Imported Northstar");
      if (tool === "trademarks") await expect(page.getByRole("textbox", { name: "Mark name", exact: true })).toHaveValue("Imported Northstar");
      expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain("Imported Northstar");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${output}/${tool}-account-mobile.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  await scenario("unsigned manual tools keep exact controls and unavailable provider actions", async ({ page, state, calls }) => {
    state.sessionStatus = 401;
    await page.goto(`${origin}/?fixture=tools&tool=domains`);
    await expect(page.locator("#session-status")).toHaveText("signed_out");
    await expect(page.getByRole("heading", { name: "Domain library unavailable", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Prepare a domain search", exact: true }).click();
    await page.getByRole("textbox", { name: "Names or full domains", exact: true }).fill("North Star\nnorthstar.org");
    await page.getByRole("button", { name: "Prepare search", exact: true }).click();
    await expect(page.getByRole("status", { name: "northstar.com availability", exact: true })).toHaveText("Unknown");
    await expect(page.getByRole("button", { name: "Check availability for northstar.com", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Create brand from northstar.com", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Fixture open handles", exact: true }).click();
    await expect(page.getByText("This tab only. Reopening this page starts a new workspace.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add handles", exact: true }).click();
    await page.getByRole("textbox", { name: "Names", exact: true }).fill("North Star");
    await page.getByRole("button", { name: "Build comparison", exact: true }).click();
    await expect(page.getByRole("button", { name: "Check platforms", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Fixture open trademarks", exact: true }).click();
    await page.getByRole("textbox", { name: "Mark name", exact: true }).fill("Manual trademark fixture");
    await page.getByRole("button", { name: "Draft preview", exact: true }).click();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export draft preview", exact: true }).click();
    const download = await downloading;
    await download.saveAs(`${output}/manual-trademark-preview.json`);
    const exported = JSON.parse(await readFile(`${output}/manual-trademark-preview.json`, "utf8"));
    expect(exported.draft.markName).toBe("Manual trademark fixture");
    expect(exported.limitations).toContain("No application has been submitted or registered. Official filing requirements remain unvalidated.");
    expect(calls.every(call => call.path === "/api/session" && call.method === "GET")).toBe(true);
  });
} finally {
  await browser.close();
  await writeFile(`${output}/verification.json`, JSON.stringify({ syntheticFixture: true, privateApiIntercepted: true, passed: checks.every(check => check.passed), checks }, null, 2));
}
console.log(JSON.stringify({ passed: true, checks: checks.length, output }, null, 2));
