import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { accountProjectSchema, accountProjectSummarySchema, type AccountProject } from "../../src/domain/project-api";
import { createProjectInputSchema } from "../../src/domain/projects";

const namesKey = "fluid.names.v1";
const draftsKey = "fluid.local-drafts.v1";
const brief = "A local lighting studio making warm, repairable lamps for small homes.";
const audience = "People living in small homes";
const notes = "Readable in English and French";

function candidate(page: Page, value: string): Locator { return page.getByRole("article", { name: `Name: ${value}`, exact: true }); }
async function openNames(page: Page) {
  await page.goto("/names");
  await expect(page.getByRole("heading", { name: "Shape a name.", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Library", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Library", exact: true }).click();
}
async function addName(page: Page, value: string, withContext = false) {
  await page.getByRole("button", { name: "Add name", exact: true }).click();
  const capture = page.getByRole("region", { name: "Add a name", exact: true });
  await capture.getByRole("textbox", { name: "Name", exact: true }).fill(value);
  if (withContext) {
    await capture.getByText("Context for new names", { exact: false }).click();
    await capture.getByRole("textbox", { name: "Brief description" }).fill(brief);
    await capture.getByRole("textbox", { name: "Known audience", exact: true }).fill(audience);
    await capture.getByRole("textbox", { name: "Naming notes" }).fill(notes);
  }
  await capture.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(candidate(page, value)).toBeVisible();
}
async function promote(page: Page, value: string) {
  const card = candidate(page, value);
  await card.getByText("Context & history", { exact: true }).click();
  await card.getByRole("button", { name: "Create brand", exact: true }).click();
}
async function stored(page: Page, key = namesKey) { return page.evaluate((key) => localStorage.getItem(key), key); }
async function capture(page: Page, path: string) {
  // Let the comparison action finish its scheduled focus/scroll before positioning evidence.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    requestAnimationFrame(() => resolve());
  })));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path, fullPage: true, scale: "css", style: "nextjs-portal { visibility: hidden; }" });
}

