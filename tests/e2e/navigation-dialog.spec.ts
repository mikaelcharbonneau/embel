import { expect, test } from "@playwright/test";

// The floating navigation replaced the narrow-screen navigation dialog. Every
// destination stays in the pill, and it fits a narrow screen.
test("narrow navigation keeps every destination in the pill", async ({ page }) => {
  const writes: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", route => { if (route.request().method() !== "GET") writes.push(route.request().method()); return route.fulfill({ status: 401, json: { error: { code: "unauthenticated" } } }); });
  await page.goto("/assets");
  const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
  for (const name of ["Home", "Projects", "Library"]) await expect(navigation.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(navigation.locator("summary")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(writes).toEqual([]);
});
