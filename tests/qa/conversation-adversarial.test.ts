import { describe, expect, it } from "vitest";
import { conversationEventSchema, conversationSchema, conversationUserContext, initialConversation, type ConversationEvent } from "@/domain/conversation";
import { accountProjectSchema, PROJECT_MUTATION_MAX_BYTES } from "@/domain/project-api";
import { contextSnapshotSchema } from "@/domain/projects";
import { accountProjectDraft, competitorReviewKey, conversationContextKey, conversationPromptPatch, conversationWidgetPatch, createAccountInput, draftContext, draftConversation, isAudienceReviewComplete, isCompetitorReviewComplete, isPersonalityReviewComplete, isPositioningReviewComplete, personalityReviewKey, positioningReviewKey } from "@/components/workspace/project-draft-adapter";

const now = "2026-10-03T12:00:00Z";
const source = { title: "Synthetic evidence", url: "https://example.com/evidence", retrievedAt: now };
const project = accountProjectSchema.parse({
  id: "aaaaaaaa-1111-4111-8111-111111111111", owner_id: "bbbbbbbb-1111-4111-8111-111111111111", title: "Preserved conversation fixture", scope: "complete_brand", current_revision: 7, created_at: now,
  context: { description: "A community workshop with a known local audience.", activity: "Community workshop", offering: "Shared tools", knownAudience: "Local makers", reformulationConfirmed: true, competitorReviewComplete: true,
    competitors: [{ id: "cccccccc-1111-4111-8111-111111111111", name: "Existing fixture", relevance: "Similar offering", selected: true, origin: "research", sources: [source] }],
    audienceSegments: [{ id: "dddddddd-1111-4111-8111-111111111111", label: "Local makers", needs: ["Shared tools", "Space"], reason: "They live nearby", selected: true, origin: "proposal", sources: [source] }],
    personality: { sincerity: 0, excitement: 35, competence: 100, sophistication: 40, ruggedness: 60 }, positioning: "Shared tools for local makers.", selectedName: "Keep This Name", creativeLocale: "fr-CA",
    intake: { step: "positioning", suppliedName: "Keep This Name", namingNotes: "Keep these notes", identityNotes: "Keep this identity context", audienceReviewedAt: now, personalityReviewedAt: now, positioningReviewedAt: now },
  },
});

function draft() { return { ...accountProjectDraft(project), preservedContext: structuredClone(project.context) }; }
function message(id = "message-1", text = "An actual user prompt"): ConversationEvent { return { id, kind: "user_message", text, createdAt: now }; }
function approvals(value: ReturnType<typeof draft>) { return [isCompetitorReviewComplete(value), isAudienceReviewComplete(value), isPersonalityReviewComplete(value), isPositioningReviewComplete(value)]; }

