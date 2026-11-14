#!/usr/bin/env node
// Downloads one complete export from a showcase brand (default: audit-pro / Kestrel Analytics) through
// the app's own Download buttons, unpacks the brand kit ZIP, and renders every file as a PNG.
//
//   node design-audit/capture-exports.mjs [outDir] [--brand=kestrel|aurelie|brightharbor]
//
// Output (default design-audit/evidence/exports/):
//   <brand>/downloads/        exactly what the buttons delivered (brand kit ZIP, guidelines, board PNG, tokens)
//   <brand>/kit/              the ZIP, unpacked
//   rendered/<brand>__<file>.png   each file drawn as a picture (images on a light checkerboard so
//                                  transparency shows, HTML pages full-length at 1200 px, text files as code)
//   manifest.json
// Needs the audit stack running, a seed, and a saved audit-pro session (run capture.mjs once first, or it
// signs in itself). Local only. Rendering blocks all network access, so web fonts fall back to system fonts.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { launchBrowser } from "./seed/journey.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = process.env.AUDIT_ORIGIN ?? "http://127.0.0.1:3105";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/u.test(ORIGIN)) throw new Error("Refusing to run: local app only.");
const args = process.argv.slice(2);
const key = (args.find((a) => a.startsWith("--brand=")) ?? "--brand=kestrel").slice(8);
const outDir = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(HERE, "evidence/exports"));
const ACCOUNT = key === "orchardlane" ? "audit-free" : "audit-pro";
const credentials = JSON.parse(readFileSync(path.join(HERE, ".audit-credentials"), "utf8")).accounts.find(
  (a) => a.account === ACCOUNT,
);
const seeded = JSON.parse(readFileSync(path.join(HERE, ".logs/last-seed.json"), "utf8")).results.find(
  (r) => r.key === key,
);
if (!seeded) throw new Error(`Brand "${key}" is not in .logs/last-seed.json`);

const dl = path.join(outDir, key, "downloads");
const kit = path.join(outDir, key, "kit");
const rendered = path.join(outDir, "rendered");
for (const d of [dl, kit, rendered]) mkdirSync(d, { recursive: true });

const browser = await launchBrowser();
const stateFile = path.join(HERE, ".auth", `${ACCOUNT}.json`);
const context = await browser.newContext({
  baseURL: ORIGIN,
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
  reducedMotion: "reduce",
  ...(existsSync(stateFile) ? { storageState: stateFile } : {}),
});
const page = await context.newPage();
await page.goto(`/brands/account/${seeded.projectId}/logo/deliverables`, { waitUntil: "domcontentloaded" });
if (
  !(await page
    .getByLabel("Account menu")
    .first()
    .waitFor({ state: "visible", timeout: 25_000 })
    .then(
      () => true,
      () => false,
    ))
) {
  await page.goto("/sign-in");
  await page.waitForTimeout(2000);
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  await form.getByRole("textbox", { name: "Email" }).fill(credentials.email);
  await form.getByLabel("Password", { exact: true }).fill(credentials.password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !/sign-in/u.test(u.pathname), { timeout: 60_000 });
  await page.goto(`/brands/account/${seeded.projectId}/logo/deliverables`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Account menu").first().waitFor({ timeout: 30_000 });
}
await page.getByRole("status").filter({ hasText: "Ready to download." }).waitFor({ timeout: 180_000 });

const downloads = [];
async function save(label, click) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), click()]);
  const file = path.join(dl, download.suggestedFilename());
  await download.saveAs(file);
  downloads.push({ button: label, file: path.relative(outDir, file), bytes: statSync(file).size });
  console.log(`  downloaded ${download.suggestedFilename()}  (${label})`);
  return file;
}
const zipFile = await save("Download brand kit as a ZIP file", () =>
  page.getByRole("button", { name: "Download brand kit as a ZIP file" }).click(),
);
await save("Download guidelines", () => page.getByRole("button", { name: "Download guidelines" }).click()).catch((e) =>
  console.log(`  skipped guidelines: ${e.message.split("\n")[0]}`),
);
for (const format of ["CSS", "JSON"])
  await save(`Download ${format}`, async () => {
    await page.getByRole("group", { name: "Format" }).getByRole("button", { name: format, exact: true }).click();
    await page.getByRole("button", { name: `Download ${format}`, exact: true }).click();
  }).catch((e) => console.log(`  skipped ${format}: ${e.message.split("\n")[0]}`));
