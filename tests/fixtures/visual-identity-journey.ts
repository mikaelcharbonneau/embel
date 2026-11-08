/** Synthetic local HTTP fixtures only. No live account, provider call or saved production data. */
import { createHash } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import { DEFAULT_PROFILE_VALUES } from "../../src/domain/account-profile";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { IMAGE_MODEL } from "../../src/domain/providers";
import { identityBatchStateSchema, logoBoardGenerationIntentSchema, type IdentityBatchState } from "../../src/domain/identity-jobs";
import { identityLogoSourceSchema } from "../../src/domain/identity-logo-source";
import type { BrandBoardApplicationDesign } from "../../src/domain/brand-board-design";
import type { BrandBoardFontFamily } from "../../src/domain/brand-board-fonts";
import {
  createIdentityInputSnapshot, getIdentityCurrentBasis, getIdentityFreshness, getIdentityReadiness, initialIdentityPreferences, projectIdentityOverviewSchema,
  selectIdentitySystem, selectIdentitySystemSchema, summarizeIdentitySystem,
  type IdentitySelection, type IdentitySystemVersion, type ProjectIdentityOverview,
} from "../../src/domain/project-identity";
import { logoConceptBatchSchema } from "../../src/domain/logo-jobs";
import { logoStageRevisionSchema, logoWorkspaceV2Schema, type LogoStageRevision } from "../../src/domain/logo-workspace";
import { syntheticLogoBatch, syntheticLogoWorkspace, syntheticResolvedLogoConcept } from "./logo-creation";
import { syntheticConversionInput } from "../features/logo-vector/raster-fixtures";
import { fixtureAt, fixtureBoards, fixtureId as id, fixtureInput, fixtureOwner as ownerId, fixtureProject as projectId, fixtureSystem } from "../client/project-identity-fixtures";
import { watchNormalAppErrors } from "../e2e/account-check";

export { ownerId, projectId };
export const directionsUrl = `/brands/account/${projectId}/logo/directions`;
export const conceptsUrl = `/brands/account/${projectId}/logo`;
export const assetsUrl = `/brands/account/${projectId}/logo/deliverables`;
const identityBase = `/api/projects/${projectId}/identity`, logoBase = `/api/projects/${projectId}/logo`;
const scope = { ownerId, projectId };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type JourneySystem = IdentitySystemVersion & { applicationDesign: BrandBoardApplicationDesign };
type Usage = { status: "pending" | "recorded" | "unknown"; knownCostMicrousd: number };

function own<T>(value: T): T {
  const original = syntheticLogoWorkspace();
  return JSON.parse(JSON.stringify(value).replaceAll(original.ownerId, ownerId).replaceAll(original.projectId, projectId));
}

