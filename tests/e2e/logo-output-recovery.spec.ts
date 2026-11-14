/** Current raster direction/asset screens with synthetic account and provider
 * responses. Font loading and local PNG/ZIP preparation use the real browser. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { expect, test, type Page } from "@playwright/test";
import { assetsUrl, createVisualJourneyFixture, directionsUrl } from "../fixtures/visual-identity-journey";

async function selectDirection(page: Page) {
  const fixture = createVisualJourneyFixture(),
    health = await fixture.setup(page);
  await page.goto(directionsUrl);
  await page.getByRole("button", { name: "Create three directions", exact: true }).click();
  await expect.poll(() => fixture.admissions.length).toBe(1);
  fixture.complete(1);
  await page.getByRole("button", { name: "Check progress", exact: true }).click();
  await page
    .getByRole("article", { name: /^Direction 1:/ })
    .getByRole("button", { name: "Choose", exact: true })
    .click();
  await expect(page.getByRole("link", { name: "Continue", exact: true })).toBeVisible();
  return { fixture, health };
}

for (const source of ["font", "logo"] as const) {
  test(`a temporary ${source} download failure retries asset preparation without generating again`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { fixture, health } = await selectDirection(page);
    let reads = 0;
    const path =
      source === "font"
        ? "/fonts/brand/lora-variable.ttf"
        : `/api/assets/${fixture.sourceLogo.preview.reference.versionId}/preview`;
    await page.route(`**${path}`, async (route) => {
      // The guidelines also show the chosen font on the page; only the kit's own read fails.
      if (route.request().resourceType() === "font") return route.fallback();
      reads++;
      if (reads === 1) return route.fulfill({ status: 503, json: {}, headers: { "cache-control": "no-store" } });
      return route.fallback();
    });
    await page.getByRole("link", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(assetsUrl);
    const panel = page.getByRole("region", { name: "Brand assets", exact: true });
    await expect(panel.getByRole("alert")).toContainText(/could not/u);
    await expect(panel.getByRole("img", { name: "Cedar final brand board", exact: true })).toHaveCount(0);
    expect(reads).toBe(1);
    const kit = panel.getByRole("button", { name: "Download brand kit", exact: true });
    await expect(kit).toBeEnabled();
    const received = page.waitForEvent("download", { timeout: 45_000 });
    await kit.click();
    const download = await received;
    expect(await download.failure()).toBeNull();
    const files = unzipSync(await readFile((await download.path())!));
    expect(createHash("sha256").update(files["direction/selected-direction.png"]!).digest("hex")).toBe(
      fixture.systems[0]!.board.asset.contentHash,
    );
    expect(Buffer.from(files["logo/logo-original.png"]!)).toEqual(fixture.logoBytes);
    expect(reads).toBe(2);
    expect(fixture.admissions).toHaveLength(1);
    expect(fixture.selections).toHaveLength(1);
    expect(health.pageErrors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
