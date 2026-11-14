// Renders previews the way the Design System frame does: tokens.css, bundle.css and bundle.js preloaded.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const DS = path.join(here, "out") + "/";
const A = JSON.parse(fs.readFileSync(path.join(here, "assets.json")));
const blob = {};
for (const k in A) blob[A[k][2]] = DS + "assets/" + A[k][0] + "/" + A[k][1];
const reg = JSON.parse(fs.readFileSync(DS + "local/reg.json"));
// usage: node render.js [all | Name,Name@2,...] [noshot]   (Name@2 clicks the second state of a validation screen first)
const args = process.argv.slice(2);
const shots = !args.includes("noshot");
const names = args.filter((a) => a !== "noshot")[0];
const only = names && names !== "all" ? names.split(",") : Object.keys(reg);
(async () => {
  const b = await chromium.launch();
  const heights = fs.existsSync(DS + "local/heights.json")
    ? JSON.parse(fs.readFileSync(DS + "local/heights.json"))
    : {};
  fs.mkdirSync(DS + "shots", { recursive: true });
  const tokens = fs.readFileSync(DS + "local/tokens.css", "utf8"),
    css = fs.readFileSync(DS + "project/components/bundle.css", "utf8"),
    js = fs.readFileSync(DS + "project/components/bundle.js", "utf8");
  for (const spec of only) {
    const [name, st] = spec.split("@");
    if (!reg[name]) {
      console.log("unknown", name);
      continue;
    }
    let html = fs.readFileSync(DS + `project/components/${name}/preview.html`, "utf8");
    html = html
      .replace('<html lang="en">', '<html lang="en" data-theme="light">')
      .replace("<head>", `<head><style>${tokens}</style><style>${css}</style><script>${js}</script>`);
    html = html.replace(/\/_blob\/([0-9a-f]{32})/g, (m, id) => "file://" + blob[id]);
    const f = DS + `local/${name}.html`;
    fs.writeFileSync(f, html);
    const w = reg[name].width || 880;
    const p = await b.newPage({ viewport: { width: w, height: reg[name].page ? 900 : 600 }, deviceScaleFactor: 1 });
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    p.on("console", (m) => {
      if (m.type() === "error") errs.push(m.text());
    });
    await p.goto("file://" + f, { waitUntil: "load" });
    if (st) await p.click(`label[for=st-${st}]`);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(150);
    const m = await p.evaluate(() => ({
      h: Math.ceil(document.body.getBoundingClientRect().height),
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
      fonts: [...document.fonts].filter((x) => x.status === "loaded").map((x) => x.family + " " + x.weight),
    }));
    if (!st) heights[name] = Math.max(40, Math.min(4000, m.h));
    if (m.sw > m.cw || errs.length) console.log("!!", name, "overflow", m.sw, m.cw, errs.slice(0, 3));
    if (shots) {
      await p.setViewportSize({ width: w, height: Math.max(300, m.h) });
      await p.waitForTimeout(80);
      await p.screenshot({ path: DS + `shots/${name}${st ? "-" + st : ""}.png`, fullPage: true });
    }
    console.log(name, w, m.h, m.fonts.length ? "" : "NO FONTS");
    await p.close();
  }
  fs.writeFileSync(DS + "local/heights.json", JSON.stringify(heights));
  await b.close();
})();
