import { expect, type Page } from "@playwright/test";

export function watchNormalAppErrors(page: Page) {
  const pageErrors: string[] = [],
    consoleErrors: string[] = [],
    expectedNetworkErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // These fixtures deliberately deny private/missing services and test a
    // revoked blob URL. They must not hide other application/runtime errors.
    if (
      /^Failed to load resource: (?:the server responded with a status of (?:403|404|503)\b|net::ERR_FILE_NOT_FOUND)/u.test(
        text,
      )
    )
      expectedNetworkErrors.push(text);
    else consoleErrors.push(text);
  });
  return { pageErrors, consoleErrors, expectedNetworkErrors };
}

/** The round account button in the navigation pill. */
export const accountMenuButton = (page: Page) => page.locator("[data-account-menu-trigger]");

/** The account menu next to that button. Its rows exist only while it is open. */
export const accountMenu = (page: Page) => page.locator('[data-account-menu-trigger] + [role="menu"]');

export async function openAccountMenu(page: Page) {
  const button = accountMenuButton(page);
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
}

export async function closeAccountMenu(page: Page) {
  const button = accountMenuButton(page);
  if ((await button.count()) && (await button.getAttribute("aria-expanded")) === "true") await button.click();
}

/** Normal app account verification, rather than a component-preview control. */
export async function checkNormalAccount(page: Page) {
  await openAccountMenu(page);
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/session" && response.request().method() === "GET",
  );
  // Choosing the row closes the menu.
  await accountMenu(page).getByRole("menuitem", { name: "Check account", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(accountMenuButton(page)).toHaveAttribute("aria-expanded", "false");
}
