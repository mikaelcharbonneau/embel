/** Current raster direction/asset screens with synthetic account and provider
 * responses. Font loading and local PNG/ZIP preparation use the real browser. */
import { expect, test, type Page } from "@playwright/test";
import { assetsUrl, createVisualJourneyFixture, directionsUrl } from "../fixtures/visual-identity-journey";

async function selectedAssets(page: Page) {
  const fixture = createVisualJourneyFixture(), health = await fixture.setup(page);
  await page.goto(directionsUrl);
  await page.getByRole("button", { name: "Generate three directions", exact: true }).click();
  await expect.poll(() => fixture.admissions.length).toBe(1);
  fixture.complete(1);
  await page.getByRole("button", { name: "Check progress", exact: true }).click();
  await page.getByRole("button", { name: "Choose direction", exact: true }).click();
  await page.getByRole("link", { name: "Continue to brand assets", exact: true }).click();
  await expect(page).toHaveURL(assetsUrl);
  return { fixture, health };
}

for (const source of ["font", "logo"] as const) {
  test(`a temporary ${source} download failure retries asset preparation without generating again`, async ({ page }) => {
    test.setTimeout(90_000);
    const { fixture, health } = await selectedAssets(page);
    let reads = 0;
    const path = source === "font" ? "/fonts/brand/lora-variable.ttf"
      : `/api/assets/${fixture.sourceLogo.preview.reference.versionId}/preview`;
    await page.route(`**${path}`, async route => {
      reads++;
      if (reads === 1) return route.fulfill({ status: 503, json: {}, headers: { "cache-control": "no-store" } });
      return route.fallback();
    });
    const create = page.getByRole("button", { name: "Create brand assets", exact: true });
    await create.click();
    await expect(page.getByRole("region", { name: "Brand assets", exact: true }).getByRole("alert")).toContainText(/could not/u);
    await expect(create).toBeEnabled();
    await expect(page.getByRole("button", { name: "Download everything", exact: true })).toHaveCount(0);
    await create.click();
    await expect(page.getByText("Your brand assets are ready.", { exact: true })).toBeVisible({ timeout: 45_000 });
    expect(reads).toBe(2);
    expect(fixture.admissions).toHaveLength(1); expect(fixture.selections).toHaveLength(1);
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download everything", exact: true }).click();
    expect(await (await downloaded).failure()).toBeNull();
    expect(health.pageErrors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
