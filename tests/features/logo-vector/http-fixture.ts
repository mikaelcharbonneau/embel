/** Synthetic same-origin HTTP only. Shared with mounted React/client tests. */
import { createHash } from "node:crypto";
import { syntheticLogoWorkspace, syntheticResolvedLogoConcept, logoFixtureId as id } from "../../fixtures/logo-creation";
import { syntheticConversionInput } from "./raster-fixtures";
import { separatedLogoDocument } from "./fixtures";
import { serializeLogoSvg } from "../../../src/features/logo-vector/model/svg";
import { applyLogoManualEdit } from "../../../src/features/logo-vector/model/edits";
import type { LogoManualCommand, LogoMutationReceipt, LogoStageRevision, LogoWorkspaceV2 } from "../../../src/domain/logo-workspace";
import type { LogoManualEdit, LogoVectorDocument } from "../../../src/domain/logo-vector";
import type { LogoVectorDetail } from "../../../src/domain/logo-deliverables";
export const source = syntheticResolvedLogoConcept(), ownerId = source.input.ownerId, projectId = source.input.projectId, base = `/api/projects/${projectId}/logo`, url = `/brands/account/${projectId}/logo/editor`;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function canonical(value: unknown): string { return Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}` : JSON.stringify(value); }
export function createVectorHttpFixture(configuration: { applyEdit?(document: LogoVectorDocument, edit: LogoManualEdit): LogoVectorDocument | Promise<LogoVectorDocument> } = {}) {
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
  const state = { owner: ownerId, currentVectorId: initial.revision.id, workspace: initialWorkspace, posts: [] as { path: string; body: LogoManualCommand["body"] }[], requests: new Map<string, LogoMutationReceipt>(), lose: false, conflict: false, requestReads: 0 };
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const fetcher: typeof fetch = async (input, options) => {
    const request = new Request(new URL(String(input), "http://127.0.0.1:3117"), options);
    const path = new URL(request.url).pathname; if (!path.startsWith("/api/")) return new Response(null, { status: 404 });
    if (path === "/api/session") return json({ user: { id: state.owner } });
    if (state.owner !== ownerId) return json({}, 404);
    if (path === base) return json(state.workspace);
    if (path === `${base}/vector/history`) {
      const query = new URL(request.url).searchParams, limit = Number(query.get("limit") ?? 20);
      const cursor = query.has("cursor") ? JSON.parse(Buffer.from(query.get("cursor")!, "base64").toString("utf8")) : null;
      if (cursor && cursor.workspaceRevision !== state.workspace.heads.workspaceRevision) return json({}, 409);
      const all = [...details.values()].sort((a, b) => b.revision.createdAt.localeCompare(a.revision.createdAt) || b.revision.id.localeCompare(a.revision.id));
      const start = cursor ? all.findIndex(item => item.revision.id === cursor.id) + 1 : 0, selected = all.slice(start, start + limit);
      const items = selected.map(({ revision }) => {
        const stage = [...stages.values()].reverse().find(item => "vectorRevisionId" in item.payload && item.payload.vectorRevisionId === revision.id);
        return { vectorRevisionId: revision.id, parentRevisionId: revision.parentRevisionId, createdAt: revision.createdAt, source: revision.source, lockCount: revision.locks.length,
          selection: state.currentVectorId === revision.id ? "current" : "retained",
          acceptance: state.workspace.approvedLogo?.vectorRevisionId === revision.id ? "approved" : [...state.requests.values()].some(receipt => receipt.workspace.approvedLogo?.vectorRevisionId === revision.id) ? "previously_accepted" : "unaccepted",
          earlierInputs: revision.inputRevisions.some(input => state.workspace.stages[input.stage]?.id !== input.id), cancellation: "none",
          stageRevision: stage ? { stage: stage.stage, id: stage.id, revision: stage.revision } : null };
      });
      const last = selected.at(-1)?.revision;
      return json({ ownerId, projectId, workspaceRevision: state.workspace.heads.workspaceRevision, items,
        nextCursor: last && start + limit < all.length ? Buffer.from(JSON.stringify({ ownerId, projectId, workspaceRevision: state.workspace.heads.workspaceRevision, id: last.id, createdAt: last.createdAt })).toString("base64") : null });
    }
    if (path === `${base}/vector/current`) return json({ ownerId, projectId, vectorRevisionId: state.currentVectorId });
    if (path.startsWith(`${base}/vector/revisions/`)) return json(details.get(path.split("/").at(-1)!));
    if (path === `/api/assets/${preview.reference.versionId}/preview`) return new Response(Buffer.from(png), { status: 200, headers: { "content-type": "image/png" } });
    if (path.includes("/stages/") && path.includes("/revisions/")) return json(stages.get(path.split("/").at(-1)!));
    if (path.includes("/reference-snapshots/")) return json(source.referenceSnapshot);
    if (path.endsWith("/history")) { const stage = path.split("/").at(-2)!; return json({ ownerId, projectId, items: [...stages.values()].filter(r => r.stage === stage).reverse(), nextCursor: null }); }
    if (path.startsWith(`${base}/edits/requests/`) && request.method === "GET") {
      state.requestReads++; const requestKey = path.split("/").at(-1)!, receipt = state.requests.get(requestKey), original = state.posts.find(item => item.path === `${base}/edits` && item.body.requestKey === requestKey);
      return json(receipt && original ? { status: "succeeded", ownerId, projectId, requestKey, command: { method: "saveLogoEdit", body: original.body }, receipt } : { status: "not_found" });
    }
    if (path.includes("/requests/")) { state.requestReads++; const receipt = state.requests.get(path.split("/").at(-1)!); return json(receipt ? { status: "succeeded", requestKey: receipt.requestKey, receipt, outputs: [], billing: { status: "recorded", confirmedMicrousd: 0 }, reason: null } : { status: "not_found" }); }
    if (request.method === "POST") {
      const body = await request.json(); state.posts.push({ path, body }); if (state.conflict) return json({}, 409);
      let stage: "vector" | "refinements" = "vector", vectorId = body.vectorRevisionId ?? state.currentVectorId;
      if (path.endsWith("/edits")) { stage = "refinements"; const previous = details.get(body.baseVectorRevisionId)!; const next = detail(configuration.applyEdit ? await configuration.applyEdit(previous.document, body.edit) : applyLogoManualEdit(previous.document, body.edit), previous.revision.id); if (body.edit.kind === "locks") next.revision.locks = body.edit.componentIds.map((componentId: string) => ({ componentId, geometryHash: "a".repeat(64), appearanceHash: "a".repeat(64), transformHash: "a".repeat(64), textHash: "a".repeat(64), zOrderHash: "a".repeat(64), effectiveHash: "a".repeat(64) })); details.set(next.revision.id, next); vectorId = next.revision.id; }
      if (path.endsWith("/restore")) { stage = body.stage; const target = stages.get(body.revisionId)!; if ("vectorRevisionId" in target.payload) vectorId = target.payload.vectorRevisionId; }
      const stageId = id(ordinal++), revision = state.workspace.heads.stageRevisions[stage] + 1, approvalId = path.endsWith("/vector/accept") ? id(ordinal++) : null;
      const basis = { version: 2 as const, id: stageId, ownerId, projectId, revision, parentRevisionId: state.workspace.stages[stage]?.id ?? null, inputRevisions: initial.revision.inputRevisions, inputHash: "b".repeat(64), createdAt: "2026-10-07T00:00:01Z" };
      const record: LogoStageRevision = stage === "refinements" ? { ...basis, stage, payload: { rasterRevisionIds: [], vectorRevisionId: vectorId, approvalId: null, sourceRequestKey: body.requestKey } } : { ...basis, stage, payload: { vectorRevisionId: vectorId, approvalId } }; stages.set(record.id, record);
      state.workspace = { ...state.workspace, heads: { ...state.workspace.heads, workspaceRevision: state.workspace.heads.workspaceRevision + 1, stageRevisions: { ...state.workspace.heads.stageRevisions, [stage]: revision } }, stages: { ...state.workspace.stages, [stage]: { stage, id: stageId, revision } }, approvedLogo: approvalId ? { id: approvalId, ownerId, projectId, vectorRevisionId: vectorId, stageRevisionId: stageId, approvedAt: record.createdAt } : stage === "vector" ? null : state.workspace.approvedLogo };
      state.currentVectorId = vectorId; const receipt = { ownerId, projectId, requestKey: body.requestKey, workspace: state.workspace, revision: record }; state.requests.set(body.requestKey, receipt);
      if (state.lose) return Promise.reject(new Error("Lost acknowledgement")); return json(receipt);
    }
    return json({}, 503);
  };
  return { state, fetcher, initial, details, stages, preview, png };
}