export function createVisualJourneyFixture(options: { standalone?: boolean; name?: string; fontFamily?: BrandBoardFontFamily } = {}) {
  const name = options.name ?? "Cedar", baseInput = fixtureInput({ name, references: 0 });
  const png = Buffer.from(syntheticConversionInput("combination").source.bytes), pngHash = hash(png);
  const resolved = own(syntheticResolvedLogoConcept());
  const brief = { ...resolved.brief, payload: { ...resolved.brief.payload, name } };
  const context = options.standalone ? contextSnapshotSchema.parse({}) : baseInput.context;
  const input = createIdentityInputSnapshot({ ...scope, scope: baseInput.scope, projectRevision: baseInput.projectRevision,
    context, referenceSnapshot: baseInput.referenceSnapshot, preferencesRevision: 0, preferences: initialIdentityPreferences(context), capturedAt: fixtureAt, logoBrief: brief });
  const logoBatch = own(syntheticLogoBatch(Array.from({ length: 6 }, () => "succeeded" as const)));
  for (const slot of logoBatch.slots) {
    for (const attempt of slot.attempts) if (attempt.preview) {
      attempt.preview.reference.contentHash = pngHash;
      attempt.preview.verification = { ...attempt.preview.verification, contentHash: pngHash, byteLength: png.length };
    }
    slot.acceptedPreview = slot.attempts[0]!.preview;
  }
  logoConceptBatchSchema.parse(logoBatch);
  const selected = { kind: "concept" as const, batchId: logoBatch.id, slotId: logoBatch.slots[0]!.id, attemptId: logoBatch.slots[0]!.attempts[0]!.id };
  const conceptStage = logoStageRevisionSchema.parse({ ...brief, id: id(800), stage: "concepts", inputRevisions: [{ stage: "brief_references", id: brief.id, revision: brief.revision }],
    payload: { batchIds: [logoBatch.id], selected } }) as LogoStageRevision<"concepts">;
  const foundation = own(syntheticLogoWorkspace());
  const workspace = structuredClone(logoWorkspaceV2Schema.parse({ ...foundation, heads: { ...foundation.heads, projectRevision: input.projectRevision,
    referenceRevision: input.referenceSnapshot.referenceRevision, workspaceRevision: 2, stageRevisions: { ...foundation.heads.stageRevisions, brief_references: 1, concepts: 1 } },
    stages: { ...foundation.stages, brief_references: { stage: "brief_references", id: brief.id, revision: 1 }, concepts: { stage: "concepts", id: conceptStage.id, revision: 1 } },
    capabilities: { ...foundation.capabilities, save: { status: "available" } } }));
  const sourceLogo = identityLogoSourceSchema.parse({ version: 1, source: selected, selectionRevision: 1, logoType: logoBatch.slots[0]!.type, brief,
    preview: logoBatch.slots[0]!.acceptedPreview });
  const stages = new Map<string, LogoStageRevision>([[brief.id, brief], [conceptStage.id, conceptStage]]);
  const boardImages = new Map<string, Buffer>(fixtureBoards.map(board => [board.sha256, Buffer.from(board.base64, "base64")]));
  const project = { id: projectId, owner_id: ownerId, title: `${name} · synthetic journey fixture`, scope: input.scope, current_revision: input.projectRevision,
    created_at: fixtureAt, context: input.context };
  const state = {
    owner: ownerId, sessionReads: 0, project, input, workspace, sourceLogo, stages, logoBatch, logoBytes: png,
    batch: null as (IdentityBatchState & { usage?: Usage }) | null,
    systems: [] as JourneySystem[], selection: null as IdentitySelection | null, sourceCurrent: true,
    admissions: [] as ReturnType<typeof logoBoardGenerationIntentSchema.parse>[], selections: [] as ReturnType<typeof selectIdentitySystemSchema.parse>[],
    stopRequests: 0, loseAdmission: false, loseSelection: false, savingAvailable: true,
    privateReads: [] as string[], unexpected: [] as string[], mutations: [] as string[],
  };

  function system(index: number): JourneySystem {
    const base = fixtureSystem(input, index), primaries = ["#123456", "#872A43", "#334455"];
    return { ...base, productionFiles: [], components: { ...base.components,
      colors: { swatches: [
        { key: "primary", name: "Primary", hex: primaries[index]! }, { key: "accent", name: "Accent", hex: "#E7B76E" },
        { key: "background", name: "Warm paper", hex: "#F7F1E3" }, { key: "text", name: "Ink", hex: "#10241A" },
      ], usageNotes: "Use the light surface for long-form content." },
      typography: { styles: [
        { key: "heading", role: "Heading", family: options.fontFamily ?? (index === 1 ? "Fraunces" : "Lora"), weight: 600, style: "normal" },
        { key: "body", role: "Body", family: options.fontFamily ?? "Manrope", weight: 400, style: "normal" },
      ], usageNotes: "Use the heading face for short statements and the body face for detail." },
      composition: { direction: ["An editorial direction with generous space.", "A warm, expressive direction with soft forms.", "A structured direction with confident blocks."][index]!, usageNotes: "Synthetic saved specification." },
    }, applicationDesign: { version: 1, graphic: ["fine_lines", "rounded_shapes", "bold_blocks"][index] as BrandBoardApplicationDesign["graphic"],
      layout: ["editorial", "centered", "split"][index] as BrandBoardApplicationDesign["layout"],
      paletteRoles: { primary: "primary", accent: "accent", background: "background", text: "text" }, headingStyleKey: "heading", bodyStyleKey: "body" } };
  }
  function overview(limit = 20): ProjectIdentityOverview {
    const currentBasis = getIdentityCurrentBasis({ ...scope, context: project.context, references: input.referenceSnapshot, preferences: initialIdentityPreferences(project.context), logoBrief: brief });
    const chosen = state.selection ? state.systems.find(item => item.id === state.selection!.systemVersionId) : null;
    const sorted = [...state.systems].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const items = sorted.slice(0, limit).map(item => summarizeIdentitySystem(item, currentBasis));
    const last = items.at(-1);
    // Parse the response as the application does; fixtures must not bypass a real contract.
    return projectIdentityOverviewSchema.parse({ ...scope, project, logoBrief: brief,
      saveAvailability: state.savingAvailable ? { status: "available" } : { status: "unavailable", reason: "trusted_transaction_unavailable" },
      session: state.selection ? { ...scope, identityRevision: state.selection.identityRevision, currentSelectionId: state.selection.id, currentPreferencesRevision: 0, createdAt: fixtureAt, updatedAt: fixtureAt } : null,
      preferences: null, referenceSnapshot: input.referenceSnapshot, currentBasis, readiness: getIdentityReadiness(project.context, project.scope, input.referenceSnapshot),
      currentSelection: chosen && state.selection ? { selection: state.selection, system: chosen, freshness: getIdentityFreshness(chosen.input.basis, currentBasis), sourceLogo, sourceLogoCurrent: state.sourceCurrent } : null,
      systems: { ...scope, query: { limit }, items, nextCursor: sorted.length > limit && last ? { projectId, id: last.id, createdAt: last.createdAt } : null },
    });
  }
  function availability() {
    return { version: 3 as const, spendControl: "uncapped" as const, ...scope, status: "available" as const, operation: "identity.image" as const,
      requestedModel: IMAGE_MODEL, policyIdentity: "a".repeat(64), handlerVersion: "identity-image-v1" as const, targetCount: 3 as const,
      maxReferenceImages: 4 as const, maxReferenceBytes: 20_971_520 as const, sourceLogo,
      expectedProjectRevision: input.projectRevision, expectedReferenceRevision: input.referenceSnapshot.referenceRevision,
      expectedPreferencesRevision: input.preferencesRevision, expectedIdentityRevision: state.selection?.identityRevision ?? 0,
      expectedLogoRevision: sourceLogo.selectionRevision, estimatedCostMicrousd: 65_000 };
  }
  function readBatch() {
    return state.batch ? identityBatchStateSchema.parse({ ...state.batch, sourceLogoCurrent: state.sourceCurrent }) : null;
  }
  function complete(count = 3, status: IdentityBatchState["status"] = count === 3 ? "succeeded" : "partial") {
    if (!state.batch) throw new Error("Start the synthetic request before completing it.");
    state.systems = Array.from({ length: count }, (_, index) => system(index));
    state.batch = { ...state.batch, status, terminal: ["succeeded", "partial", "failed", "cancelled"].includes(status), systems: state.systems,
      fulfillment: { targetCount: 3, acceptedCount: count, status: count === 3 ? "complete" : count ? "partial" : "none" },
      usage: { status: status === "needs_reconciliation" ? "unknown" : "recorded", knownCostMicrousd: count * 17_500 } };
    readBatch();
  }
  function choose(index = 0) {
    const chosen = state.systems[index]; if (!chosen || !state.sourceCurrent) throw new Error("A current saved direction is required.");
    state.selection = selectIdentitySystem({ actorId: ownerId, projectId, system: chosen, currentInput: input, previousSelection: state.selection,
      identityRevision: state.selection?.identityRevision ?? 0, request: { systemVersionId: chosen.id, expectedProjectRevision: input.projectRevision,
        expectedReferenceRevision: input.referenceSnapshot.referenceRevision, expectedPreferencesRevision: input.preferencesRevision,
        expectedIdentityRevision: state.selection?.identityRevision ?? 0, acceptEarlierBasis: false }, selectionId: id(900 + state.selections.length), now: fixtureAt });
  }
  async function setup(page: Page) {
    const health = watchNormalAppErrors(page);
    const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.hostname === "private-download.fixture.invalid" && path === "/cedar-logo.png") return route.fulfill({ status: 200,
        contentType: "image/png", headers: { "Content-Disposition": "attachment; filename=cedar-logo.png" }, body: png });
      if (url.hostname !== "127.0.0.1" && url.protocol !== "blob:") return route.abort("blockedbyclient");
      if (!path.startsWith("/api/")) return route.continue();
      if (!["GET", "HEAD"].includes(request.method())) state.mutations.push(path);
      if (path === "/api/session") { state.sessionReads++; return json(route, { user: { id: state.owner } }); }
      if (path === "/api/account/profile") return json(route, { profile: { ownerId: state.owner, email: "journey-fixture@example.invalid", revision: 0, updatedAt: null, values: DEFAULT_PROFILE_VALUES } });
      if (state.owner !== ownerId) return json(route, {}, 404);
      if (path === `/api/projects/${projectId}`) return json(route, { project });
      if (path === logoBase) return json(route, workspace);
      if (path.startsWith(`${logoBase}/stages/`) && path.includes("/revisions/")) return json(route, stages.get(path.split("/").at(-1)!));
      if (path.startsWith(`${logoBase}/stages/`) && path.endsWith("/history")) return json(route, { ...scope, stage: path.split("/").at(-2), revisions: [], nextCursor: null });
      if (path === `${logoBase}/reference-snapshots/${resolved.referenceSnapshot.id}`) return json(route, resolved.referenceSnapshot);
      if (path === `${logoBase}/batches/${logoBatch.id}`) return json(route, logoBatch);
      if (path === `${logoBase}/batches`) return json(route, { ...scope, items: [{ id: logoBatch.id, requestKey: logoBatch.requestKey, createdAt: logoBatch.createdAt }], nextCursor: null });
      if (path.startsWith(`${logoBase}/requests/`)) return json(route, { status: "not_found" });
      if (path === `${logoBase}/raster-refinements`) return json(route, { ...scope, items: [], nextCursor: null });
      if (path === `${logoBase}/saved-inputs`) return json(route, { ...scope, projectRevision: input.projectRevision, inspirationSelectionRevision: 0, inspirationCount: 0, references: [], nameConflict: false,
        draft: { name: brief.payload.name, activity: brief.payload.activity, audience: brief.payload.audience, personality: brief.payload.personality, logoTypes: brief.payload.logoTypes } });
      if (path === `${logoBase}/capabilities`) return json(route, { ...scope, observedAt: new Date().toISOString(), operations: Object.fromEntries(
        ["identity.logo_concept", "identity.logo_refine", "identity.logo_vectorize", "identity.logo_directions", "identity.logo_export", "identity.logo_vector_propose"].map(operation => [operation, { status: "unavailable" }])) });
      if (path === `${identityBase}/batches` && request.method() === "GET") return json(route, { ...scope, availability: availability(), latest: readBatch() });
      if (path === `${identityBase}/batches` && request.method() === "POST") {
        const intent = logoBoardGenerationIntentSchema.parse(request.postDataJSON()); state.admissions.push(intent);
        if (state.batch && !state.batch.terminal) return json(route, {}, 409);
        if (JSON.stringify(intent.sourceLogo) !== JSON.stringify(sourceLogo.source) || intent.expectedLogoRevision !== sourceLogo.selectionRevision) return json(route, {}, 409);
        state.batch = { ...scope, batchId: id(400), jobId: id(401), status: "queued", terminal: false, intent, input, systems: [], sourceLogo, sourceLogoCurrent: state.sourceCurrent,
          fulfillment: { targetCount: 3, acceptedCount: 0, status: "pending" }, usage: { status: "pending", knownCostMicrousd: 0 } };
        if (state.loseAdmission) { state.loseAdmission = false; return json(route, {}, 503); }
        return json(route, readBatch(), 201);
      }
      if (path.startsWith(`${identityBase}/batches/requests/`) && request.method() === "GET") return json(route,
        state.batch?.intent.idempotencyKey === path.split("/").at(-1) ? { status: "found", batch: readBatch() } : { status: "not_found" });
      if (path === `${identityBase}/batches/${state.batch?.batchId}`) return json(route, readBatch());
      if (path === `${identityBase}/batches/${state.batch?.batchId}/cancel` && request.method() === "POST") {
        state.stopRequests++; if (state.batch) state.batch = { ...state.batch, status: "cancel_requested" }; return json(route, readBatch());
      }
      if (path === identityBase || path === `${identityBase}/systems`) { const value = overview(Number(url.searchParams.get("limit") ?? 20)); return json(route, path === identityBase ? value : value.systems); }
      if (path.startsWith(`${identityBase}/systems/`)) {
        const selected = state.systems.find(item => item.id === path.split("/").at(-1));
        if (!selected) return json(route, {}, 404);
        const currentBasis = overview().currentBasis;
        return json(route, { ...scope, system: selected, currentBasis, freshness: getIdentityFreshness(selected.input.basis, currentBasis), sourceLogo, sourceLogoCurrent: state.sourceCurrent });
      }
      if (path === `${identityBase}/selection` && request.method() === "POST") {
        const body = selectIdentitySystemSchema.parse(request.postDataJSON()); state.selections.push(body);
        if (!state.sourceCurrent || body.expectedIdentityRevision !== (state.selection?.identityRevision ?? 0)) return json(route, {}, 409);
        const index = state.systems.findIndex(item => item.id === body.systemVersionId); if (index < 0) return json(route, {}, 404);
        choose(index);
        if (state.loseSelection) { state.loseSelection = false; return json(route, {}, 503); }
        const after = overview(); return json(route, { session: after.session, currentSelection: after.currentSelection });
      }
      if (path.startsWith("/api/assets/") && path.endsWith("/preview")) {
        state.privateReads.push(path); const versionId = path.split("/").at(-2);
        const logo = logoBatch.slots.some(slot => slot.acceptedPreview?.reference.versionId === versionId);
        const board = state.systems.find(item => item.board.asset.versionId === versionId);
        const bytes = logo ? png : board && boardImages.get(board.board.asset.contentHash);
        return bytes ? route.fulfill({ status: 200, contentType: "image/png", body: bytes }) : json(route, {}, 404);
      }
      if (path === `/api/assets/${sourceLogo.preview.reference.versionId}/download`) return json(route, {
        url: "https://private-download.fixture.invalid/cedar-logo.png", versionId: sourceLogo.preview.reference.versionId,
        contentHash: sourceLogo.preview.reference.contentHash, mimeType: "image/png", expiresInSeconds: 60,
      });
      state.unexpected.push(`${request.method()} ${path}`); return json(route, {}, 503);
    });
    return health;
  }
  return Object.assign(state, { overview, availability, complete, choose, setup, readBatch });
}

export type VisualJourneyFixture = ReturnType<typeof createVisualJourneyFixture>;
