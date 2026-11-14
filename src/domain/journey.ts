import type { AccountProject } from "./project-api";
import { getNamingReadiness } from "./project-naming";
import { briefChangedSinceStrategy } from "./guided-interview";

/** The user-confirmed brand journey (2026-11-06): four steps, each with its parts. */
export const JOURNEY = [
  { id: "strategy", label: "Strategy", parts: ["Competitors", "Audience", "Positioning"] },
  { id: "voice", label: "Voice", parts: ["Personality", "Name", "Slogan"] },
  { id: "identity", label: "Identity", parts: ["Inspiration", "Logo", "Creative direction"] },
  { id: "assets", label: "Assets", parts: ["Brand images", "Brand guidelines", "Design system"] },
] as const;

export type JourneyStepId = (typeof JOURNEY)[number]["id"];
type JourneyStepStatus = "done" | "current" | "upcoming";
/** `complete` keeps a finished step's state while it is the page being shown. */
export type JourneyStepView = {
  id: JourneyStepId;
  label: string;
  number: number;
  status: JourneyStepStatus;
  href?: string;
  complete?: boolean;
};

const ALL_STEPS: readonly JourneyStepId[] = JOURNEY.map((step) => step.id);

/** Presentation only: callers decide which steps are verified as done. Steps
 * are numbered by their position among the included ones. */
export function journeySteps(
  current: JourneyStepId,
  done: ReadonlySet<JourneyStepId>,
  hrefs: Partial<Record<JourneyStepId, string>> = {},
  include: readonly JourneyStepId[] = ALL_STEPS,
): JourneyStepView[] {
  return JOURNEY.filter((step) => include.includes(step.id)).map((step, index) => ({
    id: step.id,
    label: step.label,
    number: index + 1,
    status: step.id === current ? "current" : done.has(step.id) ? "done" : "upcoming",
    href: hrefs[step.id],
    ...(done.has(step.id) ? { complete: true } : {}),
  }));
}

const projectBase = (projectId: string) => `/brands/account/${projectId}`;

/** The project conversation, which holds Strategy and Voice. */
export function projectStrategyHref(projectId: string) {
  return `${projectBase(projectId)}?view=strategy`;
}

/** Which step a project page belongs to. */
export function journeyStepOfPath(projectId: string, pathname: string): JourneyStepId {
  const base = projectBase(projectId);
  const rest = pathname === base || pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : "";
  if (/^\/naming(\/|$)/.test(rest)) return "voice";
  if (/^\/logo\/deliverables(\/|$)/.test(rest)) return "assets";
  if (/^\/(logo|inspiration|identity|brand-board)(\/|$)/.test(rest)) return "identity";
  return "strategy";
}

/** Where each step lives today. Identity opens at the logo, which leads on to
 * inspiration and creative direction. */
function journeyStepHref(projectId: string, step: JourneyStepId): string {
  const base = projectBase(projectId);
  return step === "strategy"
    ? projectStrategyHref(projectId)
    : step === "voice"
      ? `${base}/naming`
      : step === "identity"
        ? `${base}/logo`
        : `${base}/logo/deliverables`;
}

// ----- One answer to "which steps are done, which is current, what is next" (docs/state-machines.md, J2) -----

export type JourneyPart = (typeof JOURNEY)[number]["parts"][number];
type JourneyStatus = "done" | "current" | "upcoming";
/** A confirmation the saved Strategy and Voice answers still need, in journey order. `brief` is a missing
 * description (or, for a project without a conversation, an unconfirmed brief). */
export type JourneyReview = "brief" | "competitors" | "audience" | "positioning" | "personality";
const REVIEWS: readonly JourneyReview[] = ["brief", "competitors", "audience", "positioning", "personality"];

/** What the saved logo and creative direction work shows. It is read from other records than the project,
 * so callers pass it in; leave it out while it has not been read. */
export type JourneyEvidence =
  | { logo: "none" }
  /** Logo work exists: started, concepts being made, or concepts ready to choose from. */
  | { logo: "started" | "progress" | "choose" }
  | { logo: "chosen"; brandKit: true }
  /** A chosen logo with `directions` current creative directions; `directionsPending` while a request is open. */
  | { logo: "chosen"; brandKit: false; directions: number; directionsPending: boolean };

