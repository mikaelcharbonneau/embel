import { captureUiEvidence } from "./ui-evidence";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { accountProjectSchema } from "../../src/domain/project-api";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { createIdentityReferenceSnapshot, identityReferenceQuerySchema, identityReferencesOverviewSchema, setReferenceReactionResponseSchema, setReferenceReactionSchema } from "../../src/domain/identity-references";
import { createIdentityInputSnapshot, getIdentityCurrentBasis, getIdentityFreshness, getIdentityReadiness, initialIdentityPreferences, listIdentitySystemsSchema,
  projectIdentityOverviewSchema, refineIdentityComponentSchema, selectIdentitySystem, selectIdentitySystemSchema, summarizeIdentitySystem, updateIdentityPreferencesSchema,
  type IdentityPreferenceRevision, type IdentitySelection, type IdentitySystemVersion, type ProjectIdentityOverview } from "../../src/domain/project-identity";
import { fixtureBoards, fixtureVisualSystems, fixtureAt, fixtureId, fixtureInput, fixtureOverview, fixtureOwner, fixtureProject, fixtureRefinement, fixtureSystem } from "../client/project-identity-fixtures";

// All responses and images are synthetic local fixtures. No provider/catalog/storage call.
const image = Buffer.from(fixtureBoards[0].base64, "base64");
const boardImages = new Map<string,Buffer>(fixtureBoards.map(board => [board.sha256, Buffer.from(board.base64, "base64")]));
const imageHash = createHash("sha256").update(image).digest("hex");
const evidenceDirectory = process.env.FLUID_IDENTITY_EVIDENCE_DIR ?? ".tmp/identity-d041-evidence";
const base = `/api/projects/${fixtureProject}/identity`, url = `/brands/account/${fixtureProject}/identity`;
function initialSystem(index = 0) { return fixtureSystem(fixtureInput(), index); }
type Fixture = ReturnType<typeof makeFixture>;
function makeFixture() {
  const input = fixtureInput(), overview = fixtureOverview({ systems: [initialSystem()], selected: true });
  return { owner: fixtureOwner, sessionStatus: 200, signOutStatus: 200, project: accountProjectSchema.parse(overview.project),
    references: structuredClone(input.referenceSnapshot.selected), referenceRevision: 1, saveAvailable: true,
    systems: [initialSystem()] as IdentitySystemVersion[], selection: overview.currentSelection!.selection as IdentitySelection | null,
    preferences: null as IdentityPreferenceRevision | null, reads: 0, writes: [] as { kind: string; body: unknown }[], pageSize: 20,
    readStatus: 200, preferenceStatus: 200, refinementStatus: 200, previewStatus: 200, loseRefinement: false, losePreference: false, loseSelection: false,
    malformedOverview: false, heldReference: null as (() => Promise<void>) | null, holdNextReference: false,
    heldOverview: null as (() => Promise<void>) | null, holdNextOverview: false,
    replay: new Map<string, { request: unknown; response: ReturnType<typeof fixtureRefinement> }>(),
  };
}
function referenceSnapshot(fixture: Fixture) {
  const selected = fixture.references.filter(entry => entry.reaction.ensemble || entry.reaction.elements.length);
  return createIdentityReferenceSnapshot({ ownerId: fixtureOwner, projectId: fixtureProject, referenceRevision: fixture.referenceRevision,
    selectedReferenceCount: selected.length, selected, capturedAt: fixtureAt });
}
function overviewOf(fixture: Fixture, query = listIdentitySystemsSchema.parse({})): ProjectIdentityOverview {
  const reference = referenceSnapshot(fixture), scope = { ownerId: fixtureOwner, projectId: fixtureProject };
  const currentBasis = getIdentityCurrentBasis({ ...scope, context: fixture.project.context, references: reference,
    preferences: fixture.preferences?.preferences ?? initialIdentityPreferences(fixture.project.context) });
  const sorted = [...fixture.systems].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const start = query.cursor ? sorted.findIndex(system => system.id === query.cursor!.id) + 1 : 0;
  const page = sorted.slice(start, start + Math.min(query.limit, fixture.pageSize)), last = page.at(-1);
  const selected = fixture.selection ? fixture.systems.find(system => system.id === fixture.selection!.systemVersionId)! : null;
  return projectIdentityOverviewSchema.parse({ ...scope, saveAvailability: fixture.saveAvailable ? { status: "available" } : { status: "unavailable", reason: "trusted_transaction_unavailable" }, project: fixture.project,
    session: fixture.selection || fixture.preferences ? { ...scope, identityRevision: fixture.selection?.identityRevision ?? 0,
      currentSelectionId: fixture.selection?.id ?? null, currentPreferencesRevision: fixture.preferences?.revision ?? 0, createdAt: fixtureAt, updatedAt: fixtureAt } : null,
    preferences: fixture.preferences, referenceSnapshot: reference, currentBasis, readiness: getIdentityReadiness(fixture.project.context, fixture.project.scope, reference),
    currentSelection: fixture.selection && selected ? { selection: fixture.selection, system: selected, freshness: getIdentityFreshness(selected.input.basis, currentBasis) } : null,
    systems: { ...scope, query, items: page.map(system => summarizeIdentitySystem(system, currentBasis)), nextCursor: last && start + page.length < sorted.length ? { projectId: fixtureProject, id: last.id, createdAt: last.createdAt } : null },
  });
}
async function setup(page: Page, fixture = makeFixture()) {
  async function json(route: Route, value: unknown, status = 200) { try { await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) }); } catch { /* Scope disposal may abort a local fixture request. */ } }
  await page.route("**/api/**", async route => {
    const request = route.request(), parsed = new URL(request.url()), path = parsed.pathname;
    if (path === "/api/session") return json(route, { user: { id: fixture.owner } }, fixture.sessionStatus);
    if (path === "/api/auth/sign-out") { if (fixture.signOutStatus === 200) fixture.sessionStatus = 401; return json(route, { authenticated: false }, fixture.signOutStatus); }
    if (fixture.owner !== fixtureOwner) return json(route, {}, 404);
    if (path === `/api/projects/${fixtureProject}`) return json(route, { project: fixture.project });
    if (path === `${base}/references` && request.method() === "GET") {
      const query = identityReferenceQuerySchema.parse({ limit: Number(parsed.searchParams.get("limit") ?? 40), excludedTags: parsed.searchParams.getAll("excludedTag") });
      const items = fixture.references.map(entry => ({ ...entry, reference: { ...entry.reference, media: { ...entry.reference.media, contentHash: imageHash } } }));
      return json(route, identityReferencesOverviewSchema.parse({ ownerId: fixtureOwner, projectId: fixtureProject, query, referenceRevision: fixture.referenceRevision,
        selectedReferenceCount: referenceSnapshot(fixture).selectedReferenceCount, feed: { status: "unavailable", reason: "reference_source_unconfigured" }, availableTags: [], tagsComplete: true, references: { items, nextCursor: null } }));
    }
    if (path.startsWith(`${base}/references/`) && request.method() === "PATCH") {
      const body = setReferenceReactionSchema.parse(request.postDataJSON()), referenceId = path.split("/").at(-1)!, entry = fixture.references.find(row => row.reference.id === referenceId)!;
      fixture.writes.push({ kind: "reference", body });
      if (fixture.holdNextReference) { fixture.holdNextReference = false; fixture.heldReference = () => json(route, {}, 409); return; }
      if (entry.reaction.revision !== body.expectedRevision) return json(route, {}, 409);
      entry.reaction = { ...entry.reaction, revision: entry.reaction.revision + 1, ensemble: body.ensemble, elements: body.elements, updatedAt: fixtureAt };
      fixture.referenceRevision += 1;
      return json(route, setReferenceReactionResponseSchema.parse({ ownerId: fixtureOwner, projectId: fixtureProject, referenceRevision: fixture.referenceRevision,
        selectedReferenceCount: referenceSnapshot(fixture).selectedReferenceCount, entry: { ...entry, reference: { ...entry.reference, media: { ...entry.reference.media, contentHash: imageHash } } } }));
    }
    if (path === base || path === `${base}/systems`) {
      fixture.reads += 1; if (fixture.readStatus !== 200) return json(route, {}, fixture.readStatus);
      const query = listIdentitySystemsSchema.parse({ limit: Number(parsed.searchParams.get("limit") ?? 20), ...(parsed.searchParams.has("cursor") ? { cursor: JSON.parse(parsed.searchParams.get("cursor")!) } : {}) });
      const overview = overviewOf(fixture, query), response = path.endsWith("/systems") ? overview.systems : fixture.malformedOverview ? { ...overview, currentSelection: { ...overview.currentSelection, system: { ...overview.currentSelection?.system, components: {} } } } : overview;
      if (fixture.holdNextOverview) { fixture.holdNextOverview = false; fixture.heldOverview = () => json(route, response); return; }
      return json(route, response);
    }
    if (path.startsWith(`${base}/systems/`)) {
      const system = fixture.systems.find(item => item.id === path.split("/").at(-1)); if (!system) return json(route, {}, 404);
      const currentBasis = overviewOf(fixture).currentBasis;
      return json(route, { ownerId: fixtureOwner, projectId: fixtureProject, system, currentBasis, freshness: getIdentityFreshness(system.input.basis, currentBasis) });
    }
    if (path === `${base}/preferences`) {
      const body = updateIdentityPreferencesSchema.parse(request.postDataJSON()); fixture.writes.push({ kind: "preferences", body });
      if (fixture.preferenceStatus !== 200) return json(route, {}, fixture.preferenceStatus);
      if (body.expectedPreferencesRevision !== (fixture.preferences?.revision ?? 0)) return json(route, {}, 409);
      fixture.preferences = { ownerId: fixtureOwner, projectId: fixtureProject, revision: body.expectedPreferencesRevision + 1, preferences: body.preferences, createdAt: fixtureAt };
      if (fixture.losePreference) { fixture.losePreference = false; return route.abort("failed"); }
      const overview = overviewOf(fixture); return json(route, { session: overview.session, preferences: fixture.preferences });
    }
    if (path === `${base}/selection`) {
      const body = selectIdentitySystemSchema.parse(request.postDataJSON()); fixture.writes.push({ kind: "selection", body });
      const overview = overviewOf(fixture), system = fixture.systems.find(item => item.id === body.systemVersionId)!;
      try {
        const input = createIdentityInputSnapshot({ ownerId: fixtureOwner, projectId: fixtureProject, scope: fixture.project.scope, projectRevision: fixture.project.current_revision,
          context: fixture.project.context, referenceSnapshot: referenceSnapshot(fixture), preferencesRevision: fixture.preferences?.revision ?? 0,
          preferences: fixture.preferences?.preferences ?? initialIdentityPreferences(fixture.project.context), capturedAt: fixtureAt });
        fixture.selection = selectIdentitySystem({ actorId: fixtureOwner, projectId: fixtureProject, system, currentInput: input, previousSelection: fixture.selection,
          identityRevision: overview.session?.identityRevision ?? 0, request: body, selectionId: fixtureId(900 + fixture.writes.length), now: fixtureAt, reason: fixture.selection ? "restored" : "selected" });
      } catch { return json(route, {}, 409); }
      if (fixture.loseSelection) { fixture.loseSelection = false; return route.abort("failed"); }
      const after = overviewOf(fixture); return json(route, { session: after.session, currentSelection: after.currentSelection });
    }
    if (path === `${base}/refinements`) {
      const body = refineIdentityComponentSchema.parse(request.postDataJSON()); fixture.writes.push({ kind: "refinement", body });
      if (fixture.refinementStatus !== 200) return json(route, {}, fixture.refinementStatus);
      const prior = fixture.replay.get(body.idempotencyKey);
      if (prior) return JSON.stringify(prior.request) === JSON.stringify(body) ? json(route, prior.response) : json(route, {}, 409);
      const system = fixture.systems.find(item => item.id === body.baseSystemVersionId)!;
      try {
        const response = fixtureRefinement(overviewOf(fixture), system, body); fixture.replay.set(body.idempotencyKey, { request: body, response });
        fixture.systems.push(response.system); fixture.selection = response.selection;
        if (fixture.loseRefinement) { fixture.loseRefinement = false; return route.abort("failed"); }
        return json(route, response);
      } catch { return json(route, {}, 409); }
    }
    if (path.endsWith("/preview")) {
      const versionId = path.split("/").at(-2);
      const system = fixture.systems.find(item => item.board.asset.versionId === versionId);
      const preview = system ? boardImages.get(system.board.asset.contentHash) : image;
      if (!preview) return json(route, {}, 503);
      return route.fulfill({ status: fixture.previewStatus, contentType: "image/png", body: preview });
    }
    if (path.endsWith("/download")) return json(route, {}, 503);
    return json(route, {}, 503);
  });
  return fixture;
}
async function ready(page: Page) { await page.goto(url); await page.getByRole("button", { name: "Saved systems", exact: true }).click(); await expect(page.getByRole("heading", { name: "Identity systems", exact: true })).toBeVisible(); await expect(page.locator("#identity-detail-title")).toHaveText("Cedar"); }
async function openContextSheet(page: Page, title: string | RegExp) {
  const target = page.getByRole("dialog", { name: title, exact: typeof title === "string" });
  if (await target.isVisible()) return;
  const visible = page.locator("dialog[open]");
  if (await visible.count()) await visible.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: title, exact: typeof title === "string" }).click();
  await expect(target).toBeVisible();
}
async function closeContextSheet(page: Page) {
  const visible = page.locator("dialog[open]");
  if (await visible.count()) await visible.getByRole("button", { name: "Close", exact: true }).click();
}
async function openPreferences(page: Page) { await openContextSheet(page, /^Identity preferences/); }
async function openColors(page: Page) { await openContextSheet(page, "Edit colors"); }
async function openTypography(page: Page) { await openContextSheet(page, "Edit typography"); }
async function beginSignOut(page: Page) {
  await closeContextSheet(page);
  const button = page.getByRole("button", { name: "Sign out", exact: true });
  if (!await button.isVisible()) await page.getByLabel("Account menu", { exact: true }).click();
  await button.click();
}
async function checkAccount(page: Page) {
  await closeContextSheet(page);
  const menu = page.locator(".workspace-account-menu");
  if (!await menu.evaluate(element => (element as HTMLDetailsElement).open)) await menu.locator("summary").click();
  await menu.getByRole("button", { name: "Check account", exact: true }).click();
  await expect(menu.getByRole("button", { name: "Check account", exact: true })).toBeEnabled();
  if (await menu.evaluate(element => (element as HTMLDetailsElement).open)) await menu.locator("summary").click();
}
async function recheck(page: Page) { await checkAccount(page); await page.getByRole("button", { name: "Saved systems", exact: true }).click(); await expect(page.getByRole("heading", { name: "Identity systems", exact: true })).toBeVisible(); await expect(page.locator("#identity-detail-title")).toBeVisible(); }

