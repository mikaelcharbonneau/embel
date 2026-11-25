import { test, expect, type Locator, type Page } from "@playwright/test";

// Synthetic same-origin responses only: no provider is ever contacted and no account is created.
// Which providers are offered is decided on the server (the real Supabase project's enabled providers), which the
// browser cannot intercept. So every test passes both ways: with no provider enabled it checks that nothing of
// the row is drawn, and with some enabled it checks the row that is there.
const names = ["Google", "Apple", "ChatGPT"] as const;
const paths: Record<(typeof names)[number], string> = {
  Google: "/api/auth/oauth/google",
  Apple: "/api/auth/oauth/apple",
  ChatGPT: "/api/auth/oauth/chatgpt",
};

/** Signed out, with the provider post answered by a stand-in page instead of a redirect to a provider. */
async function signedOut(page: Page) {
  const posts: { path: string; method: string; body: string }[] = [];
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unauthenticated" } }),
    }),
  );
  await page.route("**/api/auth/oauth/**", (route) => {
    const request = route.request();
    posts.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postData() ?? "" });
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Provider stand-in</title><h1>Provider stand-in</h1>",
    });
  });
  return posts;
}

/** The provider buttons drawn inside `scope`, in order. Empty when the server reports none. */
async function offered(scope: Locator) {
  // The email form is server-rendered with the row, so once Email is there the row is too, if any.
  await expect(scope.getByLabel("Email", { exact: true })).toBeVisible();
  const found: { name: (typeof names)[number]; button: Locator }[] = [];
  for (const name of names) {
    const button = scope.getByRole("button", { name: `Continue with ${name}`, exact: true });
    if ((await button.count()) > 0) found.push({ name, button });
  }
  return found;
}

const providerTerms = "By continuing with a provider, you agree to the Terms of Service and Privacy Policy.";
/** Sign-in only: a first-time person who continues with a provider creates an account, so the terms are named. */
async function expectProviderTerms(scope: Locator) {
  const terms = scope.locator(".auth-card__terms");
  await expect(terms).toHaveText(providerTerms);
  for (const [name, href] of [
    ["Terms of Service", "/terms"],
    ["Privacy Policy", "/privacy"],
  ] as const) {
    const link = terms.getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
  }
}

async function expectNoRow(scope: Locator) {
  await expect(scope.getByText(providerTerms, { exact: true })).toHaveCount(0);
  await expect(scope.getByText("or continue with email", { exact: true })).toHaveCount(0);
  await expect(scope.getByRole("button", { name: /^Continue with / })).toHaveCount(0);
}

