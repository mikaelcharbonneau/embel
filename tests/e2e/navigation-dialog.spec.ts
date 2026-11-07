import { expect, test } from "@playwright/test";

// The floating navigation replaced the narrow-screen navigation dialog. Every
// destination stays in the pill, and the Tools menu must fit and close cleanly.
test("narrow navigation keeps every destination in the pill and the Tools menu on screen", async ({ page }) => {
  const writes: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", route => { if (route.request().method() !== "GET") writes.push(route.request().method()); return route.fulfill({ status: 401, json: { error: { code: "unauthenticated" } } }); });
  await page.goto("/ideas");
  const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
  for (const name of ["Home", "Projects", "Library"]) await expect(navigation.getByRole("link", { name, exact: true })).toBeVisible();
  const tools = navigation.locator("summary");
  await expect(tools).toHaveAttribute("aria-current", "page");
  await tools.click();
  const menu = navigation.locator("details[open] ul");
  await expect(menu.getByRole("link", { name: "Trademarks", exact: true })).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0); await expect(tools).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(writes).toEqual([]);
});
