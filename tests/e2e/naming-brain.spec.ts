import { expect, test } from "@playwright/test";
import { base, frameBarrier, id, namingCard, namingFixture, namingUrl, openNaming, otherOwnerId, ownerId, scrollToTail } from "./naming-brain-fixture";
import { captureUiEvidence } from "./ui-evidence";

// Synthetic account/API responses only, exercised through the real Next production UI.
test("Naming V2: explicit choices save before initial100, never on mount, then restore", async ({ page }, info) => {
  const fixture = await namingFixture(page); await openNaming(page);
  await expect(page.getByRole("region", { name: "Naming choices", exact: true })).toBeVisible();
  expect(fixture.mutations()).toHaveLength(0);
  await page.getByRole("button", { name: /^Real words/ }).click();
  await page.getByRole("button", { name: /^Compounds/ }).click();
  await page.getByRole("radio", { name: /^Explore all/ }).click();
  const held = fixture.hold(`${base}/preferences`, "PATCH");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => held.ready).toBe(true);
  expect(fixture.mutations()).toHaveLength(0);
  held.release();
  await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  expect(fixture.mutations()).toHaveLength(1);
  expect(fixture.mutations()[0]).toMatchObject({ account: ownerId, body: { reason: "initial", consumedThrough: null, expectedPreferencesVersion: fixture.state.preferences!.version } });
  await page.screenshot({ path: info.outputPath("synthetic-initial100.png"), fullPage: true });
  await page.reload(); await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  await scrollToTail(page, false); expect(fixture.mutations()).toHaveLength(1);
  await page.getByRole("button", { name: "Naming choices", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Real words/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("radio", { name: /^Explore all/ })).toHaveAttribute("aria-checked", "true");
});

test("Naming V2: scroll appends100 once, preserves anchor and retained likes during work", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, count: 100 }); fixture.state.ensureMode = "pending";
  await openNaming(page); await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  await scrollToTail(page); await expect.poll(() => fixture.mutations().length).toBe(1);
  const request = fixture.mutations()[0]!;
  expect(request.body).toMatchObject({ reason: "scroll", consumedThrough: { entryId: id(200_100), position: 100 } });
  await namingCard(page, 100).getByRole("button", { name: "Favorite Synthetic 100", exact: true }).click();
  await expect(namingCard(page, 100).getByRole("button", { name: "Unfavorite Synthetic 100", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(fixture.state.rows[99]!.entry.retention.favorite).toBe(true);
  await scrollToTail(page); expect(fixture.mutations()).toHaveLength(1);
  // Complete the acknowledged run, then expose its immutable saved page on the exact replay.
  const run = { ...fixture.state.activeRun!, state: "succeeded" as const, revision: 2, progress: 100, preparedSetId: id(900_001), fulfillment: { status: "complete" as const, targetCount: 100 as const, acceptedCount: 100, missingCount: 0, coverageSatisfied: true, message: null } };
  const rows = fixture.add(100, run);
  fixture.state.savedEnsures.set(String(request.body!.idempotencyKey), { status: "appended", feed: fixture.feed(0, rows), runId: run.runId, appendedEntryIds: rows.map(row => row.entryId) });
  await namingCard(page, 100).scrollIntoViewIfNeeded();
  const before = await namingCard(page, 100).boundingBox();
  await expect(page.locator(".naming-feed-card")).toHaveCount(200, { timeout: 20_000 });
  const after = await namingCard(page, 100).boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(3);
  expect(new Set(fixture.mutations().map(row => row.body!.idempotencyKey)).size).toBe(1);
  await expect(namingCard(page, 100).getByRole("button", { name: "Unfavorite Synthetic 100", exact: true })).toHaveAttribute("aria-pressed", "true");
  await frameBarrier(page); expect(fixture.mutations()).toHaveLength(2); // one exact receipt replay, no new admission
});

test("Naming V2: More like these supersedes a held demand and keeps the unsent draft across detail/history", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, count: 3 }); fixture.state.ensureMode = "pending";
  await openNaming(page); await expect(page.locator(".naming-feed-card")).toHaveCount(3);
  await namingCard(page, 1).getByRole("checkbox", { name: /More like this\s*:\s*Synthetic 001/ }).check();
  await page.getByLabel(/Anything to emphasize/).fill("Synthetic warm direction");
  await namingCard(page, 1).getByRole("button", { name: "Inspect name Synthetic 001" }).click();
  await expect(page.getByRole("region", { name: "Inspect name" })).toBeVisible();
  await page.getByRole("button", { name: "Back to results" }).click();
  await page.getByRole("button", { name: "Saved names & history" }).click();
  await page.getByRole("button", { name: "Back to exploration" }).click();
  await expect(page.getByLabel(/Anything to emphasize/)).toHaveValue("Synthetic warm direction");
  await expect(namingCard(page, 1).getByRole("checkbox")).toBeChecked();
  const held = fixture.hold(`${base}/feed/ensure`, "POST"); await scrollToTail(page); await expect.poll(() => held.ready).toBe(true);
  await page.getByRole("button", { name: "More like these", exact: true }).click();
  await expect.poll(() => fixture.state.steering).toBe(1);
  held.release(); await expect.poll(() => held.settled).toBe(true); await frameBarrier(page);
  expect(fixture.mutations("/steering")[0]).toMatchObject({ account: ownerId, body: { candidateIds: [id(100_001)], instruction: "Synthetic warm direction", expectedSteeringRevision: 0 } });
  await expect(page.getByText("Exploring your next names…", { exact: true })).toHaveCount(0);
  await expect(page.locator(".naming-feed-card")).toHaveCount(3);
  expect(fixture.mutations()).toHaveLength(1);
});

