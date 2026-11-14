#!/usr/bin/env node
// Captures one Home example crop (IMG-007 / IMG-008) from the local app with Playwright at 2x.
//
//   node design-assets/tools/capture-home-example.mjs <account> <brandKey> <outFile>
//   e.g. node design-assets/tools/capture-home-example.mjs audit-pro kestrel design-assets/source/IMG-007_kestrel-home_v1.png
//
// Rule (fixed by the owner's Tidewild crop, IMG-007_tidewild-home_v1.webp): the top-left 720 x 540 of the
// CHOSEN 1024 x 1024 direction board, at native resolution. The board is drawn at 512 CSS px on a 2x
// screen (1 image pixel per device pixel, no resampling) and the top-left 360 x 270 CSS px are clipped.
// Local only: it signs in as a seeded audit account and never starts an AI request.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../../design-audit/seed/journey.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "http://127.0.0.1:3105";
const [accountKey, brandKey, outFile] = process.argv.slice(2);
if (!accountKey || !brandKey || !outFile)
  throw new Error("Usage: capture-home-example.mjs <account> <brandKey> <outFile>");

const creds = JSON.parse(readFileSync(path.join(ROOT, "design-audit/.audit-credentials"), "utf8")).accounts;
const seeded = JSON.parse(readFileSync(path.join(ROOT, "design-audit/.logs/last-seed.json"), "utf8")).results;
const account = creds.find((x) => x.account === accountKey);
const project = seeded.find((r) => r.key === brandKey);
if (!account || !project) throw new Error("Unknown account or brand key.");

const cached = [1, 2, 3].map((n) =>
  createHash("sha256")
    .update(
      readFileSync(
        path.join(
          ROOT,
          `design-audit/seed/showcase/${brandKey === "orchardlane" ? "orchardlane" : brandKey}/board-${n}.png`,
        ),
      ),
    )
    .digest("hex"),
);

const browser = await launchBrowser();
// A fresh, isolated context per run (no saved session).
const context = await browser.newContext({
  baseURL: ORIGIN,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  reducedMotion: "reduce",
  colorScheme: "light",
});
const page = await context.newPage();
await page.goto("/sign-in");
const form = page.getByRole("form", { name: "Sign in", exact: true });
await form.getByRole("textbox", { name: "Email" }).fill(account.email);
await form.getByLabel("Password", { exact: true }).fill(account.password);
await form.getByRole("button", { name: "Sign in", exact: true }).click();
await page.waitForURL((u) => !/sign-in/u.test(u.pathname), { timeout: 60_000 });

await page.goto(`/brands/account/${project.projectId}/logo/directions`);
const step = page.getByRole("region", { name: "Creative direction", exact: true });
await step.waitFor({ timeout: 60_000 });
const chosen = step.getByRole("radio", { name: /^Direction 1: /u });
await chosen.scrollIntoViewIfNeeded();
const img = chosen.locator("img").first();
await img.waitFor({ timeout: 60_000 });
await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle(), { timeout: 60_000 });

// Provenance: the bytes the app serves for this board against the cached showcase file.
const served = await img.evaluate(async (el) => {
  const bytes = new Uint8Array(await (await fetch(el.currentSrc)).arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    sha: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    nat: [el.naturalWidth, el.naturalHeight],
    alt: el.alt,
    checked: el.closest("[role=radio]")?.getAttribute("aria-checked"),
  };
});
const boardNumber = cached.indexOf(served.sha) + 1;
console.log(
  JSON.stringify({
    brandKey,
    alt: served.alt,
    natural: served.nat,
    radioChecked: served.checked,
    matchesCachedBoard: boardNumber || "no match",
  }),
);

// Draw the board alone at 512 CSS px in the top-left corner, then clip 360 x 270 CSS px.
await img.evaluate((el) => {
  const copy = new Image();
  copy.src = el.currentSrc;
  copy.id = "capture-board";
  copy.style.cssText =
    "position:fixed;left:0;top:0;width:512px;height:512px;z-index:2147483647;margin:0;border:0;border-radius:0;display:block";
  const veil = document.createElement("div");
  veil.style.cssText = "position:fixed;inset:0;background:#fff;z-index:2147483646";
  document.body.append(veil, copy);
  return copy.decode();
});
await page.waitForTimeout(300);
mkdirSync(path.dirname(path.resolve(ROOT, outFile)), { recursive: true });
await page.screenshot({
  path: path.resolve(ROOT, outFile),
  clip: { x: 0, y: 0, width: 360, height: 270 },
  animations: "disabled",
});
console.log("saved", outFile);
await browser.close();
