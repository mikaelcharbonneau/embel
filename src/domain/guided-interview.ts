import { z } from "zod";
import {
  audienceSegmentSchema,
  competitorSchema,
  contextSnapshotSchema,
  guidedInterviewStateSchema,
  guidedStageSchema,
  guidedTurnSchema,
  personalitySchema,
  type ContextSnapshot,
  type GuidedInterviewState,
  type GuidedStage,
  type GuidedTurn,
} from "./projects";

export { guidedInterviewStateSchema, guidedStageSchema, guidedTurnSchema };
export type { GuidedInterviewState, GuidedStage, GuidedTurn };
/** Strategy (competitors, audience, positioning), then Voice (personality, and
 * the optional slogan once a name is chosen). Naming runs between the two. */
export const GUIDED_STAGES: readonly GuidedStage[] = [
  "competitors",
  "audience",
  "positioning",
  "personality",
  "slogan",
];
/** The saved intake step has a fixed vocabulary; the slogan step reuses personality. */
export function guidedIntakeStep(
  stage: GuidedStage | "complete",
): "competitors" | "audience" | "positioning" | "personality" {
  return stage === "slogan" || stage === "complete" ? "personality" : stage;
}

const identifier = z.string().min(1).max(128);
const unselectedCompetitor = competitorSchema.refine((value) => !value.selected && Boolean(value.relevance), {
  message: "Competitor options need a relevance reason and require the user's selection",
});
const unselectedAudience = audienceSegmentSchema.refine(
  (value) => !value.selected && value.sources.length === 0 && Boolean(value.reason),
  { message: "Audience options need a rationale and remain unselected hypotheses, not sourced research" },
);
export const guidedPersonalityDirectionSchema = z.strictObject({
  profile: personalitySchema,
  traits: z.array(z.string().trim().min(1).max(120)).min(1).max(8),
  toneExample: z.string().trim().min(1).max(1000),
  expression: z.string().trim().min(1).max(1500),
});
export const guidedPositioningDirectionSchema = z.strictObject({
  angle: z.string().trim().min(1).max(180),
  statement: z.string().trim().min(1).max(1000),
  why: z.string().trim().min(1).max(1000),
  leads: z.array(z.string().trim().min(1).max(60)).min(1).max(5),
});
export const guidedSloganSchema = z.strictObject({ slogan: z.string().trim().min(1).max(120) });
const optionFields = {
  id: identifier,
  label: z.string().trim().min(1).max(180),
  description: z.string().trim().min(1).max(2000),
  recommended: z.boolean(),
  recommendationReason: z.string().trim().min(1).max(1000).nullable(),
};
export const guidedOptionSchema = z
  .discriminatedUnion("stage", [
    z.strictObject({ ...optionFields, stage: z.literal("competitors"), payload: unselectedCompetitor }),
    z.strictObject({ ...optionFields, stage: z.literal("audience"), payload: unselectedAudience }),
    z.strictObject({ ...optionFields, stage: z.literal("positioning"), payload: guidedPositioningDirectionSchema }),
    z.strictObject({ ...optionFields, stage: z.literal("personality"), payload: guidedPersonalityDirectionSchema }),
    z.strictObject({ ...optionFields, stage: z.literal("slogan"), payload: guidedSloganSchema }),
  ])
  .superRefine((option, ctx) => {
    if (option.recommended && !option.recommendationReason)
      ctx.addIssue({ code: "custom", path: ["recommendationReason"], message: "Explain each recommended option" });
    if ((option.stage === "competitors" || option.stage === "audience") && option.id !== option.payload.id)
      ctx.addIssue({ code: "custom", path: ["id"], message: "Option identifiers must match their domain payload" });
  });
/** One choice: a positioning, a personality or a slogan. Competitors and audiences take several. */
export function guidedSingleChoice(stage: GuidedStage): boolean {
  return stage === "positioning" || stage === "personality" || stage === "slogan";
}
export type GuidedOption = z.infer<typeof guidedOptionSchema>;
export const guidedSelectionSchema = z
  .discriminatedUnion("stage", [
    z.strictObject({ stage: z.literal("competitors"), competitors: z.array(unselectedCompetitor).max(20) }),
    z.strictObject({ stage: z.literal("audience"), audienceSegments: z.array(unselectedAudience).min(1).max(12) }),
    z.strictObject({ stage: z.literal("positioning"), positioning: guidedPositioningDirectionSchema }),
    z.strictObject({ stage: z.literal("personality"), personality: personalitySchema }),
    z.strictObject({ stage: z.literal("slogan"), slogan: z.string().trim().min(1).max(120) }),
  ])
  .refine(
    (selection) => {
      const entries =
        selection.stage === "competitors"
          ? selection.competitors
          : selection.stage === "audience"
            ? selection.audienceSegments
            : [];
      return new Set(entries.map((entry) => entry.id)).size === entries.length;
    },
    { message: "A decision cannot contain duplicate domain items" },
  );
