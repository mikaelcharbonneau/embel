import { describe, expect, it } from "vitest";
import {
  cleanGeneratedCandidate,
  cleanGeneratedText,
  startNamingRunRequestSchema,
} from "../../src/domain/naming-generation";
import { filterNamingBrainstormCandidates } from "../../src/domain/naming-brainstorm";

const preferences = {
  version: 2,
  creativeLocale: "en",
  notes: "",
  minimumGraphemes: null,
  maximumGraphemes: null,
  approaches: ["other_languages", "real_words"],
  directness: "open_ended",
  sourceLanguages: [],
  heritageNotes: "",
  culturalNotes: "",
  requiredText: [],
  excludedText: [],
} as never;

describe("cleaning AI-written text", () => {
  it("removes the NUL character that stopped the worker on November 9", () => {
    expect(cleanGeneratedText("Proposed Spanish word br\u0000jula, a compass.")).toBe(
      "Proposed Spanish word brjula, a compass.",
    );
  });
  it("removes other invisible characters and unpaired surrogates, and turns line breaks into spaces", () => {
    expect(cleanGeneratedText("A\u200Bwarm\u202E\uFEFF name\u0007\n\nfor  kitchens\uD800")).toBe(
      "Awarm name for kitchens",
    );
    expect(cleanGeneratedText("Emoji stay whole 🧭")).toBe("Emoji stay whole 🧭");
  });
  it("normalizes to NFC so one spelling is one text", () => {
    expect(cleanGeneratedText("Cafe\u0301")).toBe("Café");
  });
  it("repairs explanations but leaves a damaged name for the name check to drop", () => {
    const repaired = cleanGeneratedCandidate({
      value: "Bru\u0301jula",
      rationale: "Spanish br\u0000jula.",
      primaryApproach: "other_languages",
      construction: ["br\u0000jula"],
    });
    expect(repaired).toEqual({
      value: "Brújula",
      rationale: "Spanish brjula.",
      primaryApproach: "other_languages",
      construction: ["brjula"],
    });
    const damaged = cleanGeneratedCandidate({
      value: "Br\u0000jula",
      rationale: "Fine.",
      primaryApproach: "other_languages",
    });
    expect(
      filterNamingBrainstormCandidates(
        ([repaired, damaged] as Record<string, unknown>[]).map((row) =>
          Object.fromEntries(Object.entries(row).filter(([key]) => key !== "construction")),
        ),
        preferences,
        [],
      ),
    ).toEqual([expect.objectContaining({ value: "Brújula", rationale: "Spanish brjula." })]);
  });
  it("passes non-objects through for later validation", () => {
    expect(cleanGeneratedCandidate("text")).toBe("text");
    expect(cleanGeneratedCandidate(null)).toBeNull();
  });
});

describe("starting a run", () => {
  const base = {
    version: 2,
    expectedProjectRevision: 1,
    expectedPreferencesVersion: 1,
    idempotencyKey: "fixture-key-0000001",
  } as const;
  it("carries seed names or an instruction only on a steered run", () => {
    expect(
      startNamingRunRequestSchema.safeParse({ ...base, kind: "initial", seedIds: [], instruction: null }).success,
    ).toBe(true);
    expect(
      startNamingRunRequestSchema.safeParse({ ...base, kind: "more", seedIds: [], instruction: "Shorter" }).success,
    ).toBe(false);
    expect(
      startNamingRunRequestSchema.safeParse({ ...base, kind: "steer", seedIds: [], instruction: null }).success,
    ).toBe(false);
    expect(
      startNamingRunRequestSchema.safeParse({ ...base, kind: "steer", seedIds: [], instruction: "Shorter" }).success,
    ).toBe(true);
  });
});
