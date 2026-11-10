import { afterEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { contextSnapshotSchema, missingStrategy } from "@/domain/projects";
import {
  accountProjectDraft,
  createAccountInput,
  draftContext,
  draftPersonality,
  draftPositioning,
  isPersonalityReviewComplete,
  isPositioningReviewComplete,
  personalityReviewKey,
  positioningReviewKey,
  strategyDraftFields,
} from "@/components/workspace/project-draft-adapter";

// User-entered synthetic fixtures, without any AI or provider output.
const now = "2026-10-03T10:00:00Z";
const profile = { sincerity: 50, excitement: 50, competence: 50, sophistication: 50, ruggedness: 50 };
const source = { url: "https://example.com/source", title: "Synthetic reference", retrievedAt: now };
const project = accountProjectSchema.parse({
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  owner_id: "bbbbbbbb-1111-4111-8111-111111111111",
  title: "Strategy fixture",
  scope: "complete_brand",
  current_revision: 2,
  created_at: now,
  context: {
    description: "A neighborhood kitchen serving a short seasonal menu.",
    activity: "Kitchen",
    offering: "Lunch",
    knownAudience: "Local workers",
    reformulationConfirmed: true,
    competitors: [
      {
        id: "cccccccc-1111-4111-8111-111111111111",
        name: "Fixture Lunch",
        relevance: "Similar offer",
        selected: true,
        origin: "research",
        sources: [source],
      },
    ],
    audienceSegments: [
      {
        id: "dddddddd-1111-4111-8111-111111111111",
        label: "Local workers",
        needs: ["A dependable lunch"],
        reason: "They work nearby",
        selected: true,
        origin: "proposal",
        sources: [source],
      },
    ],
    personality: profile,
    positioning: "A dependable daily lunch.",
    competitorReviewComplete: true,
    selectedName: "Fixture Kitchen",
    creativeLocale: "fr-CA",
    intake: { step: "audience", audienceReviewedAt: now },
  },
});

function reviewedProject() {
  return accountProjectSchema.parse({
    ...project,
    context: {
      ...project.context,
      intake: {
        ...project.context.intake,
        step: "positioning",
        personalityReviewedAt: now,
        positioningReviewedAt: now,
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("personality and positioning draft persistence", () => {
  it("reads old snapshots without inventing review approval or a profile", () => {
    const empty = contextSnapshotSchema.parse({});
    expect(empty.personality).toBeNull();
    expect(empty.intake.personalityReviewedAt).toBeNull();
    expect(empty.intake.positioningReviewedAt).toBeNull();
    const draft = accountProjectDraft(project);
    expect(draftPersonality(draft)).toEqual(profile);
    expect(draftPositioning(draft)).toBe(project.context.positioning);
    expect(isPersonalityReviewComplete(draft)).toBe(false);
    expect(isPositioningReviewComplete(draft)).toBe(false);
    expect(draftContext(draft, project.context)).toEqual(project.context);
    expect(missingStrategy(project.context)).toEqual(["personality", "positioning"]);
  });

  it("roundtrips explicit reviews without leaking local comparison keys into account requests", () => {
    const reviewed = reviewedProject();
    const draft = { ...accountProjectDraft(reviewed), preservedContext: reviewed.context };
    expect(isPersonalityReviewComplete(draft)).toBe(true);
    expect(isPositioningReviewComplete(draft)).toBe(true);
    expect(createAccountInput(draft).context).toEqual(reviewed.context);
    expect(JSON.stringify(createAccountInput(draft))).not.toMatch(/personalityReviewKey|positioningReviewKey/);
    expect(strategyDraftFields(reviewed.context)).toMatchObject({
      personality: profile,
      personalityReviewedAt: now,
      positioningReviewedAt: now,
    });
  });

  it("retains legacy browser recovery values and review timestamps only with unchanged source context", () => {
    const reviewed = reviewedProject();
    const draft = { ...accountProjectDraft(reviewed), preservedContext: reviewed.context };
    delete draft.personality;
    delete draft.positioning;
    delete draft.personalityReviewKey;
    delete draft.positioningReviewKey;
    delete draft.personalityReviewedAt;
    delete draft.positioningReviewedAt;
    expect(createAccountInput(draft).context).toEqual(reviewed.context);
    draft.offering = "A revised offering";
    const context = createAccountInput(draft).context;
    expect(context.personality).toEqual(profile);
    expect(context.positioning).toBe(reviewed.context.positioning);
    expect(context.intake.personalityReviewedAt).toBeNull();
    expect(context.intake.positioningReviewedAt).toBeNull();
  });

  it("distinguishes explicitly cleared strategy values from absent legacy fields", () => {
    const reviewed = reviewedProject();
    const draft = {
      ...accountProjectDraft(reviewed),
      preservedContext: reviewed.context,
      personality: null,
      positioning: "",
    };
    expect(draftPersonality(draft)).toBeNull();
    expect(draftPositioning(draft)).toBe("");
    const context = createAccountInput(draft).context;
    expect(context.personality).toBeNull();
    expect(context.positioning).toBe("");
    expect(context.intake.personalityReviewedAt).toBeNull();
    expect(context.intake.positioningReviewedAt).toBeNull();
  });

  it.each(["description", "activity", "offering", "knownAudience"] as const)(
    "invalidates both current reviews after a %s change while retaining values",
    (field) => {
      const reviewed = reviewedProject();
      const draft = accountProjectDraft(reviewed);
      draft[field] += " corrected";
      const context = draftContext(draft, reviewed.context);
      expect(context.intake.personalityReviewedAt).toBeNull();
      expect(context.intake.positioningReviewedAt).toBeNull();
      expect(context.personality).toEqual(profile);
      expect(context.positioning).toBe(reviewed.context.positioning);
      expect(context.selectedName).toBe("Fixture Kitchen");
      expect(context.competitors[0]!.sources).toEqual([source]);
    },
  );

  it("binds selected audience and retained competitor content while ignoring unselected edits", () => {
    const reviewed = reviewedProject();
    const draft = accountProjectDraft(reviewed);
    draft.competitors!.push({
      id: crypto.randomUUID(),
      name: "Unselected competitor",
      relevance: "Another option",
      url: "",
      selected: false,
    });
    draft.segments.push({
      id: crypto.randomUUID(),
      name: "Unselected audience",
      needs: "Other needs",
      reason: "Other reason",
      selected: false,
    });
    expect(isPersonalityReviewComplete(draft)).toBe(true);
    expect(isPositioningReviewComplete(draft)).toBe(true);
    draft.segments[0]!.reason = "A corrected fit";
    expect(isPersonalityReviewComplete(draft)).toBe(false);
    expect(isPositioningReviewComplete(draft)).toBe(false);
  });

  it("invalidates both when the retained competitor set changes", () => {
    const draft = accountProjectDraft(reviewedProject());
    draft.competitors![0]!.selected = false;
    expect(isPersonalityReviewComplete(draft)).toBe(false);
    expect(isPositioningReviewComplete(draft)).toBe(false);
  });

  it("a profile edit requires explicit renewed approval for both strategy steps", () => {
    const reviewed = reviewedProject();
    const draft = accountProjectDraft(reviewed);
    draft.personality = { ...profile, sincerity: 75 };
    expect(isPersonalityReviewComplete(draft)).toBe(false);
    expect(isPositioningReviewComplete(draft)).toBe(false);
    draft.personalityReviewKey = personalityReviewKey(draft);
    draft.personalityReviewedAt = "2026-10-03T11:00:00Z";
    expect(isPersonalityReviewComplete(draft)).toBe(true);
    expect(isPositioningReviewComplete(draft)).toBe(false);
    draft.positioningReviewKey = positioningReviewKey(draft);
    draft.positioningReviewedAt = "2026-10-03T11:01:00Z";
    expect(isPositioningReviewComplete(draft)).toBe(true);
  });

  it("positioning edits preserve personality approval and allow short nonempty statements", () => {
    const draft = accountProjectDraft(reviewedProject());
    draft.positioning = "Local lunch.";
    expect(isPersonalityReviewComplete(draft)).toBe(true);
    expect(isPositioningReviewComplete(draft)).toBe(false);
    draft.positioningReviewKey = positioningReviewKey(draft);
    expect(isPositioningReviewComplete(draft)).toBe(true);
  });

  it("never treats a key alone as explicit approval and requires current personality approval before positioning", () => {
    const draft = accountProjectDraft(project);
    draft.personalityReviewKey = personalityReviewKey(draft);
    draft.positioningReviewKey = positioningReviewKey(draft);
    expect(isPersonalityReviewComplete(draft)).toBe(false);
    draft.positioningReviewedAt = now;
    expect(isPositioningReviewComplete(draft)).toBe(false);
    draft.personalityReviewedAt = now;
    expect(isPositioningReviewComplete(draft)).toBe(true);
    draft.personalityReviewKey = null;
    expect(isPositioningReviewComplete(draft)).toBe(false);
  });

  it("rejects false server approval claims without changing editable unreviewed defaults", () => {
    expect(contextSnapshotSchema.safeParse({ intake: { personalityReviewedAt: now } }).success).toBe(false);
    expect(
      contextSnapshotSchema.safeParse({
        personality: profile,
        positioning: " ",
        intake: { personalityReviewedAt: now, positioningReviewedAt: now },
      }).success,
    ).toBe(false);
    expect(
      contextSnapshotSchema.safeParse({
        personality: profile,
        positioning: "Local lunch.",
        intake: { positioningReviewedAt: now },
      }).success,
    ).toBe(false);
    expect(contextSnapshotSchema.safeParse({ personality: { ...profile, sincerity: 101 } }).success).toBe(false);
  });

  it("persists worst-case escaped exact keys without per-field errors and keeps an oversized workspace in memory", async () => {
    const draft = accountProjectDraft(reviewedProject());
    draft.segments = Array.from({ length: 30 }, () => ({
      id: crypto.randomUUID(),
      name: "Name",
      needs: "\u0001".repeat(24_000),
      reason: "\u0001".repeat(2_000),
      selected: true,
    }));
    draft.personalityReviewKey = personalityReviewKey(draft);
    draft.positioningReviewKey = positioningReviewKey(draft);
    expect(draft.personalityReviewKey.length).toBeGreaterThan(1_500_000);
    expect(draft.positioningReviewKey.length).toBeLessThan(8_000_000);
    const original = JSON.stringify({ version: 1, drafts: [] });
    let stored = original;
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => stored,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
    });
    const { copyToLocalDraft } = await import("@/components/workspace/local-drafts");
    const copied = copyToLocalDraft(draft);
    expect(copied).toMatchObject({ persisted: false });
    expect(stored).toBe(original);
  });
});
