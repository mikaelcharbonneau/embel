import { describe, expect, it } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { contextSnapshotSchema, missingStrategy, personalitySchema } from "@/domain/projects";
import { namingSourceSchema } from "@/domain/naming";
import { brandDraftFromName } from "@/components/workspace/name-promotion";
import {
  accountProjectDraft, createAccountInput, draftContext, draftPersonality, draftPositioning,
  isCompetitorReviewComplete, isPersonalityReviewComplete, isPositioningReviewComplete,
  personalityReviewKey, positioningReviewKey,
  personalityReviewValidationMessage, positioningReviewValidationMessage,
} from "@/components/workspace/project-draft-adapter";

// Independent synthetic data only. No provider inference, remote identities or storage.
const now = "2026-10-03T03:00:00Z";
const profile = { sincerity: 0, excitement: 35, competence: 100, sophistication: 65, ruggedness: 20 };
const citation = { url: "https://example.com/strategy-fixture", title: "Synthetic preserved research", retrievedAt: now };
const nameSource = namingSourceSchema.parse({
  id: "99999999-9999-4999-8999-999999999999", value: "Luma", origin: "workshop", createdAt: now,
  history: [{ id: "88888888-8888-4888-8888-888888888888", createdAt: now, input: { kind: "affixes", seed: "Lum", prefixes: [], suffixes: ["a"], separator: "" }, output: "Luma" }],
});
const project = accountProjectSchema.parse({
  id: "aaaaaaaa-1111-4111-8111-111111111111", owner_id: "bbbbbbbb-1111-4111-8111-111111111111",
  title: "Strategy QA fixture", scope: "complete_brand", current_revision: 4, created_at: now,
  context: {
    description: "A fixture lighting studio making repairable lamps for small homes.", activity: "Lighting studio", offering: "Repairable lamps", knownAudience: "Small-home residents", reformulationConfirmed: true,
    competitors: [
      { id: "cccccccc-1111-4111-8111-111111111111", name: "Retained fixture", relevance: "Similar lighting need", selected: true, origin: "research", sources: [citation] },
      { id: "dddddddd-1111-4111-8111-111111111111", name: "Unretained fixture", relevance: "Other category", selected: false, origin: "user", sources: [] },
    ], competitorReviewComplete: true,
    audienceSegments: [
      { id: "eeeeeeee-1111-4111-8111-111111111111", label: "Small-home residents", needs: ["Warm light", "Easy repair"], reason: "Limited space", selected: true, origin: "proposal", sources: [citation] },
      { id: "ffffffff-1111-4111-8111-111111111111", label: "Unselected fixture", needs: ["Different lighting"], reason: "A later option", selected: false, origin: "user", sources: [] },
    ],
    personality: profile, positioning: "Repairable lighting that makes small homes easier to live in.",
    selectedName: "Luma", namingSource: nameSource, creativeLocale: "fr-CA",
    intake: { step: "positioning", suppliedName: "Luma", namingNotes: "Preserve naming notes", identityNotes: "Preserve identity notes", audienceReviewedAt: now, personalityReviewedAt: now, positioningReviewedAt: now },
  },
});

function reviewedDraft() { return accountProjectDraft(structuredClone(project)); }
function confirmPersonality(draft: ReturnType<typeof reviewedDraft>) {
  draft.personalityReviewedAt = now;
  draft.personalityReviewKey = personalityReviewKey(draft);
}
function confirmPositioning(draft: ReturnType<typeof reviewedDraft>) {
  draft.positioningReviewedAt = now;
  draft.positioningReviewKey = positioningReviewKey(draft);
}

describe("independent strategy contract attacks", () => {
  it("keeps unknown personality nullable and does not manufacture a starting profile or approvals", () => {
    const context = contextSnapshotSchema.parse({});
    expect(context.personality).toBeNull();
    expect(context.positioning).toBe("");
    expect(context.intake.personalityReviewedAt).toBeNull();
    expect(context.intake.positioningReviewedAt).toBeNull();
  });

  it("accepts all five integer boundary values, including zero", () => {
    expect(personalitySchema.parse(profile)).toEqual(profile);
    expect(personalitySchema.parse(Object.fromEntries(Object.keys(profile).map((dimension) => [dimension, 0])))).toEqual({ sincerity: 0, excitement: 0, competence: 0, sophistication: 0, ruggedness: 0 });
    expect(personalitySchema.safeParse(Object.fromEntries(Object.keys(profile).map((dimension) => [dimension, 100]))).success).toBe(true);
  });

  for (const value of [-1, 101, 0.5, NaN, Infinity, null, "50", true]) {
    it(`rejects malformed dimension ${String(value)} without coercion`, () => {
      expect(personalitySchema.safeParse({ ...profile, sincerity: value }).success).toBe(false);
      expect(contextSnapshotSchema.safeParse({ personality: { ...profile, sincerity: value } }).success).toBe(false);
    });
  }

  it("requires exactly the five defined personality dimensions", () => {
    for (const dimension of Object.keys(profile)) {
      const partial: Record<string, number> = { ...profile };
      delete partial[dimension];
      expect(personalitySchema.safeParse(partial).success).toBe(false);
    }
    expect(personalitySchema.safeParse({ ...profile, luxury: 90 }).success).toBe(false);
  });

  it("rejects positioning over the supported length and does not require invented minimum prose", () => {
    expect(contextSnapshotSchema.safeParse({ positioning: "x".repeat(5_001) }).success).toBe(false);
    const draft = reviewedDraft();
    draft.positioning = "X";
    expect(positioningReviewValidationMessage(draft)).toBeNull();
    draft.positioning = " \n\t ";
    expect(positioningReviewValidationMessage(draft)).toBeTruthy();
  });
});

