import { expect, test } from "@playwright/test";
import { base, finishNamingChat, frameBarrier, namingCard, namingFixture, openNaming, savedChoices, showNamingChat, showNamingNames } from "./naming-brain-fixture";
import { captureUiEvidence } from "./ui-evidence";

// Synthetic owner-bound account/API fixtures only; no worker/provider/database is called.
const constraints = "Any length limits or text to include or avoid?";
const retiredQuestions = [
  "Which language should the names work in?", "Any languages or roots to draw from?",
  "Any people or places to draw from?", "Any stories or cultural references to explore?",
];

test("unfinished constraints survive reload and same-owner verification without confirming or generating", async ({ page }, info) => {
  const fixture = await namingFixture(page); await openNaming(page);
  for (const name of [/^Other languages/, /^Classical roots/, /^People & places/, /^Stories & culture/])
    await page.getByRole("button", { name }).click();
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await next.click();
  await page.getByRole("radio", { name: /^Explore all/ }).click(); await next.click();

  const heading = page.locator("#project-naming-preferences-heading");
  const include = page.getByRole("textbox", { name: "Text to include (optional)", exact: true });
  await expect(heading).toHaveText(constraints);
  await include.fill("Syn");
  await expect.poll(() => fixture.state.preferences?.preferences).toMatchObject({ requiredText: ["Syn"] });
  await page.reload();
  await expect(heading).toHaveText(constraints); await expect(include).toHaveValue("Syn");

  const verification = fixture.hold("/api/session", "GET");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => verification.ready).toBe(true);
  expect(fixture.mutations()).toHaveLength(0);
  verification.release();
  await expect(heading).toHaveText(constraints); await expect(include).toHaveValue("Syn");
  await expect(page.getByRole("region", { name: `Your answer: ${constraints}`, exact: true })).toHaveCount(0);
  expect(fixture.state.session.viewState.namingChat?.confirmed.length).toBeUndefined();
  expect(fixture.state.session.viewState.namingChat?.confirmed.fragments).toBeUndefined();
  expect(fixture.mutations()).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("unfinished-question-after-verification.png") });

  await next.click();
  await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  expect(fixture.mutations()).toHaveLength(1);
  expect(fixture.mutations()[0]!.body).toMatchObject({ reason: "initial" });
  expect(fixture.state.session.viewState.namingChat?.confirmed.fragments).toBe(JSON.stringify([["Syn"], []]));
});

test("saved inspiration values survive the shorter chat and stay out of its questions and answer cards", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, unavailable: true });
  const preferences: typeof savedChoices = { ...savedChoices, creativeLocale: "fr", approaches: ["real_words", "other_languages", "classical_roots", "people_places", "stories_culture"],
    sourceLanguages: ["French", "Latin"], heritageNotes: "Synthetic saved place", culturalNotes: "Synthetic saved story" };
  fixture.state.preferences = { ...fixture.state.preferences!, preferences };
  await openNaming(page); await showNamingChat(page);
  const heading = page.locator("#project-naming-preferences-heading");
  await expect(heading).toHaveText(constraints);
  await page.getByRole("textbox", { name: "Text to include (optional)", exact: true }).fill("Syn");
  await finishNamingChat(page);
  await expect(heading).toHaveText("Your naming direction");
  await page.reload(); await showNamingChat(page);
  await expect(heading).toHaveText("Your naming direction");
  for (const question of retiredQuestions) {
    await expect(page.getByText(question, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: `Your answer: ${question}`, exact: true })).toHaveCount(0);
  }
  expect(fixture.state.preferences!.preferences).toEqual({ ...preferences, requiredText: ["Syn"] });
  expect(fixture.mutations()).toHaveLength(0);
});

test("offline generator explains the outage once and rechecks availability without starting a run", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true }); let available = false;
  await page.route(url => url.pathname === `${base}/feed`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const feed = fixture.feed();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ feed: { ...feed,
      availability: available ? feed.availability : { status: "unavailable", code: "worker_unavailable" },
    } }) });
  });
  await openNaming(page); await showNamingChat(page); await finishNamingChat(page);
  const start = page.getByRole("button", { name: "Generate names", exact: true });
  await expect(page.locator('.naming-save-status')).toContainText("Saved");
  await expect(start).toHaveCount(0);
  await expect(page.getByText("The name generator is offline. Your naming choices are saved.", { exact: true }).filter({ visible: true })).toHaveCount(1);
  expect(fixture.mutations()).toHaveLength(0);
  available = true; await page.getByRole("button", { name: "Check availability", exact: true }).click();
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
  if (action === "Inspect") await expect(page.getByRole("dialog", { name: "Synthetic 001", exact: true })).toBeVisible();
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
