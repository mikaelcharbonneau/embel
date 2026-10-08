import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { createEmptyNamesWorkspace, createNamesStore } from "@/components/naming/local-names";

const now = "2026-10-03T01:00:00Z";
function fixture() {
  const data = createEmptyNamesWorkspace();
  data.ui.context = contextSnapshotSchema.parse({
    description: "An independent lighting studio making repairable lamps.", activity: "Lighting studio", offering: "Repairable lamps", knownAudience: "Small homes", reformulationConfirmed: true,
    competitorReviewComplete: true,
    personality: { sincerity: 60, excitement: 30, competence: 70, sophistication: 40, ruggedness: 20 },
    positioning: "Warm, repairable lighting for small homes.",
    intake: { step: "positioning", audienceReviewedAt: now, personalityReviewedAt: now, positioningReviewedAt: now },
  });
  let raw = JSON.stringify(data);
  const store = createNamesStore({ storage: () => ({ getItem: () => raw, setItem: (_key, value) => { raw = value; } }), createId: randomUUID, now: () => now });
  store.hydrate();
  return store;
}

describe("Names retains strategy content without carrying stale review approval", () => {
  it("invalidates future captured reviews after source edits while keeping earlier names immutable", () => {
    const store = fixture();
    expect(store.addManual("Original fixture").ok).toBe(true);
    const original = structuredClone(store.getSnapshot().data.candidates[0]!);
    expect(store.updateContext({ knownAudience: "Shared workspaces" }).ok).toBe(true);
    expect(store.addManual("New fixture").ok).toBe(true);
    const next = store.getSnapshot().data.candidates[1]!.context;
    expect(next.personality).toEqual(original.context.personality);
    expect(next.positioning).toBe(original.context.positioning);
    expect(next).toMatchObject({ reformulationConfirmed: false, competitorReviewComplete: false, intake: { audienceReviewedAt: null, personalityReviewedAt: null, positioningReviewedAt: null } });
    expect(store.getSnapshot().data.candidates[0]).toEqual(original);
  });

  it("retains current approvals when only naming notes or boundary whitespace change", () => {
    const store = fixture();
    expect(store.updateContext({ namingNotes: "Keep it short", knownAudience: " Small homes " }).ok).toBe(true);
    expect(store.getSnapshot().data.ui.context.intake).toMatchObject({ namingNotes: "Keep it short", personalityReviewedAt: now, positioningReviewedAt: now });
  });

  it("loads a legacy names workspace without inventing strategy approvals", () => {
    const earlier = fixture();
    earlier.addManual("Legacy fixture");
    const data = JSON.parse(JSON.stringify(earlier.getSnapshot().data));
    delete data.ui.context.intake.personalityReviewedAt;
    delete data.ui.context.intake.positioningReviewedAt;
    delete data.candidates[0].context.intake.personalityReviewedAt;
    delete data.candidates[0].context.intake.positioningReviewedAt;
    const store = createNamesStore({ storage: () => ({ getItem: () => JSON.stringify(data), setItem: () => {} }), createId: randomUUID, now: () => now });
    store.hydrate();
    expect(store.getSnapshot().storage).toBe("available");
    expect(store.getSnapshot().data.ui.context.personality).toEqual(data.ui.context.personality);
    expect(store.getSnapshot().data.ui.context.intake).toMatchObject({ personalityReviewedAt: null, positioningReviewedAt: null });
    expect(store.getSnapshot().data.candidates[0]!.context.intake).toMatchObject({ personalityReviewedAt: null, positioningReviewedAt: null });
    expect(store.getSnapshot().data.candidates[0]!.context.personality).toEqual(data.candidates[0].context.personality);
  });
});
