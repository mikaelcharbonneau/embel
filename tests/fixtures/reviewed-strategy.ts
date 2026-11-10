import { contextSnapshotSchema, type ContextSnapshot } from "../../src/domain/projects";

const reviewedAt = "2026-10-01T00:00:00.000Z";
/** A brand context whose Strategy is fully reviewed, so Naming and Identity are
 * open. Tests that once used a "Name only" project, which skipped Strategy,
 * use this instead now that every project is a complete brand. Values already
 * in the given context are kept. */
export function reviewedStrategy(context: unknown = {}): ContextSnapshot {
  const base = contextSnapshotSchema.parse(context);
  return contextSnapshotSchema.parse({
    ...base,
    activity: base.activity || "Neighborhood kitchen",
    offering: base.offering || "Seasonal lunches",
    reformulationConfirmed: true,
    competitorReviewComplete: true,
    audienceSegments: base.audienceSegments.some((segment) => segment.selected)
      ? base.audienceSegments
      : [
          {
            id: "f0000000-0000-4000-8000-000000000001",
            label: "Neighbors",
            needs: ["Simple weekday lunches"],
            reason: "They live nearby",
            selected: true,
            origin: "user",
            sources: [],
          },
        ],
    personality: base.personality ?? {
      sincerity: 70,
      excitement: 40,
      competence: 70,
      sophistication: 30,
      ruggedness: 20,
    },
    positioning: base.positioning || "A neighborhood kitchen for simple seasonal lunches.",
    intake: {
      ...base.intake,
      audienceReviewedAt: base.intake.audienceReviewedAt ?? reviewedAt,
      personalityReviewedAt: base.intake.personalityReviewedAt ?? reviewedAt,
      positioningReviewedAt: base.intake.positioningReviewedAt ?? reviewedAt,
    },
  });
}