await save("Download brand board as PNG", () =>
  page
    .getByRole("button", { name: /^Download .*board.* as PNG/iu })
    .first()
    .click(),
).catch((e) => console.log(`  skipped brand board: ${e.message.split("\n")[0]}`));
await context.close();

// ---- unpack the kit
const files = unzipSync(new Uint8Array(readFileSync(zipFile)));
const kitFiles = [];
for (const [name, data] of Object.entries(files)) {
  if (name.endsWith("/")) continue;
  const target = path.join(kit, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, data);
  kitFiles.push({ name, bytes: data.length });
}
console.log(`  unpacked ${kitFiles.length} files from the kit`);

// ---- render every file as a PNG (no network)
const sources = [
  ...kitFiles.map((f) => ({ label: f.name, file: path.join(kit, f.name) })),
  ...downloads
    .filter((d) => !d.file.endsWith(".zip"))
    .map((d) => ({ label: `downloads/${path.basename(d.file)}`, file: path.join(outDir, d.file) })),
];
const pngSize = (buf) =>
  buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 ? `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}` : null;
const renderer = await browser.newContext({
  viewport: { width: 1200, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: "light",
});
await renderer.route(/^https?:/u, (r) => r.abort());
const results = [];
for (const { label, file } of sources) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const out = path.join(rendered, `${key}__${label.replaceAll("/", "--")}.png`);
  const p = await renderer.newPage();
  try {
    const buffer = readFileSync(file);
    if (["png", "jpg", "jpeg", "webp", "svg"].includes(ext)) {
      const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      const uri = `data:${mime};base64,${buffer.toString("base64")}`;
      await p.setContent(
        `<body style="margin:0;padding:24px;display:inline-block;background-color:#fff;background-image:linear-gradient(45deg,#e6e6e6 25%,transparent 25%,transparent 75%,#e6e6e6 75%),linear-gradient(45deg,#e6e6e6 25%,transparent 25%,transparent 75%,#e6e6e6 75%);background-size:20px 20px;background-position:0 0,10px 10px"><img id="i" src="${uri}" style="display:block;max-width:1600px"></body>`,
      );
      await p.locator("#i").evaluate((img) => img.decode());
    } else if (ext === "html") {
      await p.setContent(buffer.toString("utf8"), { waitUntil: "load" });
    } else {
      const esc = buffer.toString("utf8").replaceAll("&", "&amp;").replaceAll("<", "&lt;");
      await p.setContent(
        `<body style="margin:0;padding:24px;background:#fff"><pre style="font:13px/1.55 ui-monospace,Menlo,monospace;white-space:pre-wrap;margin:0">${esc}</pre></body>`,
      );
    }
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: out, fullPage: true });
    results.push({
      file: label,
      rendered: path.relative(outDir, out),
      bytes: buffer.length,
      type: ext,
      pixels: pngSize(buffer),
    });
    console.log(`  rendered ${path.basename(out)}`);
  } catch (e) {
    results.push({ file: label, error: e.message.split("\n")[0] });
    console.log(`  FAILED ${label}: ${e.message.split("\n")[0]}`);
  }
  await p.close();
}
await browser.close();
writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify({ brand: key, account: ACCOUNT, downloads, kitFiles, rendered: results }, null, 2),
);
console.log(
  `${downloads.length} downloads, ${kitFiles.length} kit files, ${results.filter((r) => r.rendered).length} rendered, ${results.filter((r) => r.error).length} failed`,
);
