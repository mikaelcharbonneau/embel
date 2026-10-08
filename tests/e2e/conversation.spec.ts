import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { LocalDraft } from "../../src/components/workspace/local-drafts";

// Dedicated browser fixtures only; no provider, hosted account or paid request is made.
const key = "fluid.local-drafts.v1";
const id = "77777777-7777-4777-8777-777777777777";
const now = "2026-10-03T12:00:00Z";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Synthetic anonymous fixture" }) }));
});

async function readDraft(page: Page): Promise<LocalDraft> { return page.evaluate(storageKey => JSON.parse(localStorage.getItem(storageKey)!).drafts[0], key); }
async function start(page: Page, prompt = "A") {
  await page.goto("/brands/new");
  await page.getByRole("textbox", { name: "Your prompt", exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Competitors", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Fluid", exact: true })).toBeVisible();
}
async function send(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: "Message Fluid", exact: true });
  await composer.fill(text);
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(composer).toBeEmpty();
}
async function capture(page: Page, info: TestInfo, filename: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const width = page.viewportSize()!.width;
  await expect.poll(() => page.evaluate(() => Math.max(innerWidth, document.documentElement.scrollWidth))).toBeLessThanOrEqual(width);
  const image = await page.screenshot({ path: info.outputPath(filename), fullPage: true, scale: "css", style: "nextjs-portal { visibility: hidden; }" });
  expect(image.readUInt32BE(16)).toBe(width);
}

test("Send creates a real user prompt and inline competitors with no required brief wizard", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await start(page);
  await expect(page.getByRole("navigation", { name: "Project intake steps" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review brief", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /^Activity/ })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: /^Offering/ })).toHaveCount(0);
  const saved = await readDraft(page);
  expect(saved.description).toBe("A");
  expect(saved.activity).toBe("");
  expect(saved.offering).toBe("");
  expect(saved.conversation?.map(event => event.kind)).toEqual(["user_message", "widget"]);
  expect(saved.conversation?.[0]).toMatchObject({ text: "A" });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Competitors", exact: true })).toBeVisible();
  expect((await readDraft(page)).conversation).toEqual(saved.conversation);
  await capture(page, info, "conversation-first-prompt.png");
  expect(errors).toEqual([]);
});

test("composer supports multiline text and IME composition without premature submission", async ({ page }) => {
  await page.goto("/brands/new");
  const initial = page.getByRole("textbox", { name: "Your prompt", exact: true });
  await initial.fill("First line");
  await initial.press("Shift+Enter");
  await initial.pressSequentially("Second line");
  await expect(initial).toHaveValue("First line\nSecond line");
  await initial.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true });
  await expect(page).toHaveURL(/\/brands\/new$/);
  expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBeNull();
  await initial.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, bubbles: true });
  await expect(page).toHaveURL(/\/brands\/new$/);
  await initial.press("Enter");
  await expect(page.getByRole("textbox", { name: "Message Fluid", exact: true })).toBeVisible();
  expect((await readDraft(page)).conversation?.[0]).toMatchObject({ text: "First line\nSecond line" });
  const followup = page.getByRole("textbox", { name: "Message Fluid", exact: true });
  await followup.fill("追加入力");
  await followup.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  await expect(followup).toHaveValue("追加入力");
  expect((await readDraft(page)).conversation?.filter(event => event.kind === "user_message")).toHaveLength(1);
  await followup.press("Enter");
  await expect(followup).toBeEmpty();
  expect((await readDraft(page)).conversation?.filter(event => event.kind === "user_message")).toHaveLength(2);
});

test("keyboard-focused widget controls stay visible above the conversation composer", async ({ page }, info) => {
  await start(page, "A repair workshop for local residents.");
  await page.getByRole("button", { name: "Collapse competitors", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Add competitor", exact: true })).toBeFocused();
  const unobscured = await page.evaluate(() => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return false;
    const rect = focused.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && (hit === focused || focused.contains(hit)));
  });
  await page.screenshot({ path: info.outputPath("conversation-keyboard-focus.png"), scale: "css", style: "nextjs-portal { visibility: hidden; }" });
  expect(unobscured).toBe(true);
});

test("blank and capacity-rejected messages stay editable and never appear as accepted history", async ({ page }) => {
  await start(page, "A maker space");
  const composer = page.getByRole("textbox", { name: "Message Fluid", exact: true });
  await composer.fill(" \n ");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(composer).toHaveValue(" \n ");
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  expect((await readDraft(page)).conversation).toHaveLength(2);
  const full = await readDraft(page);
  full.conversation = Array.from({ length: 64 }, (_, index) => ({ id: `full-${index}`, kind: "user_message", text: `Earlier prompt ${index}`, createdAt: now }));
  await page.evaluate(({ key, full }) => localStorage.setItem(key, JSON.stringify({ version: 1, drafts: [full] })), { key, full });
  await page.reload();
  await composer.fill("Keep this unsent follow-up");
  await page.getByRole("button", { name: "Send prompt", exact: true }).click();
  await expect(composer).toHaveValue("Keep this unsent follow-up");
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  expect((await readDraft(page)).conversation).toHaveLength(64);
});

