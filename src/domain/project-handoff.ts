import type { AccountProject } from "./project-api";
import { getNamingReadiness } from "./project-naming";

const reviews = {
  brief: { key: "brief", label: "Review the saved brief", anchor: "brief" },
  competitors: { key: "competitors", label: "Review competitors", anchor: "competitors" },
  audience: { key: "audience", label: "Review audience", anchor: "audience" },
  personality: { key: "personality", label: "Review personality", anchor: "personality" },
  positioning: { key: "positioning", label: "Review positioning", anchor: "positioning" },
} as const;
type Continuation = { stage: "strategy" | "naming" | "inspiration"; label: string; href: string };

/** Derive guidance from saved decisions; navigation never approves or copies inputs. */
export function getProjectHandoff(project: Pick<AccountProject, "id" | "scope" | "context">) {
  const base = `/brands/account/${project.id}`, context = project.context;
  const strategy = getNamingReadiness(context, "complete_brand");
  const missing: Array<keyof typeof reviews> = [];
  for (const step of strategy.missing) {
    if (step === "scope") continue;
    const key = step === "description" || step === "reformulation" ? "brief" : step;
    if (!missing.includes(key)) missing.push(key);
  }
  const pendingReviews = missing.map(step => reviews[step]);
  const savedName = context.selectedName?.trim() || null;
  let next: Continuation;
  if (!context.description.trim() || project.scope === "complete_brand" && pendingReviews.length > 0) {
    const first = pendingReviews[0] ?? reviews.brief;
    next = { stage: "strategy", label: first.label, href: `${base}#strategy-${first.anchor}` };
  } else if (project.scope === "naming_only" || project.scope === "complete_brand" && !savedName) {
    next = { stage: "naming", label: savedName ? "Review saved name" : "Continue to Naming", href: `${base}/naming` };
  } else {
    next = { stage: "inspiration", label: "Continue to Inspiration", href: `${base}/inspiration` };
  }
  return { reviews: pendingReviews, strategyReady: strategy.ready, briefReviewed: !strategy.missing.includes("reformulation") && !strategy.missing.includes("description"), savedName, next };
}

export type ProjectStageEvidence = { ownerId: string; projectId: string; projectRevision: number; approved: boolean; needsReview?: boolean };
/** Different revisions require a fresh check; they are not proof of material staleness. */
export function projectEvidenceStatus(evidence: Pick<ProjectStageEvidence, "projectRevision" | "approved" | "needsReview"> | null, projectRevision: number | undefined) {
  if (!evidence || !projectRevision) return "unchecked";
  if (evidence.projectRevision !== projectRevision) return "recheck";
  if (evidence.needsReview) return "needs_review";
  return evidence.approved ? "approved" : "unchecked";
}
