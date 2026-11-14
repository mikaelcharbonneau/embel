// Lists the direction-board images on a finished brand page (probe only, local app only).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../../design-audit/seed/journey.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "http://127.0.0.1:3105";
const creds = JSON.parse(readFileSync(path.join(ROOT, "design-audit/.audit-credentials"), "utf8")).accounts;
const seeded = JSON.parse(readFileSync(path.join(ROOT, "design-audit/.logs/last-seed.json"), "utf8")).results;
const [accountKey, brandKey] = process.argv.slice(2);
const c = creds.find((x) => x.account === accountKey);
const projectId = seeded.find((r) => r.key === brandKey).projectId;

const browser = await launchBrowser();
const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
await page.goto("/sign-in");
const form = page.getByRole("form", { name: "Sign in", exact: true });
await form.getByRole("textbox", { name: "Email" }).fill(c.email);
await form.getByLabel("Password", { exact: true }).fill(c.password);
await form.getByRole("button", { name: "Sign in", exact: true }).click();
await page.waitForURL((u) => !/sign-in/u.test(u.pathname), { timeout: 60000 });
await page.goto(`/brands/account/${projectId}${process.argv[4] ?? ""}`);
await page.waitForTimeout(3000);
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 600) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 150));
  }
  window.scrollTo(0, 0);
});
await page.waitForTimeout(1500);
const imgs = await page.evaluate(() =>
  [...document.images].map((i) => {
    const r = i.getBoundingClientRect();
    return { alt: i.alt, src: i.currentSrc.slice(0, 110), nat: [i.naturalWidth, i.naturalHeight], rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
  }),
);
console.log(page.url().replace(projectId, "<id>"));
for (const i of imgs) console.log(JSON.stringify(i));
await browser.close();
