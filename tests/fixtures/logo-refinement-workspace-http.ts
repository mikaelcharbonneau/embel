/** TEST ONLY: synthetic durable same-origin HTTP, no provider, database or storage service. */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { syntheticLogoBatch, syntheticLogoQuote, syntheticLogoWorkspace, syntheticResolvedLogoConcept, logoFixtureId as id } from "./logo-creation";
import { syntheticRasterRefinement } from "./logo-refinement-history";
import { logoRasterRefinementSchema, logoOperationSchema, type LogoCostQuote, type LogoGenerationIntent, type LogoQuoteRequest, type LogoRequestState, type LogoRasterRefinement } from "../../src/domain/logo-jobs";
import { logoMutationReceiptSchema, logoStageRevisionSchema, type LogoRasterSource, type LogoWorkspaceV2, type LogoStageRevision, type LogoMutationReceipt } from "../../src/domain/logo-workspace";

const resolved = syntheticResolvedLogoConcept(), foundation = syntheticLogoWorkspace(), base = `/api/projects/${foundation.projectId}/logo`;
export async function syntheticRefinementWorkspaceHttp(preexisting = false) {
  const originalBytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#444444" } }).png().toBuffer();
  const refinedBytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#dddddd" } }).png().toBuffer();
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const batch = structuredClone(syntheticLogoBatch()), slot = batch.slots[0]!, preview = slot.acceptedPreview!;
  preview.reference.contentHash = hash(originalBytes); preview.verification.contentHash = hash(originalBytes); preview.verification.byteLength = originalBytes.length;
  slot.attempts[0]!.preview = preview;
  const originalBatch = JSON.stringify(batch), source: LogoRasterSource = { kind: "concept", batchId: batch.id, slotId: slot.id, attemptId: slot.attempts[0]!.id };
  const seed = syntheticRasterRefinement();
  const raster = logoRasterRefinementSchema.parse({ ...seed, preview: { ...seed.preview!, reference: { ...seed.preview!.reference, contentHash: hash(refinedBytes) }, verification: { ...seed.preview!.verification, contentHash: hash(refinedBytes), byteLength: refinedBytes.length } } });
  let workspace: LogoWorkspaceV2 = { ...foundation, heads: { ...foundation.heads, workspaceRevision: 2, stageRevisions: { ...foundation.heads.stageRevisions, brief_references: 1, concepts: 1 } },
    stages: { ...foundation.stages, brief_references: { stage: "brief_references", id: resolved.brief.id, revision: 1 }, concepts: { stage: "concepts", id: id(900), revision: 1 } },
    capabilities: { ...foundation.capabilities, save: { status: "available" } } };
  const stages = new Map<string, LogoStageRevision>([[resolved.brief.id, resolved.brief], [id(900), logoStageRevisionSchema.parse({ ...resolved.brief, id: id(900), stage: "concepts", payload: { batchIds: [batch.id], selected: source } })]]);
  const state = { records: [] as LogoRasterRefinement[], quotes: [] as LogoQuoteRequest[], admissions: [] as LogoGenerationIntent[], selections: [] as { requestKey: string; expected: LogoWorkspaceV2["heads"]; source: LogoRasterSource }[],
    detailReads: [] as string[], requests: new Map<string, LogoRequestState>(), lastQuote: null as LogoCostQuote | null, issuedQuotes: new Map<string, LogoCostQuote>(), loseSelection: false, imageAvailable: true, owner: foundation.ownerId,
    get workspace() { return workspace; }, get batch() { return batch; }, originalBatch, raster, source,
    publish(requestKey = raster.requestKey) {
      const record = { ...raster, requestKey }; state.records = [record];
      const revision = logoStageRevisionSchema.parse({ ...resolved.brief, id: id(910), stage: "refinements", payload: { rasterRevisionIds: [record.id], vectorRevisionId: null, approvalId: null, sourceRequestKey: requestKey } });
      stages.set(revision.id, revision);
      workspace = { ...workspace, heads: { ...workspace.heads, workspaceRevision: workspace.heads.workspaceRevision + 1, stageRevisions: { ...workspace.heads.stageRevisions, refinements: 1 } }, stages: { ...workspace.stages, refinements: { stage: "refinements", id: revision.id, revision: 1 } } };
    } };
  if (preexisting) state.publish();
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url), "http://127.0.0.1"), path = target.pathname;
    const request = { method: () => init?.method ?? "GET", postDataJSON: () => JSON.parse(String(init?.body)) };
    if (path === "/api/session") return json({ user: { id: state.owner } });
    if (state.owner !== foundation.ownerId) return json({}, 404);
    if (path === base) return json(workspace);
    // The Logo kinds are on, as in production; a test can answer this path itself to change that.
    if (path === `${base}/engine`) return json({ engine: true, runs: [] });
    if (path === `${base}/capabilities`) { const now = Date.now(); return json({ ownerId: foundation.ownerId, projectId: foundation.projectId, observedAt: new Date(now).toISOString(), operations: Object.fromEntries(logoOperationSchema.options.map(operation => [operation, operation === "identity.logo_vectorize" || operation === "identity.logo_refine" && state.imageAvailable ? { status: "available", expiresAt: new Date(now + 30000).toISOString() } : { status: "unavailable" }])) }); }
    if (path.includes(`${base}/stages/`)) { const revision = stages.get(path.split("/").at(-1)!); return json(revision ?? {}, revision ? 200 : 404); }
    if (path === `${base}/reference-snapshots/${resolved.referenceSnapshot.id}`) return json(resolved.referenceSnapshot);
    if (path === `${base}/batches`) return json({ ownerId: foundation.ownerId, projectId: foundation.projectId, items: [{ id: batch.id, requestKey: batch.requestKey, createdAt: batch.createdAt }], nextCursor: null });
    if (path === `${base}/batches/${batch.id}`) return json(batch);
    if (path === `${base}/raster-refinements`) return json({ ownerId: foundation.ownerId, projectId: foundation.projectId, items: state.records, nextCursor: null });
    if (path.startsWith(`${base}/raster-refinements/`)) { const recordId = path.split("/").at(-1)!; state.detailReads.push(recordId); const record = state.records.find(row => row.id === recordId); return json(record ?? {}, record ? 200 : 404); }
    if (path === `/api/assets/${preview.reference.versionId}/preview`) return new Response(new Uint8Array(originalBytes), { headers: { "content-type": "image/png" } });
    if (path === `/api/assets/${raster.preview!.reference.versionId}/preview`) return new Response(new Uint8Array(refinedBytes), { headers: { "content-type": "image/png" } });
    if (path === `${base}/rasters/selection`) {
      const body = request.postDataJSON() as typeof state.selections[number]; state.selections.push(body);
      if (state.loseSelection) { state.loseSelection = false; throw new Error("Synthetic lost selection acknowledgement"); }
      const prior = state.requests.get(body.requestKey); if (prior && prior.status === "succeeded") return json(prior.receipt);
      if (JSON.stringify(body.expected) !== JSON.stringify(workspace.heads)) return json({ error: { code: "conflict" } }, 409);
      const revision = logoStageRevisionSchema.parse({ ...resolved.brief, id: id(920), stage: "concepts", revision: 2, parentRevisionId: id(900), payload: { batchIds: [batch.id], selected: body.source } });
      stages.set(revision.id, revision); workspace = { ...workspace, heads: { ...workspace.heads, workspaceRevision: workspace.heads.workspaceRevision + 1, stageRevisions: { ...workspace.heads.stageRevisions, concepts: 2 } }, stages: { ...workspace.stages, concepts: { stage: "concepts", id: revision.id, revision: 2 } } };
      const receipt: LogoMutationReceipt = logoMutationReceiptSchema.parse({ ownerId: foundation.ownerId, projectId: foundation.projectId, requestKey: body.requestKey, workspace, revision });
      state.requests.set(body.requestKey, { status: "succeeded", requestKey: body.requestKey, receipt, outputs: [], billing: { status: "recorded", confirmedMicrousd: 0 }, reason: null });
      return json(receipt);
    }
    if (path === `${base}/quotes`) {
      const body = request.postDataJSON() as LogoQuoteRequest; state.quotes.push(body);
      const vector = body.operation === "vectorize";
      state.lastQuote = { ...syntheticLogoQuote(), id: id(1400 + state.quotes.length), request: body, expected: body.expected, expiresAt: new Date(Date.now() + 60000).toISOString(),
        conceptPlan: body.operation === "concepts" || body.operation === "more_concepts" ? batch.plan : null,
        targetSlotIds: body.operation === "retry_failed" ? body.failedSlotIds : body.operation === "concepts" || body.operation === "more_concepts" ? batch.slots.map(slot => slot.id) : [],
        ...(vector ? { provider: null, model: null, engine: { id: "synthetic-local-vector", version: "1", artifactHash: "c".repeat(64), settingsHash: "d".repeat(64) }, estimatedCostMicrousd: 0, maxCostMicrousd: 0, externalProviderCostMicrousd: 0 } : {}) };
      state.issuedQuotes.set(state.lastQuote.id, state.lastQuote);
      return json(state.lastQuote);
    }
    if (path === `${base}/requests` && request.method() === "POST") {
      const body = request.postDataJSON() as LogoGenerationIntent; state.admissions.push(body); state.publish(body.requestKey);
      const receipt = { ownerId: foundation.ownerId, projectId: foundation.projectId, requestKey: body.requestKey, operation: "identity.logo_refine", batchId: null, jobIds: [raster.jobId], inputHash: "b".repeat(64) } as const;
      state.requests.set(body.requestKey, { status: "succeeded", requestKey: body.requestKey, receipt: { ...receipt, jobIds: [...receipt.jobIds] }, outputs: [raster.preview!], billing: { status: "recorded", confirmedMicrousd: 100000 }, reason: null });
      return json(receipt);
    }
    if (path.startsWith(`${base}/requests/`)) return json(state.requests.get(path.split("/").at(-1)!) ?? { status: "not_found" });
    return json({}, 503);
  };
  return Object.assign(state, { fetcher });
}
