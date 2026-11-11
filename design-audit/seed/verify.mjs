#!/usr/bin/env node
// Checks that every seeded account and brand state is reachable, and saves a screenshot of each
// screen to design-audit/.logs/verify/. Run with the audit server up (serve.mjs) after a seed:
//   node design-audit/seed/verify.mjs
// Read-only: it only signs in and opens pages (no AI clicks, no changes).
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { BRANDS } from "./brands.mjs";
import { GENERATION, launchBrowser, signIn } from "./journey.mjs";
import { CREDENTIALS } from "./accounts.mjs";
import { auditDir, auditStack } from "./stack.mjs";

const stack = auditStack();
const out = path.join(auditDir, ".logs/verify");
mkdirSync(out, { recursive: true });
const creds = JSON.parse(readFileSync(CREDENTIALS, "utf8")).accounts;
const seeded = JSON.parse(readFileSync(path.join(auditDir, ".logs/last-seed.json"), "utf8")).results;
const rows = [];
const check = async (account, name, work) => {
  try {
    await work();
    rows.push({ account, check: name, ok: true });
  } catch (error) {
    rows.push({ account, check: name, ok: false, error: error.message.split("\n")[0].slice(0, 120) });
  }
};
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false });
const credits = async (page) => (await (await page.request.get("/api/credits")).json()).credits?.balance;

/** What each stage looks like when its brand page is opened. */
const STATE = {
  competitors: (page) =>
    expect(page.getByRole("group", { name: "Which competitors should we keep in mind?", exact: true })).toBeVisible({
      timeout: 60_000,
    }),
  personality: (page) =>
    expect(page.getByRole("group", { name: "Which personality feels right?", exact: true })).toBeVisible({
      timeout: 60_000,
    }),
  inspiration: (page) =>
    expect(page.getByRole("article", { name: "Inspiration gallery", exact: true })).toBeVisible({ timeout: 60_000 }),
  // Inspiration chosen (a liked brand and the liked upload). Until logo work starts, the app
  // reopens such a brand on Inspiration showing "2 liked · Next: Logo"; Continue opens the Logo step.
  logo: (page) => expect(page.getByText(/2 liked · Next: Logo/u)).toBeVisible({ timeout: 60_000 }),
  concepts: async (page, b) => {
    const grid = page.getByRole("region", { name: "Logo concepts", exact: true });
    await expect(grid.getByText(new RegExp(`${6 - (b.failedLogoSlots ?? 0)} of 6 concepts ready`, "u"))).toBeVisible({
      timeout: 60_000,
    });
    if (b.failedLogoSlots)
      await expect(page.getByRole("button", { name: `Retry ${b.failedLogoSlots} failed concepts` })).toBeVisible();
    await expect(grid.getByText(/Logo chosen/u)).toHaveCount(0);
  },
  directions: async (page) => {
    const step = page.getByRole("region", { name: "Creative direction", exact: true });
    await expect(step.getByText("3 of 3 ready", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(step.getByRole("radio", { checked: true })).toHaveCount(0);
  },
  complete: async (page, b, projectId) => {
    await page.goto(`/brands/account/${projectId}/logo/deliverables`);
    const assets = page.getByRole("region", { name: "Brand assets", exact: true });
    await expect(assets.getByRole("status").filter({ hasText: "Ready to download." })).toBeVisible({
      timeout: GENERATION,
    });
  },
};

const browser = await launchBrowser();
try {
  for (const account of creds) {
    const context = await browser.newContext({ baseURL: stack.appOrigin, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const who = account.account;
    await check(who, "sign in", () => signIn(page, account.email, account.password));
    for (const [route, label] of [
      ["/", "home"],
      ["/brands", "brands"],
      ["/assets", "library"],
      ["/settings", "settings"],
      ["/plans", "plans"],
    ])
      await check(who, `open ${route}`, async () => {
        const response = await page.goto(route);
        expect(response?.status()).toBeLessThan(400);
        await page.waitForLoadState("networkidle").catch(() => {});
        await shot(page, `${who}-${label}`);
      });
    const balance = await credits(page).catch(() => null);
    const expected = { "audit-fresh": 30, "audit-free": 0, "audit-pro": 112 }[who];
    await check(who, `credits = ${expected} (found ${balance})`, async () => expect(balance).toBe(expected));
    if (who === "audit-fresh")
      await check(who, "no brands yet", async () => {
        await page.goto("/brands");
        await expect(page.getByRole("link", { name: /^Open project · /u })).toHaveCount(0);
      });
    if (who === "audit-free")
      await check(who, "plans shows upgrade buttons", async () => {
        await page.goto("/plans");
        await expect(page.getByRole("button", { name: /Upgrade to Pro/u })).toBeVisible({ timeout: 30_000 });
      });
    if (who === "audit-pro")
      await check(who, "plans shows Pro as current with manage/cancel", async () => {
        await page.goto("/plans");
        await expect(page.getByRole("button", { name: /Manage plan|Cancel plan/u }).first()).toBeVisible({
          timeout: 30_000,
        });
      });
    for (const result of seeded.filter((r) => r.account === who && r.ok)) {
      const b = BRANDS.find((x) => x.key === result.key);
      await check(who, `${b.name.slice(0, 40)}: ${b.stage}`, async () => {
        await page.goto(`/brands/account/${result.projectId}?view=strategy`);
        await STATE[b.stage](page, b, result.projectId);
        await shot(page, `${who}-${b.key}-${b.stage}`);
      });
    }
    await context.close();
  }
} finally {
  await browser.close();
}
console.table(rows);
const failed = rows.filter((r) => !r.ok).length;
console.log(
  failed
    ? `${failed} check(s) failed.`
    : `All ${rows.length} checks passed. Screenshots: ${path.relative(process.cwd(), out)}`,
);
process.exit(failed ? 1 : 0);
