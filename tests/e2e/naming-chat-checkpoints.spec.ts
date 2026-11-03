import { expect, test } from "@playwright/test";
import { base, finishNamingChat, namingFixture, openNaming, showNamingChat } from "./naming-brain-fixture";

const constraints = "Any length limits or text to include or avoid?";
// An explicitly unavailable runtime isolates checkpoint persistence from admission.
// All account responses and generated names are synthetic fixture data.
test("combined default constraints survive a cold reload without another generation", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, unavailable: true });
  const original = structuredClone(fixture.state.preferences);
  await openNaming(page); await showNamingChat(page);
  const heading = page.locator("#project-naming-preferences-heading");
  await expect(heading).toHaveText(constraints);
  await expect(page.getByRole("slider", { name: "Minimum characters", exact: true })).toBeVisible();
  await expect(page.getByLabel("Text to include (optional)", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Creative language", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(heading).toHaveText("Your naming direction");
  await page.reload(); await showNamingChat(page); await expect(heading).toHaveText("Your naming direction");
  expect(fixture.mutations()).toHaveLength(0); expect(fixture.state.preferences).toEqual(original);
  expect(fixture.mutations("/preferences")).toHaveLength(0);
  expect(Object.keys(fixture.state.session.viewState.namingChat!.confirmed).sort()).toEqual(["approaches", "directness", "fragments", "length"]);
});

test("guidance-only autosave preserves prior answers while edited combined constraints reopen", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, unavailable: true });
  await openNaming(page); await showNamingChat(page); await finishNamingChat(page);
  const acknowledgedVersion = fixture.state.session.viewState.namingChat!.preferencesVersion;
  const composer = page.getByLabel("Naming message", { exact: true });
  await composer.fill("I want French names with warm and welcoming associations");
  await page.getByRole("button", { name: "Save naming guidance", exact: true }).click();
  await expect(composer).toHaveValue("");
  expect(fixture.state.session.currentPreferencesVersion).toBeGreaterThan(acknowledgedVersion);
  expect(fixture.state.preferences!.preferences.creativeLocale).toBe("fr");
  await page.reload(); await showNamingChat(page);
  const heading = page.locator("#project-naming-preferences-heading");
  await expect(heading).toHaveText("Your naming direction");
  await expect(page.locator(".guided-choice-answer")).toHaveCount(3);
  await page.getByRole("button", { name: `Edit answer: ${constraints}`, exact: true }).click();
  const maximum = page.getByRole("slider", { name: "Maximum characters", exact: true });
  await maximum.press("Home");
  for (let n = 1; n < 8; n++) await maximum.press("ArrowRight");
  await expect.poll(() => fixture.state.preferences?.preferences.maximumGraphemes).toBe(8);
  await page.reload(); await showNamingChat(page); await expect(heading).toHaveText(constraints);
  await expect(page.getByRole("region", { name: "Your answer: Which approaches would you like to explore?", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Your answer: How closely should names connect to the business?", exact: true })).toBeVisible();
  expect(fixture.mutations()).toHaveLength(0);
});

test("a lost checkpoint acknowledgement does not advance until the saved state is reloaded", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, unavailable: true });
  await openNaming(page); await showNamingChat(page);
  fixture.state.failOnce = { path: `${base}/view`, status: 503, afterSave: true };
  const before = fixture.mutations("/view").length;
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const heading = page.locator("#project-naming-preferences-heading");
  await expect(heading).toHaveText(constraints);
  await expect(page.getByText("This answer could not be confirmed as saved. Check saved choices, then continue again. Your choices are kept.", { exact: true })).toBeVisible();
  expect(fixture.mutations("/view")).toHaveLength(before + 1);
  await page.reload(); await showNamingChat(page); await expect(heading).toHaveText("Your naming direction");
  expect(fixture.mutations()).toHaveLength(0);
});

test("keyboard Continue waits for the combined checkpoint acknowledgement before moving focus", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, unavailable: true });
  await openNaming(page); await showNamingChat(page);
  const held = fixture.hold(`${base}/view`, "PATCH"), next = page.getByRole("button", { name: "Continue", exact: true });
  await next.focus(); await page.keyboard.press("Enter"); await expect.poll(() => held.ready).toBe(true);
  const heading = page.locator("#project-naming-preferences-heading"); await expect(heading).toHaveText(constraints);
  expect(fixture.mutations()).toHaveLength(0);
  held.release(); await expect(heading).toHaveText("Your naming direction"); await expect(heading).toBeFocused();
  expect(fixture.mutations()).toHaveLength(0);
});

test("length handles drag on one track, meet without crossing and reset to flexible", async ({ page, isMobile }) => {
  const f = await namingFixture(page, { saved: true, unavailable: true });
  await openNaming(page); await showNamingChat(page);
  const min = page.getByRole("slider", { name: "Minimum characters" });
  const max = page.getByRole("slider", { name: "Maximum characters" });
  await expect(min).toHaveAttribute("aria-valuetext", "No minimum");
  await expect(max).toHaveAttribute("aria-valuetext", "No maximum");
  await page.getByRole("group", { name: "Name length" }).scrollIntoViewIfNeeded();
  const left = await min.locator("..").boundingBox(), right = await max.locator("..").boundingBox();
  const x = left!.x + left!.width / 2, y = left!.y + left!.height / 2;
  const midpoint = (x + right!.x + right!.width / 2) / 2;
  if (isMobile) {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: midpoint, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally { await cdp.detach(); }
  } else {
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(midpoint, y, { steps: 4 }); await page.mouse.up();
  }
  await expect(min).toHaveValue("20");
  await expect.poll(() => f.state.preferences?.preferences.minimumGraphemes).toBe(20);
  expect(f.state.preferences!.preferences.maximumGraphemes).toBeNull();
  await max.press("Home"); await max.press("ArrowLeft");
  await expect(max).toHaveValue("20");
  await min.press("ArrowRight");
  await expect(min).toHaveValue("20");
  await max.press("End");
  await expect(max).toHaveValue("160");
  await min.press("Delete");
  await expect(min).toHaveAttribute("aria-valuetext", "No minimum");
  await page.getByRole("button", { name: "Reset length" }).click();
  await expect.poll(() => f.state.preferences?.preferences).toMatchObject({ minimumGraphemes: null, maximumGraphemes: null });
  await expect(max).toHaveAttribute("aria-valuetext", "No maximum");
  expect(f.mutations()).toHaveLength(0);
});
