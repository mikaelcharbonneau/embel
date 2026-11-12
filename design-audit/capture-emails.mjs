#!/usr/bin/env node
// Renders the repository's email templates (supabase/templates/*.html) to PNG. Nothing is sent and no
// mail service is contacted: the template file is read from disk, the {{ .ConfirmationURL }} placeholder
// is replaced with a dummy link, and Chromium draws it from a local file.
//
//   node design-audit/capture-emails.mjs [outDir]      (default design-audit/evidence/emails/)
//
// Output: <outDir>/<template>__<width>.png (600 = desktop mail client, 390 = phone),
//         <outDir>/<template>.preview.html and <outDir>/manifest.json (subject lines from supabase/config.toml).
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchBrowser } from "./seed/journey.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const templates = path.resolve(HERE, "../supabase/templates");
const config = readFileSync(path.resolve(HERE, "../supabase/config.toml"), "utf8");
const outDir = path.resolve(process.argv[2] ?? path.join(HERE, "evidence/emails"));
mkdirSync(outDir, { recursive: true });

const subject = (name) =>
  new RegExp(`\\[auth\\.email\\.template\\.${name}\\][^\\[]*?subject\\s*=\\s*"([^"]+)"`, "u").exec(config)?.[1] ??
  "(none)";

const browser = await launchBrowser();
const manifest = [];
for (const file of readdirSync(templates)
  .filter((f) => f.endsWith(".html"))
  .sort()) {
  const name = file.replace(/\.html$/u, "");
  const html = readFileSync(path.join(templates, file), "utf8").replaceAll(
    "{{ .ConfirmationURL }}",
    "https://example.invalid/auth/callback?code=PREVIEW-ONLY",
  );
  const preview = path.join(outDir, `${name}.preview.html`);
  writeFileSync(preview, html);
  for (const width of [600, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
    const page = await context.newPage();
    await page.route(/^https?:/u, (r) => r.abort()); // the preview must not touch any network
    await page.goto(pathToFileURL(preview).href);
    await page.evaluate(() => document.fonts.ready);
    const target = path.join(outDir, `${name}__${width}.png`);
    await page.screenshot({ path: target, fullPage: true });
    manifest.push({
      file: path.basename(target),
      template: `supabase/templates/${file}`,
      subject: subject(name),
      width,
      bytes: statSync(target).size,
    });
    console.log(`  ok   ${path.basename(target)}  (subject: ${subject(name)})`);
    await context.close();
  }
}
await browser.close();
writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify({ note: "Local files only; nothing was sent.", emails: manifest }, null, 2),
);
