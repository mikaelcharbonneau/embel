/** The user-confirmed brand journey (2026-11-06): four steps, each with its parts. */
export const JOURNEY = [
  { id: "strategy", label: "Strategy", parts: ["Competitors", "Audience", "Positioning"] },
  { id: "voice", label: "Voice", parts: ["Personality", "Name", "Slogan"] },
  { id: "identity", label: "Identity", parts: ["Inspiration", "Logo", "Creative direction"] },
  { id: "assets", label: "Assets", parts: ["Brand images", "Brand guidelines", "Design system"] },
] as const;

export type JourneyStepId = typeof JOURNEY[number]["id"];
export type JourneyStepStatus = "done" | "current" | "upcoming";
export type JourneyStepView = { id: JourneyStepId; label: string; number: number; status: JourneyStepStatus; href?: string };

/** Presentation only: callers decide which steps are verified as done. */
export function journeySteps(current: JourneyStepId, done: ReadonlySet<JourneyStepId>, hrefs: Partial<Record<JourneyStepId, string>> = {}): JourneyStepView[] {
  return JOURNEY.map((step, index) => ({
    id: step.id,
    label: step.label,
    number: index + 1,
    status: step.id === current ? "current" : done.has(step.id) ? "done" : "upcoming",
    href: hrefs[step.id],
  }));
}

/** "Competitors · 1 of 3", used in Embel's message label. */
export function journeyPartLabel(step: JourneyStepId, part: string): string {
  const parts: readonly string[] = JOURNEY.find(item => item.id === step)?.parts ?? [];
  const index = parts.indexOf(part);
  return index < 0 ? part : `${part} · ${index + 1} of ${parts.length}`;
}
