import { afterEach, describe, expect, it, vi } from "vitest";
import { namingSourceSchema } from "@/domain/naming";
import { contextSnapshotSchema } from "@/domain/projects";
import { brandDraftFromName } from "@/components/workspace/name-promotion";
import { accountProjectDraft, createAccountInput, draftContext } from "@/components/workspace/project-draft-adapter";
import type { LocalDraft } from "@/components/workspace/local-drafts";

const now = "2026-10-02T20:00:00Z";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const source = namingSourceSchema.parse({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", value: "Lumina", createdAt: now, origin: "workshop",
  history: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", createdAt: now, input: { kind: "affixes", seed: "Lumi", prefixes: [], suffixes: ["na"], separator: "" }, output: "Lumina" }],
});
const context = contextSnapshotSchema.parse({
  description: "A local lighting studio creating repairable lamps.", activity: "Lighting studio", offering: "Repairable lamps", knownAudience: "Small homes", reformulationConfirmed: true,
  audienceSegments: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", label: "Small-home residents", needs: ["Repairability\nwithout replacing the whole lamp", "Warm light"], reason: "Limited space", selected: true, origin: "user", sources: [] }],
  competitors: [{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", name: "Original synthetic competitor", relevance: "Local test only", origin: "research", selected: true, sources: [{ title: "Synthetic research source", url: "https://example.com/fixture", retrievedAt: now }] }],
  competitorReviewComplete: true, positioning: "Quiet, repairable lighting", personality: { sincerity: 70, excitement: 20, competence: 80, sophistication: 40, ruggedness: 30 }, creativeLocale: "fr-CA",
  intake: { suppliedName: "Previous supplied name", namingNotes: "Readable in French", identityNotes: "Warm colors", step: "audience", audienceReviewedAt: now, example: true },
});

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("a standalone name becomes a fresh brand", () => {
  it("copies known context and original provenance without changing the source or its full history", () => {
    const selected = structuredClone(source);
    const captured = structuredClone(context);
    const draft = brandDraftFromName(selected, captured, id, now);
    const input = createAccountInput(draft);
    expect(input).toMatchObject({ title: "Lumina", scope: "complete_brand" });
    expect(input.context).toEqual({ ...context, selectedName: "Lumina", namingSource: source, intake: { ...context.intake, suppliedName: "Lumina" } });
    expect(draft.stage).toBe("audience");
    expect(draft.example).toBe(true);
    expect(selected).toEqual(source);
    expect(captured).toEqual(context);
    selected.history[0]!.input = { kind: "tweaks", seed: "Changed", operations: ["uppercase"] };
    captured.audienceSegments[0]!.sources.push({ title: "Later source", url: "https://example.com/later", retrievedAt: now });
    expect(createAccountInput(draft)).toEqual(input);
  });

  it("guides missing context without inventing a brief or approving strategy", () => {
    const empty = contextSnapshotSchema.parse({});
    const draft = brandDraftFromName(source, empty, id, now);
    expect(draft).toMatchObject({ stage: "competitors", description: "", activity: "", offering: "", knownAudience: "", segments: [], suppliedName: "Lumina", example: false });
    expect(draft.confirmedBrief).toBeUndefined();
    expect(createAccountInput(draft).context.reformulationConfirmed).toBe(false);
    const supplied = contextSnapshotSchema.parse({ description: context.description, knownAudience: "Small homes" });
    expect(brandDraftFromName(source, supplied, id, now)).toMatchObject({ stage: "competitors", description: context.description, knownAudience: "Small homes" });
    const unreviewed = contextSnapshotSchema.parse({ description: context.description, intake: { step: "audience" } });
    expect(brandDraftFromName(source, unreviewed, id, now).stage).toBe("audience");
    const unreviewedCompetitors = contextSnapshotSchema.parse({ description: context.description, intake: { step: "competitors" } });
    expect(brandDraftFromName(source, unreviewedCompetitors, id, now).stage).toBe("competitors");
    for (const step of ["personality", "positioning"] as const) {
      const incomplete = contextSnapshotSchema.parse({ description: context.description, intake: { step } });
      expect(brandDraftFromName(source, incomplete, id, now).stage).toBe(step);
    }
  });

  it("carries reviewed strategy into a brand and retains its content when the brief changes", () => {
    const reviewed = contextSnapshotSchema.parse({
      ...context,
      intake: { ...context.intake, step: "positioning", personalityReviewedAt: now, positioningReviewedAt: now },
    });
    const draft = brandDraftFromName(source, reviewed, id, now);
    expect(createAccountInput(draft).context.intake).toMatchObject({ personalityReviewedAt: now, positioningReviewedAt: now });
    const changed = createAccountInput({ ...draft, offering: "Repairable lamps and custom lighting plans" }).context;
    expect(changed.intake).toMatchObject({ personalityReviewedAt: null, positioningReviewedAt: null });
    expect(changed.personality).toEqual(reviewed.personality);
    expect(changed.positioning).toBe(reviewed.positioning);
    expect(changed.namingSource).toEqual(source);
  });

  it("carries an existing conversation into the brand without relabeling or replaying messages", () => {
    const conversation = [
      { id: "actual-prompt", kind: "user_message", text: "Repairable lamps", createdAt: now },
      { id: "actual-competitors", kind: "widget", widget: "competitors", createdAt: now },
    ];
    const captured = contextSnapshotSchema.parse({ ...context, intake: { ...context.intake, conversation, step: "competitors" } });
    const draft = brandDraftFromName(source, captured, id, now);
    expect(draft.conversation).toEqual(conversation);
    expect(draft.conversation).not.toBe(captured.intake.conversation);
    expect(createAccountInput(draft).context.intake.conversation).toEqual(conversation);
    expect(createAccountInput(draft).context.namingSource).toEqual(source);
  });

  it("preserves the original provenance through a later explicit name edit and account roundtrip", () => {
    const initial = brandDraftFromName(source, context, id, now);
    const changed = { ...initial, suppliedName: "Lumina Studio" };
    const input = createAccountInput(changed);
    expect(input.context.selectedName).toBe("Lumina Studio");
    expect(input.context.namingSource).toEqual(source);
    const project = { id, owner_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", title: input.title, scope: input.scope, context: input.context, current_revision: 1, created_at: now };
    expect(draftContext(accountProjectDraft(project), project.context)).toEqual(input.context);
    expect(createAccountInput({ ...changed, suppliedName: "" }).context.selectedName).toBeNull();
  });

  it("writes a new browser draft with a distinct ID and leaves the existing original intact", async () => {
    let raw: string | null = null;
    vi.stubGlobal("window", { localStorage: { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } } });
    const { createBrandFromName } = await import("@/components/workspace/name-promotion");
    const first = createBrandFromName(source, context)!;
    const firstSaved = JSON.parse(raw!).drafts[0];
    const second = createBrandFromName(source, context)!;
    expect(first.persisted).toBe(true);
    expect(second.persisted).toBe(true);
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toBe(source.id);
    expect(JSON.parse(raw!).drafts).toEqual([expect.objectContaining({ id: second.id }), firstSaved]);
  });

  it("keeps a quota-failed draft in memory, reports nonpersistence and leaves the prior durable save readable", async () => {
    const original = brandDraftFromName(source, context, id, now);
    let raw = JSON.stringify({ version: 1, drafts: [original] });
    const saved = raw;
    let quota = true;
    const setItem = vi.fn((_key: string, value: string) => { if (quota) throw new Error("quota"); raw = value; });
    vi.stubGlobal("window", { localStorage: { getItem: () => raw, setItem } });
    const { createBrandFromName } = await import("@/components/workspace/name-promotion");
    const copy = createBrandFromName(source, context)!;
    expect(copy.persisted).toBe(false);
    expect(raw).toBe(saved);
    quota = false;
    const { updateLocalDraft } = await import("@/components/workspace/local-drafts");
    expect(updateLocalDraft(copy.id, { title: "Retained edit" })).toBe(true);
    const drafts = JSON.parse(raw).drafts as LocalDraft[];
    expect(drafts).toHaveLength(2);
    expect(drafts.find((draft) => draft.id === copy.id)).toMatchObject({ title: "Retained edit", suppliedName: "Lumina", preservedContext: { namingSource: source } });
  });

  it("does not overwrite malformed brand storage with a newly promoted name", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem: () => "{invalid", setItem } });
    const { createBrandFromName } = await import("@/components/workspace/name-promotion");
    expect(() => createBrandFromName(source, context)).toThrow("Saved brand drafts could not be read");
    expect(setItem).not.toHaveBeenCalled();
  });
});
