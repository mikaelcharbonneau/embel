import { afterEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { contextSnapshotSchema } from "@/domain/projects";
import {
  accountProjectDraft,
  competitorReviewKey,
  competitorReviewValidationMessage,
  createAccountInput,
  draftCompetitors,
  draftContext,
  isCompetitorReviewComplete,
} from "@/components/workspace/project-draft-adapter";

// Synthetic fixtures only: the URL is never fetched and no research is performed.
const source = { url: "https://example.com/source", title: "Synthetic source", retrievedAt: "2026-10-02T10:00:00Z" };
const competitor = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  name: "Fixture kitchen",
  relevance: "Serves the same neighborhood",
  url: "https://example.com/kitchen",
  origin: "research" as const,
  selected: true,
  sources: [source],
};
const project = accountProjectSchema.parse({
  id: "bbbbbbbb-1111-4111-8111-111111111111",
  owner_id: "cccccccc-1111-4111-8111-111111111111",
  title: "Synthetic kitchen",
  scope: "complete_brand",
  current_revision: 2,
  created_at: "2026-10-02T10:00:00Z",
  context: {
    description: "A local kitchen with a changing seasonal menu.",
    activity: "Kitchen",
    offering: "Lunch",
    knownAudience: "Neighbors",
    reformulationConfirmed: true,
    competitors: [competitor],
    competitorReviewComplete: true,
    positioning: "A preserved positioning",
    intake: { step: "review" },
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("competitor draft persistence", () => {
  it("supports the competitor edit position without changing default old snapshots", () => {
    expect(contextSnapshotSchema.parse({}).intake.step).toBe("review");
    expect(contextSnapshotSchema.parse({ intake: { step: "competitors" } }).intake.step).toBe("competitors");
  });

  it("roundtrips researched competitors and their review without adding browser keys to account payloads", () => {
    const draft = accountProjectDraft(project);
    expect(draftCompetitors(draft)).toEqual([
      {
        id: competitor.id,
        name: competitor.name,
        relevance: competitor.relevance,
        url: competitor.url,
        selected: true,
      },
    ]);
    expect(isCompetitorReviewComplete(draft)).toBe(true);
    expect(draftContext(draft, project.context)).toEqual(project.context);
    expect(JSON.stringify(draftContext(draft, project.context))).not.toContain("competitorReviewKey");
  });

  it("retains sources on manual content edits while ending the research-origin claim", () => {
    const draft = accountProjectDraft(project);
    draft.competitors![0]!.relevance = "My corrected reason";
    const context = draftContext(draft, project.context);
    expect(context.competitors[0]).toEqual({ ...competitor, relevance: "My corrected reason", origin: "user" });
    expect(context.competitorReviewComplete).toBe(false);
    expect(context.positioning).toBe(project.context.positioning);
  });

  it("preserves research provenance when only retention changes", () => {
    const draft = accountProjectDraft(project);
    draft.competitors![0]!.selected = false;
    expect(draftContext(draft, project.context).competitors[0]).toEqual({ ...competitor, selected: false });
    expect(isCompetitorReviewComplete(draft)).toBe(false);
  });

  it("clears an optional URL instead of reintroducing the saved URL", () => {
    const draft = accountProjectDraft(project);
    draft.competitors![0]!.url = "";
    expect(draftContext(draft, project.context).competitors[0]).not.toHaveProperty("url");
  });

  it("preserves old browser recovery copies but distinguishes an explicitly empty list and cleared review", () => {
    const draft = { ...accountProjectDraft(project), preservedContext: project.context };
    delete draft.competitors;
    delete draft.competitorReviewKey;
    expect(createAccountInput(draft).context).toEqual(project.context);
    expect(draftCompetitors(draft)).toHaveLength(1);
    draft.competitors = [];
    expect(createAccountInput(draft).context.competitors).toEqual([]);
    expect(isCompetitorReviewComplete(draft)).toBe(false);
    draft.competitorReviewKey = competitorReviewKey(draft);
    expect(isCompetitorReviewComplete(draft)).toBe(true);
    draft.competitorReviewKey = null;
    expect(isCompetitorReviewComplete(draft)).toBe(false);
  });

  it.each(["description", "activity", "offering", "knownAudience"] as const)(
    "requires a fresh review after a changed %s",
    (key) => {
      const draft = accountProjectDraft(project);
      draft[key] += " changed";
      expect(isCompetitorReviewComplete(draft)).toBe(false);
      draft.competitorReviewKey = competitorReviewKey(draft);
      expect(isCompetitorReviewComplete(draft)).toBe(true);
      expect(draftContext(draft, project.context).competitorReviewComplete).toBe(true);
    },
  );

  it("keeps completed competitor review while editing downstream audiences or the project label", () => {
    const draft = accountProjectDraft(project);
    draft.title = "Another label";
    draft.segments = [{ id: crypto.randomUUID(), name: "Neighbors", needs: "Lunch", reason: "Nearby", selected: true }];
    expect(isCompetitorReviewComplete(draft)).toBe(true);
  });

  it("rejects completing a selected competitor without relevance at the shared context boundary", () => {
    const draft = accountProjectDraft(project);
    draft.competitors![0]!.relevance = "  ";
    expect(competitorReviewValidationMessage(draft)).toBeTruthy();
    draft.competitorReviewKey = competitorReviewKey(draft);
    expect(isCompetitorReviewComplete(draft)).toBe(false);
    expect(
      contextSnapshotSchema.safeParse({ ...project.context, competitors: [{ ...competitor, relevance: "" }] }).success,
    ).toBe(false);
    expect(
      contextSnapshotSchema.safeParse({
        ...project.context,
        competitorReviewComplete: false,
        competitors: [{ ...competitor, relevance: "" }],
      }).success,
    ).toBe(true);
  });

  it("allows incomplete browser entries without silently dropping them at the account boundary", () => {
    const draft = accountProjectDraft(project);
    draft.competitors!.push({ id: crypto.randomUUID(), name: "", relevance: "", url: "unfinished", selected: false });
    expect(competitorReviewValidationMessage(draft)).toBeTruthy();
    expect(() => draftContext(draft, project.context)).toThrow();
    expect(draft.competitors).toHaveLength(2);
  });

  it("persists new editable fields and local review keys in existing version-one browser storage", async () => {
    let stored = JSON.stringify({
      version: 1,
      drafts: [{ ...accountProjectDraft(project), competitors: undefined, competitorReviewKey: undefined }],
    });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => stored,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
    });
    const { updateLocalDraft } = await import("@/components/workspace/local-drafts");
    const draft = accountProjectDraft(project);
    expect(
      updateLocalDraft(draft.id, {
        competitors: draft.competitors,
        competitorReviewKey: draft.competitorReviewKey,
        stage: "competitors",
      }),
    ).toBe(true);
    expect(JSON.parse(stored).drafts[0]).toMatchObject({
      competitors: draft.competitors,
      competitorReviewKey: draft.competitorReviewKey,
      stage: "competitors",
    });
  });
});