export type GuidedSelection = z.infer<typeof guidedSelectionSchema>;
const replyFields = { turnId: identifier, stage: guidedStageSchema, message: z.string().trim().min(1).max(6000) };
export const guidedReplySchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...replyFields,
      kind: z.literal("choices"),
      question: z.string().trim().min(1).max(1000),
      selectionMode: z.enum(["single", "multiple"]),
      options: z.array(guidedOptionSchema).min(1).max(12),
    }),
    z.strictObject({ ...replyFields, kind: z.literal("question"), question: z.string().trim().min(1).max(1000) }),
    z.strictObject({ ...replyFields, kind: z.literal("answer") }),
    z.strictObject({
      ...replyFields,
      kind: z.literal("accepted"),
      selection: guidedSelectionSchema,
      customText: z.string().trim().min(1).max(12_000),
    }),
    z.strictObject({ ...replyFields, kind: z.literal("redirect"), targetStage: guidedStageSchema }),
  ])
  .superRefine((reply, ctx) => {
    if (reply.kind === "accepted" && reply.selection.stage !== reply.stage)
      ctx.addIssue({ code: "custom", path: ["selection"], message: "A decision must belong to the current stage" });
    if (reply.kind === "redirect" && reply.targetStage === reply.stage && reply.stage !== "competitors")
      ctx.addIssue({
        code: "custom",
        path: ["targetStage"],
        message: "Only competitor research may continue through a same-stage redirect",
      });
    if (reply.kind !== "choices") return;
    if (reply.options.some((option) => option.stage !== reply.stage))
      ctx.addIssue({ code: "custom", path: ["options"], message: "Show one focused strategy stage at a time" });
    if (new Set(reply.options.map((option) => option.id)).size !== reply.options.length)
      ctx.addIssue({ code: "custom", path: ["options"], message: "Options need unique identifiers" });
    if (!reply.options.some((option) => option.recommended))
      ctx.addIssue({ code: "custom", path: ["options"], message: "Explain at least one recommended starting choice" });
    if (reply.selectionMode !== (guidedSingleChoice(reply.stage) ? "single" : "multiple"))
      ctx.addIssue({
        code: "custom",
        path: ["selectionMode"],
        message: "Choose one positioning, personality or slogan, or multiple competitors and audiences",
      });
  });
export type GuidedReply = z.infer<typeof guidedReplySchema>;

/** Absence remains absence: reading an old snapshot never fabricates an interview. */
export function parseGuidedInterview(context: ContextSnapshot): GuidedInterviewState | null {
  return context.intake.guidedInterview ? guidedInterviewStateSchema.parse(context.intake.guidedInterview) : null;
}

/** Adds only metadata. Callers supply real conversation events and the saved revision. */
export function initializeGuidedInterview(context: ContextSnapshot, initialTurn?: GuidedTurn): ContextSnapshot {
  const parsed = contextSnapshotSchema.parse(context);
  if (parsed.intake.guidedInterview) return initialTurn ? appendGuidedTurn(parsed, initialTurn) : parsed;
  const stage =
    initialTurn?.stage ??
    (!parsed.competitorReviewComplete
      ? "competitors"
      : !parsed.intake.audienceReviewedAt || !parsed.audienceSegments.some((segment) => segment.selected)
        ? "audience"
        : !parsed.intake.positioningReviewedAt || !parsed.positioning
          ? "positioning"
          : !parsed.intake.personalityReviewedAt || !parsed.personality
            ? "personality"
            : "complete");
  const initialized = contextSnapshotSchema.parse({
    ...parsed,
    intake: { ...parsed.intake, guidedInterview: { version: 1, stage, turns: [], answers: [] } },
  });
  return initialTurn ? appendGuidedTurn(initialized, initialTurn) : initialized;
}

export function appendGuidedTurn(context: ContextSnapshot, turn: GuidedTurn): ContextSnapshot {
  const parsed = contextSnapshotSchema.parse(context);
  const state = parseGuidedInterview(parsed);
  const nextTurn = guidedTurnSchema.parse(turn);
  if (!state || state.stage !== nextTurn.stage) throw new Error("Request a reply for the current interview stage");
  return contextSnapshotSchema.parse({
    ...parsed,
    intake: {
      ...parsed.intake,
      step: guidedIntakeStep(nextTurn.stage),
      guidedInterview: { ...state, turns: [...state.turns, nextTurn] },
    },
  });
}

