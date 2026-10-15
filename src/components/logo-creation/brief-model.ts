import type { ContextSnapshot } from "../../domain/projects";
import type { LogoBriefDraft } from "../../domain/logo-workspace";

/** Called only after explicit Strategy reuse. This is an editable draft, not a save. */
export function seedLogoBrief(context: ContextSnapshot): { draft: LogoBriefDraft; nameConflict: boolean } {
  const selected = context.selectedName?.trim() ? context.selectedName : "";
  const supplied = context.intake.suppliedName.trim() ? context.intake.suppliedName : "";
  const nameConflict = Boolean(selected && supplied && selected !== supplied);
  const activity = [context.activity, context.offering].filter(value => value.trim()).join("\n");
  const personality = context.personality ? [
    `Sincerity: ${context.personality.sincerity}`,
    `Excitement: ${context.personality.excitement}`,
    `Competence: ${context.personality.competence}`,
    `Sophistication: ${context.personality.sophistication}`,
    `Ruggedness: ${context.personality.ruggedness}`,
  ].join("; ") : "";
  return {
    nameConflict,
    draft: {
      name: selected || supplied,
      activity: activity || context.description,
      audience: context.knownAudience || context.audienceSegments.filter(segment => segment.selected).map(segment => segment.label).join(", "),
      personality: [personality, context.intake.identityNotes].filter(value => value.trim()).join("\n"),
      logoTypes: [],
    },
  };
}
