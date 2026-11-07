import { checkDialogHitTesting } from "./dialog-hit-testing";
import { expectProjectCanvas } from "./project-canvas-contract";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { DEFAULT_PROFILE_VALUES } from "../../src/domain/account-profile";
import { captureUiEvidence } from "./ui-evidence";
import { expect, test, type Page, type Route } from "@playwright/test";
import { syntheticLogoBatch, syntheticLogoQuote, syntheticLogoWorkspace, syntheticResolvedLogoConcept, logoFixtureId as id } from "../fixtures/logo-creation";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { logoCostQuoteSchema } from "../../src/domain/logo-jobs";
import type { LogoCostQuote, LogoGenerationIntent, LogoQuoteRequest, LogoRequestState, LogoConceptBatch } from "../../src/domain/logo-jobs";
import { logoStageRevisionSchema, type LogoBriefDraft, type LogoWorkspaceV2, type LogoStageRevision } from "../../src/domain/logo-workspace";
import { syntheticRasterRefinement } from "../fixtures/logo-refinement-history";
import type { LogoRasterRefinement } from "../../src/domain/logo-jobs";
import type { LogoRasterSource } from "../../src/domain/logo-workspace";
import { DEFAULT_LOGO_CONCEPT_TYPES } from "../../src/domain/logo-saved-inputs";

