import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { setupSavedRasterBoard } from "./brand-board-fixture";
import { checkNormalAccount } from "./account-check";
import { captureUiEvidence } from "./ui-evidence";
import { logoFixtureId as id } from "../fixtures/logo-creation";

const imageName = /Élan & Co Brand Board: selected logo, proposed palette, typography, social post and X header in one image\./;
test("brand board fits the desktop viewport and remains readable on mobile from its saved raster", async ({ page }, info) => {
  const f = await setupSavedRasterBoard(page), board = page.getByRole("figure", { name: "Complete raster Brand Board", exact: true });
  const image = board.getByRole("img", { name: imageName });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(node => { const image = node as HTMLImageElement; return { loaded: image.complete, width: image.naturalWidth, height: image.naturalHeight }; })).toEqual({ loaded: true, width: 1600, height: 1800 });
  await expect(board).toContainText("Saved logo selection");
  await expect(page.getByText("One PNG with your selected logo", { exact: false })).toContainText("not vector masters or an approved brand package");
  expect(await page.locator("[data-brand-board-layout] img").count()).toBe(1);
  expect(await page.locator("[data-application-mockup]").count()).toBe(0);
  const box = await image.boundingBox(); expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(250); expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(Math.abs(box!.width / box!.height - 1600 / 1800)).toBeLessThan(.01);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const button = page.getByRole("button", { name: "Download board preview (PNG)", exact: true });
  await expect(button).toBeEnabled(); await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport();
  const downloadEvent = page.waitForEvent("download"); await button.click(); const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.png$/u);
  const saved = info.outputPath("owned-synthetic-brand-board.png"); await download.saveAs(saved);
  const bytes = await readFile(saved), metadata = await sharp(bytes).metadata();
  expect({ format: metadata.format, width: metadata.width, height: metadata.height }).toEqual({ format: "png", width: 1600, height: 1800 });
  const displayedHash = await image.evaluate(async node => { const bytes = await (await fetch((node as HTMLImageElement).src)).arrayBuffer(); return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join(""); });
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(displayedHash);
  await expect(page.getByText("Preview download started. Check your browser’s downloads.", { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole("img", { name: imageName })).toBeVisible();
  expect(JSON.stringify(f.data.workspace)).toBe(f.workspaceBefore);
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
  expect(f.data.selections).toEqual([]); expect(f.data.quotes).toEqual([]); expect(f.data.admissions).toEqual([]);
  expect(f.browserHealth.pageErrors).toEqual([]); expect(f.browserHealth.consoleErrors).toEqual([]);
  await page.screenshot({ path: info.outputPath("saved-raster-brand-board.png"), fullPage: true, scale: "css" });
});

test("brand board removes the owned raster after normal account verification changes owner", async ({ page }) => {
  const f = await setupSavedRasterBoard(page), image = page.getByRole("img", { name: imageName });
  await expect(image).toBeVisible(); const oldUrl = await image.getAttribute("src");
  f.data.owner = id(999); await checkNormalAccount(page);
  await expect(image).toHaveCount(0);
  await expect(page.locator("[data-brand-board-layout]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download board preview (PNG)", exact: true })).toHaveCount(0);
  expect(await page.evaluate(async url => { try { await fetch(url!); return true; } catch { return false; } }, oldUrl)).toBe(false);
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
  expect(JSON.stringify(f.data.workspace)).toBe(f.workspaceBefore);
  expect(f.data.selections).toEqual([]); expect(f.data.quotes).toEqual([]); expect(f.data.admissions).toEqual([]);
  expect(f.browserHealth.pageErrors).toEqual([]); expect(f.browserHealth.consoleErrors).toEqual([]);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));
