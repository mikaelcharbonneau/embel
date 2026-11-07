import { test, expect, type Page } from "@playwright/test";

async function open(page: Page, suffix = "") {
  const unexpected: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).hostname !== "127.0.0.1") unexpected.push(request.url()); });
  await page.goto(`/${suffix}`);
  await expect(page.getByRole("heading", { name: "Search for your name", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  await page.getByText("More details", { exact: true }).click();
  return unexpected;
}
async function fill(page: Page) {
  await page.getByLabel("Mark name", { exact: true }).fill("Synthetic Mark");
  await page.getByLabel("Mark type", { exact: true }).selectOption("word");
  await page.getByLabel("Requested territories", { exact: true }).fill("Synthetic territory");
  await page.getByLabel("Goods and services", { exact: true }).fill("Synthetic product description");
  await page.getByLabel("Classification notes", { exact: true }).fill("Questions to review");
  await page.getByLabel("Owner name", { exact: true }).fill("Fixture owner");
  await page.getByLabel("Owner address", { exact: true }).fill("Fixture address");
  await page.getByLabel("Owner contact", { exact: true }).fill("Fixture contact");
  await page.getByLabel("Supporting document plan", { exact: true }).selectOption("none-planned");
}

test("empty draft preview remains incomplete and export availability is honest", async ({ page }) => {
  const requests = await open(page, "?disconnected");
  await expect(page.getByText("0 of 6 sections filled")).toBeVisible();
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Draft preview — not a filing dossier" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export draft preview" })).toBeDisabled();
  await expect(page.getByText("No application has been filed or registered.", { exact: false })).toBeVisible();
  expect(requests).toEqual([]);
});

test("fills intake, reviews, invalidates review on edit and exports actual user notes", async ({ page }, info) => {
  const requests = await open(page);
  await fill(page);
  await page.getByLabel("Your research notes", { exact: true }).fill("<script>user-entered claim</script>");
  await expect(page.getByText("6 of 6 sections filled")).toBeVisible();
  await page.getByRole("button", { name: "Review draft" }).click();
  await page.getByRole("checkbox", { name: /^I reviewed/ }).check();
  await expect(page.getByText("Reviewed draft", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit details", exact: true }).click();
  await page.getByLabel("Goods and services", { exact: true }).fill("Changed fixture goods");
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /^I reviewed/ })).not.toBeChecked();
  await page.getByRole("button", { name: "Export draft preview" }).click();
  const output = JSON.parse(await page.getByLabel("Fixture callback output").textContent() || "{}");
  expect(output.draft.goodsServices).toBe("Changed fixture goods");
  expect(output.draft.userNotes).toBe("<script>user-entered claim</script>");
  expect(output.research).toEqual({ status: "unavailable", matches: [] });
  expect(output.completeness.reviewCurrent).toBe(false);
  expect(await page.locator("script").count()).toBe(1);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain("Geist Fixture");
  const width = page.viewportSize()!.width;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.screenshot({ path: info.outputPath("draft-preview.png"), fullPage: true });
  expect(requests).toEqual([]);
});

test("research separates user notes and never fabricates matches", async ({ page }) => {
  await open(page);
  await page.getByLabel("Your research notes", { exact: true }).fill("User's own unsourced note");
  await page.getByRole("tab", { name: "Search", exact: true }).click();
  await page.getByText("Your research notes", { exact: true }).click();
  await expect(page.getByText("User's own unsourced note", { exact: true })).toBeVisible();
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(0);
});

test("rejects over-limit territory edits without losing usable draft", async ({ page }) => {
  await open(page);
  await page.getByLabel("Requested territories", { exact: true }).fill("Kept territory");
  await page.getByLabel("Requested territories", { exact: true }).fill(Array(21).fill("Too many").join("\n"));
  await expect(page.getByRole("alert")).toContainText("previous input has been kept");
  await expect(page.getByLabel("Requested territories", { exact: true })).toHaveValue("Kept territory");
});

test("export callback failure preserves the draft", async ({ page }) => {
  await open(page, "?fail");
  await page.getByLabel("Mark name", { exact: true }).fill("Retained fixture");
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await page.getByRole("button", { name: "Export draft preview" }).click();
  await expect(page.getByRole("alert")).toContainText("draft remains available");
  await page.getByRole("button", { name: "Edit details", exact: true }).click();
  await expect(page.getByLabel("Mark name", { exact: true })).toHaveValue("Retained fixture");
});

test("brand callback preserves known context without filing status", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: "Create brand from draft" })).toBeDisabled();
  await page.getByLabel("Mark name", { exact: true }).fill("  Seed fixture  ");
  await page.getByLabel("Goods and services", { exact: true }).fill("Fixture offering");
  await page.getByRole("button", { name: "Create brand from draft" }).click();
  const output = JSON.parse(await page.getByLabel("Fixture callback output").textContent() || "{}");
  expect(output).toMatchObject({ name: "Seed fixture", description: "Fixture offering", trademarkResearch: "unavailable" });
  expect(output.owner).toBeUndefined();
});


test("keyboard controls remain usable and intake has no viewport overflow", async ({ page }, info) => {
  await open(page);
  const research = page.getByRole("tab", { name: "Search", exact: true });
  await research.focus();
  await page.keyboard.press("Enter");
  await expect(research).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Details", exact: true }).click();
  await page.getByText("More details", { exact: true }).click();
  await page.getByLabel("Mark name", { exact: true }).fill("Keyboard fixture");
  await page.getByLabel("Mark type", { exact: true }).selectOption("logo");
  await expect(page.getByText("0 of 6 sections filled")).toBeVisible();
  await page.getByLabel("Representation notes", { exact: true }).fill("Fixture planned logo");
  await expect(page.getByText("1 of 6 sections filled")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: info.outputPath("dossier-intake.png"), fullPage: true });
});
