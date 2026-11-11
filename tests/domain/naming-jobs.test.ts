import { describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { projectNamingOverviewSchema } from "../../src/domain/naming-jobs";

const id = (n: number) => `20000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const ownerId = id(1),
  projectId = id(2),
  at = "2026-10-04T12:00:00Z";
const context = contextSnapshotSchema.parse({ description: "Local naming contract fixture" });

const screening = {
  domains: { status: "not_checked", reason: "integration_unavailable" },
  handles: { status: "not_checked", reason: "integration_unavailable" },
  trademarks: { status: "not_checked", reason: "integration_unavailable" },
};
const overview = () => ({
  project: {
    id: projectId,
    owner_id: ownerId,
    title: "Local fixture",
    scope: "complete_brand",
    current_revision: 4,
    created_at: at,
    context,
  },
  readiness: { ready: false, missing: ["reformulation", "competitors", "audience", "personality", "positioning"] },
  session: null,
  preferences: null,
  currentSelection: null,
  batches: { ownerId, projectId, items: [], nextCursor: null },
  candidates: { ownerId, projectId, items: [], nextCursor: null },
  availability: { status: "unavailable", operation: "naming.generate", reason: "naming_policy_unavailable" },
  jobs: [],
  screening,
});

describe("project naming overview envelope", () => {
  it("supports an unsaved initial session and fences every nested read by project and owner", () => {
    expect(projectNamingOverviewSchema.safeParse(overview()).success).toBe(true);
    const value = overview();
    expect(
      projectNamingOverviewSchema.safeParse({ ...value, candidates: { ...value.candidates, ownerId: id(90) } }).success,
    ).toBe(false);
    expect(
      projectNamingOverviewSchema.safeParse({ ...value, batches: { ...value.batches, projectId: id(91) } }).success,
    ).toBe(false);
    expect(projectNamingOverviewSchema.safeParse({ ...value, readiness: { ready: true, missing: [] } }).success).toBe(
      false,
    );
  });
  it("accepts whatever runtime availability the database function still reports", () => {
    // get_naming_availability still describes the retired ChatGPT-plan runtime; nothing reads it.
    for (const availability of [
      { status: "unavailable", operation: "naming.generate", reason: "worker_unavailable" },
      { status: "unavailable", operation: "naming.generate", reason: "strategy_incomplete" },
    ])
      expect(projectNamingOverviewSchema.safeParse({ ...overview(), availability }).success).toBe(true);
    expect(
      projectNamingOverviewSchema.safeParse({
        ...overview(),
        availability: { status: "unavailable", reason: "worker_unavailable" },
      }).success,
    ).toBe(false);
  });
  it("refuses an available runtime before project readiness", () => {
    const value = overview();
    expect(
      projectNamingOverviewSchema.safeParse({
        ...value,
        availability: { status: "available", operation: "naming.generate" },
      }).success,
    ).toBe(false);
  });
  it("has no invented screening evidence, timestamp, price or successful status", () => {
    expect(projectNamingOverviewSchema.safeParse(overview()).success).toBe(true);
    for (const extra of [
      { checkedAt: at },
      { provider: "invented" },
      { price: 0 },
      { sourceUrl: "https://example.com" },
      { status: "available" },
    ]) {
      expect(
        projectNamingOverviewSchema.safeParse({
          ...overview(),
          screening: { ...screening, domains: { ...screening.domains, ...extra } },
        }).success,
      ).toBe(false);
    }
  });
});
