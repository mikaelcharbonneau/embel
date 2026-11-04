import { expect, test, type Page } from "@playwright/test";

import { createNamesAccountFixture, waitForNamesSaved } from "./fixtures/names-account";
const fixtures = new WeakMap<Page, ReturnType<typeof createNamesAccountFixture>>();
const sampleWords = "interface, ui, application, app, screen, flow, design, site, page, web, reference, visual, graphic, front, face";
async function open(page: Page) {
  const fixture = createNamesAccountFixture(); fixtures.set(page, fixture); await fixture.install(page);
  await page.goto("/names");
  await expect(page.getByRole("heading", { name: "Shape a name.", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Workshop", exact: true })).toHaveAttribute("aria-selected", "true");
}
async function words(page: Page, value: string) {
  await page.getByRole("textbox", { name: "Add words", exact: true }).fill(value);
  await page.getByRole("textbox", { name: "Add words", exact: true }).press("Enter");
}
async function snapshot(page: Page) { await waitForNamesSaved(page); return fixtures.get(page)!.payload(); }
async function top(page: Page) { await page.locator("#main-content").evaluate(element => { element.scrollTop = 0; }); }
async function showPreview(page: Page) { const toggle = page.locator('.names-guided-viewbar').getByRole('button', { name: /^Preview ·/ }); if (await toggle.isVisible()) await toggle.click(); }
async function showControls(page: Page) { const toggle = page.locator('.names-guided-viewbar').getByRole('button', { name: 'Controls', exact: true }); if (await toggle.isVisible()) await toggle.click(); }

test("guided Names: four original layouts, live modes, native artwork and responsive geometry", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await open(page);
  await expect(page.locator(".names-word-chip")).toHaveCount(0);
  await expect(page.locator(".names-result-pill")).toHaveCount(0);
  await showPreview(page);
  await expect(page.getByRole("button", { name: "Copy all", exact: true })).toBeDisabled();
  await showControls(page);
  await words(page, sampleWords);
  await expect(page.locator(".names-word-chip")).toHaveCount(15);
  await expect(page.locator(".names-result-pill")).toHaveCount(15);
  for (const [mode, grid, height] of [["Affix", "affix", 1509], ["Tweaks", "tweaks", 1651], ["Blend", "blend", 1437], ["Swap", "swap", 1323]] as const) {
    if (info.project.name === "desktop") await page.setViewportSize({ width: 1440, height });
    await page.getByRole("tablist", { name: "Name transformations" }).getByRole("tab", { name: mode, exact: true }).click();
    await top(page);
    expect(await page.locator(".workspace-main").evaluate(element => getComputedStyle(element).backgroundImage)).toContain(`/names/${grid}-grid.svg`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const geometry = await page.locator(".names-words-panel").boundingBox();
    if (info.project.name === "desktop") {
      expect(geometry?.x).toBe(256); expect(geometry?.width).toBe(1008); expect(geometry!.height).toBeLessThanOrEqual(320);
      const controls = await page.locator('.names-guided-controls').boundingBox(), results = await page.locator('.names-guided-results').boundingBox();
      expect(results!.x).toBeGreaterThanOrEqual(controls!.x + controls!.width + 20);
      expect(Math.abs(results!.y - controls!.y)).toBeLessThanOrEqual(1);
      expect((await page.locator(".topbar").boundingBox())?.height).toBe(76);
      expect((await page.locator(".sidebar").boundingBox())?.width).toBe(80);
    }
    // Artwork may still be decoding right after a mode switch; poll for its native size.
    await expect.poll(() => page.locator('img[src^="/names/"]').evaluateAll(images => images.every(image => {
      const img = image as HTMLImageElement;
      return img.complete && img.naturalWidth === img.width && img.naturalHeight === img.height;
    }))).toBe(true);
    await page.screenshot({ path: info.outputPath(`names-${grid}.png`), fullPage: true });
    if (info.project.name === "mobile") {
      await page.locator(".names-guided-content").scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`names-${grid}-controls.png`), fullPage: true });
    }
  }
  await page.getByRole("tab", { name: "Tweaks", exact: true }).click();
  await showControls(page);
  await expect(page.locator(".names-tweak-card")).toHaveCount(10);
  await page.getByRole("button", { name: "Reverse", exact: true }).click();
  await showPreview(page);
  await expect(page.getByRole("button", { name: "Favorite result ecaf", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Affix", exact: true }).click();
  await showControls(page);
  await page.getByRole("button", { name: "prefix Neo", exact: true }).click();
  await showPreview(page);
  await expect(page.getByRole("button", { name: "Favorite result Ecafoen", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Swap", exact: true }).click();
  await showControls(page);
  await page.getByRole("button", { name: "Safe", exact: true }).click();
  const safe = await page.locator(".names-result-pill strong").allTextContents();
  await page.getByRole("button", { name: "Creative", exact: true }).click();
  const creative = await page.locator(".names-result-pill strong").allTextContents();
  expect(creative.length).toBeGreaterThanOrEqual(safe.length);
  expect(creative.every(value => !value.startsWith("Neo"))).toBe(true);
  expect((await snapshot(page)).candidates).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("guided Names: saved words, exact retained history, independent favorite and real clipboard", async ({ page }, info) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value: string) => { (window as unknown as { copied: string }).copied = value; } } }); });
  await open(page); await words(page, "Mikael");
  await page.getByRole("button", { name: "prefix Neo", exact: true }).click();
  await page.getByRole("button", { name: "suffix io", exact: true }).click();
  await expect(page.locator(".names-result-pill strong")).toHaveText(["NeoMikael", "Mikaelio"]);
  await showPreview(page);
  await page.getByRole("button", { name: "Copy all", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe("NeoMikael\nMikaelio");
  await page.getByRole("tab", { name: "Tweaks", exact: true }).click();
  await showControls(page);
  await page.getByRole("button", { name: "Double last", exact: true }).click();
  await page.getByRole("button", { name: "Reverse", exact: true }).click();
  await expect(page.locator(".names-transform-order > button .names-active-order")).toHaveText("Reverse → Double last");
  // The mixed-case input keeps its original case pattern; choose the actual first result.
  const value = await page.locator(".names-result-pill strong").first().innerText();
  const heart = page.getByRole("button", { name: `Favorite result ${value}`, exact: true });
  await showPreview(page);
  await heart.click(); await expect(heart).toHaveAttribute("aria-pressed", "true");
  const retained = await snapshot(page);
  const chosen = retained.candidates.find((candidate: { source: { value: string } }) => candidate.source.value === value);
  expect(chosen!.source.history.map((step: { input: { kind: string } }) => step.input.kind)).toEqual(["affixes", "swap", "swap"]);
  expect(chosen).toMatchObject({ favorite: true, saved: false });
  await page.getByRole("region", { name: "Words", exact: true }).getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("region", { name: "Words", exact: true }).getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator(".names-word-chip")).toHaveCount(0);
  await page.getByRole("tab", { name: "Saved", exact: true }).click();
  await expect(page.getByRole("region", { name: "Saved word lists" })).toContainText("Mikael");
  await page.getByRole("button", { name: "Use words", exact: true }).click();
  await showPreview(page);
  await expect(page.locator(".names-word-chip")).toHaveText("Mikael");
  await expect(heart).toHaveAttribute("aria-pressed", "true");
  await waitForNamesSaved(page); await page.reload(); await showPreview(page); await expect(heart).toHaveAttribute("aria-pressed", "true");
  await heart.click(); await expect(heart).toHaveAttribute("aria-pressed", "false");
  expect((await snapshot(page)).candidates).toHaveLength(retained.candidates.length);
  await heart.click();
  await page.getByRole("tab", { name: "Library", exact: true }).click();
  await expect(page.getByRole("article", { name: `Name: ${value}`, exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Retained transformations" })).toBeVisible();
  expect((await snapshot(page)).runs).toHaveLength(3);
  await page.screenshot({ path: info.outputPath("names-history.png"), fullPage: true });
});

test("guided Names: mode changes add pending words, original-word blends, bounded results and keyboard tabs", async ({ page }) => {
  await open(page);
  await page.getByRole("textbox", { name: "Add words", exact: true }).fill("smoke, fog");
  await page.getByRole("tab", { name: "Blend", exact: true }).click();
  await expect(page.locator(".names-word-chip")).toHaveCount(2);
  await showPreview(page);
  await expect(page.getByRole("button", { name: "Favorite result smog", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Blend", exact: true }).focus(); await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Swap", exact: true })).toBeFocused();
  await page.keyboard.press("Home"); await expect(page.getByRole("tab", { name: "Affix", exact: true })).toBeFocused();
  await page.getByRole("region", { name: "Words", exact: true }).getByRole("button", { name: "Clear", exact: true }).click();
  await words(page, Array.from({ length: 100 }, (_, i) => `word${i}`).join(","));
  await showControls(page);
  await page.getByRole("button", { name: "Select all prefixes", exact: true }).click();
  await expect(page.locator(".names-result-pill")).toHaveCount(300);
  await showPreview(page);
  await expect(page.getByText("This preview reached its limit.", { exact: false })).toBeVisible();
  expect((await snapshot(page)).candidates).toHaveLength(0);
});
