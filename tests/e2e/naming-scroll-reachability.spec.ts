import { expect, test, type Locator, type Page } from "@playwright/test";
import { frameBarrier, namingFixture, openNaming, showNamingNames } from "./naming-brain-fixture";

async function reachableWithComposer(page: Page, target: Locator, scrollArea: Locator) {
  await target.scrollIntoViewIfNeeded(); await frameBarrier(page);
  await target.click({ trial: true });
  const bounds = (await target.boundingBox())!, area = (await scrollArea.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(area.y - 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height + 1);
  expect(await target.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return hit === element || element.contains(hit);
  })).toBe(true);
}

test("Naming bottom composer leaves the last approach and Continue reachable", async ({ page }, info) => {
  const fixture = await namingFixture(page);
  await openNaming(page);
  const transcript = page.locator("[data-naming-chat-scroll]");
  const last = page.getByRole("group", { name: "Naming approaches", exact: true }).getByRole("button").last();
  await reachableWithComposer(page, last, transcript);
  await last.click(); await expect(last).toHaveAttribute("aria-pressed", "true");
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeEnabled();
  await reachableWithComposer(page, next, transcript);
  expect(fixture.mutations()).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("naming-last-approach-reachable.png"), scale: "css" });
});

test("Naming bottom composer leaves the last selected-name screening link reachable", async ({ page }, info) => {
  const fixture = await namingFixture(page, { saved: true, count: 100 });
  await openNaming(page); await showNamingNames(page);
  await page.getByRole("button", { name: "Inspect name Synthetic 001", exact: true }).click();
  await page.getByRole("button", { name: "Use this name", exact: true }).click();
  const screening = page.getByRole("region", { name: "Name screening", exact: true });
  await expect(screening).toContainText("Synthetic 001");
  const link = screening.getByRole("link", { name: "Open trademarks", exact: true });
  await reachableWithComposer(page, link, page.locator("[data-naming-results-scroll]"));
  await expect(link).toHaveAttribute("href", "/trademarks");
  expect(fixture.mutations()).toHaveLength(0);
  expect(fixture.state.currentSelection?.candidate.value).toBe("Synthetic 001");
  await page.screenshot({ path: info.outputPath("naming-last-screening-link-reachable.png"), scale: "css" });
});
