import { expect, test } from "@playwright/test";
import { checkDialogHitTesting } from "./dialog-hit-testing";

test("dialog hit testing: narrow navigation protects padding and restores focus", async ({ page }) => {
  const writes: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", route => { if (route.request().method() !== "GET") writes.push(route.request().method()); return route.fulfill({ status: 401, json: { error: { code: "unauthenticated" } } }); });
  await page.goto("/ideas");
  await checkDialogHitTesting(page, page.getByRole("button", { name: "Open navigation", exact: true }), page.getByRole("dialog", { name: "Navigation", exact: true }), "Close navigation");
  expect(writes).toEqual([]);
});
