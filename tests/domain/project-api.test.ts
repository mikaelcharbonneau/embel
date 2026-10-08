import { describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { expandProjectInputSchema, updateProjectInputSchema } from "../../src/domain/project-api";

describe("account draft contracts", () => {
  it("retains all existing intake notes, example provenance, and audience review position", () => {
    const intake = {
      suppliedName: "Common Room — local fixture",
      namingNotes: "Keep French and English pronunciation clear.",
      identityNotes: "Keep the existing poster dimensions.",
      step: "audience" as const,
      audienceReviewedAt: "2026-10-02T16:00:00.000Z",
      example: true,
    };
    expect(contextSnapshotSchema.parse({ intake }).intake).toEqual({ ...intake, personalityReviewedAt: null, positioningReviewedAt: null });
    expect(contextSnapshotSchema.parse({}).intake).toEqual({
      suppliedName: "", namingNotes: "", identityNotes: "", step: "review", audienceReviewedAt: null, personalityReviewedAt: null, positioningReviewedAt: null, example: false,
    });
  });

  it("accepts existing local audience field limits without truncation and still rejects oversized input", () => {
    const segment = {
      id: "10000000-0000-4000-8000-000000000011", label: "a".repeat(180),
      needs: ["b".repeat(2000)], reason: "Explicit local fixture", selected: true, origin: "user",
    };
    expect(contextSnapshotSchema.parse({ audienceSegments: [segment] }).audienceSegments[0]).toMatchObject(segment);
    expect(contextSnapshotSchema.safeParse({ audienceSegments: [{ ...segment, label: "a".repeat(181) }] }).success).toBe(false);
    expect(contextSnapshotSchema.safeParse({ audienceSegments: [{ ...segment, needs: ["b".repeat(2001)] }] }).success).toBe(false);
  });

  it("requires a known revision and does not accept client ownership or arbitrary scope changes", () => {
    expect(expandProjectInputSchema.safeParse({ expectedRevision: 0 }).success).toBe(false);
    expect(expandProjectInputSchema.safeParse({ expectedRevision: 1, ownerId: "untrusted" }).success).toBe(false);
    expect(updateProjectInputSchema.safeParse({ expectedRevision: 1, context: {}, scope: "complete_brand" }).success).toBe(false);
    expect(updateProjectInputSchema.parse({ expectedRevision: 2, context: {}, title: " Renamed fixture " }).title).toBe("Renamed fixture");
  });
});
