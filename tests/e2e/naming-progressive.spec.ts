import { expect, test } from "@playwright/test";
import { frameBarrier, id, namingCard, namingFixture, openNaming, ownerId, scrollToTail } from "./naming-brain-fixture";
import { captureUiEvidence } from "./ui-evidence";

// Synthetic acknowledged API pages exercise actual production UI timing and
// native browser events. Provider speed/quality require separate real acceptance.
test("Naming progressive: prefetches before the300 tail and renders saved microbatches while the run remains active", async ({ page }, info) => {
  const fixture = await namingFixture(page, { saved: true, count: 300, progressive: true }); fixture.state.ensureMode = "pending";
  fixture.state.rows[99]!.entry.retention = { ...fixture.state.rows[99]!.entry.retention, favorite: true, revision: 1, updatedAt: fixture.state.rows[99]!.entry.candidate.createdAt };
  await openNaming(page); await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  await scrollToTail(page); await expect(page.locator(".naming-feed-card")).toHaveCount(200);
  await scrollToTail(page); await expect(page.locator(".naming-feed-card")).toHaveCount(300);
  expect(fixture.mutations()).toHaveLength(0);
  await namingCard(page, 200).scrollIntoViewIfNeeded(); await frameBarrier(page);
  expect(fixture.mutations()).toHaveLength(0);
  expect(await page.locator(".naming-feed-tail").evaluate(tail => {
    const root = tail.closest<HTMLElement>("[data-naming-results-scroll]")!;
    return tail.getBoundingClientRect().top > root.getBoundingClientRect().bottom + root.clientHeight * 2;
  })).toBe(true);
  await namingCard(page, 200).hover(); await page.mouse.wheel(0, 120); await frameBarrier(page);
  await expect.poll(() => fixture.mutations().length).toBe(1);
  const intent = fixture.mutations()[0]!.body!;
  expect(intent.reason).toBe("scroll");
  const consumed = intent.consumedThrough as { entryId: string; position: number };
  expect(consumed.position).toBeGreaterThanOrEqual(200); expect(consumed.position).toBeLessThan(300);
  await expect(namingCard(page, consumed.position)).toBeInViewport();
  await expect(namingCard(page, consumed.position + 1)).not.toBeInViewport();
  expect(consumed.entryId).toBe(id(200_000 + consumed.position));
  const activeRun = fixture.state.activeRun!;
  fixture.add(4, activeRun);
  await expect(page.locator(".naming-feed-card")).toHaveCount(304, { timeout: 2000 });
  expect(fixture.state.activeRun?.state).toBe("running"); expect(fixture.mutations()).toHaveLength(1);
  fixture.add(6, activeRun);
  await expect(page.locator(".naming-feed-card")).toHaveCount(310, { timeout: 2000 });
  expect(fixture.mutations()).toHaveLength(1);
  await expect(namingCard(page, 100).getByRole("button", { name: "Unfavorite Synthetic 100", exact: true })).toHaveAttribute("aria-pressed", "true");
  await namingCard(page, 301).scrollIntoViewIfNeeded(); await frameBarrier(page);
  await captureUiEvidence(page, info);
  expect(fixture.mutations()).toHaveLength(1);
});

test("Naming progressive: a cold reload renders its six saved names and polls the active run without a pending intent", async ({ page }, info) => {
  const fixture = await namingFixture(page, { saved: true, progressive: true });
  const activeRun = fixture.makeRun("running"); fixture.add(6, activeRun); fixture.state.progressive = true;
  await openNaming(page); await expect(page.locator(".naming-feed-card")).toHaveCount(6);
  expect(fixture.mutations()).toHaveLength(0);
  fixture.add(4, activeRun); await expect(page.locator(".naming-feed-card")).toHaveCount(10, { timeout: 2000 });
  expect(fixture.state.activeRun?.state).toBe("running"); expect(fixture.mutations()).toHaveLength(0);
  await page.reload(); await expect(page.locator(".naming-feed-card")).toHaveCount(10);
  expect(fixture.mutations()).toHaveLength(0);
  await captureUiEvidence(page, info);
});

test("Naming recovery: an old acknowledged run cannot block a new project's saved choices", async ({ page }, info) => {
  const fixture = await namingFixture(page, { progressive: true });
  const recoveryKey = `embel.naming-recovery.v1:${ownerId}`;
  const legacy = { version: 1, ownerId, creation: null, projects: [{ projectId: id(990), preferences: null,
    steeringDraft: { candidateIds: [], instruction: "" },
    pending: { version: 1, reason: "initial", expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0,
      expectedDemandSequence: 0, consumedThrough: null, idempotencyKey: id(991) },
    acknowledged: true, acknowledgedRunId: id(992), stop: null, stopConflict: false, stopRequested: false, steering: null }] };
  await page.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), { key: recoveryKey, value: JSON.stringify(legacy) });
  await openNaming(page);
  await expect(page.getByRole("button", { name: "Recover my Naming work", exact: true })).toHaveCount(0);
  const realWords = page.getByRole("button", { name: /^Real words/ });
  await realWords.click(); await expect(realWords).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^Explore all/ })).toBeVisible();
  expect(fixture.state.preferences?.preferences).toMatchObject({ version: 2, approaches: ["real_words"] });
  expect(fixture.mutations()).toHaveLength(0);
  expect(await page.evaluate(key => sessionStorage.getItem(key), recoveryKey)).toBeNull();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Find a name that feels right" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recover my Naming work", exact: true })).toHaveCount(0);
  expect(fixture.state.preferences?.preferences).toMatchObject({ version: 2, approaches: ["real_words"] });
  expect(fixture.mutations()).toHaveLength(0);
  await captureUiEvidence(page, info);
});
