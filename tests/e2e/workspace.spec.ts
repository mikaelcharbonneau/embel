import { expect, test, type Page } from "@playwright/test";
import type { LocalDraft } from "../../src/components/workspace/local-drafts";

const description = "A neighborhood lunch counter with seasonal meals for people working nearby.";
const storageKey = "fluid.local-drafts.v1";
async function readDraft(page: Page): Promise<LocalDraft> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).drafts[0], storageKey);
}
const ownerId = "aaaaaaaa-2222-4222-8222-222222222222";

// Synthetic anonymous APIs only; no hosted account, provider or paid request is reached.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 401, json: { error: { code: "unauthenticated" } } }),
  );
});

// D065 (96ef9f1): Home accepts a prompt before sign-in, but a conversation starts only in a
// verified account. Signed out, Send keeps the prompt on this device and opens sign-in.
async function expectSignInKeepsPrompt(page: Page) {
  const signIn = page.getByRole("dialog", { name: "Sign in to Embel", exact: true });
  await expect(signIn).toBeVisible();
  await expect(
    signIn.getByText("Your idea is kept. It will be waiting when you're signed in.", { exact: false }),
  ).toBeVisible();
}

test("examples fill the prompt and keep it for sign-in without fabricated AI content", async ({ page }) => {
  const errors: string[] = [],
    writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET") writes.push(request.url());
  });
  await page.goto("/");
  const prompt = page.getByRole("textbox", { name: "Your prompt", exact: true });
  await page.getByRole("button", { name: "A neighborhood coffee shop", exact: true }).click();
  await expect(prompt).toHaveValue(/^A neighborhood coffee shop serving/);
  await expect(page.getByText("Example prompt · editable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expectSignInKeepsPrompt(page);
  const draft = await readDraft(page);
  expect(draft.description).toMatch(/^A neighborhood coffee shop serving/);
  expect(draft.example).toBe(true);
  expect(draft.activity).toBe("");
  expect(draft.offering).toBe("");
  // Only the user's own prompt is kept as a message; no AI request was made for a reply.
  expect(draft.conversation?.filter((event) => event.kind === "user_message")).toMatchObject([
    { text: draft.description },
  ]);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("storage failure is visible and never claims the prompt was kept", async ({ context, page }) => {
  await context.addInitScript(() => {
    Object.defineProperty(Storage.prototype, "setItem", {
      value() {
        throw new DOMException("Unavailable", "QuotaExceededError");
      },
    });
  });
  await page.goto("/");
  const prompt = page.getByRole("textbox", { name: "Your prompt", exact: true });
  await prompt.fill(description);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText(
    "Your prompt could not be kept. Copy it before leaving to sign in.",
  );
  await expect(page.getByRole("dialog", { name: "Sign in to Embel", exact: true })).toHaveCount(0);
  await expect(prompt).toHaveValue(description);
});

test("invalid saved data is rejected without replacing it", async ({ context, page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ status: 405, json: { error: "Read-only fixture" } });
    if (path === "/api/session") return route.fulfill({ json: { user: { id: ownerId } } });
    if (path === "/api/projects/page") return route.fulfill({ json: { ownerId, items: [], nextCursor: null } });
    return route.fulfill({ status: 503, json: { error: "Unconfigured synthetic read" } });
  });
  await context.addInitScript((key) => {
    localStorage.setItem(key, "{not-valid-json");
  }, storageKey);
  await page.goto("/brands");
  await expect(
    page.getByText("Recovery data on this device could not be read. Your account projects remain available.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe("{not-valid-json");
});

test("keyboard navigation and signed-out pages are usable", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  expect(await page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.goto("/assets");
  await expect(page.getByRole("heading", { level: 1, name: "Library", exact: true })).toBeVisible();
  await expect(page.locator("main .account-notice")).toContainText(
    /No verified account session|Account saving is unavailable/,
  );
  await expect(page.getByRole("region", { name: "Account asset library" })).toHaveCount(0);
  await page.goto("/brands/does-not-exist");
  // Unknown device drafts open recovery, which reveals nothing until an account is verified (96ef9f1).
  await expect(page.getByRole("heading", { level: 1, name: "Recover an unsaved project", exact: true })).toBeVisible();
  await expect(page.locator("main .account-notice")).toContainText("No verified account session");
});
