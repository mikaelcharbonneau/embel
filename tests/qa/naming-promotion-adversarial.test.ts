import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type NamingSource } from "@/domain/naming";
import { contextSnapshotSchema, missingStrategy } from "@/domain/projects";
import { accountProjectSchema } from "@/domain/project-api";
import { brandDraftFromName } from "@/components/workspace/name-promotion";
import { accountProjectDraft, createAccountInput, draftContext } from "@/components/workspace/project-draft-adapter";

const NOW = "2026-10-02T12:00:00Z";
function source(): NamingSource {
  return {
    id: randomUUID(), value: "Loom", origin: "workshop", createdAt: NOW,
    history: [{ id: randomUUID(), input: { kind: "swap", seed: "Room", find: "R", replacement: "L", match: "first" }, output: "Loom", createdAt: NOW }],
  };
}

describe("independent naming promotion invariants", () => {
  it("separates the promoted draft from mutable source objects and their nested research", () => {
    const chosen = source();
    const context = contextSnapshotSchema.parse({
      description: "A synthetic community workshop for local residents.",
      activity: "Community workshops", offering: "Shared tools and lessons", knownAudience: "Nearby residents",
      audienceSegments: [{ id: randomUUID(), label: "Supplied audience", needs: ["Shared tools"], reason: "User supplied", selected: true, origin: "user" }],
      competitors: [{ id: randomUUID(), name: "Researched fixture", relevance: "A local fixture", origin: "research", sources: [{ url: "https://example.com/research-fixture", title: "Synthetic source", retrievedAt: NOW }] }],
      selectedName: "Earlier supplied name", intake: { suppliedName: "Earlier supplied name", namingNotes: "Keep the original note" },
    });
    const originalSource = structuredClone(chosen);
    const originalContext = structuredClone(context);
    const draft = brandDraftFromName(chosen, context, randomUUID(), NOW);
    const initialDraft = structuredClone(draft);
    expect(chosen).toEqual(originalSource);
    expect(context).toEqual(originalContext);
    expect(draft.preservedContext).toMatchObject({ selectedName: "Loom", namingSource: originalSource, intake: { suppliedName: "Loom" } });

    chosen.history[0]!.input = { kind: "swap", seed: "Room", find: "R", replacement: "B", match: "first" };
    context.competitors[0]!.sources[0]!.title = "Changed caller source";
    context.audienceSegments[0]!.needs[0] = "Changed caller need";
    expect(draft).toEqual(initialDraft);
    draft.preservedContext!.competitors[0]!.sources[0]!.title = "Changed draft source";
    expect(context.competitors[0]!.sources[0]!.title).toBe("Changed caller source");
  });

  it.each(["Revised chosen name", ""])("keeps original provenance after explicit selected-name edit to %j and account roundtrip", (editedName) => {
    const chosen = source();
    const context = contextSnapshotSchema.parse({ description: "An independent selected-name roundtrip fixture." });
    const draft = brandDraftFromName(chosen, context, randomUUID(), NOW);
    draft.suppliedName = editedName;
    const input = createAccountInput(draft);
    expect(input.context.selectedName).toBe(editedName || null);
    expect(input.context.intake.suppliedName).toBe(editedName);
    expect(input.context.namingSource).toEqual(chosen);
    const account = accountProjectSchema.parse({
      id: randomUUID(), owner_id: randomUUID(), scope: input.scope, title: input.title,
      current_revision: 1, created_at: NOW, context: JSON.parse(JSON.stringify(input.context)),
    });
    const accountDraft = accountProjectDraft(account);
    const roundtrip = draftContext(accountDraft, account.context);
    expect(roundtrip.selectedName).toBe(editedName || null);
    expect(roundtrip.namingSource).toEqual(chosen);
    expect(chosen.value).toBe("Loom");
    expect(chosen.history[0]!.output).toBe("Loom");
  });

  it("does not turn a name selection or stale editor position into strategy approval", () => {
    const context = contextSnapshotSchema.parse({
      description: "An unreviewed strategy fixture with a saved editor position.",
      activity: "Community workshops", offering: "Shared tools", intake: { step: "audience" },
    });
    const missing = missingStrategy(context);
    const draft = brandDraftFromName(source(), context, randomUUID(), NOW);
    // Existing widget position survives promotion; it is not an approval marker.
    expect(draft.stage).toBe("audience");
    expect(draft.confirmedBrief).toBeUndefined();
    const input = createAccountInput(draft);
    expect(missingStrategy(input.context)).toEqual(missing);
    expect(input.context).toMatchObject({ reformulationConfirmed: false, competitorReviewComplete: false, personality: null, positioning: "" });
    expect(input.context).not.toHaveProperty("evidence");
    expect(input.context.namingSource).not.toHaveProperty("evidence");
  });

  it("revalidates a tampered capture before constructing a brand", () => {
    const chosen = source();
    chosen.value = "A value absent from its transformation history";
    expect(() => brandDraftFromName(chosen, contextSnapshotSchema.parse({}), randomUUID(), NOW)).toThrow();
  });
});
