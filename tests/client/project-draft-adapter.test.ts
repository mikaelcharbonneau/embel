import { describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { accountProjectSchema } from "@/domain/project-api";
import { accountProjectDraft, createAccountInput, draftContext } from "@/components/workspace/project-draft-adapter";

// Synthetic local fixtures only; no account/provider calls.
const source = { url: "https://example.com/local-fixture", title: "Local research fixture", retrievedAt: "2026-10-02T10:00:00Z" };
const project = accountProjectSchema.parse({
  id: "aaaaaaaa-1111-4111-8111-111111111111", owner_id: "bbbbbbbb-1111-4111-8111-111111111111", scope: "visual_identity_only",
  title: "Long private fixture ".repeat(7), current_revision: 4, created_at: "2026-10-02T10:00:00Z",
  context: contextSnapshotSchema.parse({
    description: "A written fixture for a visual identity project.", activity: "A public cultural program", offering: "Workshops and a shared studio", knownAudience: "Local neighbors", reformulationConfirmed: true,
    audienceSegments: [{ id: "cccccccc-1111-4111-8111-111111111111", label: "Local audience fixture", needs: ["One need\nwith its own line break", "x".repeat(2000), "A separate need"], reason: "They live nearby", selected: true, origin: "proposal", sources: [source] }],
    competitors: [{ id: "dddddddd-1111-4111-8111-111111111111", name: "Research fixture", relevance: "Similar program", origin: "research", sources: [source], selected: true }],
    competitorReviewComplete: true, positioning: "Positioning fixture", selectedName: "Common Room", creativeLocale: "fr-CA",
    personality: { sincerity: 70, excitement: 40, competence: 80, sophistication: 20, ruggedness: 10 },
    intake: { suppliedName: "Common Room", namingNotes: "Keep both languages", identityNotes: "Keep the poster grid", step: "audience", audienceReviewedAt: "2026-10-02T10:00:00Z", example: true },
  }),
});

describe("account draft adapter", () => {
  it("roundtrips all context including long and multiline needs, provenance and unseen downstream decisions", () => {
    const draft = accountProjectDraft(project);
    expect(draftContext(draft, project.context)).toEqual(project.context);
    expect(draft.title).toBe(project.title);
    expect(draft.identityNotes).toBe("Keep the poster grid");
    expect(draft.example).toBe(true);
  });

  it("patches only edited fields and retains existing segment sources and origin", () => {
    const draft = accountProjectDraft(project);
    draft.title = "Renamed fixture";
    draft.segments[0]!.reason = "An edited reason";
    const context = draftContext(draft, project.context);
    expect(context.audienceSegments[0]).toEqual({ ...project.context.audienceSegments[0], reason: "An edited reason" });
    expect(context.competitors).toEqual(project.context.competitors);
    expect(context.personality).toEqual(project.context.personality);
    expect(context.positioning).toBe(project.context.positioning);
    expect(context.selectedName).toBe(project.context.selectedName);
    expect(context.intake).toEqual(project.context.intake);
  });

  it("preserves downstream context when an explicit browser recovery copy is saved back to an account", () => {
    const draft = { ...accountProjectDraft(project), preservedContext: project.context, namingNotes: "An unsaved recovery note" };
    const input = createAccountInput(draft);
    expect(input.context).toEqual({ ...project.context, intake: { ...project.context.intake, namingNotes: "An unsaved recovery note" } });
    expect(input.title).toBe(project.title);
    expect(input.scope).toBe("visual_identity_only");
  });

  it("does not invent confirmed strategy when an unrelated field changes", () => {
    const unconfirmed = { ...project, context: { ...project.context, reformulationConfirmed: false } };
    const draft = { ...accountProjectDraft(unconfirmed), title: "New title" };
    expect(draftContext(draft, unconfirmed.context).reformulationConfirmed).toBe(false);
  });

  it("invalidates confirmed reformulation after a changed brief and labels new audiences as user supplied", () => {
    const draft = accountProjectDraft(project);
    draft.activity = "A changed activity";
    draft.segments.push({ id: "eeeeeeee-1111-4111-8111-111111111111", name: "Added audience", needs: "One need\nA second need", reason: "A supplied reason", selected: false });
    const context = draftContext(draft, project.context);
    expect(context.reformulationConfirmed).toBe(false);
    expect(context.audienceSegments[1]).toMatchObject({ needs: ["One need", "A second need"], origin: "user", sources: [] });
  });

  it("rejects unnamed segments instead of silently dropping unsaved work", () => {
    const draft = accountProjectDraft(project);
    draft.segments[0]!.name = "";
    expect(() => draftContext(draft, project.context)).toThrow();
  });

  it("requires an explicit review of changed known audience before confirming again", () => {
    const draft = accountProjectDraft(project);
    draft.knownAudience = "A changed group";
    expect(draftContext(draft, project.context).reformulationConfirmed).toBe(false);
    draft.confirmedBrief = { description: draft.description, activity: draft.activity, offering: draft.offering, knownAudience: draft.knownAudience };
    expect(draftContext(draft, project.context).reformulationConfirmed).toBe(true);
  });
});
