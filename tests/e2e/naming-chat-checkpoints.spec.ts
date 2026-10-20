import { expect, test } from "@playwright/test";
import { base, finishNamingChat, namingFixture, openNaming, showNamingChat } from "./naming-brain-fixture";

// Synthetic owner-bound account fixtures. Checkpoint writes never admit AI work.
test("acknowledged default answers survive a cold reload at each remaining question", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true });
  const original = structuredClone(fixture.state.preferences);
  await openNaming(page); await showNamingChat(page);
  const heading = page.locator("#project-naming-preferences-heading");
  await expect(heading).toHaveText("Which language should the names work in?");
  for (const question of ["Do you have a length in mind?", "Any text to include or avoid?", "Ready to explore your names?"]) {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(heading).toHaveText(question);
    await page.reload(); await showNamingChat(page);
    await expect(heading).toHaveText(question);
    expect(fixture.mutations()).toHaveLength(0);
  }
  expect(fixture.state.preferences).toEqual(original);
  expect(fixture.mutations("/preferences")).toHaveLength(0);
  expect(fixture.mutations("/view")).toHaveLength(3);
  expect(Object.keys(fixture.state.session.viewState.namingChat!.confirmed)).toHaveLength(5);
});

test("guidance-only autosave preserves prior answers while an edited answer alone reopens", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true });
  await openNaming(page); await showNamingChat(page); await finishNamingChat(page);
  const acknowledgedVersion = fixture.state.session.viewState.namingChat!.preferencesVersion;
  const composer = page.getByLabel("Naming message", { exact: true });
  await composer.fill("Synthetic warm and welcoming guidance");
  await page.getByRole("button", { name: "Save naming guidance", exact: true }).click();
  await expect(composer).toHaveValue("");
  expect(fixture.state.session.currentPreferencesVersion).toBeGreaterThan(acknowledgedVersion);
  await page.reload(); await showNamingChat(page);
  const heading = page.locator("#project-naming-preferences-heading");
  await expect(heading).toHaveText("Ready to explore your names?");
  await expect(page.locator(".guided-choice-answer")).toHaveCount(5);
  await page.getByRole("button", { name: "Edit answer: Which language should the names work in?", exact: true }).click();
  await page.getByRole("textbox", { name: "Creative language", exact: true }).fill("fr");
  await expect.poll(() => fixture.state.preferences?.preferences.creativeLocale).toBe("fr");
  await page.reload(); await showNamingChat(page);
  await expect(heading).toHaveText("Which language should the names work in?");
  await expect(page.getByRole("region", { name: "Your answer: Do you have a length in mind?", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Your answer: Any text to include or avoid?", exact: true })).toBeVisible();
  expect(fixture.mutations()).toHaveLength(0);
});

test("a failed checkpoint acknowledgement does not advance until the saved state is reloaded", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true });
  await openNaming(page); await showNamingChat(page);
  fixture.state.failOnce = { path: `${base}/view`, status: 503, afterSave: true };
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const heading = page.locator("#project-naming-preferences-heading");
  await expect(heading).toHaveText("Which language should the names work in?");
  await expect(page.getByText("This answer could not be confirmed as saved. Check saved choices, then continue again. Your choices are kept.", { exact: true })).toBeVisible();
  expect(fixture.mutations("/view")).toHaveLength(1);
  await page.reload(); await showNamingChat(page);
  await expect(heading).toHaveText("Do you have a length in mind?");
  expect(fixture.mutations("/view")).toHaveLength(1);
  expect(fixture.mutations()).toHaveLength(0);
});

test("keyboard Continue waits for a checkpoint acknowledgement before moving focus", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true });
  await openNaming(page); await showNamingChat(page);
  const held = fixture.hold(`${base}/view`, "PATCH");
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await next.focus(); await page.keyboard.press("Enter");
  await expect.poll(() => held.ready).toBe(true);
  const heading = page.locator("#project-naming-preferences-heading");
  await expect(heading).toHaveText("Which language should the names work in?");
  held.release();
  await expect(heading).toHaveText("Do you have a length in mind?");
  await expect(heading).toBeFocused();
  expect(fixture.mutations()).toHaveLength(0);
});
