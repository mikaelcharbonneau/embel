#!/usr/bin/env node
// Exercises the README's state recipes against the running audit stack (serve.mjs) and saves a
// screenshot of each state to design-audit/.logs/recipes/. Every AI answer comes from the stand-in.
// It CHANGES the seeded data (new runs, a refused upload, spent local credits): reseed afterwards.
//   node design-audit/seed/recipes-check.mjs [recipe-name ...]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect } from "@playwright/test";
import { CREDENTIALS } from "./accounts.mjs";
import { launchBrowser, signIn } from "./journey.mjs";
import { auditDir, auditStack } from "./stack.mjs";

const stack = auditStack();
const out = path.join(auditDir, ".logs/recipes");
mkdirSync(out, { recursive: true });
const creds = Object.fromEntries(JSON.parse(readFileSync(CREDENTIALS, "utf8")).accounts.map((a) => [a.account, a]));
const seeded = JSON.parse(readFileSync(path.join(auditDir, ".logs/last-seed.json"), "utf8")).results;
const project = (key) => seeded.find((r) => r.key === key).projectId;
const mode = (value) =>
  fetch(`${stack.aiOrigin}/__mode`, { method: "POST", body: JSON.stringify(value) }).then((r) => r.json());
const sw = (...args) =>
  execFileSync(process.execPath, [path.join(auditDir, "seed/switch.mjs"), ...args], { stdio: "ignore" });
const only = process.argv.slice(2);
const rows = [];

