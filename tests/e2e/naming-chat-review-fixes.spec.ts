import { expect, test } from "@playwright/test";
import { finishNamingChat, frameBarrier, namingCard, namingFixture, openNaming, showNamingChat, showNamingNames } from "./naming-brain-fixture";
import { captureUiEvidence } from "./ui-evidence";

// Synthetic owner-bound account/API fixtures only; no worker/provider/database is called.
test("interrupted follow-ups survive reload conservatively and same-owner verification exactly", async ({ page }, info) => {
  const fixture = await namingFixture(page); await openNaming(page);
  await page.getByRole("button", { name: /^Other languages/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("radio", { name: /^Explore all/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const heading = page.locator("#project-naming-preferences-heading"), source = page.getByRole("textbox", { name: /^Source languages/ });
  await expect(heading).toHaveText("Any languages or roots to draw from?");
  await source.fill("French"); await expect.poll(() => fixture.state.preferences?.preferences.version === 2 ? fixture.state.preferences.preferences.sourceLanguages : []).toEqual(["French"]);
  await page.reload(); await expect(heading).toHaveText("Any languages or roots to draw from?");
  await expect(source).toHaveValue("French"); await expect(page.getByRole("button", { name: "Start exploring", exact: true })).toHaveCount(0);
  for (const question of ["Any languages or roots to draw from?", "Which language should the names work in?", "Do you have a length in mind?", "Any text to include or avoid?"]) await expect(page.getByRole("region", { name: `Your answer: ${question}`, exact: true })).toHaveCount(0);
  expect(fixture.mutations()).toHaveLength(0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(heading).toHaveText("Which language should the names work in?");
  const verification = fixture.hold("/api/session", "GET"); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => verification.ready).toBe(true); await expect(heading).toHaveCount(0);
  verification.release(); await expect(heading).toHaveText("Which language should the names work in?");
  await expect(page.getByRole("region", { name: "Your answer: Any languages or roots to draw from?", exact: true })).toContainText("French");
  await expect(page.getByRole("region", { name: "Your answer: Which language should the names work in?", exact: true })).toHaveCount(0);
  expect(fixture.mutations()).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("unfinished-question-after-verification.png") });
  await finishNamingChat(page); expect(fixture.mutations()).toHaveLength(0);
  await page.getByRole("button", { name: "Start exploring", exact: true }).click();
  await expect(page.locator('.naming-feed-card')).toHaveCount(100); expect(fixture.mutations()).toHaveLength(1);
  expect(fixture.mutations()[0]!.body).toMatchObject({ reason: "initial" });
});

for (const action of ["Inspect", "Favorite", "History", "Pause", "Stop"] as const) test(`Space activates ${action} without admitting exploration`, async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, count: 3 });
  if (action === "Stop") fixture.state.activeRun = fixture.makeRun("running");
  await openNaming(page); await expect(page.locator('.naming-feed-card')).toHaveCount(3); await showNamingNames(page); await frameBarrier(page);
  expect(fixture.mutations()).toHaveLength(0);
  const target = action === "Inspect" ? namingCard(page, 1).getByRole("button", { name: "Inspect name Synthetic 001", exact: true })
    : action === "Favorite" ? namingCard(page, 1).getByRole("button", { name: "Favorite Synthetic 001", exact: true })
    : page.getByRole("button", { name: action === "History" ? "Saved names & history" : `${action} exploration`, exact: true });
  await target.focus(); await page.keyboard.down("Space"); await frameBarrier(page);
  expect(fixture.mutations()).toHaveLength(0);
  await page.keyboard.up("Space"); await frameBarrier(page); expect(fixture.mutations()).toHaveLength(0);
  if (action === "Inspect") await expect(page.getByRole("region", { name: "Inspect name", exact: true })).toBeVisible();
  if (action === "Favorite") await expect.poll(() => fixture.state.rows[0]!.entry.retention.favorite).toBe(true);
  if (action === "History") await expect(page.getByRole("region", { name: "Naming results", exact: true })).toBeVisible();
  if (action === "Pause" || action === "Stop") { await expect.poll(() => fixture.state.paused).toBe(true); expect(fixture.mutations("/feed/stop")).toHaveLength(1); }
});

for (const input of ["scroller keyboard", "wheel over compact card"] as const) test(`genuine ${input} still admits eligible exploration`, async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, count: 3 }); fixture.state.ensureMode = "pending";
  await openNaming(page); await expect(page.locator('.naming-feed-card')).toHaveCount(3); await showNamingNames(page); await frameBarrier(page);
  expect(fixture.mutations()).toHaveLength(0);
  if (input === "scroller keyboard") { await page.locator('[data-naming-results-scroll]').focus(); await page.keyboard.press("Space"); }
  else { await namingCard(page, 1).getByRole("button", { name: "Inspect name Synthetic 001", exact: true }).hover(); await page.mouse.wheel(0, 200); }
  await expect.poll(() => fixture.mutations().length).toBe(1); expect(fixture.mutations()[0]!.body).toMatchObject({ reason: "scroll" });
  await showNamingChat(page);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));
