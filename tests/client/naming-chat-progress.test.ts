import { expect, it } from "vitest";
import { confirmNamingChatQuestion, initialNamingChatProgress, resolveNamingChatProgress, type NamingChatProgress } from "@/components/naming/naming-chat-progress";
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
