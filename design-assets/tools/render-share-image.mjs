#!/usr/bin/env node
// Renders design-assets/tools/share-image.html to IMG-003 PNGs at 1200 x 630 (1x) and 2400 x 1260 (2x).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchBrowser } from "../../design-audit/seed/journey.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../source");
const browser = await launchBrowser();
for (const [scale, file] of [
  [1, "IMG-003_share-image_v1.png"],
  [2, "IMG-003_share-image_v1@2x.png"],
]) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: scale });
  const page = await context.newPage();
  await page.goto(pathToFileURL(path.join(HERE, "share-image.html")).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.screenshot({ path: path.join(OUT, file), clip: { x: 0, y: 0, width: 1200, height: 630 } });
  console.log("saved", file);
  await context.close();
}
await browser.close();
