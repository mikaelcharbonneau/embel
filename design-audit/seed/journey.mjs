// Drives one brand through the real Embel screens with Playwright, up to its seed stage.
// Mirrors the repository's full-journey test (tests/journey/full-journey.spec.ts); the AI is the
// design-audit stand-in, so every generation is free (showcase images: see stand-in-ai.mjs).
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { reached } from "./brands.mjs";

/**
 * Launches Chromium: Playwright's own build when installed, otherwise the newest Chrome for
 * Testing already in the Playwright cache, otherwise the installed Google Chrome. Set
 * AUDIT_BROWSER_EXECUTABLE to force one. Nothing is downloaded.
 */
export async function launchBrowser(options = {}) {
  const forced = process.env.AUDIT_BROWSER_EXECUTABLE || process.env.FLUID_E2E_BROWSER_EXECUTABLE;
  if (forced) return chromium.launch({ ...options, executablePath: forced });
  try {
    return await chromium.launch(options);
  } catch (error) {
    if (!/Executable doesn't exist/u.test(error.message)) throw error;
  }
  const cache = path.join(homedir(), "Library/Caches/ms-playwright");
  const candidates = existsSync(cache)
    ? readdirSync(cache)
        .filter((d) => /^chromium-\d+$/u.test(d))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
        .map((d) =>
          path.join(
            cache,
            d,
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          ),
        )
        .filter(existsSync)
    : [];
  if (candidates.length) return chromium.launch({ ...options, executablePath: candidates[0] });
  return chromium.launch({ ...options, channel: "chrome" });
}

/** Generous bound for one generation round, including first-time route compilation. */
export const GENERATION = 240_000;
const question = (page, name) => page.getByRole("group", { name, exact: true });

export async function signIn(page, email, password) {
  await page.goto("/sign-in");
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  await form.getByRole("textbox", { name: "Email" }).fill(email);
  await form.getByLabel("Password", { exact: true }).fill(password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).not.toHaveURL(/sign-in/u, { timeout: 60_000 });
}

/** Sends the brief from Home and returns the new project's id. */
async function startBrand(page, b) {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(b.brief);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page).toHaveURL(/\/brands\/account\/[0-9a-f-]{36}/u, { timeout: 120_000 });
  return /\/brands\/account\/([0-9a-f-]{36})/u.exec(page.url())[1];
}

/** Send is the one way forward: it confirms what is chosen and names the next step. */
async function sendNext(page, name) {
  await page.getByRole("form", { name: "Reply", exact: true }).getByRole("button", { name, exact: true }).click();
}
const nextStep = {
  "Which competitors should we keep in mind?": "Continue to Audience",
  "Who should the brand speak to first?": "Continue to Positioning",
  "Which positioning fits best?": "Continue to Voice",
  "Which personality feels right?": "Continue to Name",
};

async function pick(page, groupName, role, label) {
  const group = question(page, groupName);
  await expect(group).toBeVisible({ timeout: GENERATION });
  await group.getByRole(role, { name: label, exact: true }).check();
  await sendNext(page, nextStep[groupName]);
}

async function strategy(page, b) {
  await expect(question(page, "Which competitors should we keep in mind?")).toBeVisible({ timeout: GENERATION });
  if (!reached(b.stage, "personality")) return;
  const competitors = question(page, "Which competitors should we keep in mind?");
  for (const [name] of b.competitors.slice(0, 2))
    await competitors.getByRole("checkbox", { name, exact: true }).check();
  await sendNext(page, "Continue to Audience");
  await pick(page, "Who should the brand speak to first?", "checkbox", b.audiences[0][0]);
  await pick(page, "Which positioning fits best?", "radio", b.positionings[0][0]);
  await expect(question(page, "Which personality feels right?")).toBeVisible({ timeout: GENERATION });
}

