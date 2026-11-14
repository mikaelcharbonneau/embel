import { describe, expect, it } from "vitest";
import { chosenLogoAnswer, chosenLogoLabel } from "@/components/logo-creation/chosen-logo-label";
import { conceptVersions } from "@/components/logo-creation/concept-versions";
import type { LogoRefinementHistoryState } from "@/components/logo-creation/refinement-history";
import { syntheticLogoBatch } from "../fixtures/logo-creation";

const noHistory: LogoRefinementHistoryState = {
  items: [],
  nextCursor: null,
  loaded: true,
  loading: false,
  error: null,
};

describe("the chosen logo's name", () => {
  it("names an original concept by its place in the set", () => {
    const batch = syntheticLogoBatch();
    const slot = batch.slots[2]!;
    const source = { kind: "concept" as const, batchId: batch.id, slotId: slot.id, attemptId: slot.attempts[0]!.id };
    expect(chosenLogoLabel(batch, conceptVersions(batch, noHistory), source)).toBe("Concept 3");
  });

  it("names nothing it cannot find in the set", () => {
    const batch = syntheticLogoBatch();
    const versions = conceptVersions(batch, noHistory);
    expect(chosenLogoLabel(batch, versions, null)).toBeNull();
    expect(chosenLogoLabel(null, {}, { kind: "refinement", rasterRevisionId: batch.id })).toBeNull();
    expect(chosenLogoLabel(batch, versions, { kind: "refinement", rasterRevisionId: batch.id })).toBeNull();
  });

  it("words a changed version for a sentence or a folded answer", () => {
    expect(chosenLogoAnswer("Concept 1 · Version 2")).toBe("Concept 1, version 2");
    expect(chosenLogoAnswer("Concept 4")).toBe("Concept 4");
  });
});