/** The next action: where it is in the journey, what the link says and where it goes. `finished` means the
 * brand kit exists, so every step is done. */
export type JourneyNext = { step: JourneyStepId; part: JourneyPart; label: string; href: string; finished: boolean };
export type JourneyProgress = {
  steps: Array<{
    id: JourneyStepId;
    label: string;
    status: JourneyStatus;
    parts: Array<{ label: JourneyPart; status: JourneyStatus }>;
  }>;
  /** Null only while the logo work has not been read: then the next action is not known. */
  next: JourneyNext | null;
  finished: boolean;
  /** Saved Strategy and Voice confirmations that are still missing. */
  reviews: JourneyReview[];
  /** Every confirmation the names need is saved. */
  strategyReady: boolean;
  /** The brief was edited after Strategy was confirmed. Nothing is locked; the conversation offers a redo. */
  briefChanged: boolean;
};

type Pointer = { step: JourneyStepId; part: JourneyPart };
const PARTS: readonly Pointer[] = JOURNEY.flatMap((step) => step.parts.map((part) => ({ step: step.id, part })));
const reviewPart: Record<JourneyReview, Pointer> = {
  brief: { step: "strategy", part: "Competitors" },
  competitors: { step: "strategy", part: "Competitors" },
  audience: { step: "strategy", part: "Audience" },
  positioning: { step: "strategy", part: "Positioning" },
  personality: { step: "voice", part: "Personality" },
};
/** What the link to a missing confirmation says. */
export const journeyReviewLabel: Record<JourneyReview, string> = {
  brief: "Review the saved brief",
  competitors: "Review competitors",
  audience: "Review audience",
  positioning: "Review positioning",
  personality: "Review personality",
};

/**
 * The one place that says where a project stands. Steps before the next action are done, its step is current
 * and the rest are upcoming. Started logo work leads: from then on the next action is in Identity (or Assets),
 * whatever was reopened earlier. Before that, the saved answers decide, in journey order: the brief, Competitors,
 * Audience, Positioning, then Personality, Name and the optional Slogan under Voice, then Inspiration.
 * A skipped slogan counts as done, and a project without a conversation is never asked for one.
 */
