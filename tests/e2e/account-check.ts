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

/** Normal app account verification, rather than a component-preview control. */
export async function checkNormalAccount(page: Page) {
  const menu = page.locator(".workspace-account-menu");
  if ((await menu.getAttribute("open")) === null) await menu.locator("summary").click();
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/session" && response.request().method() === "GET",
  );
  await menu.getByRole("button", { name: "Check account", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(menu.getByRole("button", { name: "Check account", exact: true })).toBeEnabled();
  if ((await menu.getAttribute("open")) !== null) await menu.locator("summary").click();
}