test("Names library retains manual context, independent preferences, comparison and a real backup download", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openNames(page);
  await expect(page.getByRole("tab", { name: "Library", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("article")).toHaveCount(0);
  await addName(page, "Lumi", true);
  await candidate(page, "Lumi").getByRole("button", { name: "Favorite Lumi", exact: true }).click();
  await candidate(page, "Lumi").getByRole("button", { name: "Unsave Lumi", exact: true }).click();
  await candidate(page, "Lumi").getByRole("button", { name: "Compare Lumi", exact: true }).click();
  for (const value of ["Halo", "Common Light", "Day Room"]) await addName(page, value);
  await candidate(page, "Halo").getByRole("button", { name: "Compare Halo", exact: true }).click();
  await candidate(page, "Common Light").getByRole("button", { name: "Compare Common Light", exact: true }).click();
  await expect(candidate(page, "Day Room").getByRole("button", { name: "Compare Day Room", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Compare names", exact: true }).click();
  await expect(page.getByRole("region", { name: "Name comparison" })).toBeVisible();
  await capture(page, testInfo.outputPath("names-library-comparison.png"));
  await page.reload();
  await expect(page.getByRole("region", { name: "Name comparison" })).toBeVisible();
  await expect(candidate(page, "Lumi").getByRole("button", { name: "Unfavorite Lumi", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(candidate(page, "Lumi").getByRole("button", { name: "Save Lumi", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("combobox", { name: "Filter names" }).selectOption("favorite");
  await expect(page.locator(".names-library-list").getByRole("article")).toHaveCount(1);
  await page.getByText("Browser workspace ·", { exact: false }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download workspace copy" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("embel-names-workspace.json");
  const copy = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(copy.candidates).toHaveLength(4);
  expect(copy.ui.comparisonIds).toHaveLength(3);
  expect(copy.candidates[0]).toMatchObject({ favorite: true, saved: false, source: { value: "Lumi", origin: "manual", history: [] }, context: { description: brief, knownAudience: audience, intake: { namingNotes: notes } } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});

test("Workshop chains all four real transformations, retains run parameters and promotes known context without restarting", async ({ page }, testInfo) => {
  await openNames(page);
  await page.getByRole("tab", { name: "Workshop", exact: true }).click();
  await page.getByText("Single-name controls", { exact: true }).click();
  const controls = page.getByRole("complementary", { name: "Workshop controls" });
  await controls.getByRole("textbox", { name: "Start with a word" }).fill("Lumi");
  await controls.getByRole("textbox", { name: "Suffixes", exact: true }).fill("na, no");
  await controls.getByText("Context for new names", { exact: false }).click();
  const description = controls.getByRole("textbox", { name: "Brief description" });
  await description.pressSequentially("A local ");
  await expect(description).toHaveValue("A local ");
  await description.fill(brief);
  await controls.getByRole("textbox", { name: "Known audience", exact: true }).fill(audience);
  await controls.getByRole("textbox", { name: "Naming notes" }).fill(notes);
  await controls.getByRole("button", { name: "Run Affixes" }).click();
  await expect(candidate(page, "Lumina")).toBeVisible();
  await expect(candidate(page, "Lumino")).toBeVisible();
  await candidate(page, "Lumina").getByRole("button", { name: "Favorite Lumina", exact: true }).click();
  await candidate(page, "Lumina").getByRole("button", { name: "Use as seed", exact: true }).click();
  await controls.getByRole("radio", { name: /^Tweaks/ }).check();
  await controls.getByRole("checkbox", { name: "lowercase", exact: true }).uncheck();
  await controls.getByRole("checkbox", { name: "UPPERCASE", exact: true }).check();
  await controls.getByRole("button", { name: "Run Tweaks" }).click();
  await expect(candidate(page, "LUMINA")).toBeVisible();
  await candidate(page, "LUMINA").getByRole("button", { name: "Use as seed", exact: true }).click();
  await controls.getByRole("radio", { name: /^Blend/ }).check();
  await controls.getByRole("textbox", { name: "Second word" }).fill("Nova");
  await controls.getByRole("spinbutton", { name: "Keep from first" }).fill("3");
  await controls.getByRole("spinbutton", { name: "Skip from second" }).fill("1");
  await controls.getByRole("button", { name: "Run Blend" }).click();
  await expect(candidate(page, "LUMova")).toBeVisible();
  await candidate(page, "LUMova").getByRole("button", { name: "Use as seed", exact: true }).click();
  await controls.getByRole("radio", { name: /^Swap/ }).check();
  await controls.getByRole("textbox", { name: "Find exact text" }).fill("LUM");
  await controls.getByRole("textbox", { name: "Replace with" }).fill("Lum");
  await controls.getByRole("button", { name: "Run Swap" }).click();
  await expect(candidate(page, "Lumova")).toBeVisible();
  await candidate(page, "Lumova").getByRole("button", { name: "Save Lumova", exact: true }).click();
  await controls.getByRole("textbox", { name: "Brief description" }).fill("Changed current workspace context for a future name only.");
  await page.reload();
  await expect(page.getByRole("tab", { name: "Workshop", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByText("Single-name controls", { exact: true }).click();
  await expect(controls.getByRole("textbox", { name: "Find exact text" })).toHaveValue("LUM");
  const before = JSON.parse((await stored(page))!);
  const chosen = before.candidates.find((item: { source: { value: string } }) => item.source.value === "Lumova");
  expect(chosen.source.history.map((step: { input: { kind: string } }) => step.input.kind)).toEqual(["affixes", "tweaks", "blend", "swap"]);
  expect(chosen.context.description).toBe(brief);
  expect(before.runs).toHaveLength(4);
  await capture(page, testInfo.outputPath("names-workshop.png"));
  await promote(page, "Lumova");
  await expect(page).toHaveURL(/\/brands\/[a-f0-9-]+$/);
  await expect(page.getByRole("heading", { name: "Competitors", exact: true })).toBeVisible();
  await page.getByText("Project details and saving", { exact: true }).click();
  await page.getByText("Saved project details", { exact: true }).click();
  await expect(page.locator(".conversation-saved-details").getByText(audience, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Activity/ })).toHaveCount(0);
  await expect(page.getByText("Started from Names", { exact: true })).toBeVisible();
  const draft = JSON.parse((await stored(page, draftsKey))!).drafts[0];
  expect(draft).toMatchObject({ scope: "complete_brand", suppliedName: "Lumova", description: brief, namingNotes: notes });
  expect(draft.preservedContext.namingSource).toEqual(chosen.source);
  expect(draft.preservedContext.reformulationConfirmed).toBe(false);
  expect(JSON.parse((await stored(page))!)).toEqual(before);
  await page.getByText("View 4 transformation steps", { exact: true }).click();
  await capture(page, testInfo.outputPath("name-promoted-brand.png"));
  await page.reload();
  await page.getByText("Project details and saving", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lumova", exact: true, level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Open Names", exact: true }).click();
  await page.getByText("Single-name controls", { exact: true }).click();
  await expect(candidate(page, "Lumova")).toBeVisible();
  await page.getByRole("region", { name: "Workshop history" }).getByText("Run history", { exact: false }).click();
  await page.getByRole("region", { name: "Workshop history" }).getByRole("button").filter({ hasText: "Affixes" }).click();
  await expect(candidate(page, "Lumina")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test("account fixture: promoted source survives explicit account copy while both browser originals remain", async ({ page }) => {
  const owner = "aaaaaaaa-1111-4111-8111-111111111111";
  const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
  let project: AccountProject | undefined;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown;
    let status = 200;
    if (path === "/api/session") body = { user: { id: owner } };
    else if (path.endsWith("/strategy") && request.method() === "GET") body = { availability: { status: "unavailable", operations: [], reason: "runtime_disabled" }, jobs: [] };
    else if (path === "/api/projects" && request.method() === "POST") {
      project = accountProjectSchema.parse({ ...createProjectInputSchema.parse(request.postDataJSON()), id: projectId, owner_id: owner, current_revision: 1, created_at: "2026-10-02T20:00:00Z" });
      body = { project }; status = 201;
    } else if (path === "/api/projects") body = { projects: project ? [accountProjectSummarySchema.parse(project)] : [] };
    else if (path === `/api/projects/${projectId}` && project) body = { project };
    else { body = { error: "Local fixture route not found" }; status = 404; }
    await route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "private, no-store" }, body: JSON.stringify(body) });
  });
  await openNames(page);
  await addName(page, "Common Light", true);
  await promote(page, "Common Light");
  await expect(page).toHaveURL(/\/brands\/[a-f0-9-]+$/);
  const namesBefore = await stored(page);
  const draftsBefore = await stored(page, draftsKey);
  await page.getByText("Account saving", { exact: true }).click();
  await page.getByRole("button", { name: "Save to account", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/brands/account/${projectId}$`));
  await page.getByText("Project details and saving", { exact: true }).click();
  await expect(page.getByText("Saved to account · version 1", { exact: true })).toBeVisible();
  expect(project?.context).toMatchObject({ selectedName: "Common Light", description: brief, knownAudience: audience, namingSource: { value: "Common Light", origin: "manual", history: [] }, intake: { suppliedName: "Common Light", namingNotes: notes } });
  expect(await stored(page)).toBe(namesBefore);
  expect(await stored(page, draftsKey)).toBe(draftsBefore);
  await page.reload();
  await page.getByText("Project details and saving", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Common Light", exact: true, level: 1 })).toBeVisible();
  await page.getByText("Saved project details", { exact: true }).click();
  await expect(page.locator(".conversation-saved-details").getByText(audience, { exact: true })).toBeVisible();
});

test("invalid and unchanged transforms remain honest, and Names tabs support keyboard navigation", async ({ page }) => {
  await openNames(page);
  await page.getByRole("tab", { name: "Library", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Workshop", exact: true })).toBeFocused();
  await page.getByText("Single-name controls", { exact: true }).click();
  const controls = page.getByRole("complementary", { name: "Workshop controls" });
  await controls.getByRole("textbox", { name: "Start with a word" }).fill("Lumi");
  await controls.getByRole("textbox", { name: "Prefixes", exact: true }).fill(Array.from({ length: 13 }, (_, index) => `p${index}`).join(","));
  await controls.getByRole("button", { name: "Run Affixes" }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  expect(JSON.parse((await stored(page))!).runs).toHaveLength(0);
  await controls.getByRole("radio", { name: /^Swap/ }).check();
  await controls.getByRole("textbox", { name: "Find exact text" }).fill("absent");
  await controls.getByRole("textbox", { name: "Replace with" }).fill("$&");
  await controls.getByRole("button", { name: "Run Swap" }).click();
  await expect(page.getByText("No new variants for these parameters.", { exact: true })).toBeVisible();
  expect(JSON.parse((await stored(page))!).candidates).toHaveLength(0);
  await page.getByRole("tab", { name: "Workshop", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "History", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "AI Assistant", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI naming assistant" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Name screening" })).toHaveCount(0);
});

test("failed Names writes preserve the durable original, retain this tab's new name and recover on retry", async ({ context, page }) => {
  await context.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Object.defineProperty(Storage.prototype, "setItem", { value(key: string, value: string) {
      if (key === "fluid.names.v1" && (window as unknown as { denyNames?: boolean }).denyNames) throw new DOMException("Local fixture denial", "QuotaExceededError");
      return original.call(this, key, value);
    } });
  });
  await openNames(page);
  await addName(page, "Durable original");
  const original = await stored(page);
  await page.evaluate(() => { (window as unknown as { denyNames?: boolean }).denyNames = true; });
  await addName(page, "Keep this unsaved name");
  await expect(page.getByRole("region", { name: "Names storage recovery" }).getByRole("alert")).toContainText("tab only");
  expect(await stored(page)).toBe(original);
  await page.evaluate(() => { (window as unknown as { denyNames?: boolean }).denyNames = false; });
  await page.getByRole("button", { name: "Retry saving", exact: true }).click();
  await expect(page.getByRole("region", { name: "Names storage recovery" })).toHaveCount(0);
  await page.reload();
  await expect(candidate(page, "Durable original")).toBeVisible();
  await expect(candidate(page, "Keep this unsaved name")).toBeVisible();
});

test("cross-tab conflict retains both branches and offers an actual download before confirmed recovery", async ({ context, page }) => {
  const other = await context.newPage();
  // Delivering the storage notification late is a real platform condition. The mutation must
  // still compare against current durable storage instead of overwriting another tab's work.
  await other.addInitScript(() => window.addEventListener("storage", event => event.stopImmediatePropagation(), true));
  await openNames(page);
  await openNames(other);
  await addName(page, "Saved in first tab");
  await addName(other, "Kept in second tab");
  await expect(other.getByRole("region", { name: "Names storage recovery" }).getByRole("alert")).toContainText("another tab");
  const saved = JSON.parse((await stored(other))!);
  expect(saved.candidates.map((item: { source: { value: string } }) => item.source.value)).toEqual(["Saved in first tab"]);
  const downloadPromise = other.waitForEvent("download");
  await other.getByRole("button", { name: "Download this tab's copy", exact: true }).click();
  const recovery = JSON.parse(await readFile((await (await downloadPromise).path())!, "utf8"));
  expect(recovery.candidates.map((item: { source: { value: string } }) => item.source.value)).toEqual(["Kept in second tab"]);
  await other.getByRole("button", { name: "Load saved version", exact: true }).click();
  await expect(candidate(other, "Kept in second tab")).toBeVisible();
  await other.getByRole("button", { name: "Confirm load saved version", exact: true }).click();
  await expect(candidate(other, "Saved in first tab")).toBeVisible();
  await expect(candidate(other, "Kept in second tab")).toHaveCount(0);
  await other.close();
});

test("unreadable Names data is protected until explicit recovery; malformed brand data cannot be overwritten by promotion", async ({ context, page }) => {
  await context.addInitScript(() => {
    localStorage.setItem("fluid.names.v1", "{unreadable-local-fixture");
    localStorage.setItem("fluid.local-drafts.v1", "{unreadable-brand-fixture");
  });
  await openNames(page);
  await addName(page, "Recovery name");
  expect(await stored(page)).toBe("{unreadable-local-fixture");
  await promote(page, "Recovery name");
  await expect(page.locator("main").getByRole("alert").filter({ hasText: "Saved brand drafts could not be read" })).toBeVisible();
  expect(await stored(page, draftsKey)).toBe("{unreadable-brand-fixture");
  await page.getByRole("button", { name: "Replace unreadable saved data", exact: true }).click();
  expect(await stored(page)).toBe("{unreadable-local-fixture");
  await page.getByRole("button", { name: "Confirm replace saved data", exact: true }).click();
  expect(JSON.parse((await stored(page))!).candidates[0].source.value).toBe("Recovery name");
  await expect(page.getByRole("region", { name: "Names storage recovery" })).toHaveCount(0);
});
