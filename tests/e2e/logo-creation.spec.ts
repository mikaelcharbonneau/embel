import { expectProjectCanvas } from "./project-canvas-contract";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { DEFAULT_PROFILE_VALUES } from "../../src/domain/account-profile";
import { captureUiEvidence } from "./ui-evidence";
import { expect, test, type Page, type Route } from "@playwright/test";
import { syntheticLogoBatch, syntheticLogoQuote, syntheticLogoWorkspace, syntheticResolvedLogoConcept, logoFixtureId as id } from "../fixtures/logo-creation";
import type { LogoCostQuote, LogoGenerationIntent, LogoQuoteRequest, LogoRequestState, LogoConceptBatch } from "../../src/domain/logo-jobs";
import { logoStageRevisionSchema, type LogoBriefDraft, type LogoWorkspaceV2, type LogoStageRevision } from "../../src/domain/logo-workspace";
import { syntheticRasterRefinement } from "../fixtures/logo-refinement-history";
import type { LogoRasterRefinement } from "../../src/domain/logo-jobs";
import type { LogoRasterSource } from "../../src/domain/logo-workspace";
import { DEFAULT_LOGO_CONCEPT_TYPES } from "../../src/domain/logo-saved-inputs";

const source = syntheticResolvedLogoConcept(), url = `/brands/account/${source.input.projectId}/logo`, base = `/api/projects/${source.input.projectId}/logo`;
async function setup(page: Page, scenario: "empty" | "partial" | "uncertain" | "unavailable" | "retry_uncertain" | "uninitialized" | "save_uncertain" | "missing_name" = "empty", savedSelection: LogoRasterSource | null = null) {
  const noBrief = ["uninitialized", "save_uncertain", "missing_name"].includes(scenario);
  const batch = syntheticLogoBatch(scenario === "uninitialized" ? Array.from({ length: 6 }, () => "succeeded" as const)
    : scenario === "uncertain" ? ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "needs_reconciliation"] : undefined);
  let currentBrief = source.brief;
  let selectedConcept: LogoRasterSource | null = savedSelection;
  const foundation = syntheticLogoWorkspace();
  const batches = new Map<string, LogoConceptBatch>([[batch.id, batch]]);
  if (scenario === "retry_uncertain") {
    const previous = batch.slots[5]!.attempts[0]!;
    batches.set(batch.id, { ...batch, slots: batch.slots.map(slot => slot.id === previous.slotId ? { ...slot, attempts: [previous,
      { ...previous, id: id(955), jobId: id(956), requestKey: id(957), previousAttemptId: previous.id, attemptNumber: 2, state: "needs_reconciliation", reason: "outcome_unknown", billing: { status: "unknown", confirmedMicrousd: null } },
    ] } : slot) });
  }
  const summaries = ["partial", "uncertain", "retry_uncertain"].includes(scenario) ? [{ id: batch.id, requestKey: batch.requestKey, createdAt: batch.createdAt }] : [];
  const saved: LogoWorkspaceV2 = { ...foundation, heads: { ...foundation.heads, workspaceRevision: noBrief ? 0 : 1, stageRevisions: { ...foundation.heads.stageRevisions, brief_references: noBrief ? 0 : 1, concepts: ["partial", "uncertain"].includes(scenario) ? 1 : 0 } },
    stages: { ...foundation.stages, brief_references: noBrief ? null : { id: source.brief.id, revision: 1, stage: "brief_references" }, concepts: ["partial", "uncertain"].includes(scenario) ? { id: id(901), revision: 1, stage: "concepts" } : null },
    capabilities: { ...foundation.capabilities, save: { status: "available" }, generate: scenario === "unavailable" ? { status: "unavailable", reason: "Synthetic unavailable configuration" } : { status: "available" } } };
  const preparedBrief: LogoBriefDraft = { name: source.brief.payload.name, activity: source.brief.payload.activity, audience: source.brief.payload.audience,
    personality: "Saved inspiration · catalog 2026-10-13.1 · selection 2: synthetic lettering guidance.", logoTypes: [...DEFAULT_LOGO_CONCEPT_TYPES] };
  let refinementStage: LogoStageRevision<"refinements"> | null = null;
  const state = { owner: foundation.ownerId, posts: [] as LogoGenerationIntent[], quotes: [] as LogoQuoteRequest[], readKeys: [] as string[], lose: false,
    refinements: [] as LogoRasterRefinement[], selections: [] as { requestKey: string; batchId: string; slotId: string; attemptId: string }[], inputReads: 0, saves: [] as { requestKey: string; brief: LogoBriefDraft }[], order: [] as string[],
    request: { status: "not_found" } as LogoRequestState, quote: null as LogoCostQuote | null, quoteGate: null as Promise<void> | null, batchReads: 0, summaries, admissionRejection: false,
    advanceProjectRevisionOnly() { saved.heads = { ...saved.heads, projectRevision: saved.heads.projectRevision + 1 }; },
    commitRefinement(record: LogoRasterRefinement) {
      // Model the committed workspace acknowledgement, not only the polling
      // receipt. Production cannot select a result before that stage is saved.
      state.refinements = state.refinements.map(item => item.id === record.id ? record : item);
      const revision = saved.heads.stageRevisions.refinements + 1;
      const parentRevisionId = saved.stages.refinements?.id ?? null;
      refinementStage = logoStageRevisionSchema.parse({ ...source.brief, id: id(1200 + revision), stage: "refinements", revision, parentRevisionId,
        payload: { rasterRevisionIds: state.refinements.filter(item => item.state === "succeeded").map(item => item.id), vectorRevisionId: null, approvalId: null, sourceRequestKey: record.requestKey } }) as LogoStageRevision<"refinements">;
      saved.heads = { ...saved.heads, workspaceRevision: saved.heads.workspaceRevision + 1, stageRevisions: { ...saved.heads.stageRevisions, refinements: revision } };
      saved.stages.refinements = { stage: "refinements", id: refinementStage.id, revision };
    },
    advanceSavedBrief() {
      saved.heads = { ...saved.heads, workspaceRevision: 2, stageRevisions: { ...saved.heads.stageRevisions, brief_references: 2 } };
      saved.stages.brief_references = { stage: "brief_references", id: id(990), revision: 2 };
      currentBrief = { ...source.brief, id: id(990), revision: 2, parentRevisionId: source.brief.id, payload: { ...source.brief.payload, activity: "Changed in another tab" } };
    } };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/*", async route => {
    const target = new URL(route.request().url());
    if (target.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    if (!target.pathname.startsWith("/api/")) return route.continue();
    const path = target.pathname, request = route.request();
    if (path === "/api/session") return json(route, { user: { id: state.owner } });
    if (state.owner !== foundation.ownerId) return json(route, {}, 404);
    if (path === "/api/account/profile") return json(route, { profile: { ownerId: foundation.ownerId, email: "fixture@example.invalid", revision: 0, updatedAt: null, values: DEFAULT_PROFILE_VALUES } });
    if (path === `/api/projects/${foundation.projectId}`) return json(route, { project: { id: foundation.projectId, owner_id: foundation.ownerId, title: "Élan & Co · local fixture", scope: "complete_brand", current_revision: 1, created_at: "2026-10-18T00:00:00Z", context: contextSnapshotSchema.parse({ description: "Synthetic logo layout fixture. No live generation." }) } });
    if (path === `${base}/capabilities`) {
      const available = { status: "available", expiresAt: new Date(Date.now() + 30_000).toISOString() };
      return json(route, { ownerId: foundation.ownerId, projectId: foundation.projectId, observedAt: new Date().toISOString(), operations: {
        "identity.logo_concept": scenario === "unavailable" ? { status: "unavailable" } : available,
        "identity.logo_refine": scenario === "unavailable" ? { status: "unavailable" } : available,
        "identity.logo_vectorize": { status: "unavailable" }, "identity.logo_directions": { status: "unavailable" }, "identity.logo_export": { status: "unavailable" },
      } });
    }
    if (path === base) return json(route, saved);
    if (path === `${base}/saved-inputs`) {
      state.inputReads++; state.order.push("inputs");
      return json(route, { ownerId: foundation.ownerId, projectId: foundation.projectId, projectRevision: 1, inspirationSelectionRevision: 2,
        inspirationCount: 2, nameConflict: false, draft: scenario === "missing_name" ? null : noBrief ? preparedBrief : { name: currentBrief.payload.name, activity: currentBrief.payload.activity, audience: currentBrief.payload.audience, personality: currentBrief.payload.personality, logoTypes: currentBrief.payload.logoTypes } });
    }
    if ((path === `${base}/initialize` || path === `${base}/brief`) && request.method() !== "GET") {
      const body = request.postDataJSON() as { requestKey: string; brief: LogoBriefDraft };
      state.saves.push(body); state.order.push("save");
      const revision = saved.heads.stageRevisions.brief_references + 1;
      currentBrief = { ...source.brief, revision, parentRevisionId: revision === 1 ? null : currentBrief.id,
        payload: { ...source.brief.payload, ...body.brief } };
      saved.heads = { ...saved.heads, workspaceRevision: saved.heads.workspaceRevision + 1,
        stageRevisions: { ...saved.heads.stageRevisions, brief_references: revision } };
      saved.stages.brief_references = { stage: "brief_references", id: currentBrief.id, revision };
      if (scenario === "save_uncertain") return route.abort("failed");
      return json(route, { ownerId: foundation.ownerId, projectId: foundation.projectId, requestKey: body.requestKey, workspace: saved, revision: currentBrief });
    }
    if (path === `${base}/stages/brief_references/revisions/${currentBrief.id}`) return json(route, currentBrief);
    if (path === `${base}/stages/brief_references/revisions/${source.brief.id}`) return json(route, source.brief);
    if (path === `${base}/reference-snapshots/${source.referenceSnapshot.id}`) return json(route, source.referenceSnapshot);
    const concepts = () => ({ ...source.brief, createdAt: new Date().toISOString(), id: saved.stages.concepts?.id ?? id(901), revision: saved.heads.stageRevisions.concepts, parentRevisionId: saved.heads.stageRevisions.concepts > 1 ? id(899 + saved.heads.stageRevisions.concepts) : null, stage: "concepts", payload: { batchIds: [batch.id], selected: selectedConcept } });
    if (path === `${base}/rasters/selection`) {
      const body = request.postDataJSON() as { requestKey: string; source: LogoRasterSource };
      selectedConcept = body.source;
      const revision = saved.heads.stageRevisions.concepts + 1;
      saved.heads = { ...saved.heads, workspaceRevision: saved.heads.workspaceRevision + 1, stageRevisions: { ...saved.heads.stageRevisions, concepts: revision } };
      saved.stages.concepts = { stage: "concepts", id: id(900 + revision), revision };
      return json(route, { ownerId: saved.ownerId, projectId: saved.projectId, requestKey: body.requestKey, workspace: saved, revision: concepts() });
    }
    if (path === `${base}/concepts/selection`) {
      const body = request.postDataJSON() as { requestKey: string; batchId: string; slotId: string; attemptId: string };
      state.selections.push(body);
      selectedConcept = { kind: "concept", batchId: body.batchId, slotId: body.slotId, attemptId: body.attemptId };
      const revision = saved.heads.stageRevisions.concepts + 1;
      saved.heads = { ...saved.heads, workspaceRevision: saved.heads.workspaceRevision + 1, stageRevisions: { ...saved.heads.stageRevisions, concepts: revision } };
      saved.stages.concepts = { stage: "concepts", id: id(900 + revision), revision };
      return json(route, { ownerId: saved.ownerId, projectId: saved.projectId, requestKey: body.requestKey, workspace: saved, revision: concepts() });
    }
    if (path === `${base}/stages/concepts/revisions/${saved.stages.concepts?.id ?? id(901)}`) return json(route, concepts());
    if (refinementStage && path === `${base}/stages/refinements/revisions/${refinementStage.id}`) return json(route, refinementStage);
    if (path === `${base}/batches`) return json(route, { ownerId: foundation.ownerId, projectId: foundation.projectId, items: state.summaries, nextCursor: null });
    if (path.startsWith(`${base}/batches/`)) { state.batchReads++; const found = batches.get(path.split("/").at(-1)!); return json(route, found ?? {}, found ? 200 : 404); }
    if (path === `${base}/quotes`) {
      state.order.push("quote");
      const body = request.postDataJSON() as LogoQuoteRequest; state.quotes.push(body);
      state.quote = { ...syntheticLogoQuote(), request: body, expected: saved.heads, expiresAt: new Date(Date.now() + 60000).toISOString(),
        conceptPlan: body.operation === "retry_failed" || body.operation === "refine_preview" ? null : batch.plan,
        targetSlotIds: body.operation === "retry_failed" ? body.failedSlotIds : body.operation === "refine_preview" ? [id(110)] : batch.slots.map(slot => slot.id) };
      if (state.quoteGate) await state.quoteGate;
      return json(route, state.quote);
    }
    if (path === `${base}/requests` && request.method() === "POST") {
      const body = request.postDataJSON() as LogoGenerationIntent; state.posts.push(body);
      if (state.admissionRejection) return json(route, { error: { code: "conflict", message: "This request conflicts with the current state." }, rejection: { status: "rejected", ownerId: foundation.ownerId, projectId: foundation.projectId, requestKey: body.requestKey, quoteId: body.quoteId } }, 409);
      if (state.quote?.request.operation === "refine_preview") {
        state.refinements.unshift(syntheticRasterRefinement({ id: id(503 + state.posts.length), requestKey: body.requestKey, jobId: id(600), source: state.quote.request.source,
          state: "queued", preview: null, providerResponseReceiptId: null, billing: { status: "recorded", confirmedMicrousd: 0 } }));
        const receipt = { ownerId: foundation.ownerId, projectId: foundation.projectId, requestKey: body.requestKey, operation: "identity.logo_refine" as const, batchId: null, jobIds: [id(600)], inputHash: "b".repeat(64) };
        state.request = { status: "admitted", requestKey: body.requestKey, receipt, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: null };
        return json(route, receipt);
      }
      const admittedBatchId = state.quote?.request.operation === "more_concepts" ? id(980 + state.posts.length) : batch.id;
      const admittedBatch = { ...batch, id: admittedBatchId, requestKey: body.requestKey, createdAt: new Date().toISOString() };
      batches.set(admittedBatchId, admittedBatch);
      if (!state.summaries.some(item => item.id === admittedBatchId)) state.summaries.unshift({ id: admittedBatchId, requestKey: body.requestKey, createdAt: admittedBatch.createdAt });
      const receipt = { ownerId: foundation.ownerId, projectId: foundation.projectId, requestKey: body.requestKey, operation: "identity.logo_concept" as const, batchId: admittedBatchId, jobIds: [id(600)], inputHash: "b".repeat(64) };
      state.request = { status: "admitted", requestKey: body.requestKey, receipt, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: null };
      if (state.lose) return route.abort("failed");
      return json(route, receipt);
    }
    if (path.startsWith(`${base}/requests/`)) {
      const key = path.replace(/\/reconcile$/, "").split("/").at(-1)!; state.readKeys.push(key);
      if (scenario === "retry_uncertain" && key === id(957)) return json(route, { status: "needs_reconciliation", requestKey: key, receipt: null, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: "outcome_unknown" });
      return json(route, state.request);
    }
    if (path === `${base}/raster-refinements`) return json(route, { ownerId: foundation.ownerId, projectId: foundation.projectId, items: state.refinements, nextCursor: null });
    if (path.startsWith(`${base}/raster-refinements/`)) return json(route, state.refinements.find(record => record.id === path.split("/").at(-1)));
    if (path.endsWith("/preview")) return json(route, {}, 503);
    return json(route, {}, 503);
  });
  await page.goto(url);
  if (noBrief) {
    await expect(page.getByRole("heading", { name: "Explore your logo", exact: true })).toBeVisible();
    return state;
  }
  await page.getByRole("button", { name: "Project context", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Brand name" })).toHaveValue("Élan & Co");
  await page.getByRole("button", { name: "Close project context" }).click();
  return state;
}

test("saved brief seven types and explicit estimate click precede every generation", async ({ page }) => {
  const f = await setup(page); expect(f.posts).toHaveLength(0);
  await page.getByRole("button", { name: "Generate six concepts" }).click();
  const dialog = page.getByRole("dialog", { name: "Review generation cost" }); await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Not included in this batch: Mascot"); await expect(dialog).toContainText("Estimated cost"); await expect(dialog).toContainText("Maximum cost");
  expect(f.posts).toHaveLength(0); await dialog.getByRole("button", { name: "Generate 6 concepts", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1); await expect(dialog).not.toBeVisible(); expect(f.quotes[0]?.operation).toBe("concepts");
});
test("Escape cancels without admission and returns keyboard focus", async ({ page }) => {
  const f = await setup(page), trigger = page.getByRole("button", { name: "Generate six concepts" });
  await trigger.focus(); await trigger.press("Enter"); await expect(page.getByRole("dialog")).toBeVisible(); await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible(); await expect(trigger).toBeFocused(); expect(f.posts).toHaveLength(0);
});
test("partial results retain five cards and retry scope excludes successful concepts", async ({ page }) => {
  const f = await setup(page, "partial"); await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
  await expect(page.getByText("Image preview · Vector conversion and approval follow separately.", { exact: true })).toHaveCount(5);
  await page.getByRole("button", { name: "Retry 1 failed concept", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible(); expect(f.posts).toHaveLength(0);
  expect(f.quotes[0]).toMatchObject({ operation: "retry_failed", failedSlotIds: [id(115)] });
  await expect(page.getByRole("dialog")).toContainText("Concept 6");
  const previousReads = f.batchReads;
  await page.getByRole("dialog").getByRole("button", { name: "Retry 1 failed concept", exact: true }).click();
  await expect.poll(() => f.batchReads).toBeGreaterThan(previousReads);
  expect(f.posts).toHaveLength(1);
});
test("lost admission response recovers by original key without a second generation post", async ({ page }) => {
  const f = await setup(page); f.lose = true;
  await page.getByRole("button", { name: "Generate six concepts" }).click(); await page.getByRole("dialog").getByRole("button", { name: "Generate 6 concepts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check original generation request" })).toBeVisible();
  await page.getByRole("button", { name: "Check original generation request" }).click();
  await expect.poll(() => f.readKeys.length).toBeGreaterThan(0); expect(f.readKeys).toContain(f.posts[0]!.requestKey); expect(f.posts).toHaveLength(1);
});
test("unavailable generation preserves saved brief and stays within mobile viewport", async ({ page }) => {
  const f = await setup(page, "unavailable"); await expect(page.getByRole("button", { name: "Generate six concepts" })).toBeEnabled();
  await page.getByRole("button", { name: "Project context", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Brand name" })).toHaveValue("Élan & Co");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(f.posts).toHaveLength(0);
});


test("an unselected first exploration survives full reload with no concept-stage pointer", async ({ page }) => {
  const f = await setup(page);
  await page.getByRole("button", { name: "Generate six concepts" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Generate 6 concepts", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1); await page.reload();
  await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Project context", exact: true }).click();
  await page.getByText("Saved inputs and recovery", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Concept batch" })).toHaveValue(id(60)); expect(f.posts).toHaveLength(1);
});

test("an unselected More exploration is latest after reload and its earlier batch stays reachable", async ({ page }) => {
  const f = await setup(page, "partial"); await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More concepts", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Generate 6 more concepts", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1); await page.reload();
  await page.getByRole("button", { name: "Project context", exact: true }).click();
  await page.getByText("Saved inputs and recovery", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Concept batch" })).toHaveValue(id(981));
  await page.getByRole("combobox", { name: "Concept batch" }).selectOption(id(60));
  await page.getByRole("button", { name: "Close project context" }).click();
  await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible(); expect(f.posts).toHaveLength(1);
});

test("a reloaded uncertain retry checks its attempt identity and keeps five successful previews", async ({ page }) => {
  const f = await setup(page, "retry_uncertain"); await page.reload();
  await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check request", exact: true }).click();
  await expect.poll(() => f.readKeys.filter(key => key === id(957)).length).toBeGreaterThan(0);
  expect(f.readKeys).not.toContain(id(61)); expect(f.posts).toHaveLength(0);
  await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
});

test("a durable admission rejection offers a fresh review without silently generating again", async ({ page }) => {
  const f = await setup(page); f.admissionRejection = true;
  await page.getByRole("button", { name: "Generate six concepts" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Generate 6 concepts", exact: true }).click();
  await page.getByRole("button", { name: "Return to cost review" }).click(); expect(f.posts).toHaveLength(1);
  await page.getByRole("button", { name: "Generate six concepts" }).click(); await expect(page.getByRole("dialog")).toBeVisible(); expect(f.posts).toHaveLength(1);
});


test("return to cost review refreshes an H1 rejection to the other tab's saved H2 inputs", async ({ page }) => {
  const f = await setup(page);
  await page.getByRole("button", { name: "Generate six concepts" }).click();
  await expect(page.getByRole("dialog")).toBeVisible(); f.advanceSavedBrief(); f.admissionRejection = true;
  await page.getByRole("dialog").getByRole("button", { name: "Generate 6 concepts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Generate six concepts" })).toBeDisabled();
  await page.getByRole("button", { name: "Return to cost review" }).click();
  await expect(page.getByRole("button", { name: "Generate six concepts" })).toBeEnabled();
  await page.getByRole("button", { name: "Generate six concepts" }).click(); await expect(page.getByRole("dialog")).toBeVisible();
  expect(f.quotes[1]).toMatchObject({ expected: { workspaceRevision: 2, stageRevisions: { brief_references: 2 } }, briefRevisionId: id(990) });
  expect(f.posts).toHaveLength(1);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));

test("concepts landing matches the reference layout without inventing generated results", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const f = await setup(page);
  await expect(page.getByRole("heading", { name: "Explore your logo", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to inspiration" })).toHaveAttribute("href", `/brands/account/${source.input.projectId}/inspiration`);
  await expect(page.getByRole("link", { name: "Back to inspiration" })).toBeVisible();
  await expect(page.locator("header").getByRole("combobox", { name: "Concept batch" })).toHaveCount(0);
  await expect(page.locator('[data-concept-ordinal]')).toHaveCount(6);
  await expect(page.getByText(/^Review concept \d/)).toHaveCount(0);
  await expect(page.getByText("More, refine and retry each require a separate cost review.", { exact: false })).toHaveCount(0);
  await expectProjectCanvas(page);
  await expect(page.getByRole("form", { name: "Logo concept changes" })).toBeInViewport();
  const cards = page.locator('[data-concept-ordinal]');
  const first = await cards.nth(0).boundingBox(), second = await cards.nth(1).boundingBox(), third = await cards.nth(2).boundingBox();
  if (info.project.name === "desktop") {
    expect(first!.y).toBe(second!.y); expect(second!.y).toBe(third!.y);
    expect(first!.x).toBeLessThan(second!.x); expect(second!.x).toBeLessThan(third!.x);
  } else expect(second!.y).toBeGreaterThan(first!.y);
  await page.getByRole("button", { name: "Selected", exact: true }).click();
  await expect(page.getByText("No concept selected in this batch.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "All concepts · 6", exact: true }).click();
  await expect(cards).toHaveCount(6);
  expect(f.quotes).toHaveLength(0); expect(f.posts).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("concepts-layout.png") });
});

test("new logo work saves brand and Inspiration before one explicit six-concept request", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const f = await setup(page, "uninitialized");
  expect(page.url()).toContain(url);
  await expect(page).toHaveTitle("Logo creation synthetic fixture");
  const generate = page.getByRole("button", { name: "Generate six concepts", exact: true });
  await expect(generate).toBeEnabled();
  await expect(generate).toBeInViewport();
  expect(f.saves).toHaveLength(0); expect(f.quotes).toHaveLength(0); expect(f.posts).toHaveLength(0);
  await generate.click();
  const review = page.getByRole("dialog", { name: "Review generation cost" });
  await expect(review).toBeVisible();
  expect(f.order).toEqual(["inputs", "save", "quote"]);
  expect(f.saves).toHaveLength(1);
  expect(f.saves[0]!.brief).toMatchObject({ name: "Élan & Co", activity: "Tea shop", audience: "Local readers", logoTypes: DEFAULT_LOGO_CONCEPT_TYPES });
  expect(f.saves[0]!.brief.personality).toContain("selection 2");
  expect(f.quotes[0]).toMatchObject({ operation: "concepts", briefRevisionId: source.brief.id, expected: { workspaceRevision: 1, stageRevisions: { brief_references: 1 } } });
  expect(f.posts).toHaveLength(0);
  await review.getByRole("button", { name: "Generate 6 concepts", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1);
  await expect(review).not.toBeVisible();
  await page.reload();
  await expect(page.getByText("6 of 6 concepts ready", { exact: true })).toBeVisible();
  expect(f.saves).toHaveLength(1); expect(f.posts).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("an uncertain initial brief save keeps its original intent and cannot quote or generate", async ({ page }) => {
  const f = await setup(page, "save_uncertain");
  await page.getByRole("button", { name: "Generate six concepts", exact: true }).click();
  await expect.poll(() => f.saves.length).toBe(1);
  await expect(page.getByText("Your logo inputs have not been confirmed as saved.", { exact: false })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Review generation cost" })).toHaveCount(0);
  expect(f.quotes).toHaveLength(0); expect(f.posts).toHaveLength(0);
  await page.getByRole("button", { name: "Project context", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Brand name" })).toHaveValue("Élan & Co");
  await page.getByText("Saved inputs and recovery", { exact: true }).click();
  await expect(page.getByText("A previous save is awaiting confirmation.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check original save", exact: true })).toBeVisible();
  expect(f.saves).toHaveLength(1);
});

test("a project without a saved brand name is guided back before any logo write", async ({ page }) => {
  const f = await setup(page, "missing_name");
  await page.getByRole("button", { name: "Generate six concepts", exact: true }).click();
  await expect(page.getByText("Choose and save a brand name in your project before generating logo concepts.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open project to choose a name" })).toHaveAttribute("href", `/brands/account/${source.input.projectId}`);
  expect(f.inputReads).toBe(1); expect(f.saves).toHaveLength(0); expect(f.quotes).toHaveLength(0); expect(f.posts).toHaveLength(0);
});


test("clicking a logo selects it in place and persists without an inspection screen", async ({ page }) => {
  const f = await setup(page, "partial");
  const first = page.getByRole("button", { name: "Select concept 1", exact: true });
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Project logo choice saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Explore your logo", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Refine a direction", exact: true })).toHaveCount(0);
  expect(f.selections).toHaveLength(1);
  expect(f.posts).toHaveLength(0); expect(f.quotes).toHaveLength(0);
  await page.reload();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Select concept 2", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Select concept 2", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(first).toHaveAttribute("aria-pressed", "false");
  expect(f.selections).toHaveLength(2);
});


test("composer refines the saved selected concept in place with the entered changes", async ({ page }) => {
  const f = await setup(page, "partial");
  const send = page.locator('form[aria-label="Logo concept changes"] button[type="submit"]');
  await expect(send).toBeDisabled();
  await page.getByRole("button", { name: "Select concept 2", exact: true }).click();
  await expect(page.getByText("Refinement target: Concept 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refine logo", exact: true }).click();
  await page.getByRole("textbox", { name: "Describe logo changes" }).fill("Make the monogram more rounded and increase the inner spacing.");
  await expect(send).toBeEnabled();
  f.advanceProjectRevisionOnly();
  await send.click();
  const review = page.getByRole("dialog", { name: "Review generation cost" });
  await expect(review).toBeVisible(); expect(f.posts).toHaveLength(0);
  await expect(review).toContainText("Estimated cost"); await expect(review).toContainText("Maximum cost");
  await expect(review).toContainText("Make the monogram more rounded and increase the inner spacing.");
  await review.getByRole("button", { name: "Refine this concept", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1);
  await expect(review).not.toBeVisible();
  expect(f.quotes).toHaveLength(1);
  expect(f.quotes[0]).toMatchObject({ operation: "refine_preview", expected: { projectRevision: 2 }, source: { kind: "concept", slotId: id(111) }, instruction: "Make the monogram more rounded and increase the inner spacing." });
  expect(f.posts).toHaveLength(1);
  await expect(page.getByRole("heading", { name: "Refine a direction", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Describe logo changes" })).toHaveValue("Make the monogram more rounded and increase the inner spacing.");
  await expect(send).toBeDisabled();
});

test("canceling a delayed refinement quote restores the visible collapsed disclosure", async ({ page }) => {
  const batch = syntheticLogoBatch(), slot = batch.slots[0]!, attempt = slot.attempts[0]!;
  const f = await setup(page, "partial", { kind: "concept", batchId: batch.id, slotId: slot.id, attemptId: attempt.id });
  let release!: () => void;
  f.quoteGate = new Promise<void>(resolve => { release = resolve; });
  const form = page.getByRole("form", { name: "Logo concept changes" });
  await form.getByRole("button", { name: "Refine logo", exact: true }).click();
  await form.getByRole("textbox", { name: "Describe logo changes" }).fill("Retained instruction during quote");
  await form.getByRole("button", { name: "Review refinement cost", exact: true }).click();
  await expect.poll(() => f.quotes.length).toBe(1);
  await form.getByRole("button", { name: "Close refinement", exact: true }).click();
  await expect(form.getByRole("textbox", { name: "Describe logo changes" })).toBeHidden();
  release();
  const dialog = page.getByRole("dialog", { name: "Review generation cost", exact: true });
  await expect(dialog).toBeVisible(); await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form.getByRole("button", { name: "Refine logo", exact: true })).toBeFocused();
  expect(f.posts).toEqual([]); expect(f.selections).toEqual([]);
});

test("refinement disclosure reserves space, preserves edits and keeps context keyboard accessible", async ({ page }, info) => {
  await page.setViewportSize(info.project.name === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const batch = syntheticLogoBatch(), slot = batch.slots[0]!, attempt = slot.attempts[0]!;
  const f = await setup(page, "partial", { kind: "concept", batchId: batch.id, slotId: slot.id, attemptId: attempt.id });
  const form = page.getByRole("form", { name: "Logo concept changes" });
  const toggle = form.getByRole("button", { name: "Refine logo", exact: true });
  const input = form.getByRole("textbox", { name: "Describe logo changes" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(input).toBeHidden();
  expect(await form.evaluate(node => getComputedStyle(node).position)).toBe("relative");
  await form.getByRole("button", { name: "Project context", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Project context", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form.getByRole("button", { name: "Project context", exact: true })).toBeFocused();
  await toggle.click();
  await input.fill("Retained local fixture instruction");
  const formBox = await form.boundingBox(), cardBox = await page.locator('[data-concept-ordinal="0"]').boundingBox();
  expect(formBox!.y + formBox!.height).toBeLessThanOrEqual(cardBox!.y);
  await form.getByRole("button", { name: "Close refinement", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await toggle.click(); await expect(input).toHaveValue("Retained local fixture instruction");
  await expect(form.getByText("Refinement target: Concept 1", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Continue to brand board" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("link", { name: "Continue to brand board" })).toBeInViewport();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await form.getByRole("button", { name: "Close refinement", exact: true }).click();
  await form.scrollIntoViewIfNeeded(); await captureUiEvidence(page, info);
  expect(f.selections).toEqual([]); expect(f.quotes).toEqual([]); expect(f.posts).toEqual([]); expect(f.saves).toEqual([]);
});


test("a saved refinement can be selected and edited again without leaving concepts", async ({ page }) => {
  const f = await setup(page, "partial");
  const refinement = syntheticRasterRefinement();
  f.refinements.push(refinement);
  await page.reload();
  await page.getByRole("button", { name: "Select concept 1", exact: true }).click();
  await expect(page.getByText("Refinement target: Concept 1 · Version 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue to brand board" })).toHaveAttribute("href", /\/brand-board$/);
  await page.getByRole("button", { name: "Refine logo", exact: true }).click();
  await page.getByRole("textbox", { name: "Describe logo changes" }).fill("Make the lettering slightly wider.");
  await page.getByRole("textbox", { name: "Describe logo changes" }).focus();
  await page.keyboard.press("Control+Enter");
  const review = page.getByRole("dialog", { name: "Review generation cost" });
  await expect(review).toBeVisible(); expect(f.posts).toHaveLength(0);
  await review.getByRole("button", { name: "Refine this image refinement", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1);
  expect(f.quotes.at(-1)).toMatchObject({ operation: "refine_preview", source: { kind: "refinement", rasterRevisionId: refinement.id }, instruction: "Make the lettering slightly wider." });
  expect(f.posts).toHaveLength(1);
});


test("a running chat edit becomes a selectable saved refinement without reloading", async ({ page }) => {
  const f = await setup(page, "partial");
  await page.getByRole("button", { name: "Select concept 1", exact: true }).click();
  await page.getByRole("button", { name: "Refine logo", exact: true }).click();
  await page.getByRole("textbox", { name: "Describe logo changes" }).fill("Increase the letter spacing slightly.");
  await page.getByRole("button", { name: "Review refinement cost", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review generation cost" });
  await expect(review).toBeVisible(); expect(f.posts).toHaveLength(0);
  await review.getByRole("button", { name: "Refine this concept", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1);
  const result = page.getByRole("combobox", { name: "Versions for concept 1" });
  await expect(result).toHaveCount(0);
  const queued = f.refinements[0]!;
  const completed = { ...syntheticRasterRefinement(), id: queued.id, requestKey: queued.requestKey, jobId: queued.jobId, source: queued.source };
  f.commitRefinement(completed);
  if (f.request.status === "not_found") throw new Error("Synthetic admission missing");
  f.request = { ...f.request, status: "succeeded", billing: completed.billing, outputs: [completed.preview!] };
  await expect(result).toBeVisible();
  await expect(page.locator("[data-concept-ordinal]")).toHaveCount(6);
  await expect(page.getByText("Saved image refinements could not be read.", { exact: false })).toHaveCount(0);
  expect(f.posts).toHaveLength(1);
  await expect(page.getByText("Refinement target: Concept 1 · Version 2", { exact: true })).toBeVisible();
  await result.selectOption({ label: "Original" });
  await expect(page.getByText("Refinement target: Concept 1", { exact: true })).toBeVisible();
  await page.reload();
  await expect(result).toHaveValue(/concept/);
  await result.selectOption({ label: "Version 2 · Latest" });
  await expect(page.getByText("Refinement target: Concept 1 · Version 2", { exact: true })).toBeVisible();
});


test("brand board fits the desktop viewport and remains readable on mobile", async ({ page }) => {
  await page.goto("/brand-board-layout-fixture");
  await expect(page.getByRole("heading", { name: "Proposed palette", exact: true })).toBeVisible();
  await expect(page.getByText("From saved inspiration", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Proposed typography", exact: true })).toBeVisible();
  await expect(page.getByText("Geist Sans · Default preview", { exact: true })).toBeVisible();
  await expect(page.getByText("Glide · Saved selection", { exact: true })).toBeVisible();
  await expect(page.getByText("Application preview · Placeholder copy", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Website landing page" })).toHaveAccessibleDescription("Application preview · Placeholder copy");
  await expect(page.getByRole("region", { name: "Social announcement" })).toHaveAccessibleDescription("Application preview · Placeholder copy");
  await expect(page.getByText("Your brand introduction goes here.", { exact: true })).toBeVisible();
  await expect(page.getByText("Your announcement goes here.", { exact: true })).toBeVisible();
  const logo = await page.getByRole("region", { name: "Selected brand logo" }).boundingBox();
  const palette = await page.getByRole("region", { name: "Proposed palette" }).boundingBox();
  expect(logo).not.toBeNull();
  expect(palette).not.toBeNull();
  if (page.viewportSize()!.width > 700) {
    expect(Math.abs(logo!.y - palette!.y)).toBeLessThan(2);
    expect(palette!.x).toBeGreaterThan(logo!.x + logo!.width);
  } else {
    expect(palette!.y).toBeGreaterThan(logo!.y + logo!.height);
  }
  const main = page.getByRole("main", { name: "Brand board layout fixture" });
  expect(await main.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  if (page.viewportSize()!.width > 1000) {
    expect(await main.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
    const tiles = await page.locator("[data-brand-board-layout] > section").evaluateAll(nodes => nodes.map(node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom, clipped: node.scrollHeight > node.clientHeight + 1 })));
    expect(tiles).toHaveLength(6);
    for (const tile of tiles) {
      expect(tile.top).toBeGreaterThanOrEqual(0);
      expect(tile.bottom).toBeLessThanOrEqual(page.viewportSize()!.height);
      expect(tile.clipped).toBe(false);
    }
    await main.hover();
    await page.mouse.wheel(0, 1500);
    expect(await main.evaluate(node => node.scrollTop)).toBe(0);
  } else {
    await main.hover();
    await page.mouse.wheel(0, 1500);
    await expect.poll(() => main.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  }
  await page.getByRole("heading", { name: "Website landing page", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("heading", { name: "Website landing page", exact: true })).toBeVisible();
  await expect(page.getByText("Design notes & specifications", { exact: true })).toHaveCount(0);
  const mockups = await page.locator("[data-application-mockup]").evaluateAll(nodes => nodes.map(node => {
    const scene = node.getBoundingClientRect(), frame = node.firstElementChild!.getBoundingClientRect();
    return { top: frame.top - scene.top, bottom: scene.bottom - frame.bottom, left: frame.left - scene.left, right: scene.right - frame.right };
  }));
  expect(mockups).toHaveLength(3);
  for (const frame of mockups) for (const edge of Object.values(frame)) expect(edge).toBeGreaterThanOrEqual(-1);

  expect(await main.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});
