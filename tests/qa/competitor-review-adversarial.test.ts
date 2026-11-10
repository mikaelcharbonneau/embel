import { describe, expect, it } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { competitorSchema, contextSnapshotSchema } from "@/domain/projects";
import {
  accountProjectDraft,
  competitorReviewKey,
  competitorReviewValidationMessage,
  createAccountInput,
  draftCompetitors,
  draftContext,
  isCompetitorReviewComplete,
} from "@/components/workspace/project-draft-adapter";

// Independent synthetic fixtures. No provider, identity, storage or network calls.
const now = "2026-10-03T03:00:00Z";
const source = { url: "https://example.com/qa-source", title: "Synthetic source fixture", retrievedAt: now };
const project = accountProjectSchema.parse({
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  owner_id: "bbbbbbbb-1111-4111-8111-111111111111",
  scope: "complete_brand",
  title: "Independent competitor fixture",
  current_revision: 7,
  created_at: now,
  context: {
    description: "An independent local fixture for a neighborhood kitchen serving weekday lunches.",
    activity: "Neighborhood kitchen",
    offering: "Seasonal weekday lunches",
    knownAudience: "Nearby workers",
    reformulationConfirmed: true,
    audienceSegments: [
      {
        id: "cccccccc-1111-4111-8111-111111111111",
        label: "Nearby workers",
        needs: ["A predictable lunch break"],
        reason: "They work nearby",
        selected: true,
        origin: "proposal",
        sources: [source],
      },
    ],
    competitors: [
      {
        id: "dddddddd-1111-4111-8111-111111111111",
        name: "Fixture Lunch",
        relevance: "Similar lunch format",
        url: "https://example.com/fixture-lunch",
        selected: true,
        origin: "research",
        sources: [source],
      },
      {
        id: "eeeeeeee-1111-4111-8111-111111111111",
        name: "Fixture Pantry",
        relevance: "Another customer alternative",
        selected: false,
        origin: "user",
        sources: [],
      },
    ],
    competitorReviewComplete: true,
    positioning: "A calm, reliable fixture",
    selectedName: "Fixture Table",
    creativeLocale: "fr-CA",
    personality: { sincerity: 70, excitement: 20, competence: 80, sophistication: 10, ruggedness: 0 },
    intake: {
      step: "audience",
      audienceReviewedAt: now,
      suppliedName: "Fixture Table",
      namingNotes: "Keep the current notes",
      identityNotes: "Retain the visual system",
    },
  },
});

function reviewedDraft() {
  const draft = accountProjectDraft(structuredClone(project));
  draft.competitorReviewKey = competitorReviewKey(draft);
  return draft;
}

