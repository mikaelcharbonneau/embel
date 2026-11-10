import { logoTypeSchema, type LogoType } from "../../src/domain/logo-workspace";
import type { LogoConceptPlan } from "../../src/domain/logo-jobs";

// Version 1 pins these creative directions; they do not certify image uniqueness.
const DIRECTIONS = [
  "open_geometry", "compact_structure", "organic_motion",
  "angular_energy", "negative_space", "expressive_detail",
] as const;
const TYPE_ORDER: readonly LogoType[] = [
  "wordmark", "lettermark_monogram", "pictorial", "abstract", "combination", "emblem", "mascot",
];

/** Admission freezes this complete plan; recovery must reuse that saved plan. */
export function planSixConcepts(input: { types: readonly LogoType[]; priorSlotCount: number }): LogoConceptPlan {
  if (!Array.isArray(input.types) || input.types.length < 1 || input.types.length > 7 ||
    new Set(input.types).size !== input.types.length || Array.from(input.types).some(type => !logoTypeSchema.safeParse(type).success)) {
    throw new Error("Choose one or more distinct supported logo types.");
  }
  if (!Number.isSafeInteger(input.priorSlotCount) || input.priorSlotCount < 0) {
    throw new Error("Prior slot count must be a safe nonnegative integer.");
  }
  const requestedTypes = TYPE_ORDER.filter(type => input.types.includes(type));
  const start = input.priorSlotCount % requestedTypes.length;
  const slots: LogoConceptPlan["slots"] = DIRECTIONS.map((directionId, index) => ({
    ordinal: index as 0 | 1 | 2 | 3 | 4 | 5,
    type: requestedTypes[(start + index) % requestedTypes.length]!,
    directionId,
  }));
  const covered = new Set(slots.map(slot => slot.type));
  return {
    version: 1, targetCount: 6, requestedTypes, slots,
    coveredTypes: requestedTypes.filter(type => covered.has(type)),
    uncoveredTypes: requestedTypes.filter(type => !covered.has(type)),
  };
}