test("earlier widgets remain editable after later selections and a follow-up retains those choices", async ({ page }, info) => {
  await start(page, "A workshop sharing repair tools with local residents.");
  await page.getByRole("checkbox", { name: "I have no relevant competitors to retain" }).check();
  await page.getByRole("button", { name: "Keep competitors", exact: true }).click();
  await page.getByRole("button", { name: "Add audience", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Audience name", exact: true })).toBeFocused();
  await page.getByRole("textbox", { name: "Audience name", exact: true }).fill("Local residents");
  await page.getByRole("textbox", { name: "What do they need?", exact: true }).fill("Tools and guidance");
  await page.getByRole("textbox", { name: "Why are they a fit?", exact: true }).fill("They can walk to the workshop");
  await page.getByRole("checkbox", { name: "Select as target", exact: true }).check();
  await page.getByRole("button", { name: "Keep audience", exact: true }).click();
  await page.getByRole("button", { name: "Enter my own profile", exact: true }).click();
  await page.getByRole("button", { name: "Keep personality", exact: true }).click();
  await page.getByRole("textbox", { name: "Positioning statement", exact: true }).fill("A welcoming place to repair together.");
  await page.getByRole("button", { name: "Keep positioning", exact: true }).click();
  await expect(page.getByRole("region", { name: "Positioning", exact: true }).getByText("Confirmed", { exact: true })).toBeVisible();
  const before = await readDraft(page);
  expect(before.positioningReviewedAt).toBeTruthy();
  await send(page, "Please also consider students, without removing our existing choices.");
  const after = await readDraft(page);
  expect(after.segments).toEqual(before.segments);
  expect(after.personality).toEqual(before.personality);
  expect(after.positioning).toBe(before.positioning);
  expect(after.audienceReviewedAt).toBeNull();
  expect(after.personalityReviewedAt).toBeNull();
  expect(after.positioningReviewedAt).toBeNull();
  expect(after.competitorReviewKey).toBeNull();
  expect(after.activity).toBe("");
  expect(after.knownAudience).toBe("");
  await page.reload();
  await page.getByRole("button", { name: "Edit audience", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Audience name", exact: true })).toHaveValue("Local residents");
  await expect(page.getByRole("checkbox", { name: "Selected target", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Edit competitors", exact: true }).click();
  await page.getByRole("button", { name: "Add competitor", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Competitor name", exact: true })).toBeFocused();
  await page.getByRole("textbox", { name: "Competitor name", exact: true }).fill("A known local fixture");
  expect((await readDraft(page)).conversation?.filter(event => event.kind === "widget").map(event => event.widget)).toEqual(["competitors", "audience", "personality", "positioning"]);
  await capture(page, info, "conversation-history-edit.png");
});

test("failed storage preserves accepted follow-ups in the tab with an explicit persistence warning", async ({ page }) => {
  await start(page, "A useful initial prompt");
  const before = await page.evaluate(storageKey => localStorage.getItem(storageKey), key);
  await page.evaluate(storageKey => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === storageKey) throw new DOMException("Synthetic storage failure", "QuotaExceededError");
      return original.call(this, name, value);
    };
  }, key);
  await send(page, "A follow-up retained only in this tab");
  await expect(page.getByText("This tab only", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Browser storage is unavailable" })).toBeVisible();
  await expect(page.getByText("A follow-up retained only in this tab", { exact: true })).toBeVisible();
  expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBe(before);
});

test("legacy browser descriptions remain saved context without an invented conversation timestamp", async ({ page }) => {
  const legacy: LocalDraft = { id, title: "Legacy fixture", scope: "visual_identity_only", description: "A saved workshop description.", activity: "Workshop", offering: "Shared tools", knownAudience: "Local residents", suppliedName: "Saved Name", namingNotes: "Keep these notes", identityNotes: "Keep the poster system", segments: [], stage: "review", audienceReviewedAt: null, example: false, createdAt: now, updatedAt: now };
  await page.addInitScript(({ key, legacy }) => localStorage.setItem(key, JSON.stringify({ version: 1, drafts: [legacy] })), { key, legacy });
  await page.goto(`/brands/${id}`);
  await expect(page.getByText("Saved brief", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Fluid", exact: true })).toBeVisible();
  await send(page, "A first actual follow-up");
  const saved = await readDraft(page);
  expect(saved.conversation?.[0]).toMatchObject({ kind: "saved_context", text: legacy.description });
  expect(saved.conversation?.[0]).not.toHaveProperty("createdAt");
  expect(saved.conversation?.filter(event => event.kind === "user_message")).toHaveLength(1);
  expect(saved.activity).toBe(legacy.activity);
  expect(saved.offering).toBe(legacy.offering);
  expect(saved.suppliedName).toBe("Saved Name");
});
