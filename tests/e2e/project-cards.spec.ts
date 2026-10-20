import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { syntheticPng } from "../features/logo-vector/raster-fixtures";
import { syntheticLogoBatch, syntheticLogoWorkspace, syntheticResolvedLogoConcept, logoFixtureId as id } from "../fixtures/logo-creation";
import type { LogoStageRevision } from "../../src/domain/logo-workspace";
import { logoStageRevisionSchema, logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { logoConceptBatchSchema } from "../../src/domain/logo-jobs";
import { accountProjectPageSchema, compareProjectCursors, projectCursor } from "../../src/domain/project-pages";
import { captureUiEvidence } from "./ui-evidence";

// Synthetic, read-only account fixtures. No provider, account write or real
// selected artwork is used by this local browser contract.
async function setup(page: Page) {
  const workspace = structuredClone(syntheticLogoWorkspace()), batch = structuredClone(syntheticLogoBatch());
  const brief = structuredClone(syntheticResolvedLogoConcept().brief);
  brief.payload.name = "Saved logo fixture";
  const slot = batch.slots[0]!, attempt = slot.attempts[0]!;
  const bytes = syntheticPng(120, 96, (x, y) => Math.abs(x - 60) + Math.abs(y - 48) < 30 && !(x > 55 && y < 42) ? [25, 25, 25, 255] : [255, 255, 255, 255]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  attempt.preview!.reference.contentHash = hash;
  attempt.preview!.verification.contentHash = hash;
  attempt.preview!.verification.byteLength = bytes.length;
  slot.acceptedPreview = attempt.preview;
  const concepts: LogoStageRevision<"concepts"> = { ...brief, id: id(800), stage: "concepts", payload: { batchIds: [batch.id], selected: { kind: "concept", batchId: batch.id, slotId: slot.id, attemptId: attempt.id } } };
  workspace.stages.brief_references = { id: brief.id, stage: "brief_references", revision: brief.revision };
  workspace.stages.concepts = { id: concepts.id, stage: "concepts", revision: concepts.revision };
  workspace.heads.stageRevisions.brief_references = brief.revision;
  workspace.heads.stageRevisions.concepts = concepts.revision;
  const rows = [
    { id: workspace.projectId, title: "Untitled brand", scope: "complete_brand" },
    { id: id(900), title: "A long project label with enough detail to demonstrate a two-line title and a stable fallback", scope: "complete_brand" },
    { id: id(901), title: "Naming project fixture", scope: "naming_only" },
  ].map(row => ({ ...row, owner_id: workspace.ownerId, current_revision: 1, lifecycle_version: 0, created_at: "2026-10-20T00:00:00Z", deletion_state: "active", deleted_at: null, deletion_requested_at: null }));
  // Use the real HTTP contracts so an invalid local fixture fails here instead
  // of masquerading as an application rendering or private-preview failure.
  const projectPage = accountProjectPageSchema.parse({ ownerId: workspace.ownerId, items: [...rows].sort((a, b) => -compareProjectCursors(projectCursor(a), projectCursor(b))), nextCursor: null });
  logoWorkspaceV2Schema.parse(workspace);
  logoStageRevisionSchema.parse(brief);
  logoStageRevisionSchema.parse(concepts);
  logoConceptBatchSchema.parse(batch);
  const state = { writes: [] as string[], previewReads: 0 };
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    if (!path.startsWith("/api/")) return route.continue();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (request.method() !== "GET") { state.writes.push(`${request.method()} ${path}`); return reply({}, 503); }
    if (path === "/api/session") return reply({ user: { id: workspace.ownerId } });
    if (path === "/api/projects/page") return reply(projectPage);
    const base = `/api/projects/${workspace.projectId}/logo`;
    if (path === base) return reply(workspace);
    if (path === `/api/projects/${id(900)}/logo`) return reply({ ...syntheticLogoWorkspace(), projectId: id(900) });
    if (path === `${base}/stages/brief_references/revisions/${brief.id}`) return reply(brief);
    if (path === `${base}/stages/concepts/revisions/${concepts.id}`) return reply(concepts);
    if (path === `${base}/batches/${batch.id}`) return reply(batch);
    if (path === `/api/assets/${attempt.preview!.reference.versionId}/preview`) { state.previewReads++; return route.fulfill({ contentType: "image/png", body: Buffer.from(bytes) }); }
    return reply({}, 404);
  });
  return { state, rows };
}

for (const route of ["/brands", "/"]) test(`saved project cards preserve labels and selected artwork on ${route === "/" ? "Home" : "Projects"}`, async ({ page }, info) => {
  await page.setViewportSize(info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const { state, rows } = await setup(page);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(route);
  const card = page.locator(`[data-project-id="${rows[0]!.id}"]`);
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole("heading", { name: "Untitled brand", exact: true })).toBeVisible();
  const image = card.getByRole("img", { name: "Saved selected logo for Saved logo fixture" });
  await expect(image).toBeVisible();
  expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(120);
  const fallback = page.locator(`[data-project-id="${rows[1]!.id}"]`);
  await fallback.scrollIntoViewIfNeeded();
  await expect(fallback.getByText("No logo selected", { exact: true })).toBeVisible();
  const title = fallback.getByRole("heading");
  await expect(title).toHaveAttribute("title", rows[1]!.title);
  const geometry = await title.evaluate(element => ({ height: element.getBoundingClientRect().height, lineHeight: getComputedStyle(element).lineHeight }));
  expect(geometry.height).toBeLessThanOrEqual(40); expect(geometry.lineHeight).toBe("20px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const open = card.getByRole("link", { name: "Continue Untitled brand", exact: true });
  await open.focus(); await page.keyboard.press("Tab");
  const options = card.getByRole("button", { name: "Project options for Untitled brand", exact: true });
  await expect(options).toBeFocused(); await options.click();
  await expect(card.getByRole("menu")).toBeVisible(); await page.keyboard.press("Escape");
  await expect(options).toBeFocused(); await expect(card.getByRole("menu")).toHaveCount(0);
  expect(state.writes).toEqual([]); expect(state.previewReads).toBe(1); expect(errors).toEqual([]);
  await card.scrollIntoViewIfNeeded(); await captureUiEvidence(page, info);
});
