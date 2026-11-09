import { describe, expect, it } from "vitest";
import { contextSnapshotSchema, createBrandFromStandalone, missingStrategy, projectSchema } from "../../src/domain/projects";

const ownerId = "10000000-0000-4000-8000-000000000001";
const projectId = "10000000-0000-4000-8000-000000000002";
const sourceId = "10000000-0000-4000-8000-000000000003";
const at = "2026-10-02T00:00:00.000Z";
const context = contextSnapshotSchema.parse({ description: "A local bakery delivering sourdough to offices.", activity: "Bakery", offering: "Sourdough subscriptions", knownAudience: "Local offices", selectedName: "Dayloaf" });

describe("context-preserving brand starts", () => {
  it.each(["idea", "name", "handle", "domain", "trademark"] as const)("promotes %s without rewriting source facts or making approvals", (kind) => {
    const source = { id: sourceId, ownerId, kind, context, label: "Dayloaf", evidence: [{ id: "e1", provider: "fixture only", method: "manual", checkedAt: at, status: "unknown" as const }] };
    const before = structuredClone(source);
    const project = createBrandFromStandalone({ actorId: ownerId, projectId, source, now: at });
    expect(project.scope).toBe("complete_brand");
    expect(project.context.selectedName).toBe("Dayloaf");
    expect(project.context.description).toBe(context.description);
    expect(project.origin?.evidence).toEqual(source.evidence);
    expect(project.context.reformulationConfirmed).toBe(false);
    expect(project.origin?.sourceId).toBe(sourceId);
    expect(source).toEqual(before);
  });

  it("rejects another user's source without returning it", () => {
    expect(() => createBrandFromStandalone({ actorId: projectId, projectId, source: { id: sourceId, ownerId, kind: "idea", label: "Private", context, evidence: [] }, now: at })).toThrow("Source not found");
  });

  it("does not assume Assets are included in conversion", () => {
    expect(() => createBrandFromStandalone({ actorId: ownerId, projectId, source: { id: sourceId, ownerId, kind: "asset", label: "Mark", context, evidence: [] } as never, now: at })).toThrow();
  });

  it("asks only for missing strategy and never equates proposed segments with selected ones", () => {
    const known = contextSnapshotSchema.parse({ ...context, reformulationConfirmed: true, audienceSegments: [{ id: sourceId, label: "Office teams", needs: ["Reliable weekly delivery"], reason: "Recurring shared lunches", selected: false, origin: "proposal" }] });
    expect(missingStrategy(known)).toEqual(["competitors", "audience", "personality", "positioning"]);
    known.audienceSegments[0]!.selected = true;
    expect(missingStrategy(known)).toEqual(["competitors", "personality", "positioning"]);
  });

  it("requires evidence on researched competitors while preserving user supplied entries", () => {
    const competitor = { id: sourceId, name: "Neighbour bakery", relevance: "Same delivery market", selected: true, origin: "research" };
    expect(contextSnapshotSchema.safeParse({ ...context, competitors: [competitor] }).success).toBe(false);
    expect(contextSnapshotSchema.safeParse({ ...context, competitors: [{ ...competitor, origin: "user" }] }).success).toBe(true);
  });
});
