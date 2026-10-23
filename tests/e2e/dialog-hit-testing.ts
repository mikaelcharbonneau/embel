import { expect, type Locator, type Page } from "@playwright/test";

/** Real native-dialog hit testing. No forced clicks or synthetic dispatch. */
export async function checkDialogHitTesting(page: Page, trigger: Locator, dialog: Locator, closeLabel: string) {
  await trigger.click(); await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!, viewport = page.viewportSize()!;
  await page.mouse.click(box.x + 2, box.y + 2);
  await expect(dialog).toBeVisible();
  const outside = box.x >= 4 ? { x: box.x - 2, y: box.y + 10 }
    : box.x + box.width + 4 < viewport.width ? { x: box.x + box.width + 2, y: box.y + 10 }
    : { x: box.x + 10, y: box.y + box.height + 2 };
  expect(outside.x).toBeGreaterThanOrEqual(0); expect(outside.x).toBeLessThan(viewport.width);
  expect(outside.y).toBeGreaterThanOrEqual(0); expect(outside.y).toBeLessThan(viewport.height);
  await page.mouse.click(outside.x, outside.y); await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter"); await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused();
  await trigger.click(); await dialog.getByRole("button", { name: closeLabel, exact: true }).click();
  await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused();
}
