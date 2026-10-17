import type { NamingPreferencesV2 } from "@/domain/naming-brain-preferences";

export type NamingQuestion = "approaches" | "directness" | "sourceLanguages" | "heritage" | "culture" | "language" | "length" | "fragments";
export type NamingChatStep = NamingQuestion | "review";
/** Owner-bound, in-memory UI progress. Saved preferences remain authoritative. */
export type NamingChatProgress = { activeStep: NamingChatStep; confirmed: Partial<Record<NamingQuestion, string>> };

export function namingChatQuestions(value: NamingPreferencesV2): NamingQuestion[] {
  return ["approaches", "directness", ...(value.approaches.some(id => id === "other_languages" || id === "classical_roots") ? ["sourceLanguages" as const] : []), ...(value.approaches.includes("people_places") ? ["heritage" as const] : []), ...(value.approaches.includes("stories_culture") ? ["culture" as const] : []), "language", "length", "fragments"];
}
const lines = (values: string[]) => values.map(value => value.trim()).filter(Boolean);
function answerKey(question: NamingQuestion, value: NamingPreferencesV2): string {
  switch (question) {
    case "approaches": return JSON.stringify([...value.approaches].sort());
    case "directness": return JSON.stringify(value.directness);
    case "sourceLanguages": return JSON.stringify(lines(value.sourceLanguages));
    case "heritage": return JSON.stringify(value.heritageNotes.trim());
    case "culture": return JSON.stringify(value.culturalNotes.trim());
    case "language": return JSON.stringify(value.creativeLocale.trim());
    case "length": return JSON.stringify([value.minimumGraphemes, value.maximumGraphemes]);
    case "fragments": return JSON.stringify([lines(value.requiredText), lines(value.excludedText)]);
  }
}
/** Older V2 values prove the explicit choices they contain, never unseen defaults. */
export function initialNamingChatProgress(saved: NamingPreferencesV2 | null): NamingChatProgress {
  const progress: NamingChatProgress = { activeStep: "approaches", confirmed: {} };
  if (!saved) return progress;
  if (saved.approaches.length) progress.confirmed.approaches = answerKey("approaches", saved);
  if (saved.directness) progress.confirmed.directness = answerKey("directness", saved);
  progress.activeStep = namingChatQuestions(saved).find(question => !progress.confirmed[question]) ?? "review";
  return progress;
}
/** An edited value or a newly relevant question must be explicitly confirmed again. */
export function resolveNamingChatProgress(value: NamingPreferencesV2, progress: NamingChatProgress): NamingChatProgress {
  const sequence = namingChatQuestions(value), confirmed: NamingChatProgress["confirmed"] = {};
  for (const question of sequence) if (progress.confirmed[question] === answerKey(question, value)) confirmed[question] = progress.confirmed[question];
  const unfinished = sequence.find(question => !confirmed[question]);
  const activeStep = progress.activeStep !== "review" && sequence.includes(progress.activeStep) ? progress.activeStep : unfinished ?? "review";
  return { activeStep, confirmed };
}
/** Call only after the existing account save has acknowledged the latest values. */
export function confirmNamingChatQuestion(progress: NamingChatProgress, question: NamingQuestion, saved: NamingPreferencesV2): NamingChatProgress {
  const current = resolveNamingChatProgress(saved, progress), sequence = namingChatQuestions(saved);
  if (!sequence.includes(question)) return current;
  const confirmed = { ...current.confirmed, [question]: answerKey(question, saved) };
  return { activeStep: sequence.find(item => !confirmed[item]) ?? "review", confirmed };
}
