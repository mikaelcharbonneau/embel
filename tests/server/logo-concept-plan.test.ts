import { describe, expect, it } from "vitest";
import { planSixConcepts } from "../../src/server/logo-creation/concept-plan";
import { logoConceptPlanSchema } from "../../src/domain/logo-jobs";
import type { LogoType } from "../../src/domain/logo-workspace";
import { syntheticLogoTypes } from "../fixtures/logo-creation";

describe("planSixConcepts", () => {
  it("plans_six_total_and_discloses_uncovered_type", () => {
    const first = planSixConcepts({ types: syntheticLogoTypes, priorSlotCount: 0 });
    expect(first.slots).toHaveLength(6);
    expect(first.coveredTypes).toEqual(["wordmark", "lettermark_monogram", "pictorial", "abstract", "combination", "emblem"]);
    expect(first.uncoveredTypes).toEqual(["mascot"]);
    const next = planSixConcepts({ types: syntheticLogoTypes, priorSlotCount: 6 });
    expect(next.slots.map(slot => slot.type)).toEqual(["mascot", "wordmark", "lettermark_monogram", "pictorial", "abstract", "combination"]);
    expect(next.uncoveredTypes).toEqual(["emblem"]);
    expect(logoConceptPlanSchema.parse(first)).toEqual(first);
    expect(logoConceptPlanSchema.parse(next)).toEqual(next);
  });
  it("one_type_still_gets_six_distinct_planned_directions", () => {
    const plan = planSixConcepts({ types: ["mascot"], priorSlotCount: 0 });
    expect(plan.slots.map(slot => [slot.ordinal, slot.type, slot.directionId])).toEqual([
      [0, "mascot", "open_geometry"], [1, "mascot", "compact_structure"], [2, "mascot", "organic_motion"],
      [3, "mascot", "angular_energy"], [4, "mascot", "negative_space"], [5, "mascot", "expressive_detail"],
    ]);
    expect(plan.uncoveredTypes).toEqual([]);
  });
  it("uses canonical type order regardless of selection order and does not mutate input", () => {
    const types: LogoType[] = ["mascot", "wordmark", "abstract"];
    const plan = planSixConcepts({ types, priorSlotCount: 1 });
    expect(plan.requestedTypes).toEqual(["wordmark", "abstract", "mascot"]);
    expect(plan.slots.map(slot => slot.type)).toEqual(["abstract", "mascot", "wordmark", "abstract", "mascot", "wordmark"]);
    expect(plan).toEqual(planSixConcepts({ types: ["abstract", "wordmark", "mascot"], priorSlotCount: 1 }));
    expect(types).toEqual(["mascot", "wordmark", "abstract"]);
  });
  it.each([{ types: [] }, { types: ["wordmark", "wordmark"] }, { types: ["unknown"] }, { types: new Array<LogoType>(1) }])("rejects empty, duplicate, unsupported or sparse type selections: %j", ({ types }) => {
    expect(() => planSixConcepts({ types: types as LogoType[], priorSlotCount: 0 })).toThrow();
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe prior slot count %s", priorSlotCount => {
    expect(() => planSixConcepts({ types: ["wordmark"], priorSlotCount })).toThrow();
  });
  it("avoids precision loss at the largest valid count", () => {
    expect(planSixConcepts({ types: syntheticLogoTypes, priorSlotCount: Number.MAX_SAFE_INTEGER }).slots.map(slot => slot.type)).toEqual(["abstract", "combination", "emblem", "mascot", "wordmark", "lettermark_monogram"]);
  });
});