test("identity fixture: References appears first with all six actual component sections", async ({ page }) => {
  const fixture = await setup(page); await ready(page);
  expect(await page.locator("[aria-label=\"Brand references\"]").evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector(".project-identity")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  for (const name of ["Logo", "Colors", "Typography", "Graphics", "Imagery", "Composition"]) await expect(page.locator(".identity-components").getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText("Saved family specifications do not install fonts or establish a license.", { exact: true })).toBeVisible();
  await expect(page.getByText("image/svg+xml", { exact: false })).toBeVisible(); expect(fixture.writes).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("identity fixture: uppercase direct route retains canonical private scope", async ({ page }) => {
  await setup(page); await page.goto(url.toUpperCase().replace("/BRANDS/ACCOUNT/", "/brands/account/").replace("/IDENTITY", "/identity")); await page.getByRole("button", { name: "Saved systems", exact: true }).click();
  await expect(page.locator("#identity-detail-title")).toHaveText("Cedar"); await openColors(page); await page.getByRole("textbox", { name: "Color 1 name", exact: true }).fill("Berry");
  await expect(page.getByRole("button", { name: "Save colors as new version" })).toBeEnabled();
});
test("identity fixture: real empty history and unavailable reads remain distinct", async ({ page }) => {
  const fixture = await setup(page); fixture.systems = []; fixture.selection = null; fixture.readStatus = 503; await page.goto(url); await page.getByRole("button", { name: "Saved systems", exact: true }).click();
  await expect(page.locator(".project-identity").getByRole("alert")).toContainText("unavailable"); await expect(page.getByText("No Identity systems have been saved yet. Generation is unavailable.")).toHaveCount(0);
  fixture.readStatus = 200; await closeContextSheet(page); await page.locator(".identity-section-heading").getByRole("button", { name: "Check latest", exact: true }).click();
  await expect(page.getByText("No Identity systems have been saved yet. Generation is unavailable.")).toBeVisible(); expect(fixture.writes).toHaveLength(0);
});
test("identity fixture: older complete history stays reachable and explicit restoration appends a choice", async ({ page }) => {
  const fixture = await setup(page); fixture.systems = [initialSystem(0), initialSystem(1), initialSystem(2)]; fixture.pageSize = 1; await ready(page);
  await expect(page.locator(".identity-history-card")).toHaveCount(1); await page.getByRole("button", { name: "Load more systems" }).click(); await expect(page.locator(".identity-history-card")).toHaveCount(2);
  await closeContextSheet(page); await page.locator(".identity-history-card").first().getByRole("button", { name: "View system" }).click(); await expect(page.getByRole("button", { name: "Restore as current" })).toBeEnabled();
  await page.getByRole("button", { name: "Restore as current" }).click(); await expect(page.getByText("Current Identity choice saved.", { exact: true })).toBeVisible();
  expect(fixture.selection?.identityRevision).toBe(2); expect(fixture.writes.filter(write => write.kind === "selection")).toHaveLength(1); expect(fixture.systems).toHaveLength(3);
});
test("identity fixture: colors create a manual version and preserve a visibly stale board", async ({ page }) => {
  const fixture = await setup(page); await ready(page); const original = JSON.stringify(fixture.systems[0]); await openColors(page);
  await page.getByRole("textbox", { name: "Color 1 hex", exact: true }).fill("#AA2255"); await page.getByRole("button", { name: "Save colors as new version" }).click();
  await expect(page.locator("dialog[open]").getByText("The manual edit is saved in history. The latest current choice has been checked.", { exact: true })).toBeVisible();
  await expect(page.locator(".identity-system-detail").getByText(/Preview predates this edit: colors/)).toBeVisible();
  expect(fixture.systems).toHaveLength(2); expect(JSON.stringify(fixture.systems[0])).toBe(original);
  expect(fixture.systems[1]!.source.kind).toBe("manual_edit"); expect(fixture.systems[1]!.board.asset).toEqual(fixture.systems[0]!.board.asset);
});
test("identity fixture: typography edits remain specifications and preserve all other components", async ({ page }) => {
  const fixture = await setup(page); await ready(page); await openTypography(page); await page.getByRole("textbox", { name: "Type 1 family", exact: true }).fill("My supplied family");
  await page.getByRole("button", { name: "Save typography as new version" }).click(); await expect(page.locator("dialog[open]").getByText("The manual edit is saved in history. The latest current choice has been checked.", { exact: true })).toBeVisible();
  expect(fixture.systems[1]!.components.typography.styles[0]!.family).toBe("My supplied family"); expect(fixture.systems[1]!.components.colors).toEqual(fixture.systems[0]!.components.colors);
  await expect(page.locator(".identity-system-detail").getByText(/Preview predates this edit: typography/)).toBeVisible();
});
test("identity fixture: stale acknowledgment resets on an independent preference revision", async ({ page }) => {
  const fixture = await setup(page); fixture.project = { ...fixture.project, current_revision: 2, context: contextSnapshotSchema.parse({ ...fixture.project.context, description: "Changed local fixture brief" }) }; await ready(page);
  await openColors(page); await page.getByRole("textbox", { name: "Color 1 name", exact: true }).fill("Berry");
  const ack = page.getByRole("checkbox", { name: "I understand this system uses earlier saved inputs." }); await expect(page.getByRole("button", { name: "Save colors as new version" })).toBeDisabled(); await closeContextSheet(page); await ack.check(); await openColors(page);
  await expect(page.getByRole("button", { name: "Save colors as new version" })).toBeEnabled();
  fixture.preferences = { ownerId: fixtureOwner, projectId: fixtureProject, revision: 1, preferences: { ...initialIdentityPreferences(fixture.project.context), notes: "Saved independently" }, createdAt: fixtureAt };
  await closeContextSheet(page); await page.locator(".identity-section-heading").getByRole("button", { name: "Check latest", exact: true }).click(); await expect(ack).not.toBeChecked(); await openColors(page); await expect(page.getByRole("button", { name: "Save colors as new version" })).toBeDisabled();
  await closeContextSheet(page); await ack.check(); await openColors(page); await page.getByRole("button", { name: "Save colors as new version" }).click(); await expect.poll(() => fixture.writes.filter(write => write.kind === "refinement").length).toBe(1);
  expect(fixture.writes.at(-1)!.body).toMatchObject({ expectedProjectRevision: 2, expectedReferenceRevision: 1, expectedPreferencesRevision: 1, expectedIdentityRevision: 1, acceptEarlierBasis: true });
});
test("identity fixture: reference writes invalidate a previously acknowledged system", async ({ page }) => {
  const fixture = await setup(page); fixture.project = { ...fixture.project, current_revision: 2, context: contextSnapshotSchema.parse({ ...fixture.project.context, description: "Earlier-basis fixture" }) }; await ready(page); await openColors(page);
  await page.getByRole("textbox", { name: "Color 1 name", exact: true }).fill("Berry"); const ack = page.getByRole("checkbox", { name: "I understand this system uses earlier saved inputs." }); await closeContextSheet(page); await ack.check(); await openColors(page);
  await closeContextSheet(page); await page.getByRole("button", { name: "Moodboard", exact: true }).click(); await page.getByRole("button", { name: /^Ensemble for/ }).click(); await expect.poll(() => fixture.referenceRevision).toBe(2); await page.getByRole("button", { name: "Saved systems", exact: true }).click(); await expect(ack).not.toBeChecked(); await openColors(page);
  await expect(page.getByRole("button", { name: "Save colors as new version" })).toBeDisabled();
});
test("identity fixture: missing saved name preserves history and blocks dependent edits", async ({ page }) => {
  const fixture = await setup(page); fixture.project = { ...fixture.project, current_revision: 2, context: contextSnapshotSchema.parse({ ...fixture.project.context, intake: { ...fixture.project.context.intake, suppliedName: "" } }) }; await ready(page);
  await expect(page.getByText("Add a saved brand name to compare this system with current inputs.").first()).toBeVisible(); await openColors(page); await page.getByRole("textbox", { name: "Color 1 name", exact: true }).fill("Berry");
  await expect(page.getByRole("button", { name: "Save colors as new version" })).toBeDisabled(); await expect(page.locator(".identity-history-card")).toHaveCount(1); expect(fixture.writes).toHaveLength(0);
});
test("identity fixture: conflict preserves preference edits and requires an explicit new baseline", async ({ page }) => {
  const fixture = await setup(page); await ready(page); await openPreferences(page); await page.getByRole("textbox", { name: "Identity direction notes", exact: true }).fill("My private direction");
  fixture.preferences = { ownerId: fixtureOwner, projectId: fixtureProject, revision: 1, preferences: { ...initialIdentityPreferences(fixture.project.context), notes: "Other saved direction" }, createdAt: fixtureAt };
  await page.getByRole("button", { name: "Save Identity preferences" }).click(); await expect(page.locator(".project-identity").getByRole("alert")).toContainText("Saved inputs changed");
  await closeContextSheet(page); await page.locator(".identity-section-heading").getByRole("button", { name: "Check latest", exact: true }).click(); await openPreferences(page); await expect(page.getByRole("textbox", { name: "Identity direction notes", exact: true })).toHaveValue("My private direction");
  await page.getByRole("button", { name: "Keep edits against latest" }).click(); await page.getByRole("button", { name: "Save Identity preferences" }).click(); await expect(page.locator("dialog[open]").getByText("Identity preferences saved.", { exact: true })).toBeVisible(); expect(fixture.preferences.revision).toBe(2);
});
test("identity fixture: ambiguous preference save never infers original authorship from matching values", async ({ page }) => {
  const fixture = await setup(page); fixture.losePreference = true; await ready(page); await openPreferences(page); await page.getByRole("textbox", { name: "Identity direction notes", exact: true }).fill("Unconfirmed direction"); await page.getByRole("button", { name: "Save Identity preferences" }).click();
  await expect(page.getByText("The original preference save could not be confirmed. Check the latest before another save.", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Check latest preferences" }).click();
  await expect(page.getByText("The latest saved preferences match your draft. The original save could not be confirmed.", { exact: true })).toBeVisible(); expect(fixture.writes.filter(write => write.kind === "preferences")).toHaveLength(1);
});
test("identity fixture: same-owner rechecks recover both preference and raw manual buffers", async ({ page }) => {
  await setup(page); await ready(page); await openColors(page); await page.getByRole("textbox", { name: "Color 1 hex", exact: true }).fill("#A"); await openPreferences(page); await page.getByRole("textbox", { name: "Identity direction notes", exact: true }).fill("Keep this private direction");
  await recheck(page); await openColors(page); await expect(page.getByRole("textbox", { name: "Color 1 hex", exact: true })).toHaveValue("#A"); await openPreferences(page); await expect(page.getByRole("textbox", { name: "Identity direction notes", exact: true })).toHaveValue("Keep this private direction");
});
test("identity fixture: unconfirmed refinement survives remount and retries the exact original intent", async ({ page }) => {
  const fixture = await setup(page); fixture.loseRefinement = true; await ready(page); await openColors(page); await page.getByRole("textbox", { name: "Color 1 hex", exact: true }).fill("#AA2255"); await page.getByRole("button", { name: "Save colors as new version" }).click();
  await expect(page.getByRole("button", { name: "Retry original colors save" })).toBeVisible(); const first = fixture.writes.find(write => write.kind === "refinement")!.body;
  await recheck(page); await page.getByRole("button", { name: "Resume colors edit", exact: true }).click(); await openColors(page); await page.getByRole("button", { name: "Retry original colors save" }).click();
  await expect(page.locator("dialog[open]").getByText("The manual edit is saved in history. The latest current choice has been checked.", { exact: true })).toBeVisible();
  const requests = fixture.writes.filter(write => write.kind === "refinement"); expect(requests).toHaveLength(2); expect(requests[1]!.body).toEqual(first); expect(fixture.systems).toHaveLength(2); expect(fixture.selection?.identityRevision).toBe(2);
});
test("identity fixture: failed sign-out hides private content and restores edits after same-owner verification", async ({ page }) => {
  const fixture = await setup(page); fixture.signOutStatus = 500; await ready(page); await openPreferences(page); await page.getByRole("textbox", { name: "Identity direction notes", exact: true }).fill("Preserve after failed logout");
  await beginSignOut(page); await expect(page.getByRole("dialog", { name: "Sign out with unsaved account edits?" })).toBeVisible(); await page.getByRole("button", { name: "Discard edits and sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Sign-out couldn't be confirmed" })).toBeVisible(); await expect(page.locator(".project-identity")).toHaveCount(0);
  await recheck(page); await openPreferences(page); await expect(page.getByRole("textbox", { name: "Identity direction notes", exact: true })).toHaveValue("Preserve after failed logout");
});
test("identity fixture: confirmed logout clears edits and existing discard confirmation applies", async ({ page }) => {
  const fixture = await setup(page); await ready(page); await openPreferences(page); await page.getByRole("textbox", { name: "Identity direction notes", exact: true }).fill("Discard on confirmed logout");
  await beginSignOut(page); await expect(page.getByRole("dialog", { name: "Sign out with unsaved account edits?" })).toBeVisible(); await page.getByRole("button", { name: "Keep editing" }).click();
  await openPreferences(page); await expect(page.getByRole("textbox", { name: "Identity direction notes", exact: true })).toHaveValue("Discard on confirmed logout"); await beginSignOut(page); await page.getByRole("button", { name: "Discard edits and sign out" }).click();
  await expect(page.locator(".project-identity")).toHaveCount(0); fixture.sessionStatus = 200; await recheck(page); await openPreferences(page); await expect(page.getByRole("textbox", { name: "Identity direction notes", exact: true })).toHaveValue("");
});
test("identity fixture: owner change clears manual and preference buffers without leaking delayed history", async ({ page }) => {
  const fixture = await setup(page); await ready(page); await openColors(page); await page.getByRole("textbox", { name: "Color 1 name", exact: true }).fill("Private color edit"); await openPreferences(page); await page.getByRole("textbox", { name: "Identity direction notes", exact: true }).fill("Private direction");
  fixture.holdNextOverview = true; await closeContextSheet(page); await page.locator(".identity-section-heading").getByRole("button", { name: "Check latest", exact: true }).click(); await expect.poll(() => fixture.heldOverview).not.toBeNull();
  fixture.owner = fixtureId(999); await checkAccount(page); await expect(page.locator(".project-identity")).toHaveCount(0); await fixture.heldOverview!(); await expect(page.getByText("Private direction", { exact: true })).toHaveCount(0);
  fixture.owner = fixtureOwner; await recheck(page); await openColors(page); await expect(page.getByRole("textbox", { name: "Color 1 name", exact: true })).toHaveValue("Forest"); await openPreferences(page); await expect(page.getByRole("textbox", { name: "Identity direction notes", exact: true })).toHaveValue("");
});
test("identity fixture: Identity-only dirty memory prevents beforeunload", async ({ page }) => {
  await setup(page); await ready(page); await openPreferences(page); await page.getByRole("textbox", { name: "Identity direction notes", exact: true }).fill("Unsaved Identity-only edit");
  expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  await page.getByRole("button", { name: "Discard preference edits" }).click();
  expect(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
});
test("identity fixture: unavailable production files report the failed attempt without a readiness claim", async ({ page }) => {
  await setup(page); await ready(page); await page.getByRole("button", { name: "Check and download" }).click(); await expect(page.getByText("Private files are unavailable right now.", { exact: true })).toBeVisible();
  await expect(page.getByText(/vector.ready|license.ready|export.ready/i)).toHaveCount(0);
});

// Synthetic local fixture captures for parent design review; no live output claim.
test("identity fixture: current desktop and mobile design evidence", async ({ page }, testInfo) => {
  await setup(page); await ready(page);
  await page.locator(".identity-system-detail .identity-board-image").scrollIntoViewIfNeeded();
  await expect(page.locator(".identity-system-detail .identity-board-image img")).toBeVisible();
  const evidence = evidenceDirectory;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-full.png`, fullPage: true, scale: "css" });
  await page.locator(".project-identity").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-viewport.png`, scale: "css" });
  await openColors(page);
  await page.getByRole("textbox", { name: "Color 1 name", exact: true }).focus();
  await page.locator(".identity-components").screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-component-panel.png`, scale: "css" });
  await page.locator(".identity-history").screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-history-panel.png`, scale: "css" });
  await openPreferences(page);
  await page.locator(".identity-preferences").screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-preferences-panel.png`, scale: "css" });
  await page.locator(".identity-transition").screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-transition-panel.png`, scale: "css" });
  await page.locator(".identity-references-heading").screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-header.png`, scale: "css" });
  await closeContextSheet(page); await page.getByRole("button", { name: "Moodboard", exact: true }).click(); await page.getByRole("region", { name: "Brand references" }).screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-references-panel.png`, scale: "css" });
  await page.screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-colors.png`, fullPage: true, scale: "css" });
});


test("identity fixture: uncertain choice requires a fresh read before another choice", async ({ page }) => {
  const fixture = await setup(page); fixture.systems.push(initialSystem(1)); await ready(page);
  await closeContextSheet(page); await page.locator(".identity-history-card").first().getByRole("button", { name: "View system" }).click();
  fixture.loseSelection = true; await page.getByRole("button", { name: "Restore as current" }).click();
  await expect(page.locator(".project-identity").getByRole("alert")).toContainText("could not be confirmed");
  await expect(page.getByRole("button", { name: "Restore as current" })).toBeDisabled();
  expect(fixture.writes.filter(write => write.kind === "selection")).toHaveLength(1);
  await closeContextSheet(page); await page.locator(".identity-section-heading").getByRole("button", { name: "Check latest", exact: true }).click();
  await expect(page.locator(".identity-system-detail .identity-badge")).toHaveText("Current choice");
});
test("identity fixture: preference recovery cannot rebase until a successful latest read", async ({ page }) => {
  const fixture = await setup(page); fixture.losePreference = true; await ready(page); await openPreferences(page);
  await page.getByRole("textbox", { name: "Identity direction notes", exact: true }).fill("Unknown outcome");
  await page.getByRole("button", { name: "Save Identity preferences" }).click();
  await expect(page.getByRole("button", { name: "Keep edits against latest" })).toBeDisabled();
  fixture.readStatus = 503; await page.getByRole("button", { name: "Check latest preferences" }).click();
  await expect(page.locator(".project-identity").getByRole("alert")).toContainText("unavailable");
  await expect(page.getByRole("button", { name: "Keep edits against latest" })).toBeDisabled();
  fixture.readStatus = 200; await page.getByRole("button", { name: "Check latest preferences" }).click();
  await expect(page.getByRole("button", { name: "Keep edits against latest" })).toBeEnabled();
});
test("identity fixture: reference interruption clears earlier acknowledgment even when revision does not advance", async ({ page }) => {
  const fixture = await setup(page); fixture.project = { ...fixture.project, current_revision: 2, context: contextSnapshotSchema.parse({ ...fixture.project.context, description: "Changed brief" }) }; await ready(page); await openColors(page);
  await page.getByRole("textbox", { name: "Color 1 name", exact: true }).fill("Berry");
  const ack = page.getByRole("checkbox", { name: "I understand this system uses earlier saved inputs." }); await closeContextSheet(page); await ack.check(); await openColors(page);
  fixture.holdNextReference = true; await closeContextSheet(page); await page.getByRole("button", { name: "Moodboard", exact: true }).click(); await page.getByRole("button", { name: /^Ensemble for/ }).click();
  await expect.poll(() => fixture.heldReference).not.toBeNull(); await page.getByRole("button", { name: "Saved systems", exact: true }).click(); await expect(ack).not.toBeChecked(); await openColors(page);
  await expect(page.getByRole("button", { name: "Save colors as new version" })).toBeDisabled();
  await fixture.heldReference!(); await closeContextSheet(page); await page.getByRole("button", { name: "Moodboard", exact: true }).click(); await expect(page.getByRole("alert").filter({ hasText: "changed" })).toContainText("changed");
  await page.getByRole("button", { name: "Check references", exact: true }).click();
  await page.getByRole("button", { name: "Saved systems", exact: true }).click();
  await expect(ack).not.toBeChecked(); await openColors(page); await expect(page.getByRole("button", { name: "Save colors as new version" })).toBeDisabled();
});
test("identity fixture: exact old replay checks the latest head after an independent restore", async ({ page }) => {
  const fixture = await setup(page); fixture.loseRefinement = true; await ready(page); await openColors(page);
  await page.getByRole("textbox", { name: "Color 1 name", exact: true }).fill("Berry"); await page.getByRole("button", { name: "Save colors as new version" }).click();
  await expect(page.getByRole("button", { name: "Retry original colors save" })).toBeVisible();
  const original = fixture.writes.find(write => write.kind === "refinement")!.body;
  // A separate actor restored the original system after the first save completed.
  fixture.selection = { ...fixture.selection!, id: fixtureId(989), systemVersionId: fixture.systems[0]!.id, identityRevision: 3, previousSelectionId: fixture.selection!.id, reason: "restored" };
  await page.getByRole("button", { name: "Retry original colors save" }).click();
  await expect(page.locator("dialog[open]").getByText("The manual edit is saved in history. The latest current choice has been checked.", { exact: true })).toBeVisible();
  expect(fixture.selection.identityRevision).toBe(3); expect(fixture.systems).toHaveLength(2);
  expect(fixture.writes.filter(write => write.kind === "refinement")[1]!.body).toEqual(original);
  await expect(page.locator(".identity-system-detail .identity-badge")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restore as current" })).toBeEnabled();
});
test("identity fixture: client navigation back retains raw drafts in the provider", async ({ page }) => {
  await setup(page); await ready(page); await openColors(page); await page.getByRole("textbox", { name: "Color 1 hex", exact: true }).fill("#A");
  await closeContextSheet(page); await page.getByRole("link", { name: "Back to project", exact: true }).click(); await expect(page.locator(".project-identity")).toHaveCount(0);
  await page.goBack(); await page.getByRole("button", { name: "Saved systems", exact: true }).click(); await expect(page.locator("#identity-detail-title")).toBeVisible(); await openColors(page);
  await expect(page.getByRole("textbox", { name: "Color 1 hex", exact: true })).toHaveValue("#A");
});
test("identity fixture: reload and closed tab retain confirmed saved versions in account history", async ({ page, context }) => {
  const fixture = await setup(page); await ready(page); await openColors(page); await page.getByRole("textbox", { name: "Color 1 name", exact: true }).fill("Berry");
  await page.getByRole("button", { name: "Save colors as new version" }).click(); await expect(page.locator("dialog[open]").getByText("The manual edit is saved in history. The latest current choice has been checked.", { exact: true })).toBeVisible();
  await page.reload(); await page.getByRole("button", { name: "Saved systems", exact: true }).click(); await expect(page.locator(".identity-history-card")).toHaveCount(2); await expect(page.locator(".identity-swatches").filter({ hasText: "Berry" })).toBeVisible();
  await page.close(); const reopened = await context.newPage(); await setup(reopened, fixture); await ready(reopened);
  await expect(reopened.locator(".identity-history-card")).toHaveCount(2); await expect(reopened.locator(".identity-swatches").filter({ hasText: "Berry" })).toBeVisible();
  expect(fixture.writes.filter(write => write.kind === "refinement")).toHaveLength(1);
});
test("identity fixture: incomplete output is rejected without replacing validated history", async ({ page }) => {
  const fixture = await setup(page); await ready(page); fixture.malformedOverview = true;
  await closeContextSheet(page); await page.locator(".identity-section-heading").getByRole("button", { name: "Check latest", exact: true }).click();
  await expect(page.locator(".project-identity").getByRole("alert")).toContainText("could not be verified");
  await expect(page.locator(".identity-history-card")).toHaveCount(1); await expect(page.locator("#identity-detail-title")).toHaveText("Cedar"); expect(fixture.writes).toHaveLength(0);
});
test("identity fixture: keyboard editing remains usable at narrow mobile width", async ({ page }, testInfo) => {
  await setup(page); if (testInfo.project.name === "mobile") await page.setViewportSize({ width: 320, height: 568 }); await ready(page);
  const summary = page.getByRole("button", { name: "Edit colors", exact: true }); await summary.focus(); await page.keyboard.press("Enter");
  const name = page.getByRole("textbox", { name: "Color 1 name", exact: true }); await name.focus(); await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.type("Keyboard Berry");
  await page.keyboard.press("Tab"); await expect(page.getByRole("textbox", { name: "Color 1 hex", exact: true })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.type("#AA2255");
  const save = page.getByRole("button", { name: "Save colors as new version" }); await save.focus(); await page.keyboard.press("Enter");
  await expect(page.locator("dialog[open]").getByText("The manual edit is saved in history. The latest current choice has been checked.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("identity fixture: partial collection preserves two actual saved systems without filling a third", async ({ page }) => {
  const fixture = await setup(page); fixture.systems = [initialSystem(), initialSystem(1)]; await ready(page);
  await expect(page.locator(".identity-history-card")).toHaveCount(2); await expect(page.getByRole("button", { name: "Load more systems" })).toHaveCount(0);
  await expect(page.getByText(/three systems ready|generation complete|all systems completed/i)).toHaveCount(0);
  for (const card of await page.locator(".identity-history-card").all()) { await card.getByRole("button", { name: "View system" }).click(); await expect(page.locator(".identity-components").getByRole("heading", { name: "Composition", exact: true })).toBeVisible(); }
  expect(fixture.systems).toHaveLength(2); expect(fixture.writes).toHaveLength(0);
});

test("identity fixture: stale manual write preserves raw input and only retries after explicit new observation", async ({ page }) => {
  const fixture = await setup(page); await ready(page); await openColors(page); await page.getByRole("textbox", { name: "Color 1 name", exact: true }).fill("My raw color");
  fixture.project = { ...fixture.project, current_revision: 2, context: contextSnapshotSchema.parse({ ...fixture.project.context, description: "Other saved brief" }) };
  await page.getByRole("button", { name: "Save colors as new version" }).click();
  await expect(page.locator(".project-identity").getByRole("alert")).toContainText("Saved inputs changed");
  await expect(page.getByRole("textbox", { name: "Color 1 name", exact: true })).toHaveValue("My raw color"); expect(fixture.systems).toHaveLength(1);
  const first = fixture.writes.filter(write => write.kind === "refinement")[0]!.body as ReturnType<typeof refineIdentityComponentSchema.parse>;
  await closeContextSheet(page); await page.locator(".identity-section-heading").getByRole("button", { name: "Check latest", exact: true }).click();
  const ack = page.getByRole("checkbox", { name: "I understand this system uses earlier saved inputs." }); await expect(ack).not.toBeChecked(); await openColors(page);
  await expect(page.getByRole("button", { name: "Save colors as new version" })).toBeDisabled(); await closeContextSheet(page); await ack.check(); await openColors(page); await page.getByRole("button", { name: "Save colors as new version" }).click();
  await expect(page.locator("dialog[open]").getByText("The manual edit is saved in history. The latest current choice has been checked.", { exact: true })).toBeVisible();
  const second = fixture.writes.filter(write => write.kind === "refinement")[1]!.body as ReturnType<typeof refineIdentityComponentSchema.parse>;
  expect(second.expectedProjectRevision).toBe(2); expect(second.idempotencyKey).not.toBe(first.idempotencyKey); expect(second.input).toEqual(first.input);
});
test("identity fixture: keyboard Reference element likes remain independent from Ensemble", async ({ page }) => {
  const fixture = await setup(page); await ready(page); await closeContextSheet(page); await page.getByRole("button", { name: "Moodboard", exact: true }).click();
  const show = page.getByRole("button", { name: /^Show elements for/ }); await show.focus(); await page.keyboard.press("Enter");
  const type = page.getByRole("button", { name: "Typography", exact: true }); await type.focus(); await page.keyboard.press("Enter");
  await expect.poll(() => fixture.references[0]!.reaction.elements.includes("typography")).toBe(true);
  await expect(type).toBeFocused();
  await expect(page.getByRole("group", { name: "Elements in Local fixture reference", exact: true })).toBeVisible();
  await expect(page.locator(".identity-reference-indicators")).toContainText("Typography");
  await expect(page.getByRole("button", { name: /^Ensemble for/ })).toHaveAttribute("aria-pressed", "true");
  await expect(type).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^Ensemble for/ }).click(); await expect(page.getByRole("button", { name: /^Ensemble for/ })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".identity-reference-indicators")).toContainText("Typography"); expect(fixture.references[0]!.reaction.elements).toContain("typography");
});
test("identity fixture: cancelling actual tab close keeps private raw edit buffers", async ({ page }) => {
  await setup(page); await ready(page); await openColors(page); await page.getByRole("textbox", { name: "Color 1 hex", exact: true }).fill("#A");
  const dialog = page.waitForEvent("dialog"); await page.close({ runBeforeUnload: true }); const prompt = await dialog;
  expect(prompt.type()).toBe("beforeunload"); await prompt.dismiss(); expect(page.isClosed()).toBe(false);
  await expect(page.getByRole("textbox", { name: "Color 1 hex", exact: true })).toHaveValue("#A");
});

test("identity fixture: saved References has an honest keyboard transition to the actual Systems heading", async ({ page }) => {
  const fixture = await setup(page); await ready(page); const transition = page.getByRole("link", { name: "View saved systems", exact: true });
  await expect(page.locator(".identity-transition")).toContainText("New system generation is unavailable.");
  await transition.focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("heading", { name: "Identity systems", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: /^Generate/ })).toHaveCount(0); expect(fixture.writes).toHaveLength(0);
});

test("identity fixture: unavailable trusted saves keep history readable and preference CAS separate", async ({ page }, testInfo) => {
  const fixture = await setup(page); fixture.saveAvailable = false; fixture.systems.push(initialSystem(1)); await ready(page); await openColors(page);
  await page.getByRole("textbox", { name: "Color 1 name", exact: true }).fill("My retained color");
  await expect(page.getByRole("button", { name: "Save colors as new version" })).toBeDisabled();
  await expect(page.getByText("Choosing a system and saving manual edits are unavailable right now.", { exact: true })).toBeVisible();
  await closeContextSheet(page); await page.locator(".identity-history-card").first().getByRole("button", { name: "View system" }).click(); await expect(page.getByRole("button", { name: "Restore as current" })).toBeDisabled();
  await expect(page.locator(".identity-history-card")).toHaveCount(2); await openPreferences(page);
  await page.getByRole("textbox", { name: "Identity direction notes", exact: true }).fill("Preferences can still save"); await page.getByRole("button", { name: "Save Identity preferences" }).click();
  await expect(page.locator("dialog[open]").getByText("Identity preferences saved.", { exact: true })).toBeVisible();
  expect(fixture.writes.map(write => write.kind)).toEqual(["preferences"]);
  const evidence = evidenceDirectory;
  await mkdir(evidence, { recursive: true }); await closeContextSheet(page); await page.locator(".identity-section-heading").getByRole("button", { name: "Check latest", exact: true }).focus();
  await page.locator(".identity-section-heading").filter({ has: page.getByRole("heading", { name: "Identity systems", exact: true }) }).screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-unavailable-heading.png`, scale: "css" });
  await page.locator(".project-identity .identity-save-gate").screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-unavailable-gate.png`, scale: "css" });
  await openColors(page);
  await page.getByRole("textbox", { name: "Color 1 name", exact: true }).focus();
  await expect(page.getByRole("textbox", { name: "Color 1 name", exact: true })).toBeFocused();
  await expect(page.getByRole("link", { name: "Skip to content", exact: true })).not.toBeFocused();
  // Capture-only normalization for the fixed offscreen skip-link locator artifact.
  await page.locator(".identity-components").screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-unavailable-components.png`, scale: "css", style: ".skip-link:not(:focus) { visibility: hidden; }" });
  await page.locator(".identity-system-detail > .identity-actions").screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-unavailable-restore.png`, scale: "css" });
  await page.locator(".identity-history").screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-unavailable-history.png`, scale: "css" });
});