const browser = await launchBrowser();
const sessions = {};
async function as(account) {
  if (!sessions[account]) {
    const context = await browser.newContext({ baseURL: stack.appOrigin, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    if (account !== "signed-out") await signIn(page, creds[account].email, creds[account].password);
    sessions[account] = { context, page };
  }
  return sessions[account];
}
async function recipe(name, work) {
  if (only.length && !only.includes(name)) return;
  const started = Date.now();
  try {
    await work();
    rows.push({ recipe: name, ok: true, seconds: Math.round((Date.now() - started) / 1000) });
  } catch (error) {
    rows.push({ recipe: name, ok: false, error: error.message.split("\n")[0].slice(0, 140) });
    for (const s of Object.values(sessions))
      await s.page.screenshot({ path: path.join(out, `${name}-FAILED.png`) }).catch(() => {});
  } finally {
    await mode({ text: "normal", images: "normal", delayMs: 60_000 }).catch(() => {});
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
const newBrief = async (page, text) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page).toHaveURL(/\/brands\/account\//u, { timeout: 120_000 });
};
const logoSection = async (page, key) => {
  await page.goto(`/brands/account/${project(key)}?view=strategy#journey-logo`);
  const grid = page.getByRole("region", { name: "Logo concepts", exact: true });
  await expect(grid).toBeVisible({ timeout: 90_000 });
  await grid.scrollIntoViewIfNeeded();
  return grid;
};

// --- Loading and in-progress -----------------------------------------------------------------
await recipe("research-in-progress", async () => {
  const { page } = await as("audit-pro");
  await mode({ text: "hold" });
  await newBrief(page, "Recipe check: a weekend pottery studio in Lisbon offering wheel-throwing classes for adults.");
  await page.waitForTimeout(6000);
  await expect(page.getByRole("group", { name: "Which competitors should we keep in mind?" })).toHaveCount(0);
  await shot(page, "research-in-progress");
});
await recipe("logo-concepts-in-progress", async () => {
  const { page } = await as("audit-pro");
  await mode({ images: "slow", delayMs: 120_000 });
  const grid = await logoSection(page, "aurelie");
  await grid.getByRole("button", { name: "More concepts", exact: true }).click();
  await page.waitForTimeout(6000);
  await shot(page, "logo-concepts-in-progress");
});
// --- Error states -----------------------------------------------------------------------------
await recipe("research-failed", async () => {
  const { page } = await as("audit-pro");
  await mode({ text: "fail" });
  await newBrief(page, "Recipe check: a mobile dog grooming van serving Ottawa suburbs.");
  await expect(page.getByRole("button", { name: "Retry research", exact: true })).toBeVisible({ timeout: 180_000 });
  await shot(page, "research-failed");
});
await recipe("logo-concepts-failed", async () => {
  const { page } = await as("audit-pro");
  await mode({ images: "refuse" });
  const grid = await logoSection(page, "brightharbor");
  await grid.getByRole("button", { name: "More concepts", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Retry \d+ failed concepts?$/u })).toBeVisible({ timeout: 120_000 });
  await shot(page, "logo-concepts-failed");
});
await recipe("step-unavailable", async () => {
  const { page } = await as("audit-pro");
  sw("kind", "logo.concepts", "off");
  try {
    await logoSection(page, "kestrel");
    await expect(page.getByText(/Generation is unavailable/u).first()).toBeVisible({ timeout: 60_000 });
    await shot(page, "step-unavailable");
  } finally {
    sw("reset");
  }
});
await recipe("api-failing", async () => {
  const { page, context } = await as("audit-free");
  await context.route("**/api/projects/**", (route) => route.fulfill({ status: 500, body: "{}" }));
  try {
    await page.goto(`/brands/account/${project("quill")}?view=strategy`);
    await page.waitForTimeout(8000);
    await shot(page, "api-failing");
  } finally {
    await context.unroute("**/api/projects/**");
  }
});
await recipe("offline", async () => {
  const { page, context } = await as("audit-free");
  await page.goto("/settings");
  await page.waitForLoadState("networkidle").catch(() => {});
  await context.setOffline(true);
  try {
    const name = page.getByRole("textbox").first();
    await name.fill("Offline edit");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.waitForTimeout(5000);
    await shot(page, "offline");
  } finally {
    await context.setOffline(false);
  }
});
await recipe("upload-rejected", async () => {
  const { page } = await as("audit-free");
  await page.goto(`/brands/account/${project("northernlights")}?view=strategy`);
  await expect(page.getByRole("article", { name: "Inspiration gallery", exact: true })).toBeVisible({
    timeout: 90_000,
  });
  const fake = path.join(out, "not-an-image.png");
  writeFileSync(fake, "This is a text file named .png (test data).");
  await page.locator('input[type="file"][aria-label="Choose images to add"]').setInputFiles(fake);
  await page.waitForTimeout(6000);
  await page
    .getByRole("article", { name: "Your images", exact: true })
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await shot(page, "upload-rejected");
});
// --- Validation, disabled and destructive confirmation ---------------------------------------
await recipe("sign-in-wrong-password", async () => {
  const { page } = await as("signed-out");
  await page.goto("/sign-in");
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  await form.getByRole("textbox", { name: "Email" }).fill("audit-free@example.test");
  await form.getByLabel("Password", { exact: true }).fill("wrong-password-123");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "sign-in-wrong-password");
});
await recipe("sign-up-validation", async () => {
  const { page } = await as("signed-out");
  await page.goto("/sign-up");
  const form = page.getByRole("form", { name: "Create account", exact: true });
  await form.getByRole("textbox", { name: "Email" }).fill("audit-new@example.test");
  await form.getByLabel("Password", { exact: true }).fill("short");
  await form.getByLabel("Confirm password", { exact: true }).fill("different");
  await form.getByRole("button", { name: "Create account", exact: true }).click();
  await page.waitForTimeout(1500);
  await shot(page, "sign-up-validation");
});
await recipe("delete-project-dialog", async () => {
  const { page } = await as("audit-free");
  await page.goto("/brands");
  await page.getByRole("button", { name: "Project options for Quill", exact: true }).click();
  await page.getByRole("menuitem", { name: /Delete/u }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, "delete-project-dialog");
  await page.keyboard.press("Escape");
});
await recipe("delete-account-dialog", async () => {
  const { page } = await as("audit-free");
  await page.goto("/settings");
  await page
    .getByRole("button", { name: /Delete account/u })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, "delete-account-dialog");
  await page.keyboard.press("Escape");
});
// --- Plan limits and upgrade -----------------------------------------------------------------
await recipe("out-of-credits", async () => {
  const { page } = await as("audit-free");
  await page.goto(`/brands/account/${project("berenice")}?view=strategy`);
  await page.getByRole("button", { name: "Continue", exact: true }).last().click();
  const explore = page.getByRole("button", { name: "Explore six concepts", exact: true });
  await expect(explore).toBeEnabled({ timeout: 120_000 });
  await explore.click();
  await expect(
    page.getByText("You're out of credits for this month").or(page.getByText("You’re out of credits for this month")),
  ).toBeVisible({ timeout: 30_000 });
  await shot(page, "out-of-credits");
});
await recipe("upgrade-payments-unavailable", async () => {
  const { page } = await as("audit-free");
  await page.goto("/plans");
  await page.getByRole("button", { name: /Upgrade to Pro/u }).first().click();
  await expect(page.getByText(/payments are unavailable right now/iu)).toBeVisible({ timeout: 30_000 });
  await shot(page, "upgrade-payments-unavailable");
});
await recipe("daily-limit", async () => {
  const { page } = await as("audit-pro");
  sw("daily-limit", "logo.concepts", "1"); // the minimum; audit-pro has already used it today
  try {
    const grid = await logoSection(page, "kestrel");
    await grid.getByRole("button", { name: "More concepts", exact: true }).click();
    await page.waitForTimeout(6000);
    await shot(page, "daily-limit");
  } finally {
    sw("reset");
  }
});
// --- Error pages ------------------------------------------------------------------------------
await recipe("not-found", async () => {
  const { page } = await as("audit-free");
  const response = await page.goto("/this-page-does-not-exist");
  expect(response?.status()).toBe(404);
  await shot(page, "not-found");
  await page.goto("/brands/account/00000000-0000-4000-8000-000000000000?view=strategy");
  await page.waitForTimeout(5000);
  await shot(page, "missing-project");
});

for (const s of Object.values(sessions)) await s.context.close();
await browser.close();
console.table(rows);