async function voice(page, b) {
  await pick(page, "Which personality feels right?", "radio", b.personalities[0][0]);
  await expect(
    page.getByRole("heading", { name: "Which approaches would you like to explore?", exact: true }),
  ).toBeVisible({ timeout: GENERATION });
  const approaches = page.getByRole("group", { name: "Naming approaches", exact: true });
  for (const name of ["Real words", "Blended words", "Invented words", "Phrases"])
    await approaches.getByRole("button", { name: new RegExp(`^${name} `, "u") }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Name directness", exact: true })
    .getByRole("radio", { name: /^Explore all /u })
    .check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Any length limits or text to include or avoid?", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  const names = page.getByRole("region", { name: "Naming exploration", exact: true });
  const radios = names.getByRole("radiogroup", { name: "Names", exact: true }).getByRole("radio");
  await expect(radios.first()).toBeVisible({ timeout: GENERATION });
  // Only the first 40 names are shown at once; reveal the rest before looking for the planned one.
  const more = names.getByRole("button", { name: /^Show \d+ more names$/u });
  while (await more.count()) await more.click();
  const radio = names.getByRole("radio", { name: b.name, exact: true });
  if (!(await radio.count())) throw new Error(`The planned name "${b.name}" is not among the generated names`);
  await radio.first().check({ force: true });
  await sendNext(page, "Continue to Slogan");
  await expect(
    page
      .locator('[data-journey-section="voice"] details')
      .filter({ has: page.locator(".e-answer__question", { hasText: /^Name$/u }) })
      .locator("summary"),
  ).toContainText(b.name);

  const slogan = question(page, "Which slogan do you like?");
  await expect(slogan).toBeVisible({ timeout: GENERATION });
  if (b.skipSlogan) await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  else {
    await slogan.getByRole("radio", { name: b.slogans[0], exact: true }).check();
    await sendNext(page, "Continue to Identity");
  }
  await expect(page.getByRole("article", { name: "Inspiration gallery", exact: true })).toBeVisible({
    timeout: GENERATION,
  });
}

async function inspiration(page, b, uploadFile) {
  const gallery = page.getByRole("article", { name: "Inspiration gallery", exact: true });
  const likes = gallery.getByRole("button", { name: /^Like the whole .+ brand$/u });
  await expect(likes.first()).toBeVisible({ timeout: GENERATION });
  await likes.nth(0).click();
  await expect(page.getByRole("form", { name: "Reply", exact: true }).getByText("Inspiration: 1 liked")).toBeVisible();
  if (uploadFile) {
    await page.locator('input[type="file"][aria-label="Choose images to add"]').setInputFiles(uploadFile);
    const yours = page.getByRole("article", { name: "Your images", exact: true });
    await expect(yours.getByRole("button", { name: /^(Like|Unlike) /u }).first()).toBeVisible({ timeout: 120_000 });
    const like = yours.getByRole("button", { name: /^Like /u }).first();
    if (await like.count()) await like.click();
  }
  await sendNext(page, "Continue to Logo");
  await expect(page.getByRole("button", { name: "Explore six concepts", exact: true })).toBeVisible({
    timeout: GENERATION,
  });
}

/** The Logo step prepares its saved inputs first ("Preparing saved inputs…"); a reload helps it along. */
async function exploreReady(page) {
  const explore = page.getByRole("button", { name: "Explore six concepts", exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await expect(explore).toBeEnabled({ timeout: 60_000 });
      return explore;
    } catch {
      await page.reload();
    }
  }
  await expect(explore).toBeEnabled({ timeout: GENERATION });
  return explore;
}

async function concepts(page, b) {
  await (await exploreReady(page)).click();
  const grid = page.getByRole("region", { name: "Logo concepts", exact: true });
  const ready = 6 - (b.failedLogoSlots ?? 0);
  await expect(grid.getByRole("img", { name: "Image preview of saved logo concept" })).toHaveCount(ready, {
    timeout: GENERATION,
  });
  if (b.failedLogoSlots) {
    // The round ends once the refused images are recorded as failed.
    await expect(page.getByRole("button", { name: /Retry/u }).first()).toBeVisible({ timeout: GENERATION });
  } else await expect(grid.getByText(/6 of 6 concepts ready/u)).toBeVisible({ timeout: GENERATION });
}

async function chooseLogo(page, b) {
  const grid = page.getByRole("region", { name: "Logo concepts", exact: true });
  await grid.getByRole("button", { name: "Select concept 1", exact: true }).click();
  await expect(grid.getByText(/Logo chosen/u)).toBeVisible();
  if (b.refine) await refine(page, b);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

async function refine(page, b) {
  // The composer under the concepts refines the chosen concept (a new version on its card).
  await page.getByRole("textbox", { name: "Describe a change to this logo", exact: true }).fill(b.refineInstruction);
  await page.getByRole("button", { name: "Refine", exact: true }).click();
  await expect(page.getByText("Your refined logo is ready on its card.", { exact: true })).toBeVisible({
    timeout: GENERATION,
  });
}

async function directions(page) {
  const step = page.getByRole("region", { name: "Creative direction", exact: true });
  await expect(step.getByRole("img", { name: "Chosen logo concept", exact: true })).toBeVisible({
    timeout: GENERATION,
  });
  await expect(
    step.getByRole("region", { name: "Creative directions", exact: true }).getByText("3 of 3 ready", { exact: true }),
  ).toBeVisible({ timeout: GENERATION });
  await expect(step.getByRole("img", { name: /^Saved Identity board for /u })).toHaveCount(3);
}

async function complete(page) {
  const step = page.getByRole("region", { name: "Creative direction", exact: true });
  const first = step.getByRole("radio", { name: /^Direction 1: /u });
  await expect(first).toBeEnabled({ timeout: GENERATION });
  await first.click();
  await expect(first).toHaveAttribute("aria-checked", "true");
  await step.getByRole("link", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/logo\/deliverables/u, { timeout: 120_000 });
  const assets = page.getByRole("region", { name: "Brand assets", exact: true });
  await expect(assets.getByRole("status").filter({ hasText: "Ready to download." })).toBeVisible({
    timeout: GENERATION,
  });
  // A past export: the brand kit, downloaded once.
  const [kit] = await Promise.all([
    page.waitForEvent("download"),
    assets.getByRole("button", { name: "Download brand kit", exact: true }).click(),
  ]);
  if (await kit.failure()) throw new Error("brand kit download failed");
}

/** Walks one brand from Home to its seed stage. Returns the project id. */
export async function seedBrand(page, b, { uploadFile, log = () => {} } = {}) {
  const projectId = await startBrand(page, b);
  log(`project ${projectId}`);
  await strategy(page, b);
  if (!reached(b.stage, "inspiration")) return projectId;
  log("voice");
  await voice(page, b);
  if (!reached(b.stage, "logo")) return projectId;
  log("inspiration");
  await inspiration(page, b, uploadFile);
  if (!reached(b.stage, "concepts")) return projectId;
  log("logo concepts");
  await concepts(page, b);
  if (!reached(b.stage, "directions")) return projectId;
  log("logo chosen, directions");
  await chooseLogo(page, b);
  await directions(page);
  if (!reached(b.stage, "complete")) return projectId;
  log("direction chosen, assets");
  await complete(page);
  return projectId;
}