export function journeyProgress(input: {
  project: Pick<AccountProject, "id" | "scope" | "context">;
  evidence?: JourneyEvidence | null;
}): JourneyProgress {
  const { project, evidence = null } = input;
  const context = project.context,
    guided = context.intake.guidedInterview,
    base = projectBase(project.id);
  const readiness = getNamingReadiness(context, project.scope);
  const missing = new Set<JourneyReview>(
    readiness.missing.map((step) => (step === "description" || step === "reformulation" ? "brief" : step)),
  );
  // The conversation asks Positioning before Personality; while it is on that question, it is not confirmed.
  if (guided?.stage === "positioning") missing.add("positioning");
  const reviews = REVIEWS.filter((key) => missing.has(key));
  const sloganOpen =
    guided !== undefined && guided.stage !== "complete" && !guided.answers.some((answer) => answer.stage === "slogan");
  const saved: Pointer = reviews.length
    ? reviewPart[reviews[0]!]
    : !context.selectedName?.trim()
      ? { step: "voice", part: "Name" }
      : sloganOpen
        ? { step: "voice", part: "Slogan" }
        : { step: "identity", part: "Inspiration" };
  const finished = evidence?.logo === "chosen" && evidence.brandKit;
  const pointer: Pointer | null = !evidence
    ? null
    : evidence.logo === "none"
      ? saved
      : evidence.logo !== "chosen"
        ? { step: "identity", part: "Logo" }
        : evidence.brandKit
          ? { step: "assets", part: "Brand images" }
          : { step: "identity", part: "Creative direction" };
  // Without the logo work, the saved answers are still a floor: everything before them is done.
  const at = PARTS.findIndex((item) => item.part === (pointer ?? saved).part);
  const steps = JOURNEY.map((step) => {
    const parts = step.parts.map((label) => {
      const index = PARTS.findIndex((item) => item.part === label);
      const status: JourneyStatus = finished || index < at ? "done" : index === at && pointer ? "current" : "upcoming";
      return { label, status };
    });
    const status: JourneyStatus = parts.every((part) => part.status === "done")
      ? "done"
      : parts.some((part) => part.status === "current")
        ? "current"
        : "upcoming";
    return { id: step.id, label: step.label, status, parts };
  });

  const conversation = (section: "strategy" | "voice") => `${projectStrategyHref(project.id)}#journey-${section}`;
  // The conversation shows its Voice section from the Personality question on.
  const voiceOpen = guided?.stage === "personality" || guided?.stage === "slogan" || guided?.stage === "complete";
  const action = (): { label: string; href: string } => {
    if (!evidence || evidence.logo === "none") {
      if (reviews.length)
        return {
          label: journeyReviewLabel[reviews[0]!],
          href: conversation(reviews[0] === "personality" && voiceOpen ? "voice" : "strategy"),
        };
      if (saved.part === "Name") return { label: "Continue to Naming", href: `${base}/naming` };
      if (saved.part === "Slogan") return { label: "Continue to Slogan", href: conversation("voice") };
      return { label: "Continue to Inspiration", href: `${base}/inspiration` };
    }
    if (evidence.logo !== "chosen")
      return {
        label:
          evidence.logo === "choose"
            ? "Choose a logo"
            : evidence.logo === "progress"
              ? "Review logo progress"
              : "Continue logo design",
        href: `${base}/logo`,
      };
    if (evidence.brandKit) return { label: "View brand kit", href: `${base}/logo/deliverables` };
    return {
      label:
        evidence.directions > 1
          ? `Compare ${evidence.directions} directions`
          : evidence.directions === 1
            ? "Review visual direction"
            : evidence.directionsPending
              ? "Check direction progress"
              : "Explore creative directions",
      href: `${base}/logo/directions`,
    };
  };
  return {
    steps,
    next: pointer ? { ...pointer, ...action(), finished } : null,
    finished,
    reviews,
    strategyReady: readiness.ready,
    briefChanged: briefChangedSinceStrategy(context),
  };
}

/** The project bar's steps: the page being viewed is current (`shown` overrides the page: the conversation
 * reports which step is on screen), done steps come from `journeyProgress`, and the next action is a link. */
export function projectJourney(input: {
  projectId: string;
  pathname: string;
  progress: JourneyProgress | null;
  shown?: JourneyStepId | null;
}): JourneyStepView[] {
  const current = input.shown ?? journeyStepOfPath(input.projectId, input.pathname);
  const done = new Set<JourneyStepId>();
  const hrefs: Partial<Record<JourneyStepId, string>> = {};
  for (const step of input.progress?.steps ?? []) {
    if (step.status === "done") {
      done.add(step.id);
      hrefs[step.id] = journeyStepHref(input.projectId, step.id);
    } else if (step.id === input.progress?.next?.step) hrefs[step.id] = input.progress.next.href;
  }
  return journeySteps(current, done, hrefs);
}

export type JourneyMarkState = "complete" | "current" | "upcoming";
/** A project card's journey mark, from the same next action the card links to. Steps before the action's step are
 * complete and its step is current; a finished brand has all four complete (`current` is null). Null while the
 * next action is unknown, so no progress is ever guessed. */
export function projectJourneyMark(
  next: Pick<JourneyNext, "step" | "finished"> | null,
): { states: JourneyMarkState[]; current: JourneyStepId | null } | null {
  if (!next) return null;
  if (next.finished) return { states: ALL_STEPS.map(() => "complete"), current: null };
  const index = ALL_STEPS.indexOf(next.step);
  return {
    states: ALL_STEPS.map((_, at) => (at < index ? "complete" : at === index ? "current" : "upcoming")),
    current: next.step,
  };
}

/** "Competitors · 1 of 3", used in Embel's message label. */
export function journeyPartLabel(step: JourneyStepId, part: string): string {
  const parts: readonly string[] = JOURNEY.find((item) => item.id === step)?.parts ?? [];
  const index = parts.indexOf(part);
  return index < 0 ? part : `${part} · ${index + 1} of ${parts.length}`;
}
