/** The user-confirmed brand journey (2026-11-06): four steps, each with its parts. */
export const JOURNEY = [
  { id: "strategy", label: "Strategy", parts: ["Competitors", "Audience", "Positioning"] },
  { id: "voice", label: "Voice", parts: ["Personality", "Name", "Slogan"] },
  { id: "identity", label: "Identity", parts: ["Inspiration", "Logo", "Creative direction"] },
  { id: "assets", label: "Assets", parts: ["Brand images", "Brand guidelines", "Design system"] },
] as const;

export type JourneyStepId = typeof JOURNEY[number]["id"];
export type JourneyStepStatus = "done" | "current" | "upcoming";
/** `complete` keeps a finished step's state while it is the page being shown. */
export type JourneyStepView = { id: JourneyStepId; label: string; number: number; status: JourneyStepStatus; href?: string; complete?: boolean };

const ALL_STEPS: readonly JourneyStepId[] = JOURNEY.map(step => step.id);

/** Presentation only: callers decide which steps are verified as done. Steps
 * are numbered by their position among the included ones. */
export function journeySteps(current: JourneyStepId, done: ReadonlySet<JourneyStepId>, hrefs: Partial<Record<JourneyStepId, string>> = {},
  include: readonly JourneyStepId[] = ALL_STEPS): JourneyStepView[] {
  return JOURNEY.filter(step => include.includes(step.id)).map((step, index) => ({
    id: step.id,
    label: step.label,
    number: index + 1,
    status: step.id === current ? "current" : done.has(step.id) ? "done" : "upcoming",
    href: hrefs[step.id],
    ...(done.has(step.id) ? { complete: true } : {}),
  }));
}

const projectBase = (projectId: string) => `/brands/account/${projectId}`;

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
export function journeyStepHref(projectId: string, step: JourneyStepId): string {
  const base = projectBase(projectId);
  return step === "strategy" ? `${base}?view=strategy` : step === "voice" ? `${base}/naming`
    : step === "identity" ? `${base}/logo` : `${base}/logo/deliverables`;
}

/** The step a project's next action belongs to, from the same continuation the
 * project cards show. Steps before it are complete; null when it is unknown. */
export function journeyStepOfAction(projectId: string, href: string): JourneyStepId | null {
  const path = href.split(/[?#]/, 1)[0] ?? "";
  const base = projectBase(projectId);
  return path === base || path.startsWith(`${base}/`) ? journeyStepOfPath(projectId, path) : null;
}

/** The project bar's steps: the page being viewed is current, steps before the
 * verified next action are done, and the next action itself is a link. */
/** `shown` overrides the page: the conversation reports which step it is on. */
export function projectJourney(input: { projectId: string; pathname: string; nextHref: string | null; shown?: JourneyStepId | null }): JourneyStepView[] {
  const include = ALL_STEPS;
  const viewed = input.shown ?? journeyStepOfPath(input.projectId, input.pathname);
  const current = include.includes(viewed) ? viewed : include[0]!;
  const progress = input.nextHref ? journeyStepOfAction(input.projectId, input.nextHref) : null;
  const progressIndex = progress ? include.indexOf(progress) : -1;
  // The conversation reports a later step only after the earlier one is answered
  // (Voice follows a confirmed positioning), so the steps before it are done too.
  const shownIndex = input.shown ? include.indexOf(input.shown) : -1;
  const doneIndex = Math.max(progressIndex, shownIndex);
  const done = new Set(include.filter((_, index) => index < doneIndex));
  const hrefs: Partial<Record<JourneyStepId, string>> = {};
  include.forEach((step, index) => {
    if (index < doneIndex) hrefs[step] = journeyStepHref(input.projectId, step);
    else if (index === progressIndex && input.nextHref) hrefs[step] = input.nextHref;
  });
  return journeySteps(current, done, hrefs, include);
}

/** "Competitors · 1 of 3", used in Embel's message label. */
export function journeyPartLabel(step: JourneyStepId, part: string): string {
  const parts: readonly string[] = JOURNEY.find(item => item.id === step)?.parts ?? [];
  const index = parts.indexOf(part);
  return index < 0 ? part : `${part} · ${index + 1} of ${parts.length}`;
}
