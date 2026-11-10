import { AppMark } from "@/components/ui/app-mark";
import { journeyPartLabel, type JourneyStepId } from "@/domain/journey";
import type { GuidedStage } from "@/domain/guided-interview";

// Where each guided question sits in the four-step journey.
const stageParts: Record<GuidedStage, [JourneyStepId, string]> = {
  competitors: ["strategy", "Competitors"],
  audience: ["strategy", "Audience"],
  positioning: ["strategy", "Positioning"],
  personality: ["voice", "Personality"],
  slogan: ["voice", "Slogan"],
};
export function guidedStageLabel(stage: GuidedStage): string {
  const [step, part] = stageParts[stage];
  return stage === "slogan" ? `${journeyPartLabel(step, part)} · Optional` : journeyPartLabel(step, part);
}

/** Embel's avatar and name above a reply, with the journey part when known,
 * e.g. "Embel · Competitors · 1 of 3". */
export function EmbelIdentity({ label }: { label?: string }) {
  return (
    <div className="guided-assistant-identity">
      <span className="guided-assistant-avatar" aria-hidden="true">
        <AppMark />
      </span>
      <span className="guided-assistant-label">{label ? `Embel · ${label}` : "Embel"}</span>
    </div>
  );
}