describe("independent competitor review invariants", () => {
  it("roundtrips retained and unretained competitors without rewriting research or downstream context", () => {
    const before = structuredClone(project);
    const draft = reviewedDraft();
    expect(isCompetitorReviewComplete(draft)).toBe(true);
    expect(draftContext(draft, project.context)).toEqual(project.context);
    expect(project).toEqual(before);
  });

  it("keeps saved competitors when an earlier browser copy has no new competitor fields", () => {
    const draft = { ...reviewedDraft(), preservedContext: project.context };
    delete draft.competitors;
    delete draft.competitorReviewKey;
    expect(draftCompetitors(draft)).toHaveLength(2);
    const saved = createAccountInput(draft);
    expect(saved.context.competitors).toEqual(project.context.competitors);
    expect(saved.context.competitorReviewComplete).toBe(true);
    expect(saved.context.personality).toEqual(project.context.personality);
    expect(saved.context.positioning).toBe(project.context.positioning);
  });

  it("distinguishes deliberate removal of every competitor from legacy absence", () => {
    const draft = { ...reviewedDraft(), competitors: [], preservedContext: project.context };
    expect(draftCompetitors(draft)).toEqual([]);
    const saved = createAccountInput(draft);
    expect(saved.context.competitors).toEqual([]);
    expect(saved.context.competitorReviewComplete).toBe(false);
    expect(saved.context.selectedName).toBe(project.context.selectedName);
  });

  it("an explicit invalidation cannot inherit completion from the preserved account snapshot", () => {
    const draft = { ...reviewedDraft(), preservedContext: project.context, competitorReviewKey: null };
    expect(isCompetitorReviewComplete(draft)).toBe(false);
    expect(createAccountInput(draft).context.competitorReviewComplete).toBe(false);
  });

  it("a legacy browser copy cannot reuse its account review after changing the brief", () => {
    const draft = { ...reviewedDraft(), preservedContext: project.context };
    delete draft.competitorReviewKey;
    draft.offering = "A changed offer entered by the user";
    expect(isCompetitorReviewComplete(draft)).toBe(false);
    expect(createAccountInput(draft).context.competitorReviewComplete).toBe(false);
  });

  it("preserves historical research evidence but marks edited claims as supplied by the user", () => {
    const draft = reviewedDraft();
    draft.competitors![0]!.name = "My corrected fixture";
    draft.competitors![0]!.relevance = "My revised assessment";
    draft.competitors![0]!.url = "";
    const saved = draftContext(draft, project.context);
    expect(saved.competitors[0]).toEqual({
      id: project.context.competitors[0]!.id,
      name: "My corrected fixture",
      relevance: "My revised assessment",
      selected: true,
      origin: "user",
      sources: [source],
    });
    expect(saved.competitorReviewComplete).toBe(false);
    expect(project.context.competitors[0]!.url).toBe("https://example.com/fixture-lunch");
  });

  it("selection changes invalidate review without erasing research provenance", () => {
    const draft = reviewedDraft();
    draft.competitors![0]!.selected = false;
    const saved = draftContext(draft, project.context);
    expect(saved.competitors[0]).toEqual({ ...project.context.competitors[0], selected: false });
    expect(saved.competitorReviewComplete).toBe(false);
  });

  for (const field of ["description", "activity", "offering", "knownAudience"] as const) {
    it(`invalidates completion after a ${field} change even outside the editor event handlers`, () => {
      const draft = reviewedDraft();
      draft[field] += " — corrected";
      expect(isCompetitorReviewComplete(draft)).toBe(false);
      expect(draftContext(draft, project.context).competitorReviewComplete).toBe(false);
      expect(draftContext(draft, project.context).competitors).toEqual(project.context.competitors);
    });
  }

  it("keeps the completed competitor review when downstream audience targets change", () => {
    const draft = reviewedDraft();
    draft.segments[0]!.selected = false;
    const context = draftContext(draft, project.context);
    expect(isCompetitorReviewComplete(draft)).toBe(true);
    expect(context.competitorReviewComplete).toBe(true);
    expect(context.personality).toEqual(project.context.personality);
    expect(context.positioning).toBe(project.context.positioning);
    expect(context.selectedName).toBe(project.context.selectedName);
    expect(context.audienceSegments[0]!.sources).toEqual([source]);
  });

  it("does not invalidate review for a title, stage or project scope change", () => {
    const draft = reviewedDraft();
    draft.title = "New project label";
    draft.stage = "description";
    draft.scope = "complete_brand";
    expect(isCompetitorReviewComplete(draft)).toBe(true);
    expect(draftContext(draft, project.context).competitorReviewComplete).toBe(true);
  });

  it("a supplied URL never fabricates a research source or a retrieved timestamp", () => {
    const draft = reviewedDraft();
    draft.competitors!.push({
      id: "ffffffff-1111-4111-8111-111111111111",
      name: "My supplied competitor",
      relevance: "Similar customers",
      url: "https://example.org/supplied",
      selected: true,
    });
    const value = draftContext(draft, project.context).competitors.at(-1)!;
    expect(value).toMatchObject({ origin: "user", sources: [], url: "https://example.org/supplied" });
    expect(value).not.toHaveProperty("retrievedAt");
  });

  it("does not send the local review comparison key in the server snapshot", () => {
    const draft = { ...reviewedDraft(), preservedContext: project.context };
    const body = createAccountInput(draft);
    expect(body.context.competitorReviewComplete).toBe(true);
    expect(JSON.stringify(body)).not.toContain("competitorReviewKey");
    expect(contextSnapshotSchema.safeParse(body.context).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(32_768);
  });

  it("retains realistic long, accented competitor input without adding duplicate payload state", () => {
    const draft = { ...reviewedDraft(), preservedContext: project.context };
    draft.competitors = Array.from({ length: 10 }, (_, index) => ({
      id: `12345678-1234-4234-8234-${String(index).padStart(12, "0")}`,
      name: `École ${index} — synthetic competitor`,
      relevance: "Contextual relevance. ".repeat(40),
      url: "",
      selected: index < 3,
    }));
    draft.competitorReviewKey = competitorReviewKey(draft);
    const body = createAccountInput(draft);
    expect(body.context.competitors).toHaveLength(10);
    expect(body.context.competitorReviewComplete).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(32_768);
  });

  it("rejects repeated competitor IDs at the shared snapshot boundary", () => {
    expect(
      contextSnapshotSchema.safeParse({
        ...project.context,
        competitors: [project.context.competitors[0], project.context.competitors[0]],
      }).success,
    ).toBe(false);
  });

  it("cannot promote a sourceless competitor into a research result", () => {
    expect(competitorSchema.safeParse({ ...project.context.competitors[0], sources: [] }).success).toBe(false);
  });

  for (const url of [
    "javascript:alert(1)",
    "data:text/html,fixture",
    "file:///tmp/fixture",
    "//example.com/fixture",
    "https://user:password@example.com/",
    "https://example.com/\nfixture",
  ]) {
    it(`rejects unsafe supplied link ${JSON.stringify(url)}`, () => {
      const draft = reviewedDraft();
      draft.competitors![0]!.url = url;
      expect(competitorReviewValidationMessage(draft)).toBeTruthy();
      expect(() => draftContext(draft, project.context)).toThrow();
    });
  }

  it("requires relevance before confirming a retained competitor", () => {
    const draft = reviewedDraft();
    draft.competitors![0]!.relevance = "   ";
    expect(competitorReviewValidationMessage(draft)).toBeTruthy();
    expect(isCompetitorReviewComplete(draft)).toBe(false);
  });
});