describe("independent conversation acceptance and adversarial boundaries", () => {
  it("accepts a one-character prompt without inventing an assistant exchange or facts", () => {
    const events = initialConversation("A", now);
    expect(events.map(event => event.kind)).toEqual(["user_message", "widget"]);
    expect(events[0]).toMatchObject({ text: "A", createdAt: now });
    expect(events[1]).toMatchObject({ widget: "competitors" });
    expect(new Set(events.map(event => event.id)).size).toBe(2);
  });

  it.each(["", " \n\t ", "x".repeat(12_001)])("rejects blank or overlong prompt %#", text => {
    expect(conversationEventSchema.safeParse(message("prompt", text)).success).toBe(false);
  });

  it.each([
    { id: "fake", kind: "assistant_message", text: "Invented research", createdAt: now },
    { ...message(), provider: "openai", responseId: "forged" },
    { ...message(), sources: [source] },
    { id: "legacy", kind: "saved_context", text: "Existing description", createdAt: now },
    { ...message(), createdAt: "yesterday" },
  ])("rejects forged provenance, assistant events and fabricated legacy chronology %#", event => {
    expect(contextSnapshotSchema.safeParse({ intake: { conversation: [event] } }).success).toBe(false);
  });

  it("rejects duplicate IDs, duplicate widgets and skipped/reversed widget order", () => {
    expect(conversationSchema.safeParse([message(), message()]).success).toBe(false);
    expect(conversationSchema.safeParse([{ id: "w1", kind: "widget", widget: "competitors" }, { id: "w2", kind: "widget", widget: "competitors" }]).success).toBe(false);
    expect(conversationSchema.safeParse([{ id: "w1", kind: "widget", widget: "positioning" }]).success).toBe(false);
    expect(conversationSchema.safeParse([{ id: "w1", kind: "widget", widget: "audience" }, { id: "w2", kind: "widget", widget: "competitors" }]).success).toBe(false);
    expect(conversationSchema.safeParse([{ id: "s1", kind: "saved_context", text: "First" }, { id: "s2", kind: "saved_context", text: "Second" }]).success).toBe(false);
  });

  it("counts UTF-8 bytes and event overhead independently of text length", () => {
    const unicode = [message("one", "漢".repeat(12_000)), message("two", "漢".repeat(12_000))];
    expect(JSON.stringify(unicode).length).toBeLessThan(64_000);
    expect(new TextEncoder().encode(JSON.stringify(unicode)).byteLength).toBeGreaterThan(64_000);
    expect(conversationSchema.safeParse(unicode).success).toBe(false);
    expect(conversationSchema.safeParse(Array.from({ length: 64 }, (_, index) => message(`event-${index}`, "A"))).success).toBe(true);
    expect(conversationSchema.safeParse(Array.from({ length: 65 }, (_, index) => message(`event-${index}`, "A"))).success).toBe(false);
  });

  it("does not confuse a valid transcript with permission to exceed the account byte cap", () => {
    const value = draft();
    value.conversation = [message("large-unicode", "漢".repeat(11_000))];
    expect(conversationSchema.safeParse(value.conversation).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(createAccountInput(value))).byteLength).toBeGreaterThan(PROJECT_MUTATION_MAX_BYTES);
  });

  it("legacy hydration preserves the exact snapshot and review keys without invented history", () => {
    const value = draft();
    const before = [competitorReviewKey(value), personalityReviewKey(value), positioningReviewKey(value)];
    const events = draftConversation(value);
    expect(events[0]).toEqual({ id: "saved-context", kind: "saved_context", text: project.context.description });
    expect(events.every(event => !("createdAt" in event))).toBe(true);
    expect(conversationUserContext(events)).toEqual([]);
    expect(approvals(value)).toEqual([true, true, true, true]);
    expect(draftContext(value)).toEqual(project.context);
    const hydrated = { ...value, conversation: events };
    expect([competitorReviewKey(hydrated), personalityReviewKey(hydrated), positioningReviewKey(hydrated)]).toEqual(before);
    expect(approvals(hydrated)).toEqual([true, true, true, true]);
  });

  it("legacy values without confirmations stay unreviewed", () => {
    const legacy = accountProjectSchema.parse({ ...project, context: { ...project.context, competitorReviewComplete: false, intake: { step: "positioning" } } });
    const value = { ...accountProjectDraft(legacy), preservedContext: legacy.context };
    expect(approvals(value)).toEqual([false, false, false, false]);
    expect(draftConversation(value).filter(event => event.kind === "widget")).toHaveLength(4);
    expect(draftContext(value).personality).toEqual(project.context.personality);
  });

  it("a verbatim follow-up revokes approvals while retaining choices, evidence and name context", () => {
    const value = draft();
    const before = structuredClone(value);
    const text = "  Focus on students.\nDo not discard the existing name.  ";
    const next = { ...value, ...conversationPromptPatch(value, text, now) };
    expect(value).toEqual(before);
    expect(draftConversation(next).at(-1)).toMatchObject({ kind: "user_message", text, createdAt: now });
    expect(approvals(next)).toEqual([false, false, false, false]);
    const saved = draftContext(next);
    for (const field of ["activity", "offering", "knownAudience", "competitors", "audienceSegments", "personality", "positioning", "selectedName", "creativeLocale"] as const) expect(saved[field]).toEqual(project.context[field]);
    expect(saved.intake).toMatchObject({ suppliedName: "Keep This Name", namingNotes: "Keep these notes", identityNotes: "Keep this identity context", audienceReviewedAt: null, personalityReviewedAt: null, positioningReviewedAt: null });
    expect(saved.reformulationConfirmed).toBe(false);
    expect(saved.competitorReviewComplete).toBe(false);
    const payload = JSON.stringify(createAccountInput(next));
    for (const key of ["competitorReviewKey", "audienceConversationKey", "personalityReviewKey", "positioningReviewKey", "preservedContext"]) expect(payload).not.toContain(key);
    const recovered = { ...accountProjectDraft(accountProjectSchema.parse({ ...project, context: saved })), preservedContext: saved };
    expect(draftConversation(recovered)).toEqual(draftConversation(next));
    expect(approvals(recovered)).toEqual([false, false, false, false]);
  });

  it("detects user-message changes even when callers bypass the follow-up invalidation helper", () => {
    const value = draft();
    value.conversation = [...draftConversation(value), message()];
    expect(approvals(value)).toEqual([false, false, false, false]);
    expect(draftContext(value).intake).toMatchObject({ audienceReviewedAt: null, personalityReviewedAt: null, positioningReviewedAt: null });
  });

  it("binds exact message order, text and IDs, but not display timestamps or widget visibility", () => {
    const value = { ...draft(), conversation: [message("a", "First"), message("b", "Second")] };
    const original = conversationContextKey(value);
    expect(conversationContextKey({ ...value, conversation: [...value.conversation].reverse() })).not.toBe(original);
    expect(conversationContextKey({ ...value, conversation: [message("changed", "First"), message("b", "Second")] })).not.toBe(original);
    expect(conversationContextKey({ ...value, conversation: [message("a", "Changed"), message("b", "Second")] })).not.toBe(original);
    expect(conversationContextKey({ ...value, conversation: value.conversation.map(event => ({ ...event, createdAt: "2026-10-04T12:00:00Z" })) })).toBe(original);
    expect(conversationContextKey({ ...value, ...conversationWidgetPatch(value, "positioning", now) })).toBe(original);
  });

  it("reveals missing widgets once in order without replacing earlier user messages", () => {
    const value = { ...draft(), conversation: initialConversation("New prompt", now) };
    const expanded = { ...value, ...conversationWidgetPatch(value, "positioning", now) };
    const repeated = { ...expanded, ...conversationWidgetPatch(expanded, "audience", now) };
    expect(draftConversation(repeated)).toEqual(draftConversation(expanded));
    expect(draftConversation(expanded)[0]).toEqual(value.conversation[0]);
    expect(draftConversation(expanded).filter(event => event.kind === "widget").map(event => event.widget)).toEqual(["competitors", "audience", "personality", "positioning"]);
  });

  it("rejects a full transcript atomically and leaves the submitted text available to the caller", () => {
    const value = { ...draft(), conversation: Array.from({ length: 64 }, (_, index) => message(`full-${index}`)) };
    const before = structuredClone(value);
    expect(() => conversationPromptPatch(value, "Keep this unsent prompt", now)).toThrow();
    expect(() => conversationWidgetPatch(value, "competitors", now)).toThrow();
    expect(value).toEqual(before);
  });
});
