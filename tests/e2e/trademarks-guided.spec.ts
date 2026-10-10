import { test, expect, type Page } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createTrademarkDraft } from "../../src/features/trademark-workspace/domain";

async function signedOut(page: Page) {
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/api/**", route => route.fulfill({ status: 401, json: { error: "Synthetic signed-out fixture" } }));
  await page.goto("/trademarks");
  await expect(page.getByRole("tab", { name: "Search", exact: true })).toHaveAttribute("aria-selected", "true");
  return failures;
}
async function fillTab(page: Page) { await page.getByRole("tab", { name: "Fill", exact: true }).click(); }

test("search reports unavailable research without inventing a match or sending a registry request", async ({ page }) => {
  const paths: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) paths.push(new URL(request.url()).pathname); });
  const failures = await signedOut(page);
  await expect(page.getByText("Not searched yet", { exact: true })).toBeVisible();
  await page.getByLabel("Mark name", { exact: true }).fill("Synthetic Morrow");
  await page.getByLabel("Requested territories", { exact: true }).fill("Canada");
  await page.getByLabel("Goods and services", { exact: true }).fill("Synthetic coffee services");
  await page.getByRole("button", { name: "Search trademarks", exact: true }).click();
  await expect(page.getByText("Research unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Registry research is not connected", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Include similar names", exact: true }).uncheck();
  await expect(page.getByText("Not searched yet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Search trademarks", exact: true }).click();
  await page.getByLabel("Mark name", { exact: true }).fill("Changed query");
  await expect(page.getByText("Not searched yet", { exact: true })).toBeVisible();
  expect(paths.every(path => path === "/api/session")).toBe(true);
  expect(failures).toEqual([]);
});

test("keyboard tabs retain the draft and clearly bound Library and History", async ({ page }) => {
  await signedOut(page);
  await page.getByLabel("Mark name", { exact: true }).fill("Synthetic retained name");
  await page.getByLabel("Requested territories", { exact: true }).fill("Canada\nFrance");
  const search = page.getByRole("tab", { name: "Search", exact: true });
  await search.focus(); await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Fill", exact: true })).toBeFocused();
  await expect(page.getByLabel("Requested territories", { exact: true })).toHaveValue("Canada\nFrance");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Library", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Synthetic retained name", exact: true })).toBeVisible();
  await expect(page.getByText("Unsaved draft in this tab", { exact: true })).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "History", exact: true })).toBeFocused();
  await expect(page.getByText("No account save receipt is available for this draft.", { exact: true })).toBeVisible();
  await page.keyboard.press("Home");
  await expect(search).toBeFocused();
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("Synthetic retained name");
  await page.reload();
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("");
});

test("invalid territory input keeps the previous draft and remains editable", async ({ page }) => {
  await signedOut(page);
  await page.getByLabel("Requested territories", { exact: true }).fill("Kept territory");
  await page.getByLabel("Requested territories", { exact: true }).fill(Array(21).fill("Too many").join("\n"));
  await expect(page.getByRole("alert").filter({ hasText: "previous input has been kept" })).toBeVisible();
  await expect(page.getByLabel("Requested territories", { exact: true })).toHaveValue("Kept territory");
  await fillTab(page);
  await expect(page.getByLabel("Requested territories", { exact: true })).toHaveValue("Kept territory");
  await expect(page.getByText("1 of 6 sections filled", { exact: true })).toBeVisible();
});

test("original artwork is served byte-for-byte and Search/Fill fit their approved geometry", async ({ page }, info) => {
  await signedOut(page);
  const folder = new URL("../../public/trademarks/", import.meta.url);
  const files = await readdir(folder);
  expect(files.length).toBe(16);
  for (const name of files) {
    const expected = await readFile(new URL(name, folder));
    const response = await page.request.get(`/trademarks/${name}`);
    expect(response.status()).toBe(200);
    expect(createHash("sha256").update(await response.body()).digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"));
  }
  const expectedSizes = { mark: 28, home: 20, brands: 20, assets: 20, ideas: 20, names: 20, handles: 20, domains: 20, trademarks: 20, settings: 20, expand: 16, search: 24 };
  if (info.project.name === "desktop") for (const [name, size] of Object.entries(expectedSizes)) {
    const img = page.locator(`img[src='/trademarks/${name}.svg']`).first();
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(size);
    expect((await img.boundingBox())!.width).toBe(size);
    expect((await img.boundingBox())!.height).toBe(size);
  }
  await page.evaluate(() => document.fonts.ready);
  if (info.project.name === "desktop") {
    const form = (await page.locator(".tm-search-form").boundingBox())!;
    expect(form.x).toBe(256); expect(form.y).toBe(281); expect(form.width).toBe(1008); expect(form.height).toBe(278);
    expect((await page.locator(".tm-empty").boundingBox())!.height).toBe(196);
  }
  await page.screenshot({ path: info.outputPath("search.png"), fullPage: true });
  await fillTab(page);
  if (info.project.name === "desktop") {
    expect((await page.locator(".tm-editor").boundingBox())!.width).toBe(656);
    expect((await page.locator(".tm-checklist").boundingBox())!.width).toBe(328);
    expect((await page.locator(".tm-editor > .tm-section").first().boundingBox())!.height).toBe(346);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: info.outputPath("fill.png"), fullPage: true });
});

test("320px Search and Fill keep forms, disclosures and recovery controls reachable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await signedOut(page);
  await page.getByRole("button", { name: "Search trademarks", exact: true }).click();
  await fillTab(page);
  await page.getByText("Additional dossier details", { exact: true }).click();
  await page.getByLabel("Owner contact", { exact: true }).fill("Synthetic contact");
  await page.getByRole("button", { name: "Review draft preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Export draft preview", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("account save receipt, unsaved History and confirmed reload stay tied to the actual revision", async ({ page }) => {
  const owner = "aaaaaaaa-1111-4111-8111-111111111111";
  let saved = { id: "cccccccc-1111-4111-8111-111111111111", ownerId: owner, tool: "trademarks", revision: 2, payload: createTrademarkDraft("Saved fixture"), imports: [], createdAt: "2026-10-06T10:00:00Z", updatedAt: "2026-10-06T10:00:00Z" };
  const puts: unknown[] = [];
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { user: { id: owner } } });
    if (path === "/api/projects/page") return route.fulfill({ json: { ownerId: owner, items: [], nextCursor: null } });
    if (path === "/api/workspaces/trademarks") {
      if (route.request().method() === "PUT") {
        const input = route.request().postDataJSON(); puts.push(input);
        expect(input.expectedRevision).toBe(saved.revision);
        saved = { ...saved, revision: saved.revision + 1, payload: input.payload, updatedAt: "2026-10-10T15:00:00Z" };
      }
      return route.fulfill({ json: { ownerId: owner, workspace: saved } });
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  await page.goto("/trademarks");
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("Saved fixture");
  await page.getByLabel("Mark name", { exact: true }).fill("Unsaved fixture");
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(page.getByText(/Account revision 2 ·/)).toBeVisible();
  await expect(page.getByText("The current edits are not included in this saved revision.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load saved draft", exact: true }).click();
  await page.getByRole("button", { name: "Keep my edits", exact: true }).click();
  await fillTab(page);
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("Unsaved fixture");
  await page.getByRole("button", { name: "Save account draft", exact: true }).click();
  await expect(page.getByText("Account draft saved · revision 3. Review marks only your user-entered notes.", { exact: true })).toBeVisible();
  expect(puts).toHaveLength(1);
  await page.getByLabel("Mark name", { exact: true }).fill("Discarded fixture");
  await page.getByRole("button", { name: "Load saved draft", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes and load saved draft", exact: true }).click();
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("Unsaved fixture");
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(page.getByText(/Account revision 3 ·/)).toBeVisible();
  await expect(page.getByText("The current draft matches this saved revision.", { exact: true })).toBeVisible();
});
