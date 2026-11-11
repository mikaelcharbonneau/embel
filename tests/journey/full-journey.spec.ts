import { readFile } from "node:fs/promises";
import { expect, test, type Download, type Page } from "@playwright/test";
import { unzipSync } from "fflate";

// The whole brand journey in a real browser: the real app, this checkout's local Supabase and
// the generation engine, with a stand-in OpenAI provider (tests/journey/fake-openai.mjs).
// Nothing here reaches a real AI provider or any hosted service.

const PROMPT =
  "A subscription service delivering fresh sourdough bread and pastries to small offices in Montreal every week.";
/** Generous bounds for one generation round, including first-time route compilation in CI. */
const GENERATION = 180_000;
/** Credits each step's runs charge (fluid_private.generation_kinds): five Strategy turns
 * (competitors, audience, positioning, personality, slogan), one naming round, six logo
 * concepts and one creative directions round (6 credits, two per board). */
const EXPECTED_CHARGE = 5 + 1 + 6 + 6;
// Money amounts or estimate wording; credits are fine, costs and prices are never shown.
const COST_ESTIMATE =
  /[$€£]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:USD|EUR|CAD|dollars?|cents?)\b|\bcost estimates?\b|\bestimated (?:cost|price)\b|\bthis will cost\b/iu;

async function creditBalance(page: Page): Promise<number> {
  const response = await page.request.get("/api/credits");
  expect(response.status()).toBe(200);
  const balance = (await response.json()).credits?.balance;
  expect(typeof balance).toBe("number");
  return balance;
}
async function expectNoCostEstimate(page: Page) {
  expect(await page.locator("body").innerText()).not.toMatch(COST_ESTIMATE);
}
async function downloadedBytes(download: Download): Promise<Buffer> {
  expect(await download.failure()).toBeNull();
  return readFile((await download.path())!);
}
const isPng = (bytes: Buffer) =>
  bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const question = (page: Page, name: string) => page.getByRole("group", { name, exact: true });

