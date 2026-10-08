import { expect, test, type Page, type Route } from "@playwright/test";
import { syntheticLogoBatch, syntheticLogoQuote, syntheticLogoWorkspace, syntheticResolvedLogoConcept, logoFixtureId as id } from "../fixtures/logo-creation";
import type { LogoCostQuote, LogoGenerationIntent, LogoQuoteRequest, LogoRequestState, LogoConceptBatch } from "../../src/domain/logo-jobs";

const source = syntheticResolvedLogoConcept(), url = `/brands/account/${source.input.projectId}/logo`, base = `/api/projects/${source.input.projectId}/logo`;
async function setup(page: Page, scenario: "empty" | "partial" | "uncertain" | "unavailable" | "retry_uncertain" = "empty") {
  const batch = syntheticLogoBatch(scenario === "uncertain" ? ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "needs_reconciliation"] : undefined);
  let currentBrief = source.brief;
  const foundation = syntheticLogoWorkspace();
  const batches = new Map<string, LogoConceptBatch>([[batch.id, batch]]);
  if (scenario === "retry_uncertain") {
    const previous = batch.slots[5]!.attempts[0]!;
    batches.set(batch.id, { ...batch, slots: batch.slots.map(slot => slot.id === previous.slotId ? { ...slot, attempts: [previous,
      { ...previous, id: id(955), jobId: id(956), requestKey: id(957), previousAttemptId: previous.id, attemptNumber: 2, state: "needs_reconciliation", reason: "outcome_unknown", billing: { status: "unknown", confirmedMicrousd: null } },
    ] } : slot) });
  }
  const summaries = ["partial", "uncertain", "retry_uncertain"].includes(scenario) ? [{ id: batch.id, requestKey: batch.requestKey, createdAt: batch.createdAt }] : [];
  const saved = { ...foundation, heads: { ...foundation.heads, workspaceRevision: 1, stageRevisions: { ...foundation.heads.stageRevisions, brief_references: 1, concepts: ["partial", "uncertain"].includes(scenario) ? 1 : 0 } },
    stages: { ...foundation.stages, brief_references: { id: source.brief.id, revision: 1, stage: "brief_references" }, concepts: ["partial", "uncertain"].includes(scenario) ? { id: id(901), revision: 1, stage: "concepts" } : null },
    capabilities: { ...foundation.capabilities, save: { status: "available" }, generate: scenario === "unavailable" ? { status: "unavailable", reason: "Synthetic unavailable configuration" } : { status: "available" } } };
  const state = { owner: foundation.ownerId, posts: [] as LogoGenerationIntent[], quotes: [] as LogoQuoteRequest[], readKeys: [] as string[], lose: false,
    request: { status: "not_found" } as LogoRequestState, quote: null as LogoCostQuote | null, batchReads: 0, summaries, admissionRejection: false,
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
    if (path === base) return json(route, saved);
    if (path === `${base}/stages/brief_references/revisions/${currentBrief.id}`) return json(route, currentBrief);
    if (path === `${base}/stages/brief_references/revisions/${source.brief.id}`) return json(route, source.brief);
    if (path === `${base}/reference-snapshots/${source.referenceSnapshot.id}`) return json(route, source.referenceSnapshot);
    if (path === `${base}/stages/concepts/revisions/${id(901)}`) return json(route, { ...source.brief, id: id(901), stage: "concepts", payload: { batchIds: [batch.id], selected: null } });
    if (path === `${base}/batches`) return json(route, { ownerId: foundation.ownerId, projectId: foundation.projectId, items: state.summaries, nextCursor: null });
    if (path.startsWith(`${base}/batches/`)) { state.batchReads++; const found = batches.get(path.split("/").at(-1)!); return json(route, found ?? {}, found ? 200 : 404); }
    if (path === `${base}/quotes`) {
      const body = request.postDataJSON() as LogoQuoteRequest; state.quotes.push(body);
      state.quote = { ...syntheticLogoQuote(), request: body, expected: saved.heads, expiresAt: new Date(Date.now() + 60000).toISOString(),
        conceptPlan: body.operation === "retry_failed" || body.operation === "refine_preview" ? null : batch.plan,
        targetSlotIds: body.operation === "retry_failed" ? body.failedSlotIds : body.operation === "refine_preview" ? [id(110)] : batch.slots.map(slot => slot.id) };
      return json(route, state.quote);
    }
    if (path === `${base}/requests` && request.method() === "POST") {
      const body = request.postDataJSON() as LogoGenerationIntent; state.posts.push(body);
      if (state.admissionRejection) return json(route, { error: { code: "conflict", message: "This request conflicts with the current state." }, rejection: { status: "rejected", ownerId: foundation.ownerId, projectId: foundation.projectId, requestKey: body.requestKey, quoteId: body.quoteId } }, 409);
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
    if (path === `${base}/raster-refinements`) return json(route, { ownerId: foundation.ownerId, projectId: foundation.projectId, items: [], nextCursor: null });
    if (path.endsWith("/preview")) return json(route, {}, 503);
    return json(route, {}, 503);
  });
  await page.goto(url); await expect(page.getByRole("textbox", { name: "Brand name" })).toHaveValue("Élan & Co");
  return state;
}

