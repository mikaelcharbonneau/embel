import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createNamesAccountFixture, waitForNamesSaved } from "./fixtures/names-account";

const namesKey = "fluid.names.v1";
const brief = "A lighting studio making warm, repairable lamps for small homes.";
const audience = "People living in small homes";
const notes = "Readable in English and French";
function candidate(page: Page, value: string): Locator { return page.getByRole("article", { name: `Name: ${value}`, exact: true }); }
// Secondary controls open as modal sheets titled by their trigger.
async function openSheet(page: Page, scope: Page | Locator, title: string) {
  await scope.getByRole("button", { name: title }).click();
  const sheet = page.getByRole("dialog", { name: title });
  await expect(sheet).toBeVisible(); return sheet;
}
async function closeSheet(sheet: Locator) { await sheet.getByRole("button", { name: "Close", exact: true }).click(); await expect(sheet).toBeHidden(); }
async function openNames(page: Page) {
  await page.goto("/names");
  await expect(page.getByRole("heading", { name: "Shape a name.", exact: true })).toBeVisible();
  const library = page.getByRole("tab", { name: "Library", exact: true });
  if (await library.getAttribute("aria-selected") !== "true") await library.click();
}
async function addName(page: Page, value: string, withContext = false) {
  await page.getByRole("button", { name: "Add name", exact: true }).click();
  const capture = page.getByRole("region", { name: "Add a name", exact: true });
  await capture.getByRole("textbox", { name: "Name", exact: true }).fill(value);
  if (withContext) {
    const context = await openSheet(page, capture, "Context for new names");
    await context.getByRole("textbox", { name: "Brief description" }).fill(brief);
    await context.getByRole("textbox", { name: "Known audience", exact: true }).fill(audience);
    await context.getByRole("textbox", { name: "Naming notes" }).fill(notes);
    await closeSheet(context);
  }
  await capture.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(candidate(page, value)).toBeVisible();
}