export function guidedTurnOperation(turn: GuidedTurn): "strategy.reformulate" | `strategy.${GuidedStage}` {
  return turn.purpose === "message" ? "strategy.reformulate" : `strategy.${turn.stage}`;
}

function mergeSelections<T extends { id: string; selected: boolean }>(previous: T[], selected: T[]): T[] {
  const result = new Map(previous.map((item) => [item.id, { ...item, selected: false }]));
  for (const item of selected) result.set(item.id, { ...item, selected: true });
  return [...result.values()];
}

export const retainedCompetitorAnswerPrefix = "Retained competitors: ";

/** The caller must load the current choices from an owned immutable job result.
 * Clarification turns retain that widget; accepted free text must be the latest turn. */
export function confirmGuidedSelection(
  context: ContextSnapshot,
  input: {
    turnId: string;
    reply: GuidedReply;
    optionIds?: readonly string[];
    retainedCompetitorIds?: readonly string[];
    customText?: string;
    /** A slogan the user wrote in the slogan widget instead of choosing a card. */
    ownSlogan?: string;
    now: string;
  },
): ContextSnapshot {
  const parsed = contextSnapshotSchema.parse(context);
  const state = parseGuidedInterview(parsed);
  const reply = guidedReplySchema.parse(input.reply);
  const turn = state?.turns.find((turn) => turn.id === input.turnId);
  if (
    !state ||
    !turn ||
    turn.id !== input.turnId ||
    reply.turnId !== turn.id ||
    reply.stage !== state.stage ||
    turn.stage !== state.stage ||
    state.answers.some((answer) => answer.turnId === turn.id)
  )
    throw new Error("This reply is no longer the current interview turn");
  let selection!: GuidedSelection;
  let optionIds: string[] = [];
  let customText: string | null = null;
  if (reply.kind === "choices") {
    optionIds = [...(input.optionIds ?? [])];
    const retainedIds = reply.stage === "competitors" ? [...(input.retainedCompetitorIds ?? [])] : [];
    const own = reply.stage === "slogan" ? (input.ownSlogan?.trim() ?? "") : "";
    if (own && !optionIds.length) {
      if (own.length > 120) throw new Error("Keep your slogan under 120 characters");
      selection = { stage: "slogan", slogan: own };
      customText = own;
    } else if (
      optionIds.length + retainedIds.length > 20 ||
      (!optionIds.length && !retainedIds.length) ||
      new Set(retainedIds).size !== retainedIds.length ||
      new Set(optionIds).size !== optionIds.length ||
      (reply.selectionMode === "single" && optionIds.length !== 1)
    )
      throw new Error("Choose an option before continuing");
    const options = optionIds.map((id) => reply.options.find((option) => option.id === id));
    if (options.some((option) => !option)) throw new Error("Choose an option from this reply");
    if (own && !optionIds.length) {
      /* The user's own slogan is the decision. */
    } else if (reply.stage === "competitors") {
      const retained = retainedIds.map((id) => parsed.competitors.find((item) => item.id === id));
      if (retained.some((item) => !item)) throw new Error("Choose a competitor saved in this project");
      selection = {
        stage: "competitors",
        competitors: [
          ...options.flatMap((option) => (option?.stage === "competitors" ? [option.payload] : [])),
          ...retained.flatMap((item) => (item ? [{ ...item, selected: false }] : [])),
        ],
      };
      if (retained.length) customText = retainedCompetitorAnswerPrefix + retained.map((item) => item!.name).join("; ");
    } else if (reply.stage === "audience")
      selection = {
        stage: "audience",
        audienceSegments: options.flatMap((option) => (option?.stage === "audience" ? [option.payload] : [])),
      };
    else if (reply.stage === "positioning") {
      const direction = options[0];
      if (direction?.stage !== "positioning") throw new Error("Choose a positioning");
      selection = { stage: "positioning", positioning: direction.payload };
    } else if (reply.stage === "slogan") {
      const choice = options[0];
      if (choice?.stage !== "slogan") throw new Error("Choose a slogan");
      selection = { stage: "slogan", slogan: choice.payload.slogan };
      customText = choice.payload.slogan;
    } else {
      const direction = options[0];
      if (direction?.stage !== "personality") throw new Error("Choose a personality direction");
      selection = { stage: "personality", personality: direction.payload.profile };
    }
  } else if (reply.kind === "accepted") {
    const event = parsed.intake.conversation?.find(
      (event) => event.kind === "user_message" && event.id === turn.userMessageId,
    );
    if (
      state.turns.at(-1)?.id !== turn.id ||
      turn.purpose !== "message" ||
      event?.kind !== "user_message" ||
      event.text.trim() !== reply.customText ||
      (input.customText !== undefined && input.customText.trim() !== reply.customText)
    )
      throw new Error("A custom decision must match the actual user reply");
    customText = reply.customText;
    selection = reply.selection;
  } else throw new Error("This reply asks for clarification and does not confirm a decision");
  const stageIndex = GUIDED_STAGES.indexOf(reply.stage);
  const nextState: GuidedInterviewState = {
    ...state,
    stage: GUIDED_STAGES[stageIndex + 1] ?? "complete",
    answers: [
      ...state.answers.filter((answer) => GUIDED_STAGES.indexOf(answer.stage) < stageIndex),
      { stage: reply.stage, turnId: turn.id, optionIds, customText, confirmedAt: input.now },
    ],
  };
  const next: ContextSnapshot = {
    ...parsed,
    intake: { ...parsed.intake, guidedInterview: nextState, step: guidedIntakeStep(nextState.stage) },
  };
  // A changed decision reopens what was built on it: later reviews are cleared.
  if (selection.stage === "competitors") {
    // A competitor you added by name, once chosen in its researched form, is that
    // researched entry (website, offer, sources) rather than a second copy.
    const researched = new Set(
      selection.competitors.filter((item) => item.origin === "research").map((item) => item.name.trim().toLowerCase()),
    );
    next.competitors = mergeSelections(
      parsed.competitors.filter((item) => item.origin !== "user" || !researched.has(item.name.trim().toLowerCase())),
      selection.competitors,
    );
    next.competitorReviewComplete = true;
    next.intake.audienceReviewedAt = null;
    next.intake.positioningReviewedAt = null;
    next.intake.personalityReviewedAt = null;
  } else if (selection.stage === "audience") {
    next.audienceSegments = mergeSelections(parsed.audienceSegments, selection.audienceSegments);
    next.intake.audienceReviewedAt = input.now;
    next.intake.positioningReviewedAt = null;
    next.intake.personalityReviewedAt = null;
  } else if (selection.stage === "positioning") {
    next.positioning = selection.positioning.statement;
    next.intake.positioningReviewedAt = input.now;
    next.intake.personalityReviewedAt = null;
  } else if (selection.stage === "personality") {
    next.personality = selection.personality;
    next.intake.personalityReviewedAt = input.now;
  }
  return contextSnapshotSchema.parse(next);
}

