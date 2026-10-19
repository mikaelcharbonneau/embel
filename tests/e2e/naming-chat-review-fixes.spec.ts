import { expect, test } from "@playwright/test";
import { base, finishNamingChat, frameBarrier, namingCard, namingFixture, openNaming, savedChoices, showNamingChat, showNamingNames } from "./naming-brain-fixture";
import { captureUiEvidence } from "./ui-evidence";

// Synthetic owner-bound account/API fixtures only; no worker/provider/database is called.
test("interrupted follow-ups survive reload conservatively and same-owner verification exactly", async ({ page }, info) => {
  const fixture = await namingFixture(page); await openNaming(page);
  await page.getByRole("button", { name: /^Other languages/ }).click();
  await page.getByRole("button", { name: /^Classical roots/ }).click();
  await page.getByRole("button", { name: /^People & places/ }).click();
  await page.getByRole("button", { name: /^Stories & culture/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("radio", { name: /^Explore all/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const heading = page.locator("#project-naming-preferences-heading"), language = page.getByRole("textbox", { name: "Creative language", exact: true });
  await expect(heading).toHaveText("Which language should the names work in?");
  await language.fill("fr"); await expect.poll(() => fixture.state.preferences?.preferences.creativeLocale).toBe("fr");
  await page.reload(); await expect(heading).toHaveText("Which language should the names work in?");
  await expect(language).toHaveValue("fr"); await expect(page.getByRole("button", { name: "Start exploring", exact: true })).toHaveCount(0);
  for (const question of ["Any languages or roots to draw from?", "Any people or places to draw from?", "Any stories or cultural references to explore?", "Which language should the names work in?", "Do you have a length in mind?", "Any text to include or avoid?"]) await expect(page.getByRole("region", { name: `Your answer: ${question}`, exact: true })).toHaveCount(0);
  expect(fixture.mutations()).toHaveLength(0);
  const verification = fixture.hold("/api/session", "GET"); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => verification.ready).toBe(true); await expect(heading).toHaveCount(0);
  verification.release(); await expect(heading).toHaveText("Which language should the names work in?");
  await expect(language).toHaveValue("fr");
  for (const question of ["Any languages or roots to draw from?", "Any people or places to draw from?", "Any stories or cultural references to explore?"]) await expect(page.getByText(question, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Your answer: Which language should the names work in?", exact: true })).toHaveCount(0);
  expect(fixture.mutations()).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("unfinished-question-after-verification.png") });
  await finishNamingChat(page); expect(fixture.mutations()).toHaveLength(0);
  await page.getByRole("button", { name: "Start exploring", exact: true }).click();
  await expect(page.locator('.naming-feed-card')).toHaveCount(100); expect(fixture.mutations()).toHaveLength(1);
  expect(fixture.mutations()[0]!.body).toMatchObject({ reason: "initial" });
});

test("saved inspiration values and approaches survive the shorter chat without retired prompts or answer cards", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true });
  const preferences: typeof savedChoices = { ...savedChoices, approaches: ["real_words", "other_languages", "classical_roots", "people_places", "stories_culture"],
    sourceLanguages: ["French", "Latin"], heritageNotes: "Synthetic saved place", culturalNotes: "Synthetic saved story" };
  fixture.state.preferences = { ...fixture.state.preferences!, preferences };
  await openNaming(page); await showNamingChat(page);
  await expect(page.locator("#project-naming-preferences-heading")).toHaveText("Which language should the names work in?");
  await page.getByRole("textbox", { name: "Creative language", exact: true }).fill("fr");
  await expect.poll(() => fixture.state.preferences?.preferences.creativeLocale).toBe("fr");
  await finishNamingChat(page);
  await expect(page.locator("#project-naming-preferences-heading")).toHaveText("Ready to explore your names?");
  for (const question of ["Any languages or roots to draw from?", "Any people or places to draw from?", "Any stories or cultural references to explore?"]) await expect(page.getByText(question, { exact: true })).toHaveCount(0);
  expect(fixture.state.preferences!.preferences).toEqual({ ...preferences, creativeLocale: "fr" });
  expect(fixture.mutations()).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Start exploring", exact: true })).toBeEnabled();
});

test("saved choices keep Start disabled while runtime is unavailable and readiness alone never admits a run", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true }); let available = false;
  await page.route(url => url.pathname === `${base}/feed`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const feed = fixture.feed();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ feed: { ...feed,
      availability: available ? feed.availability : { status: "unavailable", code: "naming_pilot_unavailable" },
    } }) });
  });
  await openNaming(page); await showNamingChat(page); await finishNamingChat(page);
  const start = page.getByRole("button", { name: "Start exploring", exact: true });
  await expect(page.locator('.naming-save-status')).toContainText("Saved");
  await expect(start).toBeDisabled();
  await expect(page.getByText("New Naming exploration is not available for this account yet. You can still edit your choices and browse saved names.", { exact: true })).toBeVisible();
  expect(fixture.mutations()).toHaveLength(0);
  available = true; await page.reload(); await showNamingChat(page); await finishNamingChat(page);
  await expect(start).toBeEnabled(); expect(fixture.mutations()).toHaveLength(0);
  await start.click(); await expect(page.locator('.naming-feed-card')).toHaveCount(100);
  expect(fixture.mutations()).toHaveLength(1); expect(fixture.mutations()[0]!.body).toMatchObject({ reason: "initial" });
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