test("Naming V2: history/filter Continue restores exploration before admission", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, count: 3 }); await openNaming(page);
  await page.getByRole("button", { name: "Saved names & history" }).click();
  await page.getByLabel("Filter project names").selectOption("favorite");
  await expect(page.getByLabel("Filter project names")).toHaveValue("favorite");
  await page.getByRole("button", { name: "Modify filters" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("region", { name: "Naming exploration" })).toBeVisible();
  expect(fixture.state.session.viewState).toMatchObject({ pane: "results", filter: "all", query: "", visibleBatchId: null });
  expect(fixture.mutations()).toHaveLength(0); // saved current exploration needs no new paid run
  await scrollToTail(page); await expect.poll(() => fixture.mutations().length).toBe(1);
});

test("Naming V2: restored scroll, idle, hidden, search/history, detail and Stop cannot admit", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, count: 3 }); await page.clock.install(); await openNaming(page);
  await expect(page.locator(".naming-feed-card")).toHaveCount(3); await scrollToTail(page, false); expect(fixture.mutations()).toHaveLength(0);
  await page.getByRole("button", { name: "Naming choices", exact: true }).click(); await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.clock.fastForward(60_100); await scrollToTail(page, false); expect(fixture.mutations()).toHaveLength(0);
  // Emulate the document visibility boundary without bringing another shared GUI tab forward.
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.locator(".naming-continuous-results").press("End"); await frameBarrier(page); expect(fixture.mutations()).toHaveLength(0);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.getByRole("button", { name: "Saved names & history" }).click();
  await page.getByLabel("Search project names").fill("Synthetic 001"); await page.getByLabel("Search project names").press("End");
  await frameBarrier(page); expect(fixture.mutations()).toHaveLength(0);
  await page.getByRole("button", { name: "Back to exploration" }).click();
  await namingCard(page, 1).getByRole("button", { name: "Inspect name Synthetic 001" }).click(); await page.getByRole("region", { name: "Inspect name" }).press("End");
  await frameBarrier(page); expect(fixture.mutations()).toHaveLength(0);
  await page.getByRole("button", { name: "Back to results" }).click();
  await page.getByRole("button", { name: "Pause exploration" }).click(); await expect.poll(() => fixture.state.paused).toBe(true);
  await scrollToTail(page); expect(fixture.mutations()).toHaveLength(0);
  expect(fixture.mutations("/feed/stop")).toHaveLength(1);
});

