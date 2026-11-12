#!/usr/bin/env node
// Design-audit seed: resets the three audit accounts on the LOCAL stack and rebuilds them by
// driving the real app (Playwright) with the free stand-in AI. Safe to run again: each run
// deletes the audit accounts (only those) and recreates the same state.
//
//   node design-audit/seed/seed.mjs                 reset and rebuild everything
//   node design-audit/seed/seed.mjs --only quill    rebuild one brand only (debugging; no reset)
//   node design-audit/seed/seed.mjs --headed        watch the browser
//   node design-audit/seed/seed.mjs --real-images   allow missing showcase images to be generated
//                                                   once with the real OpenAI API (costs money;
//                                                   owner approval required). Cached afterwards.
//
// Needs: the local Supabase stack (npm run dev:up) and nothing else serving port 3105.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";
import { prepareJourneyDatabase } from "../../tests/journey/prepare.mjs";
import {
  adminClient,
  applyProPlan,
  createAccount,
  grantSeedCredits,
  loadPasswords,
  resetAccount,
  saveCredentials,
  settleCredits,
} from "./accounts.mjs";
import { ACCOUNTS, BRANDS } from "./brands.mjs";
import { launchBrowser, seedBrand, signIn } from "./journey.mjs";
import { listening, startAuditServers } from "./serve.mjs";
import { auditDir, auditStack } from "./stack.mjs";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const headed = args.includes("--headed");
const realImages = args.includes("--real-images");
/** Final credit balances: Free sits at its limit so upgrade prompts appear; Pro looks partly used. */
const FINAL_CREDITS = { free: 0, pro: 112 };
const started = Date.now();
const log = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);

const stack = auditStack();
if ((await listening(`${stack.appOrigin}/sign-in`)) || (await listening(`${stack.aiOrigin}/__health`))) {
  console.error(
    `Port ${stack.settings.webPort} or the stand-in AI port is in use. Stop npm run dev / serve.mjs first.`,
  );
  process.exit(1);
}

log("Preparing the local database (engine login, generation kinds on, engine unpaused)");
await prepareJourneyDatabase();

const passwords = loadPasswords(ACCOUNTS);
const owners = {};
if (only) {
  const admin = adminClient(stack);
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  for (const a of ACCOUNTS) owners[a.key] = data.users.find((u) => u.email === a.email)?.id;
} else {
  for (const a of ACCOUNTS) {
    if (await resetAccount(stack, a.email)) log(`Reset ${a.email}`);
    owners[a.key] = await createAccount(stack, a.email, passwords[a.email]);
    log(`Created ${a.email} (${a.plan})`);
  }
  saveCredentials(stack, ACCOUNTS, passwords);
  await applyProPlan(stack, owners.pro);
  log("Recorded a test-mode Pro subscription for audit-pro (no Stripe call)");
}
for (const key of ["free", "pro"]) await grantSeedCredits(stack, owners[key], 300);

// A clearly marked test image for the "own upload" on Inspiration.
const fixtures = path.join(auditDir, ".logs");
mkdirSync(fixtures, { recursive: true });
const uploadFile = path.join(fixtures, "test-upload-moodboard.png");
await sharp(
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="#d9c7a3"/><stop offset="1" stop-color="#6b7f6a"/></linearGradient></defs>` +
      `<rect width="1200" height="900" fill="url(#g)"/><circle cx="860" cy="300" r="170" fill="#f4efe6" opacity=".7"/>` +
      `<rect x="120" y="520" width="520" height="220" rx="24" fill="#2f3b33" opacity=".85"/>` +
      `<text x="150" y="620" font-family="Helvetica" font-size="54" font-weight="700" fill="#fff">Mood reference</text>` +
      `<text x="150" y="690" font-family="Helvetica" font-size="30" letter-spacing="5" fill="#d9c7a3">TEST DATA · UPLOAD</text></svg>`,
  ),
)
  .png()
  .toFile(uploadFile);

log(`Starting the audit stack (stand-in AI${realImages ? " with real showcase images allowed" : ""} and the app)`);
const { stop } = await startAuditServers({ seeding: true, realImages, quiet: true });
const browser = await launchBrowser({ headless: !headed });
const results = [];
let failed = false;
try {
  const brandsFor = (account) => BRANDS.filter((b) => b.account === account && (!only || b.key === only));
  await Promise.all(
    ["free", "pro"].map(async (accountKey) => {
      const account = ACCOUNTS.find((a) => a.key === accountKey);
      const queue = [...brandsFor(accountKey)];
      if (!queue.length) return;
      const context = await browser.newContext({ baseURL: stack.appOrigin, viewport: { width: 1440, height: 900 } });
      const first = await context.newPage();
      await signIn(first, account.email, passwords[account.email]);
      await first.close();
      // Up to two brands of one account at a time, each in its own tab.
      await Promise.all(
        Array.from({ length: 2 }, async () => {
          for (let b = queue.shift(); b; b = queue.shift()) {
            const page = await context.newPage();
            page.setDefaultTimeout(60_000);
            const brandLog = (m) => log(`${account.key}/${b.key}: ${m}`);
            try {
              brandLog(`start (target: ${b.stage})`);
              const projectId = await seedBrand(page, b, { uploadFile, log: brandLog });
              results.push({
                account: `audit-${account.key}`,
                brand: b.name,
                key: b.key,
                stage: b.stage,
                projectId,
                ok: true,
              });
              brandLog("done");
            } catch (error) {
              failed = true;
              const shot = path.join(fixtures, `failed-${b.key}.png`);
              await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
              results.push({
                account: `audit-${account.key}`,
                brand: b.name,
                key: b.key,
                stage: b.stage,
                ok: false,
                error: error.message.split("\n")[0],
              });
              brandLog(`FAILED: ${error.message.split("\n")[0]} (screenshot ${path.relative(auditDir, shot)})`);
            } finally {
              await page.close();
            }
          }
        }),
      );
      await context.close();
    }),
  );
} finally {
  await browser.close();
  const stats = await fetch(`${stack.aiOrigin}/__stats`)
    .then((r) => r.json())
    .catch(() => null);
  if (stats) log(`Stand-in AI images: ${JSON.stringify(stats.images)}`);
  stop();
}

if (!only) {
  await settleCredits(stack, owners.free, FINAL_CREDITS.free);
  await settleCredits(stack, owners.pro, FINAL_CREDITS.pro);
  log(
    `Credits settled: audit-free ${FINAL_CREDITS.free}, audit-pro ${FINAL_CREDITS.pro}, audit-fresh untouched (30 on first visit)`,
  );
}
writeFileSync(
  path.join(auditDir, ".logs/last-seed.json"),
  JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
);
console.table(results.map(({ account, brand, stage, ok, error }) => ({ account, brand, stage, ok, error })));
log(failed ? "Seed finished WITH FAILURES (see above)." : "Seed finished.");
process.exit(failed ? 1 : 0);
