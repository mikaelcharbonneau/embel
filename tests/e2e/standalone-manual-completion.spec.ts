import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { standalonePayloadCodec } from "../../src/features/domain-workspace/account-codec";

async function setup(page: Page) {
  const unexpected: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === `http://127.0.0.1:${process.env.FLUID_E2E_PORT ?? "3105"}` && !url.pathname.startsWith("/api/")) return route.continue();
    unexpected.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort();
  });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path !== "/api/session") unexpected.push(path);
    return route.fulfill({ status: 401, json: { error: "Synthetic signed-out fixture" } });
  });
  await page.goto("/names");
  await page.getByRole("textbox", { name: "Add words", exact: true }).fill("cedar");
  await page.getByRole("textbox", { name: "Add words", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Favorite result cedar", exact: true }).click();
  return () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); };
}

async function choose(page: Page) {
  await page.getByRole("button", { name: "From name library", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Name library", exact: true });
  await expect(dialog).toBeVisible();
  const option = dialog.getByLabel("Browser name", { exact: true }).locator("option").filter({ hasText: "cedar" });
  await dialog.getByLabel("Browser name", { exact: true }).selectOption(await option.getAttribute("value") ?? "");
  await dialog.getByRole("button", { name: "Use this name", exact: true }).click();
  return dialog;
}

test("browser Names feeds Domains without creating a project or checking availability", async ({ page }, info) => {
  const audit = await setup(page);
  await page.goto("/domains"); await choose(page);
  await expect(page.getByRole("button", { name: "Remove name cedar", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Search domains", exact: true }).click();
  await expect(page.getByRole("heading", { name: "cedar.com", exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "cedar.com availability", exact: true })).toHaveText("Unknown");
  await page.screenshot({ path: info.outputPath("domains-from-names.png"), fullPage: true });
  audit();
});

test("browser name copies save as ordinary account Domain input without invented provenance", async ({ page }) => {
  const audit = await setup(page), ownerId = "aaaaaaaa-1111-4111-8111-111111111111";
  let saved: object | null = null;
  await page.route("**/api/session", route => route.fulfill({ json: { user: { id: ownerId } } }));
  await page.route("**/api/projects/page?*", route => route.fulfill({ json: { ownerId, items: [], nextCursor: null } }));
  await page.route("**/api/workspaces/domains", async route => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      expect(body.expectedRevision).toBe(0); expect(body.imports).toEqual([]);
      const payload = standalonePayloadCodec.schema.parse(body.payload);
      expect(payload.input).toBe("cedar");
      saved = { id: "bbbbbbbb-1111-4111-8111-111111111111", ownerId, tool: "domains", revision: 1, payload, imports: [], createdAt: "2026-10-12T12:00:00Z", updatedAt: "2026-10-12T12:00:00Z" };
    }
    return route.fulfill({ json: { ownerId, workspace: saved } });
  });
  await page.goto("/domains"); await choose(page);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Saved to account · version 1", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Remove name cedar", exact: true })).toBeVisible();
  await expect(page.getByText(/Imported saved sources/)).toHaveCount(0);
  audit();
});

test("name imports require explicit replacement and keep trademark fields and source names", async ({ page }, info) => {
  const audit = await setup(page);
  await page.goto("/trademarks");
  await page.getByLabel("Mark name", { exact: true }).fill("Existing name");
  await page.getByLabel("Goods and services", { exact: true }).fill("Existing services");
  let dialog = await choose(page);
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("Existing name");
  await dialog.getByRole("button", { name: "Keep current input" }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  dialog = await choose(page);
  await dialog.getByRole("button", { name: "Replace with this name" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("cedar");
  await expect(page.getByLabel("Goods and services", { exact: true })).toHaveValue("Existing services");
  await page.getByRole("button", { name: "Prepare manual search" }).click();
  await expect(page.getByText("Ready for manual research", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open WIPO Global Brand Database" })).toHaveAttribute("href", "https://branddb.wipo.int/en/");
  await page.screenshot({ path: info.outputPath("manual-trademark-research.png"), fullPage: true });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fluid.names.v1")!).candidates.some((item: { source: { value: string } }) => item.source.value === "cedar"))).toBe(true);
  audit();
});

test("Handles prepares manual profile links and exports an unchecked comparison", async ({ page }, info) => {
  const audit = await setup(page);
  await page.goto("/handles"); await choose(page);
  await page.getByRole("button", { name: "Build comparison", exact: true }).click();
  await page.getByRole("button", { name: "Details for @cedar from cedar", exact: true }).click();
  await expect(page.locator('a[href="https://www.instagram.com/cedar/"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh results", exact: true })).toBeDisabled();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export handles CSV", exact: true }).click();
  const download = await pending, path = info.outputPath("handles.csv"); await download.saveAs(path);
  const csv = await readFile(path, "utf8");
  expect(csv).toContain('"cedar","Instagram","cedar","Unknown"'); expect(csv).not.toContain("Confirmed available");
  await page.screenshot({ path: info.outputPath("manual-handle-profiles.png"), fullPage: true });
  audit();
});

test("Names backup preview is nondestructive and an explicitly restored workspace survives reload", async ({ page }, info) => {
  const audit = await setup(page);
  await page.getByText(/^Browser workspace ·/).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download workspace copy", exact: true }).click();
  const download = await pending, path = info.outputPath("names.json"); await download.saveAs(path);
  await page.getByRole("button", { name: "Start a new Names workspace", exact: true }).click();
  await page.getByRole("button", { name: "Confirm new workspace", exact: true }).click();
  await page.getByLabel("Names backup file", { exact: true }).setInputFiles(path);
  await expect(page.getByText(/This backup contains 1 name and 0 runs/)).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fluid.names.v1")!).candidates.length)).toBe(0);
  await page.getByRole("button", { name: "Replace workspace with backup", exact: true }).click();
  await expect(page.getByText("Names workspace restored in this browser.", { exact: true })).toBeVisible();
  await page.reload();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("fluid.names.v1")!).candidates[0].source.value)).toBe("cedar");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  audit();
});