test("identity fixture: pending Reference controls keep focus and reject repeat keyboard or forced pointer writes", async ({ page }) => {
  const fixture = await setup(page); await ready(page); fixture.holdNextReference = true;
  await closeContextSheet(page); await page.getByRole("button", { name: "Moodboard", exact: true }).click(); await page.getByRole("button", { name: /^Show elements for/ }).focus(); await page.keyboard.press("Enter");
  const type = page.getByRole("button", { name: "Typography", exact: true }); await type.focus(); await page.keyboard.press("Enter");
  await expect.poll(() => fixture.heldReference).not.toBeNull(); await expect(type).toBeFocused(); await expect(type).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter"); await page.keyboard.press("Space"); await type.click({ force: true });
  expect(fixture.writes.filter(write => write.kind === "reference")).toHaveLength(1); await fixture.heldReference!();
  await expect(page.getByRole("alert").filter({ hasText: "changed" })).toBeVisible(); await expect(type).toBeFocused();
  await expect(type).toHaveAttribute("aria-disabled", "true"); await page.keyboard.press("Enter"); await type.click({ force: true });
  expect(fixture.writes.filter(write => write.kind === "reference")).toHaveLength(1);
});

test("identity fixture: empty Systems shows the generation gate and honest transition with saved References", async ({ page }, testInfo) => {
  const fixture = await setup(page); fixture.systems = []; fixture.selection = null; fixture.saveAvailable = false;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); await page.goto(url); await page.getByRole("button", { name: "Saved systems", exact: true }).click();
  await expect(page.getByText("No Identity systems have been saved yet. Generation is unavailable.", { exact: true })).toBeVisible();
  await expect(page.locator("[aria-label=\"Brand references\"] article")).toHaveCount(1);
  await expect(page.locator(".identity-history-card")).toHaveCount(0); await expect(page.getByRole("link", { name: "View saved systems", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Generate/ })).toHaveCount(0); expect(fixture.writes).toHaveLength(0); expect(errors).toEqual([]);
  const evidence = evidenceDirectory; await mkdir(evidence, { recursive: true });
  await page.getByRole("button", { name: "Check latest", exact: true }).focus();
  await page.locator(".project-identity").screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-empty-systems.png`, scale: "css" });
  await page.locator(".identity-transition").screenshot({ path: `${evidence}/synthetic-identity-${testInfo.project.name}-empty-transition.png`, scale: "css" });
});


function visualFixture() {
  const fixture = makeFixture(), systems = fixtureVisualSystems();
  const overview = fixtureOverview({input:systems[0]!.input,systems,selected:true});
  fixture.systems=systems; fixture.project=accountProjectSchema.parse(overview.project);
  fixture.selection=overview.currentSelection!.selection; fixture.saveAvailable=false;
  return fixture;
}
async function waitForBoard(page:Page,selector:string) {
  await page.locator(selector).locator(".identity-board-image").scrollIntoViewIfNeeded();
  const image=page.locator(selector).locator(".identity-board-image img");
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("alt",/^Saved Identity board for Synthetic fixture — /);
  await expect.poll(()=>image.evaluate(node=>({width:(node as HTMLImageElement).naturalWidth,height:(node as HTMLImageElement).naturalHeight}))).toEqual({width:640,height:480});
  expect(await image.evaluate(node=>getComputedStyle(node).objectFit)).toBe("contain");
}
async function viewportCapture(page:Page,name:string) {
  await mkdir(evidenceDirectory,{recursive:true});
  await expect(page.getByRole("link",{name:"Skip to content",exact:true})).not.toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`${evidenceDirectory}/${name}.png`,scale:"css"});
}
test("D041 synthetic evidence: three authored PNG boards and full viewport context",async({page},testInfo)=>{
  const fixture=visualFixture(); await setup(page,fixture);
  if(testInfo.project.name==="desktop")await page.setViewportSize({width:1440,height:1000});
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await page.goto(url); await page.getByRole("button", { name: "Saved systems", exact: true }).click();
  await expect(page.locator("#identity-detail-title")).toHaveText(fixture.systems[0]!.input.basis.name);
  await expect(page.locator(".identity-history-card")).toHaveCount(3);
  for(const board of fixtureBoards){const bytes=Buffer.from(board.base64,"base64");expect(bytes.subarray(0,8).toString("hex")).toBe("89504e470d0a1a0a");expect(createHash("sha256").update(bytes).digest("hex")).toBe(board.sha256);}
  expect(new Set(fixture.systems.map(system=>system.board.asset.contentHash)).size).toBe(3);
  const prefix=`d041-synthetic-${testInfo.project.name}`;
  await page.getByLabel("Account menu", { exact: true }).focus();await page.evaluate(()=>window.scrollTo(0,0));
  await viewportCapture(page,`${prefix}-01-reference-context`);
  const transition=page.getByRole("link",{name:"View saved systems",exact:true});await transition.focus();await page.keyboard.press("Enter");
  await expect(page.getByRole("heading",{name:"Identity systems",exact:true})).toBeFocused();
  await page.locator(".identity-transition").evaluate(node=>window.scrollTo(0,window.scrollY+node.getBoundingClientRect().top-180));
  await viewportCapture(page,`${prefix}-02-reference-to-systems`);
  await page.locator(".identity-system-detail").evaluate(node=>node.scrollIntoView({block:"start"}));await waitForBoard(page,".identity-system-detail");
  await viewportCapture(page,`${prefix}-03-current-board`);
  await openColors(page);const name=page.getByRole("textbox",{name:"Color 1 name",exact:true});await name.fill("  Retained long local color name for layout review  ");
  const hex=page.getByRole("textbox",{name:"Color 1 hex",exact:true});await hex.fill("#A");await name.focus();
  const save=page.getByRole("button",{name:"Save colors as new version"});await expect(save).toBeDisabled();await expect(save).toHaveAttribute("aria-describedby","identity-colors-save-unavailable");
  await save.scrollIntoViewIfNeeded();await expect(page.locator("#identity-colors-save-unavailable")).toBeVisible();
  await viewportCapture(page,`${prefix}-04-unavailable-color-save`);await expect(hex).toHaveValue("#A");
  await openTypography(page);await page.getByRole("textbox",{name:"Type 1 family",exact:true}).focus();
  const typeSave=page.getByRole("button",{name:"Save typography as new version"});await expect(typeSave).toBeDisabled();await expect(typeSave).toHaveAttribute("aria-describedby","identity-typography-save-unavailable");await typeSave.scrollIntoViewIfNeeded();
  await viewportCapture(page,`${prefix}-05-unavailable-type-save`);
  await closeContextSheet(page);
  const cards=page.locator(".identity-history-card");
  if(testInfo.project.name==="desktop"){
    await page.locator(".identity-history").evaluate(node=>node.scrollIntoView({block:"start"}));
    for(let index=0;index<3;index++)await waitForBoard(page,`.identity-history-card:nth-child(${index+1})`);
    await viewportCapture(page,`${prefix}-06-three-saved-systems`);
  }else{
    for(let index=0;index<3;index++){
      await cards.nth(index).scrollIntoViewIfNeeded();await waitForBoard(page,`.identity-history-card:nth-child(${index+1})`);
      await viewportCapture(page,`${prefix}-0${6+index}-saved-system-${index+1}`);
    }
  }
  await expect(cards.filter({hasText:"Current choice"})).toHaveCount(1);expect(fixture.writes).toHaveLength(0);expect(errors).toEqual([]);
});
test("D041 synthetic evidence: unavailable controls preserve raw drafts and keyboard focus",async({page})=>{
  const fixture=visualFixture();await setup(page,fixture);await page.goto(url); await page.getByRole("button", { name: "Saved systems", exact: true }).click();await expect(page.locator(".identity-history-card")).toHaveCount(3);
  const transition=page.getByRole("link",{name:"View saved systems",exact:true});await transition.focus();await page.keyboard.press("Enter");await expect(page.getByRole("heading",{name:"Identity systems",exact:true})).toBeFocused();
  const summary=page.getByRole("button",{name:"Edit colors",exact:true});await summary.focus();await page.keyboard.press("Enter");
  const name=page.getByRole("textbox",{name:"Color 1 name",exact:true});await name.focus();await page.keyboard.press("ControlOrMeta+A");await page.keyboard.type("  Raw local color  ");await page.keyboard.press("Tab");
  const hex=page.getByRole("textbox",{name:"Color 1 hex",exact:true});await expect(hex).toBeFocused();await hex.fill("#A");
  const save=page.getByRole("button",{name:"Save colors as new version"});await expect(save).toBeDisabled();await expect(save).toHaveAccessibleDescription("Saving manual edits is unavailable right now. Your local edits are kept in this tab.");
  await page.keyboard.press("Enter");await expect(hex).toHaveValue("#A");await expect(name).toHaveValue("  Raw local color  ");
  await closeContextSheet(page);await summary.focus();await page.keyboard.press("Enter");await expect(name).toHaveValue("  Raw local color  ");await expect(hex).toHaveValue("#A");expect(fixture.writes).toHaveLength(0);
});
test("D041 synthetic evidence: explicit local fixture restoration appends a current choice",async({page},testInfo)=>{
  const fixture=visualFixture();fixture.saveAvailable=true;await setup(page,fixture);await page.goto(url); await page.getByRole("button", { name: "Saved systems", exact: true }).click();await expect(page.locator(".identity-history-card")).toHaveCount(3);
  const original=JSON.stringify(fixture.systems);await page.locator(".identity-history-card").first().getByRole("button",{name:"View system"}).click();
  const ack=page.getByRole("checkbox",{name:"I understand this system uses earlier saved inputs."});await closeContextSheet(page); await ack.check();
  const restore=page.getByRole("button",{name:"Restore as current"});await expect(restore).toBeEnabled();await restore.focus();await page.keyboard.press("Enter");
  await expect(page.getByText("Current Identity choice saved.",{exact:true})).toBeVisible();expect(fixture.selection).toMatchObject({identityRevision:2,reason:"restored",acceptedEarlierBasis:true});expect(JSON.stringify(fixture.systems)).toBe(original);
  await expect(page.locator(".identity-system-detail").getByText("Current choice",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Current Identity choice",exact:true})).toBeDisabled();
  await page.locator(".identity-system-detail").evaluate(node=>node.scrollIntoView({block:"start"}));await waitForBoard(page,".identity-system-detail");
  await viewportCapture(page,`d041-synthetic-${testInfo.project.name}-09-fixture-only-restored-choice`);expect(fixture.writes.map(write=>write.kind)).toEqual(["selection"]);
});

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));

// Current modal interaction regression: do not reach through a native dialog
// to a background acknowledgment or feedback node.
test("identity editor: stale colors can be approved and saved entirely inside the modal", async ({ page }, info) => {
  const fixture = await setup(page);
  fixture.project = { ...fixture.project, current_revision: 2, context: contextSnapshotSchema.parse({ ...fixture.project.context, description: "A changed saved brief" }) };
  await ready(page); await openColors(page);
  const panel = page.getByRole("dialog", { name: "Edit colors", exact: true });
  const original = JSON.stringify(fixture.systems[0]);
  await panel.getByRole("textbox", { name: "Color 1 name", exact: true }).fill("Berry");
  const submit = panel.getByRole("button", { name: "Save colors as new version", exact: true });
  await expect(submit).toBeDisabled();
  await panel.getByRole("checkbox", { name: "I understand this system uses earlier saved inputs.", exact: true }).check();
  await expect(submit).toBeEnabled(); await submit.click();
  await expect(panel.getByRole("status")).toContainText("The manual edit is saved in history.");
  await expect(panel).toBeVisible();
  expect(fixture.systems).toHaveLength(2); expect(JSON.stringify(fixture.systems[0])).toBe(original);
  expect(fixture.writes.filter(write => write.kind === "refinement")).toHaveLength(1);
  await page.screenshot({ path: info.outputPath("identity-editor-saved-in-modal.png") });
});

test("identity editor: preference conflict feedback and refresh stay inside the modal", async ({ page }) => {
  const fixture = await setup(page); await ready(page); await openPreferences(page);
  const panel = page.getByRole("dialog", { name: /^Identity preferences/ });
  await panel.getByRole("textbox", { name: "Identity direction notes", exact: true }).fill("Keep my direction");
  fixture.preferences = { ownerId: fixtureOwner, projectId: fixtureProject, revision: 1, preferences: { ...initialIdentityPreferences(fixture.project.context), notes: "Another saved direction" }, createdAt: fixtureAt };
  await panel.getByRole("button", { name: "Save Identity preferences", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Saved inputs changed");
  await panel.getByRole("button", { name: "Check latest saved inputs", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "Identity direction notes", exact: true })).toHaveValue("Keep my direction");
  await panel.getByRole("button", { name: "Keep edits against latest", exact: true }).click();
  await panel.getByRole("button", { name: "Save Identity preferences", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Identity preferences saved.");
  expect(fixture.preferences.revision).toBe(2);
});
