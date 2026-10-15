import { describe, expect, it } from "vitest";
import { screeningCheckResponseSchema, screeningOverviewSchema, screeningRecordFreshness, screeningRecordInputSchema, screeningRecordSchema } from "@/domain/project-screening";
import { screeningBasis, screeningInput, screeningPage, screeningRecord } from "../fixtures/project-screening";
describe("project screening research contracts", () => {
  it("cannot upgrade owner notes into verified provider evidence or legal clearance", () => {
    expect(screeningRecordInputSchema.safeParse({ ...screeningInput, result: { availability: "available" } }).success).toBe(false);
    expect(screeningRecordInputSchema.safeParse({ ...screeningInput, provenance: "provider_verified" }).success).toBe(false);
    expect(screeningRecordInputSchema.safeParse({ ...screeningInput, acknowledged: false }).success).toBe(false);
    expect(screeningRecordSchema.safeParse({ ...screeningRecord, verification: "verified" }).success).toBe(false);
    expect(screeningRecordSchema.safeParse({ ...screeningRecord, legalClearance: "clear" }).success).toBe(false);
  });
  it("distinguishes exact selection/context, changed criteria, and observation freshness", () => {
    expect(screeningRecordFreshness(screeningRecord, screeningBasis, screeningInput.criteria)).toBe("current_context_unverified");
    expect(screeningRecordFreshness(screeningRecord, { ...screeningBasis, projectRevision: 3 })).toBe("earlier_context");
    expect(screeningRecordFreshness(screeningRecord, { ...screeningBasis, selectionId: screeningRecord.id })).toBe("earlier_context");
    expect(screeningRecordFreshness(screeningRecord, screeningBasis, { tool: "domains", domain: "cedar.ca" })).toBe("different_criteria");
    expect(screeningRecordFreshness(screeningRecord, null)).toBe("earlier_context");
  });
  it("rejects another owner, cursor substitution, unsafe links and future-to-record observations", () => {
    expect(screeningOverviewSchema.safeParse({ ...screeningPage, records: [{ ...screeningRecord, basis: { ...screeningBasis, ownerId: screeningRecord.id } }] }).success).toBe(false);
    expect(screeningOverviewSchema.safeParse({ ...screeningPage, records: [screeningRecord], nextCursor: { recordedAt: screeningRecord.recordedAt, id: screeningRecord.requestId } }).success).toBe(false);
    for (const source of ["javascript:alert(1)", "https://user:password@example.com/", "http://example.com/"]) expect(screeningRecordInputSchema.safeParse({ ...screeningInput, sourceUrls: [source] }).success).toBe(false);
    expect(screeningRecordSchema.safeParse({ ...screeningRecord, observedAt: "2099-01-01T00:00:00Z" }).success).toBe(false);
  });
  it("retains unknown failures but rejects a lookup for another target", () => {
    const response = { basis: screeningBasis, criteria: screeningInput.criteria, completedAt: screeningRecord.recordedAt, result: { status: "failed", code: "unavailable", retryAfterSeconds: null } };
    expect(screeningCheckResponseSchema.safeParse(response).success).toBe(true);
    expect(screeningCheckResponseSchema.safeParse({ ...response, result: { status: "domain", quote: null, check: { id: "fixture", domain: "different.com", provider: "Public registry RDAP", availability: "taken", checkedAt: screeningInput.observedAt, validUntil: screeningRecord.recordedAt, evidenceReference: "fixture" } } }).success).toBe(false);
  });
});
