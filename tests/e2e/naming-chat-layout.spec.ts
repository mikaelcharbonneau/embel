import { expect, test, type Page } from "@playwright/test";
import { base, frameBarrier, namingCard, namingFixture, namingUrl, openNaming, scrollToTail, showNamingChat as showChat, showNamingNames as showNames } from "./naming-brain-fixture";
import { captureUiEvidence } from "./ui-evidence";

// Explicit synthetic account/API fixtures through the production UI. No live model calls.
async function continueAnswer(page: Page) { await page.getByRole("button", { name: "Continue", exact: true }).click(); }
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }

test("sequential chat saves each answer and preserves the same composer with compact names", async ({ page }, info) => {
  await page.setViewportSize(info.project.name === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
  const fixture = await namingFixture(page); await openNaming(page);
  const layout = page.locator("[data-naming-layout]"), composer = page.getByLabel("Naming message", { exact: true });
  await expect(layout).toHaveAttribute("data-naming-layout", "chat");
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Real words/ })).toHaveAttribute("aria-pressed", "false");
  expect(fixture.mutations()).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("chat-first.png") });
  await page.getByRole("button", { name: /^Real words/ }).click();
  await page.getByRole("button", { name: /^Compounds/ }).click();
  const held = fixture.hold(`${base}/preferences`, "PATCH"); await continueAnswer(page);
  await expect.poll(() => held.ready).toBe(true);
  await expect(page.getByRole("radio")).toHaveCount(0); expect(fixture.mutations()).toHaveLength(0);
  held.release();
  await expect(page.getByRole("radio", { name: /^Explore all/ })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("radio", { name: /^Explore all/ }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("radio", { name: /^Explore all/ })).toHaveAttribute("aria-checked", "true"); await continueAnswer(page);
  await expect(page.getByLabel("Maximum characters")).toBeVisible();
  expect(fixture.mutations()).toHaveLength(0);
  await composer.fill("Synthetic unsent thought survives layout change");
  await composer.evaluate(input => input.setAttribute("data-chat-identity", "same-mounted-composer"));
  await continueAnswer(page);
  await expect(page.locator(".naming-feed-card")).toHaveCount(100); await expect(layout).toHaveAttribute("data-naming-layout", "results");
  expect(fixture.mutations()).toHaveLength(1);
  expect(fixture.state.preferences?.preferences).toMatchObject({ version: 2, approaches: ["real_words", "compounds"], directness: "all" });
  await expect(composer).toHaveAttribute("data-chat-identity", "same-mounted-composer"); await expect(composer).toHaveValue("Synthetic unsent thought survives layout change");
  await expect(page.getByRole("heading", { name: "Find a name that feels right", exact: true })).toBeVisible();
  const cards = page.locator(".naming-feed-card .project-naming-card");
  const geometry = await cards.evaluateAll(items => items.slice(0, 4).map(item => { const r = item.getBoundingClientRect(); return { x: r.x, y: r.y, height: r.height, width: r.width }; }));
  if (info.project.name === "desktop") {
    const chat = await page.getByRole("complementary", { name: "Naming conversation", exact: true }).boundingBox(), results = await page.locator("[data-naming-results-scroll]").boundingBox();
    const header = await page.getByRole("banner").boundingBox();
    expect(results!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
    expect(results!.y + results!.height).toBeLessThanOrEqual(chat!.y + 1);
    expect(chat!.y + chat!.height).toBeLessThanOrEqual(901);
    expect(chat!.width).toBeGreaterThan(0); expect(results!.width).toBeGreaterThan(0);
    expect(new Set(geometry.map(item => item.y)).size).toBe(1); expect(geometry[0]!.height).toBe(90); expect(geometry[1]!.x - geometry[0]!.x - geometry[0]!.width).toBe(12);
  } else { expect(geometry[0]!.y).toBe(geometry[1]!.y); expect(geometry[2]!.y).toBeGreaterThan(geometry[0]!.y); }
  expect(await namingCard(page, 1).getByRole("button").count()).toBe(2);
  await expect(namingCard(page, 1).locator('img[src="/naming/heart.svg"]')).toHaveJSProperty("naturalWidth", 16);
  await noOverflow(page); await page.screenshot({ path: info.outputPath("compact-results.png") });
  await showChat(page);
  await page.getByRole("button", { name: "Edit answer: Which approaches would you like to explore?", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Real words/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Compounds/ }).click(); await continueAnswer(page);
  await expect.poll(() => fixture.state.preferences?.preferences.version === 2 ? fixture.state.preferences.preferences.approaches : []).toEqual(["real_words"]);
  await expect(composer).toHaveValue("Synthetic unsent thought survives layout change"); expect(fixture.mutations()).toHaveLength(1);
  await noOverflow(page); await page.screenshot({ path: info.outputPath("chat-revisit.png") });
});

test("conversation scrolling cannot admit names; genuine grid scrolling can", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, count: 3 }); fixture.state.ensureMode = "pending";
  await openNaming(page); await expect(page.locator(".naming-feed-card")).toHaveCount(3); await frameBarrier(page);
  await showChat(page);
  const chat = page.locator("[data-naming-chat-scroll]"); await chat.hover(); await page.mouse.wheel(0, 450); await chat.press("End"); await frameBarrier(page);
  expect(fixture.mutations()).toHaveLength(0);
  await showNames(page); await scrollToTail(page, false); expect(fixture.mutations()).toHaveLength(0);
  await scrollToTail(page); await expect.poll(() => fixture.mutations().length).toBe(1);
  expect(fixture.mutations()[0]!.body).toMatchObject({ reason: "scroll" });
});

test("composer guidance waits for account acknowledgement and preserves all name detail actions", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, count: 3 }); await page.goto(namingUrl); await expect(page.locator(".naming-feed-card")).toHaveCount(3);
  await showChat(page); const composer = page.getByLabel("Naming message", { exact: true });
  await composer.fill("Synthetic warm and useful direction"); const held = fixture.hold(`${base}/preferences`, "PATCH");
  await page.getByRole("button", { name: "Save naming guidance", exact: true }).click(); await expect.poll(() => held.ready).toBe(true);
  await expect(composer).toHaveValue("Synthetic warm and useful direction"); expect(fixture.mutations()).toHaveLength(0);
  held.release(); await expect(composer).toHaveValue(""); expect(fixture.state.preferences?.preferences.notes).toContain("Synthetic warm and useful direction");
  await showNames(page); await namingCard(page, 1).getByRole("button", { name: "Inspect name Synthetic 001", exact: true }).click();
  const detail = page.getByRole("region", { name: "Inspect name", exact: true });
  await expect(detail.getByRole("button", { name: "Use this name", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Explore variations", exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Save Synthetic 001", exact: true }).click(); await expect.poll(() => fixture.state.rows[0]!.entry.retention.saved).toBe(true);
  await detail.getByRole("checkbox", { name: /More like this/ }).check();
  await detail.getByRole("button", { name: "Origin and history", exact: true }).click(); await expect(detail.getByText(/Generated with synthetic-never-call/)).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Back to results", exact: true }).click(); await showChat(page);
  await expect(page.getByRole("button", { name: "Send naming direction", exact: true })).toBeEnabled();
  await composer.fill("Synthetic closer to the first name"); await page.getByRole("button", { name: "Send naming direction", exact: true }).click();
  await expect.poll(() => fixture.state.steering).toBe(1); await expect(composer).toHaveValue(""); expect(fixture.mutations()).toHaveLength(0);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));
