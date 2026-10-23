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
  await expect(page.getByLabel("Minimum characters", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Include these text fragments", { exact: true })).toBeVisible();
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
  await page.getByLabel("Maximum characters", { exact: true }).fill("8");
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
