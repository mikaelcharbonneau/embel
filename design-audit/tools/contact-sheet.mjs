#!/usr/bin/env node
// Lays frames from evidence/motion/frames side by side in one labelled PNG, so a sequence can be read
// at a glance (used for the M-xxx evidence images).
//   node design-audit/tools/contact-sheet.mjs <out.png> "<title>" <frame-name-substring> [more substrings…] [--cols=4] [--width=420]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../seed/journey.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAMES = path.resolve(HERE, "../evidence/motion/frames");
const args = process.argv.slice(2);
const options = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const [out, title, ...needles] = args.filter((a) => !a.startsWith("--"));
const cols = Number(options.cols ?? 4);
const width = Number(options.width ?? 420);
const all = readdirSync(FRAMES).sort();
const files = needles.flatMap((needle) => all.filter((f) => f.includes(needle)));
if (!files.length) throw new Error(`No frames match ${needles.join(", ")}`);

const label = (file) =>
  file
    .replace(/^[a-z]+__/u, "")
    .replace(/\.jpg$/u, "")
    .replace(/__\d\d-/u, " · ")
    .replace(/__/gu, " @");
const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; padding: 20px; background: #fff; font: 13px/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #191919; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 14px; }
  .grid { display: grid; grid-template-columns: repeat(${cols}, ${width}px); gap: 14px; }
  figure { margin: 0; } img { width: ${width}px; display: block; border: 1px solid #c9c8c2; }
  figcaption { margin-top: 4px; color: #55554f; font-size: 12px; word-break: break-word; }
</style><h1>${title}</h1><div class="grid">${files
  .map(
    (f) =>
      `<figure><img src="data:image/jpeg;base64,${readFileSync(path.join(FRAMES, f)).toString("base64")}"><figcaption>${label(f)}</figcaption></figure>`,
  )
  .join("")}</div>`;

const browser = await launchBrowser();
const page = await browser.newPage({
  viewport: { width: cols * (width + 14) + 40, height: 600 },
  deviceScaleFactor: 1,
});
await page.setContent(html, { waitUntil: "load" });
await page.screenshot({ path: path.resolve(out), fullPage: true });
await browser.close();
console.log(`${files.length} frames -> ${out}`);
