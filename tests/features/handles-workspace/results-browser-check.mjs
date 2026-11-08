// Dedicated headless fixture, independent of the shared Embel server/browser.
// Run: node tests/features/handles-workspace/results-browser-check.mjs
import { build } from "esbuild";
import { createServer } from "node:http";
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(".tmp/handles-results");
await mkdir(output, { recursive: true });
await build({ entryPoints: ["tests/features/handles-workspace/results-preview.tsx"], bundle: true, outfile: `${output}/preview.js`, platform: "browser", jsx: "automatic", define: { "process.env": "{}", "process.env.NODE_ENV": '"development"' }, tsconfig: "tsconfig.json" });
const globalCss = (await readFile("src/styles/tokens.css", "utf8")) + (await readFile("src/styles/globals.css", "utf8")).replace(/@import[^;]+;/g, "");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Handles isolated fixture</title><style>${globalCss} :root{--font-geist-sans:Arial} body{padding:24px}.page{padding:0;margin:0 auto}</style><link rel="stylesheet" href="./preview.css"></head><body><main id="root"></main><script src="./preview.js"></script></body></html>`;
await writeFile(`${output}/preview.html`, html);
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
const browser = await chromium.launch({ headless: true, executablePath: process.env.FLUID_E2E_BROWSER_EXECUTABLE || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.setDefaultTimeout(10000);
const errors = [], remoteRequests = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("**/*", route => {
  const asset = new URL(route.request().url()).pathname.match(/^\/handles\/([a-z-]+\.svg)$/);
  if (asset) return readFile(`public/handles/${asset[1]}`).then(body => route.fulfill({ contentType: "image/svg+xml", body }));
  if (!route.request().url().startsWith(url)) { remoteRequests.push(route.request().url()); return route.abort(); }
  return route.continue();
});
const checks = [];
try {
  await page.goto(`${url}preview.html`);
  await page.getByLabel("Business handles", { exact: true }).fill("morrow, northbound, solmere");
  await page.getByLabel("Prefixes", { exact: true }).fill("get, hello");
  await page.getByLabel("Suffixes", { exact: true }).fill("hq");
  await page.getByRole("button", { name: "Build comparison", exact: true }).click();
  await expect(page.locator(".handles-result-row")).toHaveCount(12);
  await expect(page.locator(".handles-search-form")).toBeHidden();
  await expect(page.getByRole("button", { name: "Available everywhere 0", exact: true })).toBeVisible();
  await expect(page.getByText("To check", { exact: true })).toHaveCount(60);
  await expect(page.getByText("Not connected", { exact: true })).toHaveCount(0);
  checks.push("12 real candidates, five selected platform counts, eight visual columns, honest unknown/disconnected states");
  await page.getByRole("button", { name: "Available everywhere 0", exact: true }).click();
  await expect(page.locator(".handles-result-row")).toHaveCount(0);
  await expect(page.getByText("No handle is available on every selected platform yet.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "All handles 12", exact: true }).click();
  await page.getByRole("button", { name: "Refresh results", exact: true }).click();
  await expect(page.getByRole("button", { name: "Available everywhere 1", exact: true })).toBeVisible();
  await expect(page.getByText("Confirmed available", { exact: true })).toHaveCount(5);
  await expect(page.getByText("Taken", { exact: true })).toHaveCount(11);
  await expect(page.getByText("To check", { exact: true })).toHaveCount(44);
  await page.getByRole("button", { name: "Details for @morrow from morrow", exact: true }).click();
  await page.locator(".handles-result-details").getByText("Check details (1)", { exact: true }).first().click();
  await expect(page.locator(".handles-result-details dd").filter({ hasText: "Synthetic results fixture" }).first()).toBeVisible();
  await expect(page.locator(".handles-result-details").getByText("Synthetic browser check", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Details for @morrow from morrow", exact: true }).click();
  checks.push("authoritative counts and Unknown stay distinct; expandable exact source/method/date evidence");
  await page.getByRole("button", { name: "Available everywhere 1", exact: true }).click();
  await expect(page.locator(".handles-result-row")).toHaveCount(1);
  await expect(page.locator(".handles-result-identity")).toContainText("@morrowhq");
  await page.getByRole("button", { name: "Save @morrowhq from morrow to library", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save @morrowhq from morrow to library", exact: true })).toBeDisabled();
  const saved = JSON.parse(await page.locator("#fixture-state").textContent()).bundles[0];
  expect(saved.source.name).toBe("morrow"); expect(saved.entries).toHaveLength(5);
  expect(saved.entries.every(entry => entry.handle === "morrowhq" && entry.evidence.length === 1 && !entry.favorite && !entry.selected && entry.accountCreated === null)).toBe(true);
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "@morrowhq", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Available everywhere 1", exact: true }).click();
  await page.getByRole("button", { name: "Next fixture round", exact: true }).click();
  await page.getByRole("button", { name: "Refresh results", exact: true }).click();
  await expect(page.getByRole("button", { name: "Available everywhere 0", exact: true })).toBeVisible();
  await expect(page.locator(".handles-result-row")).toHaveCount(0);
  expect(JSON.parse(await page.locator("#fixture-state").textContent()).bundles[0]).toEqual(saved);
  checks.push("row save retains source and immutable copied evidence, prevents duplicate save; refresh invalidates availability without changing saved snapshot");
  await page.getByRole("button", { name: "All handles 12", exact: true }).click();
  await page.getByRole("checkbox", { name: "Choose @morrow on instagram for bundle", exact: true }).check();
  await page.getByRole("button", { name: "Edit search", exact: true }).click();
  await expect(page.locator(".handles-results")).toHaveCount(0);
  await expect(page.getByLabel("Business handles", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Prefixes", { exact: true })).toHaveValue("get, hello");
  await page.getByRole("button", { name: "Build comparison", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Choose @morrow on instagram for bundle", exact: true })).not.toBeChecked();
  checks.push("Edit returns preserved search controls, resets selection and prior results");
  await page.screenshot({path:`${output}/results-desktop.png`,fullPage:true});
  const geometry=await page.locator(".handles-result-row").first().boundingBox();expect(geometry.height).toBe(49);
  const images=await page.locator(".handles-results img").evaluateAll(nodes=>nodes.map(img=>({src:img.getAttribute("src"),width:img.width,height:img.height,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,loaded:img.complete&&img.naturalWidth>0})));
  expect(images.every(img=>img.loaded&&img.width===img.naturalWidth&&img.height===img.naturalHeight)).toBe(true);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator(".handles-results-scroll").evaluate(node=>{node.scrollLeft=node.scrollWidth;});
  await expect(page.getByRole("button", {name:"Save @morrow from morrow to library",exact:true})).toBeVisible();
  await page.screenshot({path:`${output}/results-mobile.png`,fullPage:true});
  checks.push("49px rows, every visible original SVG loads at intrinsic size, mobile scroll reaches Save without page overflow");
  expect(errors).toEqual([]);expect(remoteRequests).toEqual([]);
  await writeFile(`${output}/verification.json`,JSON.stringify({passed:true,checks,images,errors,remoteRequests,syntheticFixture:true},null,2));
  console.log(JSON.stringify({passed:true,checks:checks.length,output},null,2));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
