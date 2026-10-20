import { expect, it } from "vitest";
import { confirmNamingChatQuestion, initialNamingChatProgress, namingChatCheckpoint, namingChatQuestions, resolveNamingChatProgress, type NamingChatProgress } from "@/components/naming/naming-chat-progress";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { contextSnapshotSchema } from "@/domain/projects";

it.each(["sourceLanguages", "heritage", "culture"])("resumes a retired %s question at the next real decision without changing saved preferences", retired => {
  const value = { ...initialNamingPreferencesV2(contextSnapshotSchema.parse({ description: "Synthetic saved Naming context" })),
    approaches: ["other_languages", "classical_roots", "people_places", "stories_culture"] as const, directness: "all" as const,
    sourceLanguages: ["French"], heritageNotes: "Synthetic saved place", culturalNotes: "Synthetic saved story" };
  const preferences = { ...value, approaches: [...value.approaches] }, original = structuredClone(preferences);
  const approaches = confirmNamingChatQuestion(initialNamingChatProgress(null), "approaches", preferences);
  const current = confirmNamingChatQuestion(approaches, "directness", preferences);
  const legacy = { ...current, activeStep: retired, confirmed: { ...current.confirmed, [retired]: '"Synthetic earlier answer"' } } as unknown as NamingChatProgress;
  expect(resolveNamingChatProgress(preferences, legacy)).toEqual(current);
  expect(current.activeStep).toBe("language");
  expect(preferences).toEqual(original);
});

it("restores only unchanged explicit answers from a current or older checkpoint", () => {
  const saved = { ...initialNamingPreferencesV2(contextSnapshotSchema.parse({})), approaches: ["invented" as const], directness: "suggestive" as const };
  const completed = namingChatQuestions().reduce((progress, question) => confirmNamingChatQuestion(progress, question, saved), initialNamingChatProgress(saved));
  const checkpoint = namingChatCheckpoint(completed, saved, 7);
  expect(initialNamingChatProgress(saved, checkpoint, 7).activeStep).toBe("review");
  expect(initialNamingChatProgress(saved, checkpoint, 8).activeStep).toBe("review");
  expect(initialNamingChatProgress(saved, checkpoint, 6).activeStep).toBe("language");
  expect(initialNamingChatProgress(saved).activeStep).toBe("language");
  expect(initialNamingChatProgress({ ...saved, creativeLocale: "fr" }, checkpoint, 7).confirmed.language).toBeUndefined();
  expect(initialNamingChatProgress({ ...saved, maximumGraphemes: 12 }, checkpoint, 7).confirmed.length).toBeUndefined();
  expect(initialNamingChatProgress({ ...saved, requiredText: ["new"] }, checkpoint, 7).confirmed.fragments).toBeUndefined();
});

it("rebinds only unchanged confirmations when an edited answer is acknowledged", () => {
  const saved = { ...initialNamingPreferencesV2(contextSnapshotSchema.parse({})), approaches: ["invented" as const], directness: "suggestive" as const };
  const completed = namingChatQuestions().reduce((progress, question) => confirmNamingChatQuestion(progress, question, saved), initialNamingChatProgress(saved));
  const edited = { ...saved, creativeLocale: "fr" };
  const current = resolveNamingChatProgress(edited, completed);
  expect(current.activeStep).toBe("language"); expect(current.confirmed.language).toBeUndefined();
  const confirmed = confirmNamingChatQuestion(current, "language", edited);
  const checkpoint = namingChatCheckpoint(confirmed, edited, 8);
  expect(initialNamingChatProgress(edited, checkpoint, 8).activeStep).toBe("review");
  expect(checkpoint.confirmed.length).toBe("[null,null]"); expect(checkpoint.confirmed.fragments).toBe("[[],[]]");
});
