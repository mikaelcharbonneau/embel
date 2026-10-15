import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationSchema } from "@/domain/conversation";
import { accountProjectSchema } from "@/domain/project-api";
import { contextSnapshotSchema } from "@/domain/projects";
import { accountProjectDraft, conversationContextKey, conversationPromptPatch, conversationWidgetPatch, createAccountInput, draftContext, draftConversation, isCompetitorReviewComplete, isPersonalityReviewComplete } from "@/components/workspace/project-draft-adapter";

const now = "2026-10-03T12:00:00Z";
const project = accountProjectSchema.parse({
  id: "aaaaaaaa-1111-4111-8111-111111111111", owner_id: "bbbbbbbb-1111-4111-8111-111111111111", title: "Conversation fixture", scope: "complete_brand", current_revision: 3, created_at: now,
  context: { description: "A neighborhood kitchen with a changing seasonal menu.", activity: "Kitchen", offering: "Lunch", knownAudience: "Local workers", reformulationConfirmed: true, competitorReviewComplete: true,
    audienceSegments: [{ id: "cccccccc-1111-4111-8111-111111111111", label: "Local workers", needs: ["A dependable lunch"], reason: "They work nearby", selected: true, origin: "user" }],
    personality: { sincerity: 50, excitement: 40, competence: 70, sophistication: 30, ruggedness: 20 }, positioning: "A dependable daily lunch.",
    intake: { step: "positioning", audienceReviewedAt: now, personalityReviewedAt: now, positioningReviewedAt: now },
  },
});

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("persistent project conversation", () => {
  it("does not add invented conversation to old saved snapshots", () => {
    expect(contextSnapshotSchema.parse({}).intake).not.toHaveProperty("conversation");
    const draft = accountProjectDraft(project);
    expect(draftContext(draft, project.context)).toEqual(project.context);
    expect(draftConversation(draft)).toEqual(draftConversation(draft));
    expect(draftConversation(draft)[0]).toEqual({ id: "saved-context", kind: "saved_context", text: project.context.description });
    expect(draftConversation(draft).filter((event) => event.kind === "widget").map((event) => event.widget)).toEqual(["competitors", "audience", "personality", "positioning"]);
    expect(draftConversation(draft).every((event) => !("createdAt" in event))).toBe(true);
    expect(isCompetitorReviewComplete(draft)).toBe(true);
    expect(isPersonalityReviewComplete(draft)).toBe(true);
  });

  it("persists a new Send as actual user text and a competitor widget without making activity facts", async () => {
    let stored: string | null = null;
    vi.stubGlobal("window", { localStorage: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } } });
    const { createLocalDraft } = await import("@/components/workspace/local-drafts");
    createLocalDraft({ title: "", scope: "complete_brand", description: "Lunch", suppliedName: "", namingNotes: "", identityNotes: "", example: false });
    const draft = JSON.parse(stored!).drafts[0];
    expect(draft.stage).toBe("competitors");
    expect(draft.activity).toBe("");
    expect(draft.offering).toBe("");
    expect(draft.conversation.map((event: { kind: string }) => event.kind)).toEqual(["user_message", "widget"]);
    expect(draft.conversation[0].text).toBe("Lunch");
    expect(draftContext(draft).reformulationConfirmed).toBe(false);
    expect(createAccountInput(draft).context.intake.conversation).toEqual(draft.conversation);
  });

  it("reads the exact newly created conversation for account handoff even when browser storage fails", async () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => { throw new Error("Synthetic unavailable storage"); } } });
    const { createLocalDraft, getLocalDraft, updateLocalDraft } = await import("@/components/workspace/local-drafts");
    const id = createLocalDraft({ title: "", scope: "complete_brand", description: "Lunch", suppliedName: "", namingNotes: "", identityNotes: "", example: false });
    const handoff = getLocalDraft(id!);
    expect(handoff?.conversation).toHaveLength(2);
    expect(handoff?.conversation?.[0]).toMatchObject({ kind: "user_message", text: "Lunch" });
    const captured = structuredClone(handoff);
    handoff!.description = "An account-side change";
    expect(getLocalDraft(id!)).toEqual(captured);
    expect(updateLocalDraft(id!, { title: "Local title" })).toBe(false);
    expect(getLocalDraft(id!)).toEqual({ ...captured, title: "Local title", updatedAt: expect.any(String) });
    expect(getLocalDraft("missing-id")).toBeUndefined();
  });

  it("keeps follow-ups verbatim without parsing them into facts or discarding choices", () => {
    const draft = accountProjectDraft(project);
    const prompt = "Actually focus on students, but keep the name and visual work.";
    const next = { ...draft, ...conversationPromptPatch(draft, prompt, now) };
    const context = draftContext(next, project.context);
    expect(context.activity).toBe(project.context.activity);
    expect(context.knownAudience).toBe(project.context.knownAudience);
    expect(context.audienceSegments).toEqual(project.context.audienceSegments);
    expect(context.personality).toEqual(project.context.personality);
    expect(context.positioning).toBe(project.context.positioning);
    expect(context.reformulationConfirmed).toBe(false);
    expect(context.competitorReviewComplete).toBe(false);
    expect(context.intake).toMatchObject({ audienceReviewedAt: null, personalityReviewedAt: null, positioningReviewedAt: null });
    expect(context.intake.conversation?.at(-1)).toMatchObject({ kind: "user_message", text: prompt, createdAt: now });
  });

  it("binds all existing reviews to new actual user messages even when event handlers are bypassed", () => {
    const draft = accountProjectDraft(project);
    draft.conversation = [...draftConversation(draft), { id: crypto.randomUUID(), kind: "user_message", text: "An added constraint.", createdAt: now }];
    const context = draftContext(draft, project.context);
    expect(context.competitorReviewComplete).toBe(false);
    expect(context.intake).toMatchObject({ audienceReviewedAt: null, personalityReviewedAt: null, positioningReviewedAt: null });
  });

  it("allows explicit brief review against the current follow-up without approving other strategy", () => {
    const draft = accountProjectDraft(project);
    const next = { ...draft, ...conversationPromptPatch(draft, "Keep the kitchen, with takeaway service.", now) };
    next.confirmedBrief = { description: next.description, activity: next.activity, offering: next.offering, knownAudience: next.knownAudience, conversationKey: conversationContextKey(next) };
    const context = draftContext(next, project.context);
    expect(context.reformulationConfirmed).toBe(true);
    expect(context.competitorReviewComplete).toBe(false);
    expect(context.intake).toMatchObject({ audienceReviewedAt: null, personalityReviewedAt: null, positioningReviewedAt: null });
    expect(JSON.stringify(context)).not.toContain("conversationKey");
  });

  it("invalidates an explicit brief binding when later messages change without using the Send handler", () => {
    const draft = accountProjectDraft(project);
    draft.confirmedBrief = { ...draft.confirmedBrief!, conversationKey: conversationContextKey(draft) };
    draft.conversation = [...draftConversation(draft), { id: crypto.randomUUID(), kind: "user_message", text: "A later constraint.", createdAt: now }];
    expect(draftContext(draft, project.context).reformulationConfirmed).toBe(false);
  });

  it("accepts manual review of a new browser conversation without a saved account snapshot", () => {
    const draft = accountProjectDraft(project);
    const next = { ...draft, ...conversationPromptPatch(draft, "A new browser-only direction.", now) };
    next.confirmedBrief = { description: next.description, activity: next.activity, offering: next.offering, knownAudience: next.knownAudience, conversationKey: conversationContextKey(next) };
    expect(draftContext(next).reformulationConfirmed).toBe(true);
  });

  it("reveals each widget once without revoking unchanged approvals or inventing work", () => {
    const draft = accountProjectDraft(project);
    const patch = conversationWidgetPatch(draft, "audience", now);
    const next = { ...draft, ...patch };
    expect(draftConversation(next).filter((event) => event.kind === "widget" && event.widget === "audience")).toHaveLength(1);
    expect(isCompetitorReviewComplete(next)).toBe(true);
    expect(isPersonalityReviewComplete(next)).toBe(true);
    expect(conversationContextKey(next)).toBe(conversationContextKey(draft));
  });

  it("preserves review bindings when only widget timestamps change", () => {
    const draft = accountProjectDraft(project);
    draft.conversation = draftConversation(draft).map((event) => event.kind === "widget" ? { ...event, createdAt: now } : event);
    expect(isPersonalityReviewComplete(draft)).toBe(true);
    expect(draftContext(draft, project.context).intake.audienceReviewedAt).toBe(now);
  });

  it("retains schema-valid Unicode legacy descriptions without truncation", () => {
    const draft = { ...accountProjectDraft(project), description: "漢".repeat(12_000) };
    expect(conversationSchema.parse(draftConversation(draft))[0]).toMatchObject({ text: draft.description });
  });

  it("rejects empty prompts and transcript capacity overflow without modifying the existing draft", () => {
    const draft = accountProjectDraft(project);
    expect(() => conversationPromptPatch(draft, " \n ", now)).toThrow();
    const before = structuredClone(draft);
    const full = Array.from({ length: 64 }, (_, index) => ({ id: `message-${index}`, kind: "user_message" as const, text: "A prompt", createdAt: now }));
    expect(() => conversationPromptPatch({ ...draft, conversation: full }, "One more prompt", now)).toThrow();
    expect(draft).toEqual(before);
  });

  it("rejects assistant/provenance claims supplied in client-editable intake", () => {
    expect(contextSnapshotSchema.safeParse({ intake: { conversation: [{ id: "invented", kind: "assistant_message", text: "I researched these competitors.", createdAt: now, model: "invented-model" }] } }).success).toBe(false);
  });
});
