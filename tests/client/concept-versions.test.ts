import { describe, expect, it } from "vitest";
import { conceptVersions } from "../../src/components/logo-creation/concept-versions";
import { syntheticLogoBatch, logoFixtureId as id } from "../fixtures/logo-creation";
import { syntheticRasterRefinement } from "../fixtures/logo-refinement-history";
import type { LogoRefinementHistoryState } from "../../src/components/logo-creation/refinement-history";
const batch = syntheticLogoBatch();
const first = syntheticRasterRefinement();
const state = (...records: ReturnType<typeof syntheticRasterRefinement>[]): LogoRefinementHistoryState => ({ items: records.map(record => ({ record, verified: true, error: null })), nextCursor: null, loaded: true, loading: false, error: null });
describe("concept card versions", () => {
  it("keeps an immutable original and follows nested refinements into the same slot", () => {
    const next = syntheticRasterRefinement({ id: id(800), source: { kind: "refinement", rasterRevisionId: first.id }, createdAt: "2026-10-07T12:00:00Z" });
    const before = JSON.stringify(batch);
    const versions = conceptVersions(batch, state(next, first))[batch.slots[0]!.id]!;
    expect(versions.map(item => item.label)).toEqual(["Original", "Version 2", "Version 3"]);
    expect(versions.at(-1)?.source).toEqual({ kind: "refinement", rasterRevisionId: next.id });
    expect(JSON.stringify(batch)).toBe(before);
  });
  it("excludes unverified, missing-parent and foreign-batch refinements", () => {
    const history = state(first);
    history.items[0]!.verified = false;
    expect(conceptVersions(batch, history)[batch.slots[0]!.id]).toHaveLength(1);
    const missing = syntheticRasterRefinement({ source: { kind: "refinement", rasterRevisionId: id(900) } });
    const foreign = syntheticRasterRefinement({ source: { ...first.source, kind: "concept", batchId: id(901), slotId: batch.slots[0]!.id, attemptId: batch.slots[0]!.attempts[0]!.id } });
    expect(conceptVersions(batch, state(missing, foreign))[batch.slots[0]!.id]).toHaveLength(1);
  });
});