/** Explicit revisiting retains all typed content while invalidating downstream review. */
export function revisitGuidedStage(context: ContextSnapshot, stage: GuidedStage): ContextSnapshot {
  const parsed = initializeGuidedInterview(context);
  const state = parsed.intake.guidedInterview!;
  const stageIndex = GUIDED_STAGES.indexOf(stage);
  const reopens = (later: GuidedStage) => GUIDED_STAGES.indexOf(later) >= stageIndex;
  return contextSnapshotSchema.parse({
    ...parsed,
    ...(stage === "competitors" ? { competitorReviewComplete: false } : {}),
    intake: {
      ...parsed.intake,
      step: guidedIntakeStep(stage),
      ...(reopens("audience") ? { audienceReviewedAt: null } : {}),
      ...(reopens("positioning") ? { positioningReviewedAt: null } : {}),
      ...(reopens("personality") ? { personalityReviewedAt: null } : {}),
      guidedInterview: {
        ...state,
        stage,
        answers: state.answers.filter((answer) => GUIDED_STAGES.indexOf(answer.stage) < stageIndex),
      },
    },
  });
}

/** The slogan is optional: skipping records the decision without one. */
export function skipGuidedSlogan(context: ContextSnapshot, input: { turnId: string; now: string }): ContextSnapshot {
  const parsed = contextSnapshotSchema.parse(context);
  const state = parseGuidedInterview(parsed);
  const turn = state?.turns.find((item) => item.id === input.turnId);
  if (!state || state.stage !== "slogan" || turn?.stage !== "slogan") throw new Error("The slogan step is not open");
  return contextSnapshotSchema.parse({
    ...parsed,
    intake: {
      ...parsed.intake,
      guidedInterview: {
        ...state,
        stage: "complete",
        answers: [
          ...state.answers.filter((answer) => answer.stage !== "slogan"),
          { stage: "slogan", turnId: turn.id, optionIds: [], customText: null, confirmedAt: input.now },
        ],
      },
    },
  });
}

/** The chosen slogan, or null when none was chosen (skipped or not reached). */
export function guidedSlogan(context: ContextSnapshot): string | null {
  return context.intake.guidedInterview?.answers.find((answer) => answer.stage === "slogan")?.customText ?? null;
}