for (const terminal of ["partial", "needs_reconciliation"] as const) test(`Naming V2: ${terminal} never retries on scroll and only eligible partial explicitly resumes`, async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, count: 20, terminal }); const previous = fixture.state.activeRun!; fixture.state.ensureMode = "pending";
  await openNaming(page); await expect(page.locator(".naming-feed-card")).toHaveCount(20);
  await scrollToTail(page); expect(fixture.mutations()).toHaveLength(0);
  if (terminal === "partial") {
    await page.getByRole("button", { name: "Resume unfinished exploration" }).click();
    await expect.poll(() => fixture.mutations().length).toBe(1);
    expect(fixture.mutations()[0]!.body).toMatchObject({ reason: "resume", resumeOfRunId: previous.runId, expectedRunRevision: previous.revision });
    expect(fixture.state.activeRun!.runId).not.toBe(previous.runId);
    expect(fixture.state.activeRun!.accounting).toEqual({ status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null });
  } else { await expect(page.getByRole("button", { name: "Resume unfinished exploration" })).toHaveCount(0); await page.getByRole("button", { name: "Check saved result" }).click(); expect(fixture.mutations()).toHaveLength(0); }
});

test("Naming V2: same-owner verification keeps an exact pending preference save and admission", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true }); await openNaming(page);
  await page.getByRole("button", { name: "Naming choices", exact: true }).click();
  fixture.state.failOnce = { path: `${base}/preferences`, status: 401 };
  await page.getByRole("button", { name: /^Real words/ }).click();
  await expect.poll(() => fixture.mutations("/preferences").length).toBe(1);
  const save = fixture.mutations("/preferences")[0]!.body;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("region", { name: "Naming choices", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry saving choices" }).click();
  await expect.poll(() => fixture.mutations("/preferences").length).toBe(2);
  expect(fixture.mutations("/preferences")[1]!.body).toEqual(save);
  fixture.state.failOnce = { path: `${base}/feed/ensure`, status: 401 };
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => fixture.mutations().length).toBe(1);
  const demand = fixture.mutations()[0]!.body;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "Retry the same request" }).click();
  await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  expect(fixture.mutations()[1]!.body).toEqual(demand);
});

test("Naming V2: a changed owner cannot see a held prior-owner response or steering draft", async ({ page }) => {
  const fixture = await namingFixture(page, { saved: true, count: 3 }); await openNaming(page);
  await namingCard(page, 1).getByRole("checkbox").check(); await page.getByLabel(/Anything to emphasize/).fill("Private synthetic old-owner draft");
  const held = fixture.hold(`${base}/feed/ensure`, "POST"); await scrollToTail(page); await expect.poll(() => held.ready).toBe(true);
  fixture.state.owner = otherOwnerId; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Synthetic 001", { exact: true })).toHaveCount(0);
  held.release(); await expect.poll(() => held.settled).toBe(true); await frameBarrier(page);
  await expect(page.locator(".naming-feed-card")).toHaveCount(0);
  await expect(page.locator('input[value="Private synthetic old-owner draft"]')).toHaveCount(0);
  expect(fixture.mutations()).toHaveLength(1);
});

test("Naming V2: standalone brief creates one project only on submit and replays lost acknowledgement", async ({ page }) => {
  const fixture = await namingFixture(page); await page.goto("/names");
  await page.getByRole("button", { name: "AI Assistant", exact: true }).click();
  const form = page.getByRole("form", { name: "Start Naming project" }); await expect(form).toBeVisible();
  await form.getByLabel("What are you naming?").fill("Synthetic new neighborhood kitchen"); await form.getByLabel("Anything else to consider?").fill("Synthetic warm direction");
  expect(fixture.mutations("/api/projects")).toHaveLength(0); expect(fixture.mutations()).toHaveLength(0);
  fixture.state.failOnce = { path: "/api/projects", status: 503, afterSave: true };
  await form.getByRole("button", { name: "Continue to Naming" }).click();
  await expect(form.getByRole("button", { name: "Retry this project save" })).toBeVisible();
  const first = fixture.mutations("/api/projects")[0]!;
  await form.getByRole("button", { name: "Retry this project save" }).click();
  await expect(page).toHaveURL(namingUrl); await expect(page.getByRole("region", { name: "Naming choices", exact: true })).toBeVisible();
  expect(fixture.state.created.size).toBe(1); expect(fixture.mutations("/api/projects")[1]!.body).toEqual(first.body);
  expect(first.account).toBe(ownerId); expect(fixture.mutations()).toHaveLength(0);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));
