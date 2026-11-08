import { expect, it } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { confirmGuidedSelection, guidedReplySchema } from "@/domain/guided-interview";
import { initialGuidedContext, recordGuidedChoice } from "@/components/workspace/guided-interview-client";
const now = "2026-10-21T04:00:00Z", manual = "11111111-1111-4111-8111-111111111111", researched = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const context = initialGuidedContext(contextSnapshotSchema.parse({ description: "A branding studio", competitors: [{ id: manual, name: "Logram.ai", relevance: "Added by you", origin: "user", selected: true, sources: [] }] }), 1, now);
  const turn = context.intake.guidedInterview!.turns[0]!;
  const reply = guidedReplySchema.parse({ kind: "choices", turnId: turn.id, stage: "competitors", message: "Choose comparisons", question: "Which competitors?", selectionMode: "multiple", options: [{ id: researched, stage: "competitors", label: "Fixture Studio", description: "Branding", recommended: true, recommendationReason: "Similar offer", payload: { id: researched, name: "Fixture Studio", relevance: "Similar offer", origin: "research", selected: false, sources: [{ url: "https://example.com", title: "Fixture", retrievedAt: now }] } }] });
  if (reply.kind !== "choices") throw Error("Invalid fixture");
  return { context, turn, reply };
}
it.each([true, false])("confirms a manual competitor with suggested selection=%s without inventing provider provenance", includeSuggested => {
  const { context, turn, reply } = fixture();
  const ids = includeSuggested ? [researched] : [];
  const result = confirmGuidedSelection(context, { turnId: turn.id, reply, optionIds: ids, retainedCompetitorIds: [manual], now });
  expect(result.competitors.find(item => item.id === manual)).toMatchObject({ name: "Logram.ai", selected: true, origin: "user", sources: [] });
  expect(result.competitors.filter(item => item.selected)).toHaveLength(includeSuggested ? 2 : 1);
  expect(result.intake.guidedInterview?.stage).toBe("audience");
  const message = recordGuidedChoice(result, reply, ids, now, [manual]);
  expect(message.context.intake.conversation?.at(-1)).toMatchObject({ kind: "user_message", text: includeSuggested ? "Fixture Studio; Logram.ai" : "Logram.ai" });
  expect(reply.options).toHaveLength(1);
});
it("rejects an unsaved or duplicated retained competitor", () => {
  const { context, turn, reply } = fixture();
  expect(() => confirmGuidedSelection(context, { turnId: turn.id, reply, optionIds: [], retainedCompetitorIds: [researched], now })).toThrow("saved in this project");
  expect(() => confirmGuidedSelection(context, { turnId: turn.id, reply, optionIds: [], retainedCompetitorIds: [manual, manual], now })).toThrow();
});
it("replaces a competitor you added by name with its researched entry once that is chosen", () => {
  const { reply } = fixture(), added = "33333333-3333-4333-8333-333333333333";
  const context = initialGuidedContext(contextSnapshotSchema.parse({ description: "A branding studio", competitors: [
    { id: manual, name: "Logram.ai", relevance: "Added by you", origin: "user", selected: true, sources: [] },
    { id: added, name: "fixture studio", relevance: "Added by you", origin: "user", selected: true, sources: [] },
  ] }), 1, now);
  const turn = context.intake.guidedInterview!.turns[0]!;
  const result = confirmGuidedSelection(context, { turnId: turn.id, reply: { ...reply, turnId: turn.id }, optionIds: [researched], retainedCompetitorIds: [manual], now });
  expect(result.competitors.map(item => [item.name, item.origin, item.selected])).toEqual([["Logram.ai", "user", true], ["Fixture Studio", "research", true]]);
});
