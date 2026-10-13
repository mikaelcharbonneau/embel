import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { LocalDraft } from "../../src/components/workspace/local-drafts";

const description = "A neighborhood lunch counter with seasonal meals for people working nearby.";
const storageKey = "fluid.local-drafts.v1";
async function readDraft(page: Page): Promise<LocalDraft> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!).drafts[0], storageKey); }
async function rename(page: Page, title: string) {
  await page.getByRole("button", { name: "Rename project", exact: true }).click();
  await page.getByRole("textbox", { name: "Project label", exact: true }).fill(title);
  await page.getByRole("textbox", { name: "Project label", exact: true }).press("Enter");
}
async function createDraft(page: Page, scope = "naming_only") {
  await page.goto(`/brands/new?scope=${scope}`);
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(description);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Competitors", exact: true })).toBeVisible();
  await rename(page, "Lunch fixture");
}
async function capture(page: Page, info: TestInfo, filename: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const width = page.viewportSize()!.width;
  await expect.poll(() => page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(width);
  const image = await page.screenshot({ path: info.outputPath(filename), fullPage: true, scale: "css", style: "nextjs-portal { visibility: hidden; }" });
  expect(image.readUInt32BE(16)).toBe(width);
}

test("examples fill the prompt and start a real conversation without fabricated AI content", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Write a prompt");
  await page.getByRole("button", { name: /Local food/ }).click();
  await expect(page.getByRole("textbox", { name: "Your prompt", exact: true })).toHaveValue(/^A neighborhood lunch counter/);
  await expect(page.getByText("Example prompt · editable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Competitors", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Activity/ })).toHaveCount(0);
  await expect(page.getByText("Example prompt", { exact: true })).toBeVisible();
  expect((await readDraft(page)).activity).toBe("");
  expect((await readDraft(page)).offering).toBe("");
  expect((await readDraft(page)).conversation?.filter(event => event.kind === "user_message")).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("three stored browser drafts retain their scopes and follow-up context after reopening", async ({ page }) => {
  // Seed the existing version-one format, including user content that still says Fluid.
  // Home now starts an account flow; these drafts must remain usable independently.
  const now = "2026-10-12T10:00:00.000Z";
  const briefs = [
    { title: "Fluid studio", scope: "complete_brand" as const, description: "A subscription tool for small property teams." },
    { title: "Lunch fixture", scope: "naming_only" as const, description: "A neighborhood lunch counter." },
    { title: "Culture fixture", scope: "visual_identity_only" as const, description: "A public cultural program." },
  ];
  const drafts: LocalDraft[] = briefs.map((brief, index) => ({ ...brief,
    id: `aaaaaaaa-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    activity: "", offering: "", knownAudience: "", suppliedName: "", namingNotes: "", identityNotes: "",
    segments: [], stage: "competitors", audienceReviewedAt: null, createdAt: now, updatedAt: now, example: true,
    conversation: [{ id: `message-${index}`, kind: "user_message", text: brief.description, createdAt: now },
      { id: `widget-${index}`, kind: "widget", widget: "competitors", createdAt: now }],
  }));
  await page.route("**/api/**", route => route.fulfill({ status: 401, json: { error: { code: "unauthenticated" } } }));
  await page.addInitScript(({ storageKey, drafts }) => {
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify({ version: 1, drafts }));
  }, { storageKey, drafts });
  for (const draft of drafts) {
    await page.goto(`/brands/${draft.id}`);
    await expect(page).toHaveTitle("Brand draft · Embel");
    const composer = page.getByRole("textbox", { name: "Message Embel", exact: true });
    await expect(composer).toBeVisible();
    const followup = `Keep the saved context for ${draft.title}.`;
    await composer.fill(followup);
    await page.getByRole("button", { name: "Save message", exact: true }).click();
    await expect(composer).toBeEmpty();
    await page.reload();
    await expect(composer).toBeVisible();
    const saved = await page.evaluate(({ storageKey, id }) => JSON.parse(localStorage.getItem(storageKey)!).drafts.find((value: LocalDraft) => value.id === id) as LocalDraft, { storageKey, id: draft.id });
    expect(saved).toMatchObject({ title: draft.title, scope: draft.scope, description: draft.description, activity: "" });
    expect(saved.conversation?.at(-1)).toMatchObject({ kind: "user_message", text: followup });
  }
  await page.goto("/brands");
  await expect(page.locator('.project-card[data-storage="browser"]')).toHaveCount(3);
  for (const draft of drafts) await expect(page.getByRole("heading", { name: draft.title, exact: true })).toBeVisible();
});

test("a scoped conversation preserves selected audiences through reload, expansion and a follow-up", async ({ page }, info) => {
  await createDraft(page);
  await page.getByRole("checkbox", { name: "I have no relevant competitors to retain" }).check();
  await page.getByRole("button", { name: "Keep competitors", exact: true }).click();
  await page.getByRole("button", { name: "Keep audience", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Choose at least one target audience");
  await page.getByRole("button", { name: "Add audience", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Audience name", exact: true })).toBeFocused();
  await page.getByRole("textbox", { name: "Audience name", exact: true }).fill("People within walking distance");
  await page.getByRole("textbox", { name: "What do they need?" }).fill("A fresh, reliable lunch without a long wait.");
  await page.getByRole("textbox", { name: "Why are they a fit?" }).fill("The short menu and nearby location fit their workday.");
  await page.getByRole("checkbox", { name: "Select as target" }).check();
  await page.getByRole("button", { name: "Keep audience", exact: true }).click();
  await expect(page.getByRole("region", { name: "Audience", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
  await capture(page, info, "audience-conversation.png");
  await page.reload();
  await page.getByRole("button", { name: "Edit audience", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Selected target" })).toBeChecked();
  await page.getByRole("button", { name: "Expand to complete brand", exact: true }).click();
  expect((await readDraft(page)).scope).toBe("complete_brand");
  expect((await readDraft(page)).description).toBe(description);
  await page.getByRole("textbox", { name: "Message Embel", exact: true }).fill("Also consider afternoon takeaway meals.");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByRole("region", { name: "Audience", exact: true }).getByText("Confirmed", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit audience", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Selected target" })).toBeChecked();
  await page.getByRole("button", { name: "Add another audience" }).click();
  await expect(page.getByRole("textbox", { name: "Audience name" }).nth(1)).toBeFocused();
  await page.getByRole("button", { name: "Remove audience 2", exact: true }).click();
  await page.getByRole("button", { name: "Keep it", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Audience name" })).toHaveCount(2);
  await page.getByRole("button", { name: "Remove audience 2", exact: true }).click();
  await page.getByRole("button", { name: "Remove audience", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Audience name" })).toHaveCount(1);
  await capture(page, info, "audience-edited.png");
});

test("storage failure is visible and never claims a persistent save", async ({ context, page }) => {
  await context.addInitScript(() => { Object.defineProperty(Storage.prototype, "setItem", { value() { throw new DOMException("Unavailable", "QuotaExceededError"); } }); });
  await createDraft(page);
  await expect(page.getByRole("alert").filter({ hasText: "Browser storage is unavailable" })).toBeVisible();
  await expect(page.getByText("Saved in this browser", { exact: true })).toHaveCount(0);
  await expect(page.getByText("This tab only", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message Embel", exact: true }).fill("Keep this in-tab follow-up");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByText("Keep this in-tab follow-up", { exact: true })).toBeVisible();
});

test("invalid saved data is rejected with a recovery path", async ({ context, page }) => {
  await context.addInitScript(() => { localStorage.setItem("fluid.local-drafts.v1", "{not-valid-json"); });
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Saved drafts could not be read" })).toBeVisible();
  await page.getByRole("button", { name: "Clear drafts", exact: true }).click();
  await page.getByRole("button", { name: "Delete all drafts", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Local drafts cleared." })).toHaveText("Local drafts cleared.");
  await expect(page.getByRole("alert").filter({ hasText: "Saved drafts could not be read" })).toHaveCount(0);
});

test("keyboard navigation, mobile menu, and unavailable tools are usable", async ({ page, isMobile }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  if (isMobile) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Navigation" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
  }
  expect(await page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.goto("/ideas");
  await expect(page.getByRole("heading", { name: "Ideas", exact: true })).toBeVisible();
  await expect(page.locator("main .account-notice")).toContainText(/No verified account session|Account saving is unavailable/);
  await expect(page.getByRole("region", { name: "Capture an idea" })).toHaveCount(0);
  await page.goto("/handles");
  await expect(page.getByRole("heading", { name: "Handles", exact: true })).toBeVisible();
  await expect(page.getByText("Checks not connected", { exact: true })).toBeVisible();
  await expect(page.getByText("This tab only. Reopening this page starts a new workspace.", { exact: true })).toBeVisible();
  await page.goto("/domains");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Domain library unavailable", exact: true })).toBeVisible();
  await page.goto("/trademarks");
  await expect(page.getByRole("heading", { name: "Check your name for trademarks", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Search", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goto("/assets");
  await expect(page.locator("main").getByRole("heading", { name: "Assets", exact: true })).toBeVisible();
  await expect(page.locator("main .account-notice")).toContainText(/No verified account session|Account saving is unavailable/);
  await expect(page.getByRole("region", { name: "Account asset library" })).toHaveCount(0);
  await page.goto("/brands/does-not-exist");
  await expect(page.getByRole("heading", { name: "Draft not found in this browser" })).toBeVisible();
});
