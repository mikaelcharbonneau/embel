import { describe, expect, it } from "vitest";
import { getProjectHandoff, projectEvidenceStatus } from "@/domain/project-handoff";
import { contextSnapshotSchema, type ContextSnapshot, type ProjectScope } from "@/domain/projects";
import { journeySectionOfHash } from "@/components/journey/project-header";

const projectId = "d0000000-0000-4000-8000-000000000002";
const now = "2026-10-13T00:00:00Z";
function ready(): ContextSnapshot {
  return contextSnapshotSchema.parse({
    description: "A repairable lighting studio",
    activity: "Lighting",
    offering: "Repairable lamps",
    reformulationConfirmed: true,
    competitorReviewComplete: true,
    audienceSegments: [
      {
        id: "d0000000-0000-4000-8000-000000000003",
        label: "Small homes",
        needs: [],
        reason: "Compact lighting",
        selected: true,
        origin: "user",
      },
    ],
    personality: { sincerity: 60, excitement: 30, competence: 70, sophistication: 40, ruggedness: 20 },
    positioning: "Repairable lights for small homes",
    intake: { audienceReviewedAt: now, personalityReviewedAt: now, positioningReviewedAt: now },
  });
}
const handoff = (context: ContextSnapshot, scope: ProjectScope = "complete_brand") =>
  getProjectHandoff({ id: projectId, scope, context });

describe("saved project handoffs", () => {
  it("resumes the first genuinely unreviewed Strategy step without accepting filled text", () => {
    const context = ready();
    context.intake.audienceReviewedAt = null;
    expect(handoff(context)).toMatchObject({
      strategyReady: false,
      reviews: [{ key: "audience", label: "Review audience", anchor: "audience" }],
      next: { stage: "strategy", href: `/brands/account/${projectId}?view=strategy#journey-strategy` },
    });
  });
  it("combines missing description and unreviewed brief into one editable destination", () => {
    const context = contextSnapshotSchema.parse({});
    expect(handoff(context).reviews.filter((step) => step.anchor === "brief")).toHaveLength(1);
    expect(handoff(context)).toMatchObject({
      briefReviewed: false,
      savedName: null,
      next: { href: `/brands/account/${projectId}?view=strategy#journey-strategy` },
    });
  });
  it("continues approved Strategy to Naming, then a saved name to Inspiration", () => {
    const context = ready();
    expect(handoff(context).next).toMatchObject({ stage: "naming", href: `/brands/account/${projectId}/naming` });
    context.selectedName = "Luma";
    expect(handoff(context)).toMatchObject({
      savedName: "Luma",
      next: {
        stage: "inspiration",
        label: "Continue to Inspiration",
        href: `/brands/account/${projectId}/inspiration`,
      },
    });
    expect(context.intake.suppliedName).toBe("");
  });
  it("keeps a selected name while upstream review becomes incomplete", () => {
    const context = ready();
    context.selectedName = "Luma";
    context.reformulationConfirmed = false;
    expect(handoff(context)).toMatchObject({
      savedName: "Luma",
      strategyReady: false,
      next: { stage: "strategy", href: `/brands/account/${projectId}?view=strategy#journey-strategy` },
    });
  });
  it("starts in Strategy until the brief is reviewed, even when a name was supplied", () => {
    const context = contextSnapshotSchema.parse({
      description: "Repairable lighting",
      intake: { suppliedName: "Provided name" },
    });
    expect(handoff(context)).toMatchObject({ strategyReady: false, next: { stage: "strategy" } });
  });
  it("sends every Strategy review to a section the project conversation has", () => {
    // The conversation renders `journey-strategy` always and `journey-voice` from Personality on;
    // it has no per-step `strategy-…` anchors.
    type Guided = NonNullable<ContextSnapshot["intake"]["guidedInterview"]>;
    const guided = (stage: Guided["stage"]): Guided => ({ version: 1, stage, turns: [], answers: [] });
    const cases: Array<[string, (context: ContextSnapshot) => void, "strategy" | "voice"]> = [
      ["brief", (context) => void (context.reformulationConfirmed = false), "strategy"],
      ["competitors", (context) => void (context.competitorReviewComplete = false), "strategy"],
      ["audience", (context) => void (context.intake.audienceReviewedAt = null), "strategy"],
      ["positioning", (context) => void (context.intake.positioningReviewedAt = null), "strategy"],
      // Without the conversation at Personality or later, its Voice section is not shown yet.
      ["personality", (context) => void (context.intake.personalityReviewedAt = null), "strategy"],
      [
        "personality",
        (context) => {
          context.intake.personalityReviewedAt = null;
          context.intake.guidedInterview = guided("personality");
        },
        "voice",
      ],
      [
        "personality",
        (context) => {
          context.intake.personalityReviewedAt = null;
          context.intake.guidedInterview = guided("slogan");
        },
        "voice",
      ],
      [
        "competitors",
        (context) => {
          context.competitorReviewComplete = false;
          context.intake.guidedInterview = guided("slogan");
        },
        "strategy",
      ],
    ];
    for (const [key, change, section] of cases) {
      const context = ready();
      change(context);
      const { next, reviews } = handoff(context);
      expect(reviews[0]?.key).toBe(key);
      expect(next.stage).toBe("strategy");
      const url = new URL(next.href, "https://embel.test");
      expect(url.pathname + url.search).toBe(`/brands/account/${projectId}?view=strategy`);
      expect(journeySectionOfHash(url.hash)).toBe(section);
    }
    expect(journeySectionOfHash("#strategy-competitors")).toBeNull();
  });
  it("distinguishes verified stale evidence from evidence requiring a new revision check", () => {
    expect(projectEvidenceStatus(null, 4)).toBe("unchecked");
    expect(projectEvidenceStatus({ projectRevision: 3, approved: true, needsReview: false }, 4)).toBe("recheck");
    expect(projectEvidenceStatus({ projectRevision: 4, approved: true, needsReview: true }, 4)).toBe("needs_review");
    expect(projectEvidenceStatus({ projectRevision: 4, approved: true, needsReview: false }, 4)).toBe("approved");
    expect(projectEvidenceStatus({ projectRevision: 4, approved: false }, 4)).toBe("unchecked");
  });
});
