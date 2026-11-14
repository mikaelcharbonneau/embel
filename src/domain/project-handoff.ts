import type { AccountProject } from "./project-api";
import { journeyProgress, journeyReviewLabel, projectStrategyHref, type JourneyNext } from "./journey";

export { projectStrategyHref };

/** Guidance from the saved decisions alone, before any logo work: what still needs confirming and the next step.
 * It reads `journeyProgress` (src/domain/journey.ts), the one answer the bar and the cards also read.
 * Navigation never approves or copies inputs. */
export function getProjectHandoff(project: Pick<AccountProject, "id" | "scope" | "context">) {
  const progress = journeyProgress({ project, evidence: { logo: "none" } });
  return {
    reviews: progress.reviews.map((key) => ({ key, label: journeyReviewLabel[key] })),
    strategyReady: progress.strategyReady,
    briefReviewed: !progress.reviews.includes("brief"),
    savedName: project.context.selectedName?.trim() || null,
    briefChanged: progress.briefChanged,
    next: progress.next as JourneyNext,
  };
}

export type ProjectStageEvidence = {
  ownerId: string;
  projectId: string;
  projectRevision: number;
  approved: boolean;
  needsReview?: boolean;
};
/** Different revisions require a fresh check; they are not proof of material staleness. */
export function projectEvidenceStatus(
  evidence: Pick<ProjectStageEvidence, "projectRevision" | "approved" | "needsReview"> | null,
  projectRevision: number | undefined,
) {
  if (!evidence || !projectRevision) return "unchecked";
  if (evidence.projectRevision !== projectRevision) return "recheck";
  if (evidence.needsReview) return "needs_review";
  return evidence.approved ? "approved" : "unchecked";
}
