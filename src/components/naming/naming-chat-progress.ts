import type { NamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { namingChatCheckpointSchema, type NamingChatCheckpoint } from "@/domain/naming-chat-checkpoint";

export type NamingQuestion = "approaches" | "directness" | "language" | "length" | "fragments";
export type NamingChatStep = NamingQuestion | "review";
/** Owner-bound UI progress. Durable checkpoints acknowledge exact saved preferences. */
export type NamingChatProgress = { activeStep: NamingChatStep; confirmed: Partial<Record<NamingQuestion, string>> };

export function namingChatQuestions(): NamingQuestion[] {
  return ["approaches", "directness", "length"];
}
const lines = (values: string[]) => values.map((value) => value.trim()).filter(Boolean);
function answerKey(question: NamingQuestion, value: NamingPreferencesV2): string {
  switch (question) {
    case "approaches":
      return JSON.stringify([...value.approaches].sort());
    case "directness":
      return JSON.stringify(value.directness);
    case "language":
      return JSON.stringify(value.creativeLocale.trim());
    case "length":
      return JSON.stringify([value.minimumGraphemes, value.maximumGraphemes]);
    case "fragments":
      return JSON.stringify([lines(value.requiredText), lines(value.excludedText)]);
  }
}
/** Older V2 values prove choices, never unseen defaults. A checkpoint proves only
 * unchanged explicit answers, even when unrelated guidance creates a revision. */
export function initialNamingChatProgress(
  saved: NamingPreferencesV2 | null,
  checkpoint?: NamingChatCheckpoint,
  savedVersion?: number,
): NamingChatProgress {
  const progress: NamingChatProgress = { activeStep: "approaches", confirmed: {} };
  if (!saved) return progress;
  if (saved.approaches.length) progress.confirmed.approaches = answerKey("approaches", saved);
  if (saved.directness) progress.confirmed.directness = answerKey("directness", saved);
  if (checkpoint && savedVersion !== undefined && checkpoint.preferencesVersion <= savedVersion) {
    for (const question of [...namingChatQuestions(), "fragments"] as NamingQuestion[]) {
      if (checkpoint.confirmed[question] === answerKey(question, saved))
        progress.confirmed[question] = checkpoint.confirmed[question];
    }
  }
  if (!progress.confirmed.fragments) delete progress.confirmed.length;
  progress.activeStep = namingChatQuestions().find((question) => !progress.confirmed[question]) ?? "review";
  return progress;
}

/** Build only after a preference save ACK; the view write must also ACK before advancing. */
export function namingChatCheckpoint(
  progress: NamingChatProgress,
  saved: NamingPreferencesV2,
  savedVersion: number,
): NamingChatCheckpoint {
  return namingChatCheckpointSchema.parse({
    version: 1,
    preferencesVersion: savedVersion,
    confirmed: resolveNamingChatProgress(saved, progress).confirmed,
  });
}
/** Edited answers need confirmation again; retired questions cannot block progress. */
export function resolveNamingChatProgress(
  value: NamingPreferencesV2,
  progress: NamingChatProgress,
): NamingChatProgress {
  const sequence = namingChatQuestions(),
    confirmed: NamingChatProgress["confirmed"] = {};
  for (const question of [...sequence, "fragments"] as NamingQuestion[])
    if (progress.confirmed[question] === answerKey(question, value)) confirmed[question] = progress.confirmed[question];
  // Length and fragments are one answer now, but keep both legacy checkpoint
  // keys so old saved answers migrate only when both values are unchanged.
  if (!confirmed.fragments) delete confirmed.length;
  const unfinished = sequence.find((question) => !confirmed[question]);
  const activeStep =
    progress.activeStep !== "review" && sequence.includes(progress.activeStep)
      ? progress.activeStep
      : (unfinished ?? "review");
  return { activeStep, confirmed };
}
/** Call only after the existing account save has acknowledged the latest values. */
export function confirmNamingChatQuestion(
  progress: NamingChatProgress,
  question: NamingQuestion,
  saved: NamingPreferencesV2,
): NamingChatProgress {
  const current = resolveNamingChatProgress(saved, progress),
    sequence = namingChatQuestions();
  if (!sequence.includes(question)) return current;
  const confirmed = {
    ...current.confirmed,
    [question]: answerKey(question, saved),
    ...(question === "length" ? { fragments: answerKey("fragments", saved) } : {}),
  };
  return { activeStep: sequence.find((item) => !confirmed[item]) ?? "review", confirmed };
}
