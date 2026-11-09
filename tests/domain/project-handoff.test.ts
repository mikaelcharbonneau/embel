import { describe, expect, it } from "vitest";
import { getProjectHandoff, projectEvidenceStatus } from "@/domain/project-handoff";
import { contextSnapshotSchema, type ContextSnapshot, type ProjectScope } from "@/domain/projects";

const projectId = "d0000000-0000-4000-8000-000000000002";
const now = "2026-10-13T00:00:00Z";
function ready(): ContextSnapshot {
  return contextSnapshotSchema.parse({ description: "A repairable lighting studio", activity: "Lighting", offering: "Repairable lamps", reformulationConfirmed: true, competitorReviewComplete: true,
    audienceSegments: [{ id: "d0000000-0000-4000-8000-000000000003", label: "Small homes", needs: [], reason: "Compact lighting", selected: true, origin: "user" }],
    personality: { sincerity: 60, excitement: 30, competence: 70, sophistication: 40, ruggedness: 20 }, positioning: "Repairable lights for small homes",
    intake: { audienceReviewedAt: now, personalityReviewedAt: now, positioningReviewedAt: now } });
}
const handoff = (context: ContextSnapshot, scope: ProjectScope = "complete_brand") => getProjectHandoff({ id: projectId, scope, context });

describe("saved project handoffs", () => {
  it("resumes the first genuinely unreviewed Strategy step without accepting filled text", () => {
    const context = ready(); context.intake.audienceReviewedAt = null;
    expect(handoff(context)).toMatchObject({ strategyReady: false, reviews: [{ key: "audience", label: "Review audience", anchor: "audience" }], next: { stage: "strategy", href: `/brands/account/${projectId}?view=strategy#strategy-audience` } });
  });
  it("combines missing description and unreviewed brief into one editable destination", () => {
    const context = contextSnapshotSchema.parse({});
    expect(handoff(context).reviews.filter(step => step.anchor === "brief")).toHaveLength(1);
    expect(handoff(context)).toMatchObject({ briefReviewed: false, savedName: null, next: { href: `/brands/account/${projectId}?view=strategy#strategy-brief` } });
  });
  it("continues approved Strategy to Naming, then a saved name to Inspiration", () => {
    const context = ready();
    expect(handoff(context).next).toMatchObject({ stage: "naming", href: `/brands/account/${projectId}/naming` });
    context.selectedName = "Luma";
    expect(handoff(context)).toMatchObject({ savedName: "Luma", next: { stage: "inspiration", label: "Continue to Inspiration", href: `/brands/account/${projectId}/inspiration` } });
    expect(context.intake.suppliedName).toBe("");
  });
  it("keeps a selected name while upstream review becomes incomplete", () => {
    const context = ready(); context.selectedName = "Luma"; context.reformulationConfirmed = false;
    expect(handoff(context)).toMatchObject({ savedName: "Luma", strategyReady: false, next: { stage: "strategy", href: `/brands/account/${projectId}?view=strategy#strategy-brief` } });
  });
  it("starts in Strategy until the brief is reviewed, even when a name was supplied", () => {
    const context = contextSnapshotSchema.parse({ description: "Repairable lighting", intake: { suppliedName: "Provided name" } });
    expect(handoff(context)).toMatchObject({ strategyReady: false, next: { stage: "strategy" } });
  });
  it("distinguishes verified stale evidence from evidence requiring a new revision check", () => {
    expect(projectEvidenceStatus(null, 4)).toBe("unchecked");
    expect(projectEvidenceStatus({ projectRevision: 3, approved: true, needsReview: false }, 4)).toBe("recheck");
    expect(projectEvidenceStatus({ projectRevision: 4, approved: true, needsReview: true }, 4)).toBe("needs_review");
    expect(projectEvidenceStatus({ projectRevision: 4, approved: true, needsReview: false }, 4)).toBe("approved");
    expect(projectEvidenceStatus({ projectRevision: 4, approved: false }, 4)).toBe("unchecked");
  });
});