test("saved brief seven types and explicit estimate click precede every generation", async ({ page }) => {
  const f = await setup(page); expect(f.posts).toHaveLength(0);
  await page.getByRole("button", { name: "Explore six concepts" }).click();
  const dialog = page.getByRole("dialog", { name: "Review generation cost" }); await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Not included in this batch: Mascot"); await expect(dialog).toContainText("Estimated cost"); await expect(dialog).toContainText("Maximum cost");
  expect(f.posts).toHaveLength(0); await dialog.getByRole("button", { name: "Generate 6 concepts", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1); await expect(dialog).not.toBeVisible(); expect(f.quotes[0]?.operation).toBe("concepts");
});
test("Escape cancels without admission and returns keyboard focus", async ({ page }) => {
  const f = await setup(page), trigger = page.getByRole("button", { name: "Explore six concepts" });
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
});
test("lost admission response recovers by original key without a second generation post", async ({ page }) => {
  const f = await setup(page); f.lose = true;
  await page.getByRole("button", { name: "Explore six concepts" }).click(); await page.getByRole("dialog").getByRole("button", { name: "Generate 6 concepts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check original generation request" })).toBeVisible();
  await page.getByRole("button", { name: "Check original generation request" }).click();
  await expect.poll(() => f.readKeys.length).toBeGreaterThan(0); expect(f.readKeys).toContain(f.posts[0]!.requestKey); expect(f.posts).toHaveLength(1);
});
test("unavailable generation preserves saved brief and stays within mobile viewport", async ({ page }) => {
  const f = await setup(page, "unavailable"); await expect(page.getByRole("button", { name: "Explore six concepts" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "Brand name" })).toHaveValue("Élan & Co");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(f.posts).toHaveLength(0);
});


test("an unselected first exploration survives full reload with no concept-stage pointer", async ({ page }) => {
  const f = await setup(page);
  await page.getByRole("button", { name: "Explore six concepts" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Generate 6 concepts", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1); await page.reload();
  await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Concept batch" })).toHaveValue(id(60)); expect(f.posts).toHaveLength(1);
});

test("an unselected More exploration is latest after reload and its earlier batch stays reachable", async ({ page }) => {
  const f = await setup(page, "partial"); await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More concepts", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Generate 6 more concepts", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(1); await page.reload();
  await expect(page.getByRole("combobox", { name: "Concept batch" })).toHaveValue(id(981));
  await page.getByRole("combobox", { name: "Concept batch" }).selectOption(id(60));
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
  await page.getByRole("button", { name: "Explore six concepts" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Generate 6 concepts", exact: true }).click();
  await page.getByRole("button", { name: "Return to cost review" }).click(); expect(f.posts).toHaveLength(1);
  await page.getByRole("button", { name: "Explore six concepts" }).click(); await expect(page.getByRole("dialog")).toBeVisible(); expect(f.posts).toHaveLength(1);
});


test("return to cost review refreshes an H1 rejection to the other tab's saved H2 inputs", async ({ page }) => {
  const f = await setup(page);
  await page.getByRole("button", { name: "Explore six concepts" }).click();
  await expect(page.getByRole("dialog")).toBeVisible(); f.advanceSavedBrief(); f.admissionRejection = true;
  await page.getByRole("dialog").getByRole("button", { name: "Generate 6 concepts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Explore six concepts" })).toBeDisabled();
  await page.getByRole("button", { name: "Return to cost review" }).click();
  await expect(page.getByRole("button", { name: "Explore six concepts" })).toBeEnabled();
  await page.getByRole("button", { name: "Explore six concepts" }).click(); await expect(page.getByRole("dialog")).toBeVisible();
  expect(f.quotes[1]).toMatchObject({ expected: { workspaceRevision: 2, stageRevisions: { brief_references: 2 } }, briefRevisionId: id(990) });
  expect(f.posts).toHaveLength(1);
});