test("Names account library persists context, preferences, comparison and a real backup download", async ({ page }, info) => {
  const fixture = createNamesAccountFixture(); await fixture.install(page);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openNames(page); await addName(page, "Lumi", true);
  await candidate(page, "Lumi").getByRole("button", { name: "Favorite Lumi", exact: true }).click();
  await candidate(page, "Lumi").getByRole("button", { name: "Unsave Lumi", exact: true }).click();
  await candidate(page, "Lumi").getByRole("button", { name: "Compare Lumi", exact: true }).click();
  for (const value of ["Halo", "Common Light", "Day Room"]) await addName(page, value);
  await candidate(page, "Halo").getByRole("button", { name: "Compare Halo", exact: true }).click();
  await candidate(page, "Common Light").getByRole("button", { name: "Compare Common Light", exact: true }).click();
  await expect(candidate(page, "Day Room").getByRole("button", { name: "Compare Day Room", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Compare names", exact: true }).click();
  await waitForNamesSaved(page); await page.reload();
  await expect(page.getByRole("region", { name: "Name comparison" })).toBeVisible();
  await expect(candidate(page, "Lumi").getByRole("button", { name: "Unfavorite Lumi", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(candidate(page, "Lumi").getByRole("button", { name: "Save Lumi", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Browser library", exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Project names', exact: true }).click();
  await expect(page.getByRole("heading", { name: "From your projects", exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Workshop & manual', exact: true }).click();
  await page.getByRole("combobox", { name: "Filter names" }).selectOption("favorite");
  await expect(page.locator(".names-library-list").getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Backups and recovery", exact: true })).toBeVisible();
  const pending = page.waitForEvent("download"); await page.getByRole("button", { name: "Download a backup", exact: true }).click();
  const download = await pending; expect(download.suggestedFilename()).toBe("embel-names-backup.json");
  const copy = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(copy.candidates).toHaveLength(4); expect(copy.ui.comparisonIds).toHaveLength(3);
  expect(copy.candidates[0]).toMatchObject({ favorite: true, saved: false, source: { value: "Lumi", origin: "manual", history: [] }, context: { description: brief, knownAudience: audience, intake: { namingNotes: notes } } });
  expect(await page.evaluate(key => localStorage.getItem(key), namesKey)).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath("account-names-library.png"), fullPage: true }); expect(errors).toEqual([]);
});

test("Workshop retains all four transformations and creates an account brand with the captured context", async ({ page }) => {
  const fixture = createNamesAccountFixture(); await fixture.install(page); await openNames(page);
  await page.getByRole("tab", { name: "Workshop", exact: true }).click(); await openSheet(page, page, "Single-name controls");
  const controls = page.getByRole("complementary", { name: "Workshop controls" });
  await controls.getByRole("textbox", { name: "Start with a word" }).fill("Lumi");
  await controls.getByRole("textbox", { name: "Suffixes", exact: true }).fill("na");
  let context = await openSheet(page, controls, "Context for new names");
  await context.getByRole("textbox", { name: "Brief description" }).fill(brief); await closeSheet(context);
  await controls.getByRole("button", { name: "Run Affixes" }).click();
  await candidate(page, "Lumina").getByRole("button", { name: "Use as seed", exact: true }).click();
  await controls.getByRole("radio", { name: /^Tweaks/ }).check();
  await controls.getByRole("checkbox", { name: "lowercase", exact: true }).uncheck();
  await controls.getByRole("checkbox", { name: "UPPERCASE", exact: true }).check();
  await controls.getByRole("button", { name: "Run Tweaks" }).click();
  await candidate(page, "LUMINA").getByRole("button", { name: "Use as seed", exact: true }).click();
  await controls.getByRole("radio", { name: /^Blend/ }).check();
  await controls.getByRole("textbox", { name: "Second word" }).fill("Nova");
  await controls.getByRole("spinbutton", { name: "Keep from first" }).fill("3");
  await controls.getByRole("spinbutton", { name: "Skip from second" }).fill("1");
  await controls.getByRole("button", { name: "Run Blend" }).click();
  await candidate(page, "LUMova").getByRole("button", { name: "Use as seed", exact: true }).click();
  await controls.getByRole("radio", { name: /^Swap/ }).check();
  await controls.getByRole("textbox", { name: "Find exact text" }).fill("LUM");
  await controls.getByRole("textbox", { name: "Replace with" }).fill("Lum");
  await controls.getByRole("button", { name: "Run Swap" }).click();
  await candidate(page, "Lumova").getByRole("button", { name: "Save Lumova", exact: true }).click();
  context = await openSheet(page, controls, "Context for new names");
  await context.getByRole("textbox", { name: "Brief description" }).fill("A future name has different context."); await closeSheet(context);
  await waitForNamesSaved(page); const before = structuredClone(fixture.payload());
  const chosen = before.candidates.find(item => item.source.value === "Lumova")!;
  expect(chosen.source.history.map(step => step.input.kind)).toEqual(["affixes", "tweaks", "blend", "swap"]);
  expect(chosen.context.description).toBe(brief); expect(before.runs).toHaveLength(4);
  await page.reload(); await openSheet(page, page, "Single-name controls");
  await expect(controls.getByRole("textbox", { name: "Find exact text" })).toHaveValue("LUM");
  const history = await openSheet(page, candidate(page, "Lumova"), "Context & history");
  await history.getByRole("button", { name: "Create brand", exact: true }).click();
  await expect(page).toHaveURL(/\/brands\/account\/[a-f0-9-]+$/);
  expect(fixture.state.projects).toHaveLength(1);
  expect(fixture.state.projects[0]!.context).toMatchObject({ description: brief, selectedName: "Lumova", namingSource: chosen.source });
  expect(await page.evaluate(() => localStorage.getItem("fluid.local-drafts.v1"))).toBeNull();
  expect(fixture.payload()).toEqual(before);
});

test("invalid transformations and keyboard tabs remain honest", async ({ page }) => {
  const fixture = createNamesAccountFixture(); await fixture.install(page); await openNames(page);
  await page.getByRole("tab", { name: "Library", exact: true }).focus(); await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Workshop", exact: true })).toBeFocused();
  await openSheet(page, page, "Single-name controls");
  const controls = page.getByRole("complementary", { name: "Workshop controls" });
  await controls.getByRole("textbox", { name: "Start with a word" }).fill("Lumi");
  await controls.getByRole("textbox", { name: "Prefixes", exact: true }).fill(Array.from({ length: 13 }, (_, i) => `p${i}`).join(","));
  await controls.getByRole("button", { name: "Run Affixes" }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible(); await waitForNamesSaved(page); expect(fixture.payload().runs).toHaveLength(0);
  await controls.getByRole("radio", { name: /^Swap/ }).check();
  await controls.getByRole("textbox", { name: "Find exact text" }).fill("absent");
  await controls.getByRole("textbox", { name: "Replace with" }).fill("$&");
  await controls.getByRole("button", { name: "Run Swap" }).click();
  await expect(page.getByText("No new variants for these parameters.", { exact: true })).toBeVisible();
  await closeSheet(page.getByRole("dialog", { name: "Single-name controls" }));
  await page.getByRole("tab", { name: "Workshop", exact: true }).focus(); await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "History", exact: true })).toBeFocused();
  await waitForNamesSaved(page); expect(fixture.payload().candidates).toHaveLength(0); expect(fixture.payload().runs).toHaveLength(1);
});

test("account save failures retain buffered names and recover with the identical request", async ({ page }) => {
  const fixture = createNamesAccountFixture(); await fixture.install(page); await openNames(page);
  await addName(page, "Durable original"); await waitForNamesSaved(page); fixture.state.failSaves = true;
  await addName(page, "Unsaved name"); await expect(page.getByRole("region", { name: "Names save recovery" })).toBeVisible();
  expect(fixture.payload().candidates.map(item => item.source.value)).toEqual(["Durable original"]);
  const failed = fixture.state.puts.at(-1)!; fixture.state.failSaves = false;
  await page.getByRole("button", { name: "Retry saving", exact: true }).click(); await waitForNamesSaved(page);
  expect(fixture.state.puts.at(-1)).toEqual(failed); await page.reload();
  await expect(candidate(page, "Durable original")).toBeVisible(); await expect(candidate(page, "Unsaved name")).toBeVisible();
});

test("cross-tab account conflicts preserve both branches and offer backup before recovery", async ({ context, page }) => {
  const fixture = createNamesAccountFixture(); await fixture.install(page); await openNames(page); await waitForNamesSaved(page);
  const other = await context.newPage(); await fixture.install(other); await openNames(other);
  await addName(page, "Saved in first tab"); await waitForNamesSaved(page);
  await addName(other, "Kept in second tab");
  await expect(other.getByRole("region", { name: "Names save recovery" }).getByRole("alert")).toContainText("another session");
  expect(fixture.payload().candidates.map(item => item.source.value)).toEqual(["Saved in first tab"]);
  const pending = other.waitForEvent("download"); await other.getByRole("button", { name: "Download unsaved copy", exact: true }).click();
  const copy = JSON.parse(await readFile((await (await pending).path())!, "utf8")); expect(copy.candidates[0].source.value).toBe("Kept in second tab");
  await other.getByRole("button", { name: "Load saved version", exact: true }).click(); await expect(candidate(other, "Kept in second tab")).toBeVisible();
  await other.getByRole("button", { name: "Confirm load saved version", exact: true }).click();
  await expect(candidate(other, "Saved in first tab")).toBeVisible(); await expect(candidate(other, "Kept in second tab")).toHaveCount(0); await other.close();
});

test("unreadable legacy data is untouched and never replaces normal account Names", async ({ page }) => {
  const fixture = createNamesAccountFixture(); await fixture.install(page);
  await page.addInitScript(() => localStorage.setItem("fluid.names.v1", "{unreadable-legacy-fixture"));
  await openNames(page); await addName(page, "Account name"); await waitForNamesSaved(page);
  await page.goto("/names?recover=1"); await expect(page.getByRole("heading", { name: "Backups and recovery", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Recover earlier browser names", exact: true }).click();
  await expect(page.getByText("The earlier browser backup could not be read. Its stored data has been left untouched.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("fluid.names.v1"))).toBe("{unreadable-legacy-fixture");
  expect(fixture.payload().candidates[0]!.source.value).toBe("Account name");
});

test("signed-out Names gates the editor and never imports unowned browser data", async ({ page }) => {
  const fixture = createNamesAccountFixture(); fixture.state.ownerId = null; await fixture.install(page);
  await page.addInitScript(() => localStorage.setItem("fluid.names.v1", "legacy-private-copy")); await page.goto("/names");
  await expect(page.getByText("Sign in to keep your names, workshop, and history together.", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Add words", exact: true })).toHaveCount(0); expect(fixture.state.puts).toHaveLength(0);
  expect(await page.evaluate(() => localStorage.getItem("fluid.names.v1"))).toBe("legacy-private-copy");
});
