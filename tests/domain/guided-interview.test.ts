import { describe, expect, it } from "vitest";
import { contextSnapshotSchema, missingStrategy } from "../../src/domain/projects";
import { appendGuidedTurn, confirmGuidedSelection, guidedReplySchema, guidedSlogan, guidedTurnOperation, initializeGuidedInterview, parseGuidedInterview, revisitGuidedStage, skipGuidedSlogan, type GuidedReply } from "../../src/domain/guided-interview";

const now = "2026-10-14T20:00:00.000Z";
const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
const profile = { sincerity: 80, excitement: 45, competence: 90, sophistication: 30, ruggedness: 10 };
const context = contextSnapshotSchema.parse({ description: "Explicit synthetic guided interview fixture", intake: { conversation: [{ id: "prompt", kind: "user_message", text: "An office bread subscription", createdAt: now }] } });
const turn = { id: "turn1", stage: "competitors" as const, purpose: "research" as const, inputRevision: 1, userMessageId: "prompt" };
function initial() { return initializeGuidedInterview(context, turn); }
function choices(): Extract<GuidedReply, { kind: "choices" }> {
  return guidedReplySchema.parse({ kind: "choices", turnId: "turn1", stage: "competitors", message: "Synthetic sourced alternatives", question: "Which competitors should we keep?", selectionMode: "multiple", options: ids.map((id, index) => ({
    id, stage: "competitors", label: `Fixture ${index}`, description: "Office bread delivery", recommended: index === 0, recommendationReason: index === 0 ? "It serves the same buying need" : null,
    payload: { id, name: `Fixture ${index}`, relevance: "The same delivery model", origin: "research", selected: false, sources: [{ url: `https://example.com/${index}`, title: "Synthetic source", retrievedAt: now }] },
  })) }) as Extract<GuidedReply, { kind: "choices" }>;
}