describe("independent review bindings and preserved strategy", () => {
  it("roundtrips reviewed strategy, source provenance, names and unrelated context immutably", () => {
    const before = structuredClone(project);
    const draft = reviewedDraft();
    expect(isPersonalityReviewComplete(draft)).toBe(true);
    expect(isPositioningReviewComplete(draft)).toBe(true);
    expect(draftContext(draft, project.context)).toEqual(project.context);
    expect(project).toEqual(before);
  });

  it("legacy values remain editable but are never automatically marked reviewed", () => {
    const legacy = { ...project.context, intake: { ...project.context.intake } };
    const input = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown> & { intake: Record<string, unknown> };
    delete input.intake.personalityReviewedAt;
    delete input.intake.positioningReviewedAt;
    const context = contextSnapshotSchema.parse(input);
    const draft = accountProjectDraft({ ...project, context });
    expect(draftPersonality(draft)).toEqual(profile);
    expect(draftPositioning(draft)).toBe(project.context.positioning);
    expect(isPersonalityReviewComplete(draft)).toBe(false);
    expect(isPositioningReviewComplete(draft)).toBe(false);
    expect(missingStrategy(context)).toEqual(expect.arrayContaining(["personality", "positioning"]));
    expect(draftContext(draft, context).intake).toMatchObject({ personalityReviewedAt: null, positioningReviewedAt: null });
  });

  it("a manually initialized valid profile is still unreviewed until the explicit action", () => {
    const draft = reviewedDraft();
    draft.personality = { sincerity: 50, excitement: 50, competence: 50, sophistication: 50, ruggedness: 50 };
    draft.personalityReviewedAt = null;
    draft.personalityReviewKey = null;
    expect(personalityReviewValidationMessage(draft)).toBeNull();
    expect(isPersonalityReviewComplete(draft)).toBe(false);
    expect(isPositioningReviewComplete(draft)).toBe(false);
    confirmPersonality(draft);
    expect(isPersonalityReviewComplete(draft)).toBe(true);
    expect(isPositioningReviewComplete(draft)).toBe(false);
  });

  it("explicit null and empty values clear old data rather than restoring a preserved snapshot", () => {
    const draft = { ...reviewedDraft(), preservedContext: project.context, personality: null, positioning: "", personalityReviewedAt: null, personalityReviewKey: null, positioningReviewedAt: null, positioningReviewKey: null };
    const input = createAccountInput(draft);
    expect(input.context.personality).toBeNull();
    expect(input.context.positioning).toBe("");
    expect(input.context.namingSource).toEqual(nameSource);
    expect(input.context.selectedName).toBe("Luma");
  });

  it("older recovery drafts without new editor fields retain existing strategy and explicit saved approvals", () => {
    const draft = { ...reviewedDraft(), preservedContext: project.context };
    delete draft.personality;
    delete draft.positioning;
    delete draft.personalityReviewedAt;
    delete draft.positioningReviewedAt;
    delete draft.personalityReviewKey;
    delete draft.positioningReviewKey;
    expect(createAccountInput(draft).context).toEqual(project.context);
  });

  for (const field of ["description", "activity", "offering", "knownAudience"] as const) {
    it(`a changed ${field} makes strategy reviews stale without removing their content`, () => {
      const draft = reviewedDraft();
      draft[field] += " — revised";
      expect(isPersonalityReviewComplete(draft)).toBe(false);
      expect(isPositioningReviewComplete(draft)).toBe(false);
      const context = draftContext(draft, project.context);
      expect(context.personality).toEqual(profile);
      expect(context.positioning).toBe(project.context.positioning);
      expect(context.intake).toMatchObject({ personalityReviewedAt: null, positioningReviewedAt: null });
    });
  }

  it("retained competitor corrections invalidate both later reviews while preserving evidence", () => {
    const draft = reviewedDraft();
    draft.competitors![0]!.relevance += " with revised notes";
    const context = draftContext(draft, project.context);
    expect(isPersonalityReviewComplete(draft)).toBe(false);
    expect(isPositioningReviewComplete(draft)).toBe(false);
    expect(context.competitors[0]?.sources).toEqual([citation]);
    expect(context.personality).toEqual(profile);
    expect(context.positioning).toBe(project.context.positioning);
  });

  it("selected audience corrections invalidate strategy while retaining their provenance and competitor review", () => {
    const draft = reviewedDraft();
    draft.segments[0]!.needs = "A corrected need";
    expect(isCompetitorReviewComplete(draft)).toBe(true);
    expect(isPersonalityReviewComplete(draft)).toBe(false);
    expect(isPositioningReviewComplete(draft)).toBe(false);
    expect(draftContext(draft, project.context).audienceSegments[0]?.sources).toEqual([citation]);
  });

  it("unselected audience and unretained competitor corrections do not change reviewed strategy", () => {
    const draft = reviewedDraft();
    draft.segments[1]!.name += " revised";
    draft.segments[1]!.needs = "An exploratory need";
    draft.competitors![1]!.name += " revised";
    draft.competitors![1]!.relevance = "An exploratory alternative";
    expect(isPersonalityReviewComplete(draft)).toBe(true);
    expect(isPositioningReviewComplete(draft)).toBe(true);
    expect(draftContext(draft, project.context).intake).toMatchObject({ personalityReviewedAt: now, positioningReviewedAt: now });
  });

  it("adding an explored audience or competitor to the selected context invalidates strategy", () => {
    for (const selected of ["audience", "competitor"] as const) {
      const draft = reviewedDraft();
      if (selected === "audience") draft.segments[1]!.selected = true;
      else draft.competitors![1]!.selected = true;
      expect(isPersonalityReviewComplete(draft)).toBe(false);
      expect(isPositioningReviewComplete(draft)).toBe(false);
    }
  });

  it("positioning edits invalidate only positioning; personality edits keep the positioning text", () => {
    const draft = reviewedDraft();
    draft.positioning = "My new statement";
    expect(isPersonalityReviewComplete(draft)).toBe(true);
    expect(isPositioningReviewComplete(draft)).toBe(false);
    confirmPositioning(draft);
    expect(isPositioningReviewComplete(draft)).toBe(true);
    draft.personality = { ...profile, excitement: 36 };
    expect(isPersonalityReviewComplete(draft)).toBe(false);
    expect(isPositioningReviewComplete(draft)).toBe(false);
    expect(draftContext(draft, project.context).positioning).toBe("My new statement");
  });

  it("cannot mark positioning current merely by matching its key when personality is not reviewed", () => {
    const draft = reviewedDraft();
    draft.personalityReviewedAt = null;
    draft.personalityReviewKey = null;
    confirmPositioning(draft);
    expect(positioningReviewValidationMessage(draft)).toBeTruthy();
    expect(isPositioningReviewComplete(draft)).toBe(false);
    expect(draftContext(draft, project.context).intake.positioningReviewedAt).toBeNull();
  });

  it("title, scope and navigation edits do not revoke either strategy review", () => {
    const draft = reviewedDraft();
    draft.title = "Renamed fixture";
    draft.scope = "complete_brand";
    draft.stage = "description";
    expect(isPersonalityReviewComplete(draft)).toBe(true);
    expect(isPositioningReviewComplete(draft)).toBe(true);
  });

  it("maximum supported positioning remains a draft without leaking local review keys into API input", () => {
    const draft = { ...reviewedDraft(), preservedContext: project.context };
    draft.positioning = "é".repeat(5_000);
    confirmPositioning(draft);
    const input = createAccountInput(draft);
    expect(input.context.positioning).toHaveLength(5_000);
    expect(input.context.intake.positioningReviewedAt).toBe(now);
    expect(JSON.stringify(input)).not.toMatch(/(?:personality|positioning|competitor)ReviewKey/);
    expect(new TextEncoder().encode(JSON.stringify(input)).length).toBeLessThan(32_768);
  });

  it("promoting a standalone name retains strategy, original name provenance and review status", () => {
    const draft = brandDraftFromName(nameSource, project.context, "77777777-7777-4777-8777-777777777777", now);
    const input = createAccountInput(draft);
    expect(input.scope).toBe("complete_brand");
    expect(input.context.personality).toEqual(profile);
    expect(input.context.positioning).toBe(project.context.positioning);
    expect(input.context.namingSource).toEqual(nameSource);
    expect(isPersonalityReviewComplete(draft)).toBe(true);
    expect(isPositioningReviewComplete(draft)).toBe(true);
  });
});
