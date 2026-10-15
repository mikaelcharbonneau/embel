import { describe, expect, it, vi } from "vitest";
import { checkLogoQuoteReferences } from "../../src/components/logo-creation/reference-limit";
import type { LogoQuoteRequest } from "../../src/domain/logo-jobs";
import { syntheticLogoBatch, syntheticLogoQuote, syntheticLogoReferences, syntheticResolvedLogoConcept, logoFixtureId as id } from "../fixtures/logo-creation";
import { syntheticRasterRefinement } from "../fixtures/logo-refinement-history";

function setup(count = 0) {
  const { brief, referenceSnapshot } = structuredClone(syntheticResolvedLogoConcept());
  const batch = structuredClone(syntheticLogoBatch()), refinement = structuredClone(syntheticRasterRefinement());
  const sample = syntheticLogoReferences()[0]!;
  referenceSnapshot.references = Array.from({ length: count }, (_, index) => ({ referenceId: id(700 + index), sourceKind: sample.sourceKind,
    rightsEvidenceId: sample.rightsEvidenceId, aspects: sample.aspects, asset: { ...sample.asset, assetId: id(720 + index), versionId: id(740 + index) } }));
  const client = { readLogoConceptBatch: vi.fn(async () => batch), readLogoRasterRefinement: vi.fn(async () => refinement),
    getLogoStageRevision: vi.fn(async () => brief), readLogoReferenceSnapshot: vi.fn(async () => referenceSnapshot) };
  const expected = syntheticLogoQuote().expected;
  const concept: LogoQuoteRequest = { operation: "concepts", expected, briefRevisionId: brief.id, referenceSnapshotId: referenceSnapshot.id };
  const source = { kind: "concept" as const, batchId: batch.id, slotId: batch.slots[0]!.id, attemptId: batch.slots[0]!.attempts[0]!.id };
  const requests: LogoQuoteRequest[] = [concept, { ...concept, operation: "more_concepts" }, { operation: "retry_failed", expected, sourceBatchId: batch.id, failedSlotIds: [batch.slots[5]!.id] },
    { operation: "refine_preview", expected, source, instruction: "Simplify" }, { operation: "refine_preview", expected, source: { kind: "refinement", rasterRevisionId: refinement.id }, instruction: "Simplify again" }];
  return { client, brief, referenceSnapshot, batch, requests, read: (request: LogoQuoteRequest = concept, signal = new AbortController().signal) => checkLogoQuoteReferences({ client, ownerId: id(1), projectId: id(2), request, signal }) };
}

describe("exact image source reference bounds before cost review", () => {
  it.each([0, 1, 2, 3, 4])("reads operation source %i without substituting or changing its saved snapshot", async index => {
    const f = setup(index < 3 ? 4 : 3), before = structuredClone(f.referenceSnapshot);
    await f.read(f.requests[index]);
    expect(f.client.getLogoStageRevision).toHaveBeenCalledWith("brief_references", f.brief.id, expect.any(AbortSignal));
    expect(f.client.readLogoReferenceSnapshot).toHaveBeenCalledExactlyOnceWith(f.referenceSnapshot.id, expect.any(AbortSignal));
    expect(f.referenceSnapshot).toEqual(before);
  });
  it.each([0, 1, 2, 3, 4])("rejects operation %i above its bound without trimming references", async index => {
    const f = setup(index < 3 ? 5 : 4), before = structuredClone(f.referenceSnapshot);
    await expect(f.read(f.requests[index])).rejects.toThrow(index < 3 ? "Concept generation allows at most 4" : "Refinement allows at most 3");
    expect(f.referenceSnapshot).toEqual(before);
  });
  it.each(["owner", "project", "id", "brief-snapshot"])("rejects mismatched %s provenance", async field => {
    const f = setup();
    if (field === "owner") f.referenceSnapshot.ownerId = id(999);
    if (field === "project") f.referenceSnapshot.projectId = id(999);
    if (field === "id") f.referenceSnapshot.id = id(999);
    if (field === "brief-snapshot") f.brief.payload.referenceSnapshotId = id(999);
    await expect(f.read()).rejects.toMatchObject({ status: 502 });
  });
  it("never applies image reference limits to post-logo identity directions", async () => {
    const f = setup(5); await f.read({ operation: "directions", expected: syntheticLogoQuote().expected, approvedLogoId: id(500) });
    expect(f.client.getLogoStageRevision).not.toHaveBeenCalled(); expect(f.client.readLogoReferenceSnapshot).not.toHaveBeenCalled();
  });
  it("stops a cancelled source read before fetching any snapshot", async () => {
    const f = setup(), abort = new AbortController();
    f.client.getLogoStageRevision.mockImplementation(async () => { abort.abort(); return f.brief; });
    await expect(f.read(f.requests[0], abort.signal)).rejects.toMatchObject({ status: 503 });
    expect(f.client.readLogoReferenceSnapshot).not.toHaveBeenCalled();
  });
});