describe("pure guided interview decisions", () => {
  it("keeps older contexts readable and does not invent conversation or approvals when initializing", () => {
    expect(parseGuidedInterview(context)).toBeNull();
    const before = structuredClone(context);
    const initialized = initial();
    expect(initialized.intake.conversation).toEqual(context.intake.conversation);
    expect(initialized.intake.guidedInterview?.stage).toBe("competitors");
    expect(initialized.intake.guidedInterview?.answers).toEqual([]);
    expect(initialized.reformulationConfirmed).toBe(false);
    expect(context).toEqual(before);
  });

  it("requires real user messages for research and message turns and permits actual selection anchors for proposals", () => {
    expect(() => initializeGuidedInterview(context, { ...turn, userMessageId: "invented" })).toThrow();
    expect(() => initializeGuidedInterview(context, { ...turn, userMessageId: null })).toThrow();
    expect(() => initializeGuidedInterview(context, { ...turn, stage: "audience" })).toThrow();
    expect(initializeGuidedInterview(context, { ...turn, purpose: "propose", userMessageId: "prompt" }).intake.guidedInterview?.turns[0]?.userMessageId).toBe("prompt");
    expect(initializeGuidedInterview(context, { ...turn, purpose: "propose", userMessageId: null }).intake.conversation).toEqual(context.intake.conversation);
  });

  it("accepts only new increasing revisions for the current stage", () => {
    expect(() => appendGuidedTurn(initial(), { ...turn, id: "turn2" })).toThrow();
    expect(() => appendGuidedTurn(initial(), { ...turn, id: "turn2", inputRevision: 2, stage: "audience", purpose: "propose" })).toThrow();
    expect(appendGuidedTurn(initial(), { ...turn, id: "turn2", inputRevision: 2, purpose: "message" }).intake.guidedInterview?.turns).toHaveLength(2);
    expect(guidedTurnOperation(turn)).toBe("strategy.competitors");
    expect(guidedTurnOperation({ ...turn, purpose: "message" })).toBe("strategy.reformulate");
  });

  it("never treats a recommendation as a selection and confirms exactly the clicked options", () => {
    const reply = choices();
    expect(reply.options.every(option => option.stage === "competitors" && !option.payload.selected)).toBe(true);
    expect(() => confirmGuidedSelection(initial(), { turnId: turn.id, reply, now })).toThrow("Choose an option");
    const saved = confirmGuidedSelection(initial(), { turnId: turn.id, reply, optionIds: [ids[1]!], now });
    expect(saved.competitors).toMatchObject([{ id: ids[1], selected: true }]);
    expect(saved.competitorReviewComplete).toBe(true);
    expect(saved.intake.guidedInterview?.stage).toBe("audience");
    expect(saved.intake.guidedInterview?.answers[0]?.optionIds).toEqual([ids[1]]);
    expect(reply.options[1]?.stage === "competitors" && reply.options[1].payload.selected).toBe(false);
  });

  it("rejects stale turns, arbitrary IDs, duplicate IDs, mismatched stages and already-confirmed decisions", () => {
    const reply = choices();
    for (const changes of [{ turnId: "old" }, { optionIds: ["forged"] }, { optionIds: [ids[0]!, ids[0]!] }]) {
      expect(() => confirmGuidedSelection(initial(), { turnId: turn.id, reply, optionIds: [ids[0]!], now, ...changes })).toThrow();
    }
    expect(guidedReplySchema.safeParse({ ...reply, stage: "audience" }).success).toBe(false);
    const saved = confirmGuidedSelection(initial(), { turnId: turn.id, reply, optionIds: [ids[0]!], now });
    expect(() => confirmGuidedSelection(saved, { turnId: turn.id, reply, optionIds: [ids[0]!], now })).toThrow("no longer");
  });

  it("keeps explanations and clarification questions on the same stage", () => {
    const before = initial();
    for (const kind of ["answer", "question"] as const) {
      const reply = guidedReplySchema.parse({ kind, turnId: turn.id, stage: "competitors", message: "Synthetic clarification", ...(kind === "question" ? { question: "Which region should we focus on?" } : {}) });
      expect(() => confirmGuidedSelection(before, { turnId: turn.id, reply, now })).toThrow("clarification");
    }
    expect(before.intake.guidedInterview?.stage).toBe("competitors");
  });

  it("retains the original choice widget after a clarification without rebinding provider output", () => {
    const original = initial();
    const withMessage = contextSnapshotSchema.parse({ ...original, intake: { ...original.intake, conversation: [...original.intake.conversation!, { id: "clarification", kind: "user_message", text: "Why do you recommend this?", createdAt: now }] } });
    const pending = appendGuidedTurn(withMessage, { id: "explanation", stage: "competitors", purpose: "message", userMessageId: "clarification", inputRevision: 2 });
    const answer = guidedReplySchema.parse({ kind: "answer", turnId: "explanation", stage: "competitors", message: "It serves the same buying need." });
    expect(() => confirmGuidedSelection(pending, { turnId: "explanation", reply: answer, now })).toThrow("clarification");
    const saved = confirmGuidedSelection(pending, { turnId: turn.id, reply: choices(), optionIds: [ids[0]!], now });
    expect(saved.intake.guidedInterview?.stage).toBe("audience");
    expect(saved.intake.guidedInterview?.answers[0]?.turnId).toBe(turn.id);
    expect(saved.intake.guidedInterview?.turns.at(-1)?.id).toBe("explanation");
  });

  it("accepts a first-class custom answer only when bound to the actual user message", () => {
    const userText = "Keep Custom Bakery";
    const base = contextSnapshotSchema.parse({ ...initial(), intake: { ...initial().intake, conversation: [...context.intake.conversation!, { id: "custom", kind: "user_message", text: userText, createdAt: now }] } });
    const pending = appendGuidedTurn(base, { ...turn, id: "turn2", purpose: "message", userMessageId: "custom", inputRevision: 2 });
    const reply = guidedReplySchema.parse({ kind: "accepted", turnId: "turn2", stage: "competitors", message: "Synthetic interpretation", customText: userText,
      selection: { stage: "competitors", competitors: [{ id: ids[0], name: "Custom Bakery", relevance: "Same offer", origin: "user", selected: false, sources: [] }] },
    });
    const saved = confirmGuidedSelection(pending, { turnId: "turn2", reply, now });
    expect(saved.competitors).toMatchObject([{ name: "Custom Bakery", origin: "user", sources: [], selected: true }]);
    expect(saved.intake.guidedInterview?.answers[0]?.customText).toBe(userText);
    expect(() => confirmGuidedSelection(pending, { turnId: "turn2", reply: { ...reply, customText: "Forged message" } as GuidedReply, now })).toThrow("actual user reply");
    expect(() => confirmGuidedSelection(initial(), { turnId: turn.id, reply: { ...reply, turnId: turn.id }, now })).toThrow("actual user reply");
  });

  it("requires a recommendation with a reason but rejects preselected option payloads", () => {
    const reply = choices();
    expect(guidedReplySchema.safeParse({ ...reply, options: reply.options.map(option => ({ ...option, recommended: false })) }).success).toBe(false);
    expect(guidedReplySchema.safeParse({ ...reply, options: [{ ...reply.options[0], recommendationReason: null }] }).success).toBe(false);
    const option = reply.options[0]!;
    expect(guidedReplySchema.safeParse({ ...reply, options: [{ ...option, payload: { ...option.payload, selected: true } }] }).success).toBe(false);
  });

  it("asks positioning before personality, then waits for the name before the optional slogan", () => {
    let saved = confirmGuidedSelection(initial(), { turnId: turn.id, reply: choices(), optionIds: [ids[0]!], now });
    saved = appendGuidedTurn(saved, { id: "audience", stage: "audience", purpose: "propose", userMessageId: "prompt", inputRevision: 3 });
    saved = confirmGuidedSelection(saved, { turnId: "audience", now, optionIds: [ids[0]!], reply: guidedReplySchema.parse({ kind: "choices", turnId: "audience", stage: "audience", message: "Synthetic audience", question: "Who should we serve first?", selectionMode: "multiple",
      options: [{ id: ids[0], stage: "audience", label: "Office teams", description: "Shared office meals", recommended: true, recommendationReason: "Matches the offer", payload: { id: ids[0], label: "Office teams", needs: ["Dependable delivery"], reason: "Recurring demand", origin: "proposal", selected: false, sources: [] } }],
    }) });
    expect(saved.intake.guidedInterview?.stage).toBe("positioning");
    saved = appendGuidedTurn(saved, { id: "positioning", stage: "positioning", purpose: "propose", userMessageId: null, inputRevision: 4 });
    expect(guidedTurnOperation(saved.intake.guidedInterview!.turns.at(-1)!)).toBe("strategy.positioning");
    const direction = { angle: "Lunch that just arrives", statement: "For office teams, the bread subscription that shows up before anyone asks.", why: "Pairs a habit with reliability.", leads: ["Reliable", "Fresh"] };
    saved = confirmGuidedSelection(saved, { turnId: "positioning", now, optionIds: [ids[1]!], reply: guidedReplySchema.parse({ kind: "choices", turnId: "positioning", stage: "positioning", message: "Synthetic positioning", question: "How will you stand apart?", selectionMode: "single",
      options: [{ id: ids[1], stage: "positioning", label: direction.angle, description: direction.statement, recommended: true, recommendationReason: "Fits the audience", payload: direction }],
    }) });
    expect(saved.positioning).toBe(direction.statement);
    expect(saved.intake.positioningReviewedAt).toBe(now);
    expect(saved.intake.personalityReviewedAt).toBeNull();
    saved = appendGuidedTurn(saved, { id: "personality", stage: "personality", purpose: "propose", userMessageId: null, inputRevision: 5 });
    saved = confirmGuidedSelection(saved, { turnId: "personality", now, optionIds: [ids[0]!], reply: guidedReplySchema.parse({ kind: "choices", turnId: "personality", stage: "personality", message: "Synthetic direction", question: "How should this brand feel?", selectionMode: "single",
      options: [{ id: ids[0], stage: "personality", label: "Dependable warmth", description: "Friendly and reliable", recommended: true, recommendationReason: "Suited to everyday trust", payload: { profile, traits: ["Warm", "Reliable"], toneExample: "Good bread, right on time.", expression: "Plain language and warm colors" } }],
    }) });
    expect(saved.intake.guidedInterview?.stage).toBe("slogan");
    expect(saved.intake.step).toBe("personality");
    expect(saved.intake.guidedInterview?.answers).toHaveLength(4);
    expect(saved.personality).toEqual(profile);
    expect(saved.intake.positioningReviewedAt).toBe(now);
    expect(missingStrategy(saved)).toEqual([]);
    expect(saved.reformulationConfirmed).toBe(false);
    const sloganTurn = appendGuidedTurn({ ...saved, selectedName: "Crumb" }, { id: "slogan", stage: "slogan", purpose: "propose", userMessageId: null, inputRevision: 6 });
    expect(guidedTurnOperation(sloganTurn.intake.guidedInterview!.turns.at(-1)!)).toBe("strategy.slogan");
    const sloganReply = guidedReplySchema.parse({ kind: "choices", turnId: "slogan", stage: "slogan", message: "Synthetic slogans", question: "Which slogan sounds like you?", selectionMode: "single",
      options: [{ id: ids[0], stage: "slogan", label: "Bread, before the meeting.", description: "Reliability", recommended: true, recommendationReason: "Short and warm", payload: { slogan: "Bread, before the meeting." } }] });
    expect(guidedSlogan(confirmGuidedSelection(sloganTurn, { turnId: "slogan", reply: sloganReply, optionIds: [ids[0]!], now }))).toBe("Bread, before the meeting.");
    expect(guidedSlogan(confirmGuidedSelection(sloganTurn, { turnId: "slogan", reply: sloganReply, ownSlogan: "Warm bread, every desk.", now }))).toBe("Warm bread, every desk.");
    const skipped = skipGuidedSlogan(sloganTurn, { turnId: "slogan", now });
    expect(skipped.intake.guidedInterview?.stage).toBe("complete");
    expect(guidedSlogan(skipped)).toBeNull();
    saved = skipped;
    const clarification = appendGuidedTurn(contextSnapshotSchema.parse({ ...saved, intake: { ...saved.intake,
      conversation: [...saved.intake.conversation!, { id: "completed-clarification", kind: "user_message", text: "Why is this personality a good fit?", createdAt: now }],
      guidedInterview: { ...saved.intake.guidedInterview!, stage: "personality" },
    } }), { id: "clarification-after-completion", userMessageId: "completed-clarification", stage: "personality", purpose: "message", inputRevision: 7 });
    expect(missingStrategy(clarification)).toEqual([]);
    for (const kind of ["answer", "question"] as const) {
      const reply = guidedReplySchema.parse({ kind, turnId: "clarification-after-completion", stage: "personality", message: "Synthetic clarification", ...(kind === "question" ? { question: "Which trait would you like explained?" } : {}) });
      expect(() => confirmGuidedSelection(clarification, { turnId: reply.turnId, reply, now })).toThrow("does not confirm a decision");
      expect(missingStrategy(clarification)).toEqual([]);
    }
    expect(clarification.intake.audienceReviewedAt).toBe(saved.intake.audienceReviewedAt);
    expect(clarification.intake.personalityReviewedAt).toBe(saved.intake.personalityReviewedAt);
    const revisited = revisitGuidedStage(saved, "audience");
    expect(revisited.personality).toEqual(profile);
    expect(revisited.intake.personalityReviewedAt).toBeNull();
    expect(revisited.intake.positioningReviewedAt).toBeNull();
    expect(revisited.intake.guidedInterview?.answers).toHaveLength(1);
    expect(missingStrategy(revisited)).toContain("audience");
    const personalityAgain = revisitGuidedStage(saved, "personality");
    expect(personalityAgain.intake.positioningReviewedAt).toBe(now);
    expect(personalityAgain.intake.guidedInterview?.answers.map(answer => answer.stage)).toEqual(["competitors", "audience", "positioning"]);
  });

  it("rejects assistant text in saved metadata and duplicate decision references", () => {
    const state = initial().intake.guidedInterview!;
    expect(contextSnapshotSchema.safeParse({ ...context, intake: { ...context.intake, guidedInterview: { ...state, assistantMessage: "Fabricated output" } } }).success).toBe(false);
    expect(contextSnapshotSchema.safeParse({ ...context, intake: { ...context.intake, guidedInterview: { ...state, answers: [{ stage: "competitors", turnId: "unknown", optionIds: [], customText: "None", confirmedAt: now }] } } }).success).toBe(false);
  });

  it("keeps an explicit stage redirect distinct from confirmation and preserves content when composed with revisit", () => {
    const existing = contextSnapshotSchema.parse({ ...context, competitorReviewComplete: true, personality: profile,
      audienceSegments: [{ id: ids[0], label: "Office teams", needs: ["Delivery"], reason: "Recurring needs", selected: true, origin: "user", sources: [] }],
      intake: { ...context.intake, audienceReviewedAt: now, personalityReviewedAt: now,
        conversation: [...context.intake.conversation!, { id: "change-direction", kind: "user_message", text: "I want to revisit our target audience", createdAt: now }],
      },
    });
    const pending = initializeGuidedInterview(existing, { id: "redirect-turn", userMessageId: "change-direction", stage: "personality", purpose: "message", inputRevision: 4 });
    const reply = guidedReplySchema.parse({ kind: "redirect", turnId: "redirect-turn", stage: "personality", message: "Let's revisit the target audience.", targetStage: "audience" });
    expect(() => confirmGuidedSelection(pending, { turnId: reply.turnId, reply, now })).toThrow("does not confirm a decision");
    const next = appendGuidedTurn(revisitGuidedStage(pending, "audience"), { id: "revisit-audience", userMessageId: "change-direction", stage: "audience", purpose: "propose", inputRevision: 5 });
    expect(next.intake.guidedInterview?.stage).toBe("audience");
    expect(next.audienceSegments).toEqual(existing.audienceSegments);
    expect(next.personality).toEqual(profile);
    expect(next.intake.audienceReviewedAt).toBeNull();
    expect(next.intake.personalityReviewedAt).toBeNull();
    expect(next.intake.conversation).toEqual(existing.intake.conversation);
    expect(guidedReplySchema.safeParse({ ...reply, targetStage: "personality" }).success).toBe(false);
    expect(guidedReplySchema.safeParse({ ...reply, targetStage: "positioning" }).success).toBe(true);
    expect(guidedReplySchema.safeParse({ ...reply, targetStage: "naming" }).success).toBe(false);
    expect(guidedReplySchema.safeParse({ ...reply, kind: "answer" }).success).toBe(false);
    expect(guidedReplySchema.safeParse({ ...reply, stage: "competitors", targetStage: "competitors" }).success).toBe(true);
  });
});
