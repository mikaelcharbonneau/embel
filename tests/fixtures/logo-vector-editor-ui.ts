/** Test-only ordinary app fixture. Synthetic data/bytes; no provider or live account. */
import { createHash } from "node:crypto";
import { expect, type Page, type Route } from "@playwright/test";
import { syntheticLogoWorkspace, syntheticResolvedLogoConcept, logoFixtureId as id } from "./logo-creation";
import { syntheticConversionInput } from "../features/logo-vector/raster-fixtures";
import { separatedLogoDocument } from "../features/logo-vector/fixtures";
import { serializeLogoSvg } from "../../src/features/logo-vector/model/svg";
import { applyLogoManualEdit } from "../../src/features/logo-vector/model/edits";
import type { LogoManualCommand, LogoMutationReceipt, LogoStageRevision, LogoWorkspaceV2 } from "../../src/domain/logo-workspace";
import type { LogoVectorDocument } from "../../src/domain/logo-vector";
import type { LogoVectorDetail } from "../../src/domain/logo-deliverables";
import { DEFAULT_PROFILE_VALUES } from "../../src/domain/account-profile";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { watchNormalAppErrors } from "../e2e/account-check";
export const source = syntheticResolvedLogoConcept(), ownerId = source.input.ownerId, projectId = source.input.projectId, base = `/api/projects/${projectId}/logo`, url = `/brands/account/${projectId}/logo/vector`;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function canonical(value: unknown): string { return Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}` : JSON.stringify(value); }
export async function setupSavedVectorEditor(page: Page, options: { navigate?: boolean } = {}) {
  const browserHealth = watchNormalAppErrors(page);
  let ordinal = 700;
  const png = syntheticConversionInput("combination").source.bytes;
  const preview = { id: id(600), reference: { ownerId, projectId, assetId: id(601), versionId: id(602), contentHash: hash(png) }, verification: { status: "verified" as const, contentHash: hash(png), mimeType: "image/png", byteLength: png.length, checkedAt: "2026-10-07T00:00:00Z" }, purpose: "brand_asset" as const, sourceReceiptId: id(603), rightsEvidenceId: null, publicationState: "committed" as const };
  function detail(document: LogoVectorDocument, parentRevisionId: string | null = null): LogoVectorDetail {
    const documentHash = hash(new TextEncoder().encode(canonical(document))), svgHash = hash(serializeLogoSvg(document)), vectorId = id(ordinal++);
    return { document, sourcePreview: preview, revision: { id: vectorId, ownerId, projectId, parentRevisionId, source: { kind: "refinement", rasterRevisionId: id(604) }, sourcePreview: preview.reference,
      documentAsset: { ownerId, projectId, assetId: id(ordinal++), versionId: id(ordinal++), contentHash: documentHash }, svgAsset: { ownerId, projectId, assetId: id(ordinal++), versionId: id(ordinal++), contentHash: svgHash }, documentHash,
      proof: { version: 1, documentHash, svgContentHash: svgHash, validator: { id: "fluid.logo-vector", version: "1" }, viewBox: document.viewBox, pathCount: document.components.flatMap(c => c.paths).length, componentCount: document.components.length, externalFontDependencies: [] }, locks: [], inputRevisions: [ { stage: "brief_references", id: source.brief.id, revision: source.brief.revision } ], reviewStatus: "review_required", createdAt: "2026-10-07T00:00:00Z" } };
  }
  const initial = detail(separatedLogoDocument()), details = new Map([[initial.revision.id, initial]]);
  const vectorStage: LogoStageRevision = { version: 2, id: id(610), ownerId, projectId, stage: "vector", revision: 1, parentRevisionId: null, inputRevisions: initial.revision.inputRevisions, inputHash: "a".repeat(64), payload: { vectorRevisionId: initial.revision.id, approvalId: null }, createdAt: "2026-10-07T00:00:00Z" };
  const stages = new Map([[source.brief.id, source.brief as LogoStageRevision], [vectorStage.id, vectorStage]]);
  const foundation = syntheticLogoWorkspace();
  const initialWorkspace: LogoWorkspaceV2 = { ...foundation, heads: { ...foundation.heads, workspaceRevision: 2, stageRevisions: { ...foundation.heads.stageRevisions, brief_references: 1, vector: 1 } }, stages: { ...foundation.stages, brief_references: { stage: "brief_references", id: source.brief.id, revision: 1 }, vector: { stage: "vector", id: vectorStage.id, revision: 1 } }, capabilities: { ...foundation.capabilities, save: { status: "available" } } };
  const state = { owner: ownerId, currentVectorId: initial.revision.id, workspace: initialWorkspace, posts: [] as { path: string; body: LogoManualCommand["body"] }[], requests: new Map<string, LogoMutationReceipt>(), lose: false, conflict: false, requestReads: 0, sessionReads: 0, deniedPrivateReads: [] as string[], mutations: [] as string[], browserHealth };
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/*", async route => {
    const target = new URL(route.request().url()); if (target.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    const path = target.pathname; if (!path.startsWith("/api/")) return route.continue();
    if (!["GET", "HEAD"].includes(route.request().method())) state.mutations.push(path);
    if (path === "/api/session") { state.sessionReads++; return json(route, { user: { id: state.owner } }); }
    if (path === "/api/account/profile") return json(route, { profile: { ownerId: state.owner, email: "vector-fixture@example.invalid", revision: 0, updatedAt: null, values: DEFAULT_PROFILE_VALUES } });
    if (state.owner !== ownerId) { state.deniedPrivateReads.push(path); return json(route, {}, 404); }
    if (path === `/api/projects/${projectId}`) return json(route, { project: { id: projectId, owner_id: ownerId, title: "Owned vector fixture", scope: "complete_brand", current_revision: 1,
      created_at: "2026-10-07T00:00:00Z", deleted_at: null, deletion_requested_at: null, deletion_state: "active", lifecycle_version: 0, context: contextSnapshotSchema.parse({ description: "Synthetic vector fixture. No live generation." }) } });
    if (path === `${base}/capabilities`) return json(route, { ownerId, projectId, observedAt: new Date().toISOString(), operations: Object.fromEntries(["identity.logo_concept","identity.logo_refine","identity.logo_vectorize","identity.logo_directions","identity.logo_export","identity.logo_vector_propose"].map(operation => [operation, { status: "unavailable" }])) });
    if (path === `${base}/vector-proposals/requests/current`) return json(route, { ownerId, projectId, items: [], nextCursor: null });
    if (path === `${base}/vector-proposals`) return json(route, { ownerId, projectId, items: [], nextCursor: null });
    if (path === base) return json(route, state.workspace);
    if (path === `${base}/vector/current`) return json(route, { ownerId, projectId, vectorRevisionId: state.currentVectorId });
    if (path.startsWith(`${base}/vector/revisions/`)) return json(route, details.get(path.split("/").at(-1)!));
    if (path === `/api/assets/${preview.reference.versionId}/preview`) return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(png) });
    if (path.includes("/stages/") && path.includes("/revisions/")) return json(route, stages.get(path.split("/").at(-1)!));
    if (path.includes("/reference-snapshots/")) return json(route, source.referenceSnapshot);
    if (path.endsWith("/history")) { const stage = path.split("/").at(-2)!; return json(route, { ownerId, projectId, items: [...stages.values()].filter(r => r.stage === stage).reverse(), nextCursor: null }); }
    if (path.includes("/requests/")) { state.requestReads++; const receipt = state.requests.get(path.split("/").at(-1)!); return json(route, receipt ? { status: "succeeded", requestKey: receipt.requestKey, receipt, outputs: [], billing: { status: "recorded", confirmedMicrousd: 0 }, reason: null } : { status: "not_found" }); }
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON(); state.posts.push({ path, body }); if (state.conflict) return json(route, {}, 409);
      let stage: "vector" | "refinements" = "vector", vectorId = body.vectorRevisionId ?? state.currentVectorId;
      if (path.endsWith("/edits")) { stage = "refinements"; const previous = details.get(body.baseVectorRevisionId)!; const next = detail(applyLogoManualEdit(previous.document, body.edit), previous.revision.id); if (body.edit.kind === "locks") next.revision.locks = body.edit.componentIds.map((componentId: string) => ({ componentId, geometryHash: "a".repeat(64), appearanceHash: "a".repeat(64), transformHash: "a".repeat(64), textHash: "a".repeat(64), zOrderHash: "a".repeat(64), effectiveHash: "a".repeat(64) })); details.set(next.revision.id, next); vectorId = next.revision.id; }
      if (path.endsWith("/restore")) { stage = body.stage; const target = stages.get(body.revisionId)!; if ("vectorRevisionId" in target.payload) vectorId = target.payload.vectorRevisionId; }
      const stageId = id(ordinal++), revision = state.workspace.heads.stageRevisions[stage] + 1, approvalId = path.endsWith("/vector/accept") ? id(ordinal++) : null;
      const basis = { version: 2 as const, id: stageId, ownerId, projectId, revision, parentRevisionId: state.workspace.stages[stage]?.id ?? null, inputRevisions: initial.revision.inputRevisions, inputHash: "b".repeat(64), createdAt: "2026-10-07T00:00:01Z" };
      const record: LogoStageRevision = stage === "refinements" ? { ...basis, stage, payload: { rasterRevisionIds: [], vectorRevisionId: vectorId, approvalId: null, sourceRequestKey: body.requestKey } } : { ...basis, stage, payload: { vectorRevisionId: vectorId, approvalId } }; stages.set(record.id, record);
      state.workspace = { ...state.workspace, heads: { ...state.workspace.heads, workspaceRevision: state.workspace.heads.workspaceRevision + 1, stageRevisions: { ...state.workspace.heads.stageRevisions, [stage]: revision } }, stages: { ...state.workspace.stages, [stage]: { stage, id: stageId, revision } }, approvedLogo: approvalId ? { id: approvalId, ownerId, projectId, vectorRevisionId: vectorId, stageRevisionId: stageId, approvedAt: record.createdAt } : stage === "vector" ? null : state.workspace.approvedLogo };
      state.currentVectorId = vectorId; const receipt = { ownerId, projectId, requestKey: body.requestKey, workspace: state.workspace, revision: record }; state.requests.set(body.requestKey, receipt);
      if (state.lose) return route.abort("failed"); return json(route, receipt);
    }
    return json(route, {}, 503);
  });
  if (options.navigate !== false) { await page.goto(url); await expect(page.getByRole("img", { name: "Vector candidate", exact: true })).toBeVisible(); }
  return Object.assign(state, { details, stages, makeDetail: detail, initial, source, ownerId, projectId, base, url });
}