test("a new brand goes from the first prompt to downloadable assets", async ({ page }) => {
  const email = process.env.EMBEL_JOURNEY_EMAIL,
    password = process.env.EMBEL_JOURNEY_PASSWORD;
  if (!email || !password)
    throw new Error("Run with playwright.journey.config.ts: its global setup creates the test account.");
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await test.step("sign in", async () => {
    await page.goto("/sign-in");
    const form = page.getByRole("form", { name: "Sign in", exact: true });
    await form.getByRole("textbox", { name: "Email" }).fill(email);
    await form.getByLabel("Password", { exact: true }).fill(password);
    await form.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).not.toHaveURL(/sign-in/u);
  });
  const startingCredits = await creditBalance(page);

  await test.step("Home: the first prompt starts competitor research", async () => {
    await page.goto("/");
    await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(PROMPT);
    await page.getByRole("button", { name: "Send prompt", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start competitor research" })).toHaveCount(0);
  });

  await test.step("Strategy: competitors, audience and positioning", async () => {
    const competitors = question(page, "Which competitors should we keep in mind?");
    await expect(competitors).toBeVisible({ timeout: GENERATION });
    await expectNoCostEstimate(page);
    // Research shows its verified sources.
    await expect(
      page
        .getByRole("group", { name: "References for Northloaf Bakery", exact: true })
        .getByRole("link", { name: /Visit website/u }),
    ).toBeVisible();
    await competitors.getByRole("checkbox", { name: "Northloaf Bakery", exact: true }).check();
    await competitors.getByRole("button", { name: "Continue", exact: true }).click();

    const audience = question(page, "Who should the brand speak to first?");
    await expect(audience).toBeVisible({ timeout: GENERATION });
    await audience.getByRole("checkbox", { name: "Office managers", exact: true }).check();
    await audience.getByRole("button", { name: "Continue", exact: true }).click();

    const positioning = question(page, "Which positioning fits best?");
    await expect(positioning).toBeVisible({ timeout: GENERATION });
    await positioning.getByRole("radio", { name: "Fresh every Monday", exact: true }).check();
    await positioning.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("navigation", { name: "Brand journey" }).getByRole("link", { name: /^Strategy , complete/u }),
    ).toBeVisible();
  });

  await test.step("Voice: personality", async () => {
    const personality = question(page, "Which personality feels right?");
    await expect(personality).toBeVisible({ timeout: GENERATION });
    await personality.getByRole("radio", { name: "Warm and dependable", exact: true }).check();
    await personality.getByRole("button", { name: "Continue", exact: true }).click();
  });

  await test.step("Voice: names generated and one chosen", async () => {
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
    const choose = names.getByRole("button", { name: /Choose this name$/u });
    await expect(choose.first()).toBeVisible({ timeout: GENERATION });
    await expect(names.getByRole("alert")).toHaveCount(0);
    expect(await choose.count()).toBeGreaterThanOrEqual(20);
    await expectNoCostEstimate(page);
    const chosen = (await names.getByRole("article").first().getByRole("heading", { level: 3 }).innerText()).trim();
    await choose.first().click();
    await page
      .getByRole("article", { name: "Names", exact: true })
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await expect(page.getByRole("article", { name: "Your name", exact: true }).getByRole("listitem")).toHaveText(
      chosen,
    );
  });

  await test.step("Voice: slogan", async () => {
    const slogan = question(page, "Which slogan do you like?");
    await expect(slogan).toBeVisible({ timeout: GENERATION });
    await slogan.getByRole("radio", { name: "Fresh bread, every week", exact: true }).check();
    await slogan.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("navigation", { name: "Brand journey" }).getByRole("link", { name: /^Voice , complete/u }),
    ).toBeVisible();
  });

  await test.step("Identity: inspiration", async () => {
    const gallery = page.getByRole("article", { name: "Inspiration gallery", exact: true });
    await expect(gallery).toBeVisible({ timeout: GENERATION });
    await gallery.getByRole("button", { name: "Like the whole Archi-Tex brand", exact: true }).click();
    await expect(gallery.getByText(/^1 liked/u)).toBeVisible();
    await gallery.getByRole("button", { name: "Continue", exact: true }).click();
  });

  await test.step("Identity: logo concepts generated and one chosen", async () => {
    const explore = page.getByRole("button", { name: "Explore six concepts", exact: true });
    await expect(explore).toBeVisible({ timeout: GENERATION });
    await expectNoCostEstimate(page);
    // One deliberate click starts the round: no quote or confirmation screen.
    await explore.click();
    const concepts = page.getByRole("region", { name: "Logo concepts", exact: true });
    await expect(concepts.getByText(/6 of 6 concepts ready/u)).toBeVisible({ timeout: GENERATION });
    await expect(concepts.getByRole("img", { name: "Image preview of saved logo concept" })).toHaveCount(6);
    await concepts.getByRole("button", { name: "Select concept 1", exact: true }).click();
    await expect(concepts.getByText(/Logo chosen/u)).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  });

  await test.step("Identity: creative directions generated and one chosen", async () => {
    const step = page.getByRole("region", { name: "Creative direction", exact: true });
    await expect(step.getByRole("img", { name: "Chosen logo concept", exact: true })).toBeVisible({
      timeout: GENERATION,
    });
    await expect(
      step.getByRole("region", { name: "Creative directions", exact: true }).getByText("3 of 3 ready", { exact: true }),
    ).toBeVisible({ timeout: GENERATION });
    await expect(step.getByRole("img", { name: /^Saved Identity board for /u })).toHaveCount(3);
    await expectNoCostEstimate(page);
    const first = step.getByRole("radio", { name: /^Direction 1: /u });
    await expect(first).toBeEnabled({ timeout: GENERATION });
    await first.click();
    await expect(first).toHaveAttribute("aria-checked", "true");
    await step.getByRole("link", { name: "Continue", exact: true }).click();
  });

  await test.step("Assets: brand board visible and downloads", async () => {
    await expect(page).toHaveURL(/\/logo\/deliverables/u);
    const assets = page.getByRole("region", { name: "Brand assets", exact: true });
    await expect(assets.getByRole("status").filter({ hasText: "Ready to download." })).toBeVisible({
      timeout: GENERATION,
    });
    const board = assets
      .getByRole("region", { name: "Brand board", exact: true })
      .getByRole("img", { name: /final brand board$/u });
    await expect(board).toBeVisible();
    await expect
      .poll(() =>
        board.evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0),
      )
      .toBe(true);
    await expectNoCostEstimate(page);

    const [boardFile] = await Promise.all([
      page.waitForEvent("download"),
      assets.getByRole("button", { name: "Download brand board as PNG", exact: true }).click(),
    ]);
    expect(isPng(await downloadedBytes(boardFile))).toBe(true);
    const [kitFile] = await Promise.all([
      page.waitForEvent("download"),
      assets.getByRole("button", { name: "Download brand kit", exact: true }).click(),
    ]);
    expect(kitFile.suggestedFilename()).toMatch(/\.zip$/u);
    const kit = Object.keys(unzipSync(new Uint8Array(await downloadedBytes(kitFile))));
    test.info().annotations.push({ type: "brand kit", description: kit.join(", ") });
    expect(kit.filter((name) => name.endsWith(".png")).length).toBeGreaterThanOrEqual(5);
  });

  await test.step("credits were charged for the work", async () => {
    expect(startingCredits - (await creditBalance(page))).toBe(EXPECTED_CHARGE);
  });
  expect(pageErrors).toEqual([]);
});
