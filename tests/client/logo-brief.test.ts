import { describe, expect, it } from "vitest";
import { seedLogoBrief } from "../../src/components/logo-creation/brief-model";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { syntheticLogoContext } from "../fixtures/logo-creation";

describe("seedLogoBrief", () => {
  it("strategy_seed_does_not_require_reviewed_strategy", () => {
    const context = syntheticLogoContext();
    expect(seedLogoBrief(context)).toEqual({ nameConflict: false, draft: { name: "Élan & Co", activity: "Tea shop", audience: "Local readers", personality: "", logoTypes: [] } });
    expect(context.reformulationConfirmed).toBe(false);
  });
  it("strategy_seed_preserves_spelling_and_exposes_name_conflict", () => {
    const matching = syntheticLogoContext({ intake: contextSnapshotSchema.parse({ intake: { suppliedName: "Élan & Co" } }).intake });
    expect(seedLogoBrief(matching).draft.name).toBe("Élan & Co");
    const conflicting = structuredClone(matching);
    conflicting.intake.suppliedName = "Elan & Co";
    expect(seedLogoBrief(conflicting)).toMatchObject({ nameConflict: true, draft: { name: "" } });
    const decomposed = "E\u0301lan & Co";
    expect(seedLogoBrief(syntheticLogoContext({ selectedName: decomposed })).draft.name).toBe(decomposed);
  });
  it("uses supplied name when no saved selection exists and never chooses a missing name or type", () => {
    const context = syntheticLogoContext({ selectedName: null });
    context.intake.suppliedName = " Élan & Co ";
    expect(seedLogoBrief(context).draft.name).toBe(" Élan & Co ");
    expect(seedLogoBrief(contextSnapshotSchema.parse({}))).toEqual({ nameConflict: false, draft: { name: "", activity: "", audience: "", personality: "", logoTypes: [] } });
  });
  it("reuses offering, selected audience labels, personality values and identity notes without mutating Strategy", () => {
    const context = syntheticLogoContext({ offering: "Tea and books", knownAudience: "", audienceSegments: [
      { id: "00000000-0000-4000-8000-000000000001", label: "Readers", needs: [], reason: "", selected: true, origin: "user", sources: [] },
      { id: "00000000-0000-4000-8000-000000000002", label: "Tourists", needs: [], reason: "", selected: false, origin: "user", sources: [] },
    ], personality: { sincerity: 80, excitement: 30, competence: 60, sophistication: 40, ruggedness: 0 } });
    context.intake.identityNotes = "A quiet, welcoming place";
    const before = structuredClone(context);
    const result = seedLogoBrief(context);
    expect(result.draft.activity).toBe("Tea shop\nTea and books");
    expect(result.draft.audience).toBe("Readers");
    expect(result.draft.personality).toBe("Sincerity: 80; Excitement: 30; Competence: 60; Sophistication: 40; Ruggedness: 0\nA quiet, welcoming place");
    expect(context).toEqual(before);
  });
  it("keeps a long description editable instead of silently truncating it", () => {
    const description = "A".repeat(5000);
    expect(seedLogoBrief(syntheticLogoContext({ activity: "", offering: "", description })).draft.activity).toBe(description);
  });
});
