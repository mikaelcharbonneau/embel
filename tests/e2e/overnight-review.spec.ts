import { test, expect, type Page } from "@playwright/test";
import { namingFixture, namingUrl, base, id } from "./naming-brain-fixture";
import { syntheticLogoBatch, syntheticLogoWorkspace, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
import { contextSnapshotSchema } from "../../src/domain/projects";
async function constraints(page: Page) {
  await page.goto(namingUrl);
  await page.getByRole("button", { name: /^Real words/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("radio", { name: /^Explore all/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Any length limits or text to include or avoid?", exact: true })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Minimum characters", exact: true })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Maximum characters", exact: true })).toBeVisible();
  await expect(page.getByLabel("Text to include (optional)", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Text to avoid (optional)", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Creative language", { exact: true })).toHaveCount(0);
}
test("last answer starts one request, keeps chat for 99 names, then opens full-width results with a bottom composer", async ({ page }, info) => {
  const f = await namingFixture(page, { progressive: true }); f.state.ensureMode = "pending";
  await constraints(page);
  const maximum = page.getByRole("slider", { name: "Maximum characters", exact: true });
  await maximum.press("Home");
  for (let n = 1; n < 16; n++) await maximum.press("ArrowRight");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => f.mutations().length).toBe(1);
  await expect(page.locator('[data-naming-layout="chat"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Start exploring", exact: true })).toHaveCount(0);
  const run = f.state.activeRun!; f.add(99, run);
  await expect(page.getByText("99 of 100 names saved.", { exact: false })).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-naming-layout="chat"]')).toBeVisible();
  f.add(1, { ...run, state: "succeeded", progress: 100, preparedSetId: id(48000), fulfillment: { status: "complete", targetCount: 100, acceptedCount: 100, missingCount: 0, coverageSatisfied: true, message: null } });
  await expect(page.locator('[data-naming-layout="results"]')).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  const canvas = await page.locator('[data-naming-results-scroll]').boundingBox(), composer = await page.getByLabel("Naming message", { exact: true }).boundingBox();
  expect(canvas!.width).toBeGreaterThan(page.viewportSize()!.width * .7);
  expect(composer!.y).toBeGreaterThan(canvas!.y);
  await page.getByLabel("Naming message", { exact: true }).fill("Keep my unsent thought");
  const original = await page.getByLabel("Naming message", { exact: true }).elementHandle();
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your naming direction", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close chat", exact: true }).click();
  await expect(page.getByLabel("Naming message", { exact: true })).toHaveValue("Keep my unsent thought");
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await page.screenshot({ path: info.outputPath("naming-bottom-composer.png"), fullPage: true });
  expect(new Set(f.mutations().map(row => row.body?.idempotencyKey)).size).toBe(1);
});
test("unknown generation remains in the conversation with recovery, not a misleading ready screen", async ({ page }) => {
  const f = await namingFixture(page); f.state.ensureMode = "unknown";
  await constraints(page); await page.getByRole("button", { name: "Continue", exact: true }).click();
  // The outcome is also summarized in the exploration panel; the conversation must carry it.
  await expect(page.getByRole("region", { name: "Naming choices" }).getByText("Synthetic unknown outcome requires resolution.", { exact: true })).toBeVisible();
  await expect(page.locator('[data-naming-layout="chat"]')).toBeVisible();
  // An uncertain paid request offers no new generation, only a saved-state check.
  await expect(page.getByRole("button", { name: /^(Retry generation|Generate names)$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply updated choices", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Check saved state", exact: true })).toBeVisible();
  expect(new Set(f.mutations().map(row => row.body?.idempotencyKey)).size).toBe(1);
});
test("an uncertain final answer save does not start generation", async ({ page }) => {
  const f = await namingFixture(page); await constraints(page);
  f.state.failOnce = { path: `${base}/view`, status: 503 };
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("This answer could not be confirmed as saved.", { exact: false })).toBeVisible();
  expect(f.mutations()).toHaveLength(0);
  await expect(page.getByRole("slider", { name: "Maximum characters", exact: true })).toBeVisible();
});
test("one account entry and a keyboard-dismissable account menu", async ({ page }, info) => {
  await namingFixture(page, { saved: true, count: 100 }); await page.goto(namingUrl);
  await expect(page.locator(".workspace-account-avatar")).toHaveCount(1);
  await expect(page.locator(".workspace-avatar")).toHaveCount(0);
  const trigger = page.getByLabel("Account menu", { exact: true });
  await trigger.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "Account settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activity", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("account-menu.png") });
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await expect(page.getByRole("link", { name: "Account settings", exact: true })).not.toBeVisible();
});
test("context opens in a readable sheet, not a small dropdown", async ({ page }, info) => {
  await namingFixture(page); await page.goto(namingUrl);
  await page.getByRole("button", { name: "Saved project context", exact: false }).click();
  const dialog = page.getByRole("dialog", { name: "Saved project context", exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog.getByText("Synthetic brief: a warm neighborhood kitchen.", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("project-context-sheet.png") });
  await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Saved project context", exact: false })).toBeFocused();
});
test("six logo cards use the selected Image FX preset and respect reduced motion", async ({ page }, info) => {
  const source = syntheticResolvedLogoConcept(), foundation = syntheticLogoWorkspace();
  const batch = syntheticLogoBatch(Array.from({ length: 6 }, () => "running" as const));
  const projectId = foundation.projectId, ownerId = foundation.ownerId, logoBase = `/api/projects/${projectId}/logo`;
  const workspace = { ...foundation, heads: { ...foundation.heads, workspaceRevision: 1, stageRevisions: { ...foundation.heads.stageRevisions, brief_references: 1 } }, stages: { ...foundation.stages, brief_references: { id: source.brief.id, revision: 1, stage: "brief_references" } } };
  await page.route("**/*", async route => {
    const url = new URL(route.request().url()), p = url.pathname;
    if (url.hostname !== "127.0.0.1") return route.abort();
    if (!p.startsWith("/api/")) return route.continue();
    const value = p === "/api/session" ? { user: { id: ownerId } } : p === `/api/projects/${projectId}` ? { project: { id: projectId, owner_id: ownerId, title: "Animation comparison fixture", scope: "complete_brand", current_revision: 1, created_at: source.brief.createdAt, context: contextSnapshotSchema.parse({ description: "Synthetic fixture only" }) } }
      : p === logoBase ? workspace : p === `${logoBase}/batches` ? { ownerId, projectId, items: [{ id: batch.id, requestKey: batch.requestKey, createdAt: batch.createdAt }], nextCursor: null }
      : p === `${logoBase}/batches/${batch.id}` ? batch
      : p === `${logoBase}/stages/brief_references/revisions/${source.brief.id}` ? source.brief
      : p === `${logoBase}/reference-snapshots/${source.referenceSnapshot.id}` ? source.referenceSnapshot
      : p === `${logoBase}/refinements` ? { ownerId, projectId, items: [], nextCursor: null } : null;
    await route.fulfill({ status: value ? 200 : 503, json: value ?? {} });
  });
  await page.goto(`/brands/account/${projectId}/logo`);
  await expect(page.locator("[data-generation-animation]")).toHaveCount(6);
  expect(await page.locator("[data-generation-animation]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-generation-animation")))).toEqual(["1", "2", "3", "4", "5", "6"]);
  await page.screenshot({ path: info.outputPath("image-fx-logo-loading.png"), fullPage: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("[data-generation-animation] canvas")).toHaveCount(0);
  await expect(page.locator('[data-image-fx-preset="pixels-organic"]')).toHaveCount(6);
  await expect(page.getByText("Creating your concept", { exact: true })).toHaveCount(6);
});
