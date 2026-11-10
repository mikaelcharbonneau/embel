import { expect, it } from "vitest";
import {
  confirmNamingChatQuestion,
  initialNamingChatProgress,
  namingChatCheckpoint,
  namingChatQuestions,
  resolveNamingChatProgress,
  type NamingChatProgress,
} from "@/components/naming/naming-chat-progress";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { contextSnapshotSchema } from "@/domain/projects";
const saved = {
  ...initialNamingPreferencesV2(contextSnapshotSchema.parse({})),
  approaches: ["invented" as const],
  directness: "suggestive" as const,
};
const completed = () =>
  namingChatQuestions().reduce(
    (progress, question) => confirmNamingChatQuestion(progress, question, saved),
    initialNamingChatProgress(saved),
  );
it("asks three decisions, with length and fragments combined and language inferred", () => {
  expect(namingChatQuestions()).toEqual(["approaches", "directness", "length"]);
  const checkpoint = namingChatCheckpoint(completed(), saved, 7);
  expect(checkpoint.confirmed.length).toBe("[null,null]");
  expect(checkpoint.confirmed.fragments).toBe("[[],[]]");
  expect(initialNamingChatProgress(saved, checkpoint, 7).activeStep).toBe("review");
  expect(initialNamingChatProgress(saved, checkpoint, 8).activeStep).toBe("review");
  expect(initialNamingChatProgress(saved, checkpoint, 6).activeStep).toBe("length");
});
it.each(["sourceLanguages", "heritage", "culture", "language", "fragments"])(
  "resumes retired %s at the next real decision without mutating preferences",
  (retired) => {
    const original = structuredClone(saved);
    const progress = initialNamingChatProgress(saved);
    expect(
      resolveNamingChatProgress(saved, { ...progress, activeStep: retired } as NamingChatProgress).activeStep,
    ).toBe("length");
    expect(saved).toEqual(original);
  },
);
it("reopens the combined answer when either length or text fragments change", () => {
  for (const changed of [
    { ...saved, maximumGraphemes: 12 },
    { ...saved, requiredText: ["new"] },
  ]) {
    const resolved = resolveNamingChatProgress(changed, completed());
    expect(resolved.activeStep).toBe("length");
    expect(resolved.confirmed.length).toBeUndefined();
    const acknowledged = confirmNamingChatQuestion(resolved, "length", changed);
    expect(acknowledged.activeStep).toBe("review");
    expect(initialNamingChatProgress(changed, namingChatCheckpoint(acknowledged, changed, 8), 8).activeStep).toBe(
      "review",
    );
  }
});
it("preserves old checkpoint answers only when both parts of the combined question match", () => {
  const legacy = namingChatCheckpoint(completed(), saved, 7);
  legacy.confirmed.language = '"en"';
  expect(initialNamingChatProgress(saved, legacy, 7).activeStep).toBe("review");
  delete legacy.confirmed.fragments;
  expect(initialNamingChatProgress(saved, legacy, 7).activeStep).toBe("length");
});
it("changing inferred language does not reintroduce a language question", () => {
  const edited = { ...saved, creativeLocale: "fr" };
  expect(resolveNamingChatProgress(edited, completed()).activeStep).toBe("review");
});
