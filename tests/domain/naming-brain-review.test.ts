import { describe, expect, it } from "vitest";
import * as brain from "../../src/domain/naming-brain";
import { id } from "./naming-brain-fixtures";
import { factualReviewPool, factualReviewRequest, managedReviewWireBody } from "./naming-brain-review-fixtures";

describe("bounded full-pool review requests", () => {
  it.each([150, 200] as const)("fits all %s factual candidates and curation in actual managed instructions/schema/wire", count => {
    for (const role of ["curator", "verifier"] as const) {
      const { request, pool, review } = factualReviewRequest(role, count);
      expect(brain.namingStageRequestSchema.safeParse(request).success).toBe(true);
      expect(review?.candidates).toHaveLength(count);
      expect(review?.sources).toHaveLength(1);
      expect(review?.candidates.reduce((total, candidate) => total + candidate.claims.length, 0)).toBe(count);
      expect(pool.candidates.every(candidate => candidate.sources.length === 1)).toBe(true);
      const wire = managedReviewWireBody(request);
      const bytes = brain.assertNamingStageWireInput?.(request, wire);
      expect(bytes).toBe(Buffer.byteLength(JSON.stringify(wire), "utf8"));
      expect(bytes).toBeLessThanOrEqual(131_072);
    }
  });
  it("sends a shared 4000-character retained source once for a 200-candidate gap pool", () => {
    for (const role of ["curator", "verifier"] as const) {
      const { request, review } = factualReviewRequest(role, 200, 4000);
      expect(brain.namingStageRequestSchema.safeParse(request).success).toBe(true);
      expect(review?.sources[0]?.excerpt).toHaveLength(4000);
      expect(brain.assertNamingStageWireInput?.(request, managedReviewWireBody(request))).toBeLessThanOrEqual(131_072);
    }
  });
  it("blocks oversized complete data before dispatch without deleting candidates or claims", () => {
    const { pool, request, review } = factualReviewRequest("verifier", 200, 51, 2000);
    expect(review?.candidates).toHaveLength(200);
    expect(brain.namingStageRequestSchema.safeParse(request).success).toBe(false);
    expect(() => brain.assertNamingStageWireInput(request, managedReviewWireBody(request))).toThrow();
    expect(pool.candidates).toHaveLength(200);
    expect(pool.candidates.every(candidate => candidate.claims.length === 1 && candidate.rationale.length === 2000)).toBe(true);
  });
  it("counts escaped Unicode instructions and the actual output schema in the wire limit", () => {
    const { request } = factualReviewRequest("curator", 150);
    expect(brain.namingStageRequestSchema.safeParse(request).success).toBe(true);
    const wire = managedReviewWireBody(request);
    wire.agent.instructions += '"é\\\n"'.repeat(30_000);
    expect(() => brain.assertNamingStageWireInput(request, wire)).toThrow(/131072|131,072/);
    const schemaWire = managedReviewWireBody(request);
    Object.assign(schemaWire.agent.text.format.schema, { description: "x".repeat(131_072) });
    expect(() => brain.assertNamingStageWireInput(request, schemaWire)).toThrow(/131072|131,072/);
  });
});

describe("compact review provenance binding", () => {
  it("binds every local candidate and claim to its exact saved artifact and source", () => {
    const { pool, review, request } = factualReviewRequest("verifier", 200);
    expect(brain.validateNamingReviewProjection?.(review, pool.candidates)).toEqual(review);
    expect(review?.artifacts).toHaveLength(2);
    const damaged = structuredClone(review!);
    damaged.artifacts[0]!.sourceArtifactId = id(999);
    expect(() => brain.validateNamingReviewProjection(damaged, pool.candidates)).toThrow();
    const missingClaim = structuredClone(review!);
    missingClaim.candidates[0]!.claims = [];
    expect(() => brain.validateNamingReviewProjection(missingClaim, pool.candidates)).toThrow();
    const missingBinding = { ...review, artifacts: review?.artifacts.slice(1) };
    expect(brain.namingReviewProjectionSchema?.safeParse(missingBinding).success).toBe(false);
    expect(brain.namingStageRequestSchema.safeParse({ ...request, dependencyArtifactIds: [] }).success).toBe(false);
    expect(brain.namingStageRequestSchema.safeParse({ ...request, runId: id(999) }).success).toBe(false);
  });
  it("preserves every Curator annotation and rejects remapping its stored source", () => {
    const pool = factualReviewPool(200);
    const projected = brain.createNamingCurationProjection?.(pool.curation);
    expect(projected?.annotations).toHaveLength(200);
    expect(projected?.annotationFields).toEqual(["assignmentKey", "candidateKey", "concerns", "suggestedRejection"]);
    expect(projected?.annotations[0]).toEqual(["initial-language", "word-0", ["Check pronunciation with the intended audience."], null]);
    expect(brain.validateNamingCurationProjection?.(projected, pool.curation)).toEqual(projected);
    expect(() => brain.validateNamingCurationProjection({ ...projected, artifactId: id(999) }, pool.curation)).toThrow();
  });
  it.each(["hash", "text", "provenance"])("rejects the same shared source key with different %s", conflict => {
    const pool = factualReviewPool(150), changed = structuredClone(pool.candidates);
    const source = changed[1]!.sources[0]!;
    if (conflict === "hash") source.contentHash = "f".repeat(64);
    if (conflict === "text") source.excerpt = "Different retained text under the same source key.";
    if (conflict === "provenance") { source.providerItemId = "different-item"; source.provenance!.itemId = "different-item"; }
    expect(() => brain.createNamingReviewProjection({ runId: id(3), snapshotHash: pool.snapshot.snapshotHash, candidates: changed })).toThrow(/source|Source/);
  });
});