/** Every button is a 44 px target, they share one row evenly (or stack), and nothing is clipped or overflows. */
async function expectRowFits(page: Page, scope: Locator, buttons: Locator[]) {
  await expect(scope.getByText("or continue with email", { exact: true })).toBeVisible();
  const boxes: { x: number; y: number; width: number; height: number }[] = [];
  for (const button of buttons) {
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(Math.round(box.height)).toBe(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(button.locator("svg")).toHaveAttribute("aria-hidden", "true");
    boxes.push(box);
  }
  const widths = boxes.map((box) => Math.round(box.width));
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  const sideBySide = boxes.every((box) => Math.abs(box.y - boxes[0]!.y) < 1);
  const stacked = boxes.every((box) => Math.abs(box.x - boxes[0]!.x) < 1);
  expect(sideBySide || stacked).toBe(true);
  for (let i = 1; i < boxes.length; i++) {
    if (sideBySide) expect(boxes[i]!.x).toBeGreaterThanOrEqual(boxes[i - 1]!.x + boxes[i - 1]!.width);
    else expect(boxes[i]!.y).toBeGreaterThanOrEqual(boxes[i - 1]!.y + boxes[i - 1]!.height);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
}

test("auth providers: the sign-in page offers only enabled providers and posts the pressed one once", async ({
  page,
}, testInfo) => {
  const posts = await signedOut(page);
  await page.goto("/sign-in");
  const card = page.locator(".auth-card");
  await expect(card.getByRole("heading", { name: "Sign in to Embel" })).toBeVisible();
  const found = await offered(card);
  if (found.length === 0) {
    await expectNoRow(card);
    expect(posts).toEqual([]);
    return;
  }
  for (const { name, button } of found) {
    await expect(button).toHaveText(name);
    await expect(button).toHaveAttribute("translate", "no");
    // Disabled only while the session is being checked.
    await expect(button).toBeEnabled();
  }
  await expectRowFits(
    page,
    card,
    found.map(({ button }) => button),
  );
  await expectProviderTerms(card);
  // The row sits above the email form, each button in a form of its own.
  expect(
    await card.evaluate((element) => {
      const row = element.querySelector(".auth-providers");
      const email = element.querySelector('form[aria-label="Sign in"]');
      return Boolean(
        row &&
        email &&
        row.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING &&
        !row.closest("form") &&
        !row.querySelector("form form"),
      );
    }),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("sign-in-providers.png"), scale: "css" });

  const { name, button } = found[0]!;
  await card.getByLabel("Password", { exact: true }).fill("inert provider fixture");
  await button.click();
  await expect(page.getByRole("heading", { name: "Provider stand-in" })).toBeVisible();
  expect(posts).toEqual([{ path: paths[name], method: "POST", body: "next=%2Fbrands" }]);
  // The browser stayed on this origin: the stand-in answered in place of the redirect to the provider.
  expect(new URL(page.url()).pathname).toBe(paths[name]);
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(storage).not.toContain("inert provider fixture");
});

test("auth providers: account creation offers the same providers with the terms line", async ({ page }) => {
  await signedOut(page);
  await page.goto("/sign-up");
  const card = page.locator(".auth-card");
  await expect(card.getByRole("heading", { name: "Create your Embel account" })).toBeVisible();
  const found = await offered(card);
  if (found.length === 0) await expectNoRow(card);
  else
    await expectRowFits(
      page,
      card,
      found.map(({ button }) => button),
    );
  await expect(card.locator(".auth-card__terms")).toHaveText(
    "By creating an account, you agree to the Terms of Service and Privacy Policy.",
  );
});

test("auth providers: in the overlay the row keeps focus in Email, the Tab trap and a 320 px phone", async ({
  page,
}, testInfo) => {
  const posts = await signedOut(page);
  await page.goto("/settings");
  await page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Welcome back", exact: true });
  await expect(dialog).toBeVisible();
  const found = await offered(dialog);
  if (found.length === 0) {
    await expectNoRow(dialog);
    return;
  }
  const buttons = found.map(({ button }) => button);
  for (const button of buttons) await expect(button).toBeEnabled();
  await expectProviderTerms(dialog);
  await expect(dialog.getByRole("link", { name: "Create account", exact: true })).toHaveAttribute("href", "/sign-up");
  // The provider forms hold only hidden fields, so first focus is still Email, not a provider button.
  await expect(dialog.getByLabel("Email", { exact: true })).toBeFocused();
  // Close, then the providers in order, then Email: Shift+Tab from Email reaches the last provider.
  await page.keyboard.press("Shift+Tab");
  await expect(buttons.at(-1)!).toBeFocused();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await expectRowFits(page, dialog, buttons);
  await page.screenshot({ path: testInfo.outputPath("overlay-providers.png"), scale: "css" });

  await page.setViewportSize({ width: 320, height: 640 });
  await expectRowFits(page, dialog, buttons);
  for (const button of buttons) {
    const box = (await button.boundingBox())!;
    const sheet = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(sheet.x);
    expect(box.x + box.width).toBeLessThanOrEqual(sheet.x + sheet.width);
  }
  await page.screenshot({ path: testInfo.outputPath("overlay-providers-320.png"), scale: "css" });
  expect(posts).toEqual([]);
});

test("auth providers: a failed provider sign-in is explained and email sign-in stays usable", async ({ page }) => {
  await signedOut(page);
  await page.goto("/sign-in?provider=failed");
  const card = page.locator(".auth-card");
  await expect(card.getByRole("alert")).toHaveText(
    "We couldn’t sign you in with that provider. Try again, or use your email and password.",
  );
  await expect(card.getByLabel("Email", { exact: true })).toBeVisible();
  for (const { button } of await offered(card)) await expect(button).toBeEnabled();
  // Only the exact value shows the message.
  await page.goto("/sign-in?provider=other");
  await expect(card.getByRole("heading", { name: "Sign in to Embel" })).toBeVisible();
  await expect(card.getByText("We couldn’t sign you in with that provider.")).toHaveCount(0);
});
