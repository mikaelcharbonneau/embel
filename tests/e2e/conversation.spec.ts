import { expect, test, type Page } from "@playwright/test";
import type { LocalDraft } from "../../src/components/workspace/local-drafts";

// Dedicated browser fixtures only; no provider, hosted account or paid request is made.
// D065 (96ef9f1) retired the signed-out browser conversation: Home accepts the first prompt,
// keeps it on this device and asks for sign-in; the conversation continues in the account
// Strategy interview (see guided-interview.spec.ts).
const key = "fluid.local-drafts.v1";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "Synthetic anonymous fixture" }),
    }),
  );
});

async function readDraft(page: Page): Promise<LocalDraft> {
  return page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)!).drafts[0], key);
}

test("composer supports multiline text and IME composition without premature submission", async ({ page }) => {
  await page.goto("/brands/new");
  const initial = page.getByRole("textbox", { name: "Your prompt", exact: true });
  const signIn = page.getByRole("dialog", { name: "Sign in to Embel", exact: true });
  await initial.fill("First line");
  await initial.press("Shift+Enter");
  await initial.pressSequentially("Second line");
  await expect(initial).toHaveValue("First line\nSecond line");
  await initial.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true });
  await expect(page).toHaveURL(/\/brands\/new$/);
  await expect(signIn).toHaveCount(0);
  expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), key)).toBeNull();
  await initial.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, bubbles: true });
  await expect(page).toHaveURL(/\/brands\/new$/);
  await expect(signIn).toHaveCount(0);
  expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), key)).toBeNull();
  await initial.press("Enter");
  await expect(signIn).toBeVisible();
  await expect(signIn.getByText("Your prompt is kept while you sign in.", { exact: false })).toBeVisible();
  expect((await readDraft(page)).conversation?.filter((event) => event.kind === "user_message")).toMatchObject([
    { text: "First line\nSecond line" },
  ]);
});
