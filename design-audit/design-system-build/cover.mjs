import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const DS = path.join(here, "out") + "/";
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 960, height: 288 } });
  let html = fs.readFileSync(DS + "project/components/Cover/preview.html", "utf8");
  html = html
    .replace('<html lang="en">', '<html lang="en" data-theme="light">')
    .replace(
      "<head>",
      `<head><style>${fs.readFileSync(DS + "local/tokens.css", "utf8")}</style><style>${fs.readFileSync(DS + "project/components/bundle.css", "utf8")}</style>`,
    );
  fs.writeFileSync(DS + "local/Cover.html", html);
  await p.goto("file://" + DS + "local/Cover.html");
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(200);
  await p.screenshot({ path: DS + "shots/Cover.png" });
  await b.close();
})();