const source = syntheticResolvedLogoConcept(), url = `/brands/account/${source.input.projectId}/logo`, base = `/api/projects/${source.input.projectId}/logo`;
async function setup(page: Page, scenario: "empty" | "partial" | "uncertain" | "unavailable" | "retry_uncertain" | "uninitialized" | "save_uncertain" | "missing_name" | "quote_failed" | "quote_expired" | "unknown_estimate" | "inputs_failed" | "input_review" | "save_unavailable" = "empty", savedSelection: LogoRasterSource | null = null) {
  const noBrief = ["uninitialized", "save_uncertain", "missing_name", "save_unavailable"].includes(scenario);
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
    capabilities: { ...foundation.capabilities, save: scenario === "save_unavailable" ? { status: "unavailable", reason: "Synthetic saving outage" } : { status: "available" }, generate: scenario === "unavailable" ? { status: "unavailable", reason: "Synthetic unavailable configuration" } : { status: "available" } } };
  const preparedBrief: LogoBriefDraft = { name: source.brief.payload.name, activity: source.brief.payload.activity, audience: source.brief.payload.audience,
    personality: "Saved inspiration · catalog 2026-10-13.1 · selection 2: synthetic lettering guidance.", logoTypes: [...DEFAULT_LOGO_CONCEPT_TYPES] };
  let refinementStage: LogoStageRevision<"refinements"> | null = null;
  const state = { owner: foundation.ownerId, posts: [] as LogoGenerationIntent[], quotes: [] as LogoQuoteRequest[], readKeys: [] as string[], lose: false,
    refinements: [] as LogoRasterRefinement[], selections: [] as { requestKey: string; batchId: string; slotId: string; attemptId: string }[], inputReads: 0, saves: [] as { requestKey: string; brief: LogoBriefDraft }[], order: [] as string[],
    issuedQuotes: new Map<string, LogoCostQuote>(), request: { status: "not_found" } as LogoRequestState, quote: null as LogoCostQuote | null, quoteGate: null as Promise<void> | null, failQuotes: scenario === "quote_failed", failInputReads: scenario === "inputs_failed", batchReads: 0, summaries, admissionRejection: false,
    restoreSaving() { saved.capabilities.save = { status: "available" }; },
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
      if (state.failInputReads) return json(route, {}, 503);
      return json(route, { ownerId: foundation.ownerId, projectId: foundation.projectId, projectRevision: 1, inspirationSelectionRevision: 2,
        inspirationCount: 2, nameConflict: scenario === "input_review", draft: scenario === "missing_name" ? null : noBrief ? preparedBrief : { name: currentBrief.payload.name, activity: currentBrief.payload.activity, audience: currentBrief.payload.audience, personality: currentBrief.payload.personality, logoTypes: currentBrief.payload.logoTypes } });
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
      const rawQuote: Record<string, unknown> = { ...syntheticLogoQuote(), id: id(1400 + state.quotes.length), request: body, expected: saved.heads, expiresAt: new Date(Date.now() + (scenario === "quote_expired" ? 2000 : 60000)).toISOString(),
        conceptPlan: body.operation === "refine_preview" ? null : batch.plan,
        targetSlotIds: body.operation === "retry_failed" ? body.failedSlotIds : body.operation === "refine_preview" ? [] : batch.slots.map(slot => slot.id) };
      delete rawQuote.maxCostMicrousd; delete rawQuote.externalProviderCostMicrousd;
      const quote = logoCostQuoteSchema.parse({ ...rawQuote, version: 3, billingMode: "openai_api", spendControl: "uncapped", provider: "openai", model: IMAGE_MODEL,
        handlerVersion: "logo-image-v1", estimatedCostMicrousd: scenario === "unknown_estimate" ? null : rawQuote.estimatedCostMicrousd });
      state.quote = quote; state.issuedQuotes.set(quote.id, quote);
      if (state.quoteGate) await state.quoteGate;
      return json(route, quote, state.failQuotes ? 503 : 200);
    }
    if (path === `${base}/requests` && request.method() === "POST") {
      const body = request.postDataJSON() as LogoGenerationIntent; state.posts.push(body);
      const quote = state.issuedQuotes.get(body.quoteId);
      if (state.admissionRejection) return json(route, { error: { code: "conflict", message: "This request conflicts with the current state." }, rejection: { status: "rejected", ownerId: foundation.ownerId, projectId: foundation.projectId, requestKey: body.requestKey, quoteId: body.quoteId } }, 409);
      if (quote?.request.operation === "refine_preview") {
        state.refinements.unshift(syntheticRasterRefinement({ id: id(503 + state.posts.length), requestKey: body.requestKey, jobId: id(600), source: quote.request.source,
          state: "queued", preview: null, providerResponseReceiptId: null, billing: { status: "recorded", confirmedMicrousd: 0 } }));
        const receipt = { ownerId: foundation.ownerId, projectId: foundation.projectId, requestKey: body.requestKey, operation: "identity.logo_refine" as const, batchId: null, jobIds: [id(600)], inputHash: "b".repeat(64) };
        state.request = { status: "admitted", requestKey: body.requestKey, receipt, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: null };
        return json(route, receipt);
      }
      const admittedBatchId = quote?.request.operation === "more_concepts" ? id(980 + state.posts.length) : batch.id;
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
    await expect(page.getByRole("heading", { name: "Logo", exact: true })).toBeVisible();
    return state;
  }
  await page.getByRole("button", { name: "Project context", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Brand name" })).toHaveValue("Élan & Co");
  await page.getByRole("button", { name: "Close project context" }).click();
  return state;
}

test("starts six concepts with one deliberate click and shows no cost", async ({ page }, info) => {
  const f = await setup(page), action = page.getByRole("group", { name: "Explore six concepts", exact: true });
  const generate = action.getByRole("button", { name: "Explore six concepts", exact: true });
  await expect(generate).toBeEnabled(); await expect(action).not.toContainText(/cost|estimat|\$/i);
  await expect(action).toContainText("Not included in this batch: Mascot");
  await expect(page.getByRole("dialog", { name: "Review generation cost" })).toHaveCount(0);
  expect(f.posts).toHaveLength(0); await page.screenshot({ path: info.outputPath("generation-ready.png") }); await generate.click();
  await expect.poll(() => f.posts.length).toBe(1);
  expect(f.issuedQuotes.get(f.posts[0]!.quoteId)?.request.operation).toBe("concepts");
  expect(f.posts[0]).not.toHaveProperty("acceptedMaxCostMicrousd");
  await expect(page.getByRole("dialog", { name: "Review generation cost" })).toHaveCount(0);
});
test("a keyboard action starts one request without opening a cost dialog", async ({ page }) => {
  const f = await setup(page), trigger = page.getByRole("button", { name: "Explore six concepts", exact: true });
  await expect(trigger).toBeEnabled(); expect(f.posts).toHaveLength(0);
  await trigger.focus(); await page.keyboard.press("Enter");
  await expect.poll(() => f.posts.length).toBe(1);
  await expect(page.getByRole("dialog", { name: "Review generation cost" })).toHaveCount(0);
});
test("failed saved-input loading can be refreshed in place without starting generation", async ({ page }) => {
  const f = await setup(page, "inputs_failed"), generate = page.getByRole("button", { name: "Explore six concepts", exact: true });
  await expect(page.getByRole("button", { name: "Refresh logo inputs" })).toBeVisible();
  await expect(generate).toBeDisabled(); expect(f.posts).toHaveLength(0); expect(f.quotes).toHaveLength(0);
  f.failInputReads = false;
  await page.getByRole("button", { name: "Refresh logo inputs" }).click();
  await expect(generate).toBeEnabled(); expect(f.inputReads).toBeGreaterThan(1); expect(f.posts).toHaveLength(0);
  await generate.click(); await expect.poll(() => f.posts.length).toBe(1);
});
test("a paused saved-input review can be resumed without choosing a brand automatically", async ({ page }) => {
  const f = await setup(page, "input_review"), review = page.getByRole("region", { name: "Confirm logo inputs" });
  await expect(review).toBeVisible(); await review.getByRole("button", { name: "Keep reviewing" }).click();
  await expect(review).toHaveCount(0); expect(f.saves).toHaveLength(0); expect(f.posts).toHaveLength(0);
  await page.getByRole("button", { name: "Refresh logo inputs" }).click();
  await expect(review).toBeVisible(); expect(f.quotes).toHaveLength(0);
  await review.getByRole("button", { name: "Use current logo brief" }).click();
  await expect(page.getByRole("button", { name: "Explore six concepts", exact: true })).toBeEnabled();
  expect(f.posts).toHaveLength(0); expect(f.saves).toHaveLength(0);
});
test("restored saving refreshes prepared inputs and enables a deliberate Generate click", async ({ page }) => {
  const f = await setup(page, "save_unavailable");
  await expect(page.getByText(/Logo saving is unavailable/)).toBeVisible();
  expect(f.saves).toHaveLength(0); expect(f.posts).toHaveLength(0);
  f.restoreSaving(); await page.getByRole("button", { name: "Refresh logo inputs" }).click();
  await expect(page.getByRole("button", { name: "Explore six concepts", exact: true })).toBeEnabled();
  expect(f.saves).toHaveLength(1); expect(f.posts).toHaveLength(0);
});
test("partial results retain five cards and one-click retry excludes successful concepts", async ({ page }) => {
  const f = await setup(page, "partial"); await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
  const action = page.getByRole("group", { name: "Retry 1 failed concept", exact: true });
  await expect(action.getByRole("button", { name: "Retry 1 failed concept", exact: true })).toBeEnabled(); expect(f.posts).toHaveLength(0);
  const previousReads = f.batchReads;
  await action.getByRole("button", { name: "Retry 1 failed concept", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1);
  expect(f.issuedQuotes.get(f.posts[0]!.quoteId)?.request).toMatchObject({ operation: "retry_failed", failedSlotIds: [id(115)] });
  await expect.poll(() => f.batchReads).toBeGreaterThan(previousReads);
  await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
});
test("lost admission response recovers by original key without a second generation post", async ({ page }) => {
  const f = await setup(page); f.lose = true;
  await page.getByRole("button", { name: "Explore six concepts" }).click();
  await expect(page.getByRole("button", { name: "Check original generation request" })).toBeVisible();
  await page.getByRole("button", { name: "Check original generation request" }).click();
  await expect.poll(() => f.readKeys.length).toBeGreaterThan(0); expect(f.readKeys).toContain(f.posts[0]!.requestKey); expect(f.posts).toHaveLength(1);
});
test("unavailable generation preserves saved brief and stays within mobile viewport", async ({ page }) => {
  const f = await setup(page, "unavailable"); await expect(page.getByRole("button", { name: "Explore six concepts" })).toBeDisabled();
  await page.getByRole("button", { name: "Project context", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Brand name" })).toHaveValue("Élan & Co");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(f.posts).toHaveLength(0);
});


test("an unselected first exploration survives full reload with no concept-stage pointer", async ({ page }) => {
  const f = await setup(page);
  await page.getByRole("button", { name: "Explore six concepts" }).click();

  await expect.poll(() => f.posts.length).toBe(1); await page.reload();
  await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Project context", exact: true }).click();
  await page.getByRole("button", { name: "Saved inputs and recovery", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Concept batch" })).toHaveValue(id(60)); expect(f.posts).toHaveLength(1);
});

test("an unselected More exploration is latest after reload and its earlier batch stays reachable", async ({ page }) => {
  const f = await setup(page, "partial"); await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More concepts", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1); await page.reload();
  await page.getByRole("button", { name: "Project context", exact: true }).click();
  await page.getByRole("button", { name: "Saved inputs and recovery", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Concept batch" })).toHaveValue(id(981));
  await page.getByRole("combobox", { name: "Concept batch" }).selectOption(id(60));
  await page.getByRole("dialog", { name: "Saved inputs and recovery", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
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

test("a rejected request offers fresh inputs and an estimate without silently generating again", async ({ page }) => {
  const f = await setup(page); f.admissionRejection = true;
  await page.getByRole("button", { name: "Explore six concepts", exact: true }).click();
  await page.getByRole("button", { name: "Refresh saved inputs", exact: true }).click();
  await expect(page.getByRole("button", { name: "Explore six concepts", exact: true })).toBeEnabled();
  expect(f.posts).toHaveLength(1);
  await expect(page.getByRole("dialog", { name: "Review generation cost" })).toHaveCount(0);
});


test("recovery refreshes a rejected request to the other tab's saved inputs", async ({ page }) => {
  const f = await setup(page), generate = page.getByRole("button", { name: "Explore six concepts", exact: true });
  await expect(generate).toBeEnabled(); f.advanceSavedBrief(); f.admissionRejection = true;
  await generate.click(); await expect(generate).toBeDisabled();
  await page.getByRole("button", { name: "Refresh saved inputs", exact: true }).click();
  await expect(generate).toBeEnabled();
  expect(f.quotes.at(-1)).toMatchObject({ expected: { workspaceRevision: 2, stageRevisions: { brief_references: 2 } }, briefRevisionId: id(990) });
  expect(f.posts).toHaveLength(1);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));

test("concepts landing asks the logo-types question without inventing generated results", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const f = await setup(page);
  await expect(page.getByRole("heading", { name: "Logo", exact: true })).toBeAttached();
  // Redesign (2026-11-06): Embel's message asks which logo types to explore; the
  // project bar replaces the old back link, and no empty concept frames are shown.
  await expect(page.getByText(/^Embel · Logo · 2 of 3$/)).toBeVisible();
  await expect(page.getByRole("group", { name: "Which logo types should I explore?" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to inspiration" })).toHaveCount(0);
  await expect(page.locator("header").getByRole("combobox", { name: "Concept batch" })).toHaveCount(0);
  await expect(page.locator('[data-concept-ordinal]')).toHaveCount(0);
  await expect(page.getByText(/^Review concept \d/)).toHaveCount(0);
  await expect(page.getByText("More, refine and retry each require a separate cost review.", { exact: false })).toHaveCount(0);
  await expectProjectCanvas(page);
  await expect(page.getByRole("button", { name: "Explore six concepts", exact: true })).toBeVisible();
  expect(f.posts).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("concepts-layout.png") });
});

test("new logo work prepares saved inputs and cost before one explicit six-concept request", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const f = await setup(page, "uninitialized");
  const generate = page.getByRole("button", { name: "Explore six concepts", exact: true });
  await expect(generate).toBeEnabled(); await expect(generate).toBeInViewport();
  expect(f.order).toEqual(["inputs", "save", "quote"]); expect(f.saves).toHaveLength(1);
  expect(f.saves[0]!.brief).toMatchObject({ name: "Élan & Co", activity: "Tea shop", audience: "Local readers", logoTypes: DEFAULT_LOGO_CONCEPT_TYPES });
  expect(f.saves[0]!.brief.personality).toContain("selection 2"); expect(f.posts).toHaveLength(0);
  await expect(generate).toBeEnabled();
  await generate.click(); await expect.poll(() => f.posts.length).toBe(1);
  await page.reload(); await expect(page.getByText("6 of 6 concepts ready", { exact: true })).toBeVisible();
  expect(f.saves).toHaveLength(1); expect(f.posts).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
});

test("an uncertain initial brief save keeps its original intent and cannot quote or generate", async ({ page }) => {
  const f = await setup(page, "save_uncertain");
  await expect.poll(() => f.saves.length).toBe(1);
  await expect(page.getByText("Your logo inputs have not been confirmed as saved.", { exact: false })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Review generation cost" })).toHaveCount(0);
  expect(f.posts).toHaveLength(0);
  await page.getByRole("button", { name: "Project context", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Brand name" })).toHaveValue("Élan & Co");
  await page.getByRole("button", { name: "Saved inputs and recovery", exact: true }).click();
  await expect(page.getByText("A previous save is awaiting confirmation.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check original save", exact: true })).toBeVisible();
  expect(f.saves).toHaveLength(1);
  expect(f.quotes).toHaveLength(0);
});

test("a project without a saved brand name is guided back before any logo write", async ({ page }) => {
  const f = await setup(page, "missing_name");
  await expect(page.getByText("Choose and save a brand name in your project before generating logo concepts.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open project to choose a name" })).toHaveAttribute("href", `/brands/account/${source.input.projectId}?view=strategy`);
  expect(f.inputReads).toBe(1); expect(f.saves).toHaveLength(0); expect(f.posts).toHaveLength(0);
  expect(f.quotes).toHaveLength(0);
});


test("clicking a logo selects it in place and persists without an inspection screen", async ({ page }) => {
  const f = await setup(page, "partial");
  const first = page.getByRole("button", { name: "Select concept 1", exact: true });
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Logo chosen. Continue, or describe a change below.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Logo", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Refine a direction", exact: true })).toHaveCount(0);
  expect(f.selections).toHaveLength(1);
  expect(f.posts).toHaveLength(0);
  expect(f.quotes.every(quote => quote.operation === "more_concepts" || quote.operation === "retry_failed")).toBe(true);
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
  const send = page.getByRole("button", { name: "Generate refinement", exact: true });
  await expect(send).toBeHidden();
  await page.getByRole("button", { name: "Select concept 2", exact: true }).click();
  await expect(page.getByText("Refinement target: Concept 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refine logo", exact: true }).click();
  await page.getByRole("textbox", { name: "Describe logo changes" }).fill("Make the monogram more rounded and increase the inner spacing.");
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => f.posts.length).toBe(1);
  await expect(page.getByRole("dialog", { name: "Review generation cost" })).toHaveCount(0);
  expect(f.issuedQuotes.get(f.posts[0]!.quoteId)?.request).toMatchObject({ operation: "refine_preview", source: { kind: "concept", slotId: id(111) }, instruction: "Make the monogram more rounded and increase the inner spacing." });
  expect(f.posts).toHaveLength(1);
  await expect(page.getByRole("heading", { name: "Refine a direction", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Describe logo changes" })).toHaveValue("Make the monogram more rounded and increase the inner spacing.");
  await expect(send).toBeDisabled();
});

test("a delayed estimate never generates or takes focus after the refinement editor closes", async ({ page }) => {
  const batch = syntheticLogoBatch(), slot = batch.slots[0]!, attempt = slot.attempts[0]!;
  const f = await setup(page, "partial", { kind: "concept", batchId: batch.id, slotId: slot.id, attemptId: attempt.id });
  let release!: () => void; f.quoteGate = new Promise<void>(resolve => { release = resolve; });
  const form = page.getByRole("form", { name: "Logo concept changes" });
  await form.getByRole("button", { name: "Refine logo", exact: true }).click();
  await form.getByRole("textbox", { name: "Describe logo changes" }).fill("Retained instruction during quote");
  await expect.poll(() => f.quotes.some(quote => quote.operation === "refine_preview")).toBe(true);
  await form.getByRole("button", { name: "Close refinement", exact: true }).click();
  release(); await expect(form.getByRole("textbox", { name: "Describe logo changes" })).toBeHidden();
  await expect(form.getByRole("button", { name: "Refine logo", exact: true })).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Review generation cost" })).toHaveCount(0);
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
  // The refine box sits below the concepts, so opening it never pushes the cards around.
  expect(formBox!.y).toBeGreaterThanOrEqual(cardBox!.y + cardBox!.height);
  await form.getByRole("button", { name: "Close refinement", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await toggle.click(); await expect(input).toHaveValue("Retained local fixture instruction");
  await expect(form.getByText("Refinement target: Concept 1", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator(`a[href$="/logo/directions"]`, { hasText: /^Continue$/ }).scrollIntoViewIfNeeded();
  await expect(page.locator(`a[href$="/logo/directions"]`, { hasText: /^Continue$/ })).toBeInViewport();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await form.getByRole("button", { name: "Close refinement", exact: true }).click();
  await form.scrollIntoViewIfNeeded(); await captureUiEvidence(page, info);
  expect(f.selections).toEqual([]); expect(f.posts).toEqual([]); expect(f.saves).toEqual([]);
});


test("a saved refinement can be selected and edited again without leaving concepts", async ({ page }) => {
  const f = await setup(page, "partial");
  const refinement = syntheticRasterRefinement();
  f.refinements.push(refinement);
  await page.reload();
  await page.getByRole("button", { name: "Select concept 1", exact: true }).click();
  await expect(page.getByText("Refinement target: Concept 1 · Version 2", { exact: true })).toBeVisible();
  await expect(page.locator(`a[href$="/logo/directions"]`, { hasText: /^Continue$/ })).toHaveAttribute("href", /\/logo\/directions$/);
  await page.getByRole("button", { name: "Refine logo", exact: true }).click();
  await page.getByRole("textbox", { name: "Describe logo changes" }).fill("Make the lettering slightly wider.");
  await page.getByRole("textbox", { name: "Describe logo changes" }).focus();
  await expect(page.getByRole("button", { name: "Generate refinement", exact: true })).toBeEnabled();
  expect(f.posts).toHaveLength(0); await page.keyboard.press("Control+Enter");
  await expect.poll(() => f.posts.length).toBe(1);
  expect(f.quotes.at(-1)).toMatchObject({ operation: "refine_preview", source: { kind: "refinement", rasterRevisionId: refinement.id }, instruction: "Make the lettering slightly wider." });
  expect(f.posts).toHaveLength(1);
});


test("a running chat edit becomes a selectable saved refinement without reloading", async ({ page }) => {
  const f = await setup(page, "partial");
  await page.getByRole("button", { name: "Select concept 1", exact: true }).click();
  await page.getByRole("button", { name: "Refine logo", exact: true }).click();
  await page.getByRole("textbox", { name: "Describe logo changes" }).fill("Increase the letter spacing slightly.");
  await page.getByRole("button", { name: "Generate refinement", exact: true }).click();
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



test("dialog hit testing: logo project context protects padding without generation", async ({ page }) => {
  const batch = syntheticLogoBatch(), slot = batch.slots[0]!, attempt = slot.attempts[0]!;
  const f = await setup(page, "partial", { kind: "concept", batchId: batch.id, slotId: slot.id, attemptId: attempt.id });
  const trigger = page.getByRole("form", { name: "Logo concept changes" }).getByRole("button", { name: "Project context", exact: true });
  await checkDialogHitTesting(page, trigger, page.getByRole("dialog", { name: "Project context", exact: true }), "Close project context");
  expect(f.posts).toEqual([]); expect(f.saves).toEqual([]); expect(f.selections).toEqual([]);
});


test("a failed preparation can be retried without starting generation", async ({ page }) => {
  const f = await setup(page, "quote_failed");
  const action = page.getByRole("group", { name: "Explore six concepts", exact: true });
  await expect(action).toContainText("This request could not be prepared");
  await expect(action.getByRole("button", { name: "Explore six concepts", exact: true })).toBeDisabled();
  expect(f.posts).toHaveLength(0); f.failQuotes = false;
  await action.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(action.getByRole("button", { name: "Explore six concepts", exact: true })).toBeEnabled();
  expect(f.posts).toHaveLength(0); expect(f.quotes).toHaveLength(2);
});

test("an expired request is replaced quietly and never starts generation on its own", async ({ page }) => {
  const f = await setup(page, "quote_expired");
  const action = page.getByRole("group", { name: "Explore six concepts", exact: true });
  const generate = action.getByRole("button", { name: "Explore six concepts", exact: true });
  await expect(generate).toBeEnabled();
  await expect.poll(() => f.quotes.length).toBeGreaterThan(1); expect(f.posts).toHaveLength(0);
  await expect(generate).toBeEnabled(); await expect(action).not.toContainText(/estimat|expired/i); expect(f.posts).toHaveLength(0);
  await generate.click(); await expect.poll(() => f.posts.length).toBe(1);
});

test("a cancelled request keeps partial previews and allows a later deliberate generation", async ({ page }) => {
  const f = await setup(page);
  await page.getByRole("button", { name: "Explore six concepts", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1);
  if (f.request.status === "not_found") throw Error("Synthetic admission missing");
  f.request = { ...f.request, status: "cancelled", billing: { status: "recorded", confirmedMicrousd: 0 }, outputs: [] };
  await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "More concepts", exact: true })).toBeEnabled();
  expect(f.posts).toHaveLength(1);
});


test("an uncapped generation shows no cost and starts on one click", async ({ page }) => {
  const f = await setup(page, "unknown_estimate");
  const action = page.getByRole("group", { name: "Explore six concepts", exact: true });
  await expect(action).not.toContainText(/cost|estimat|\$/i);
  expect(f.posts).toHaveLength(0); await action.getByRole("button", { name: "Explore six concepts", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1); expect(f.posts[0]).not.toHaveProperty("acceptedMaxCostMicrousd");
});
