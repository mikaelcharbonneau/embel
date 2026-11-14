import { z } from "zod";
import { namingSourceSchema } from "./naming";
import { conversationSchema } from "./conversation";

/** Every project is a complete brand. "Name only" and "Visual identity" projects
 * were retired on November 9, 2026, and live ones were converted to complete brands. */
export const projectScopeSchema = z.literal("complete_brand");
export type ProjectScope = z.infer<typeof projectScopeSchema>;
/** Saved Identity history keeps the scope it was made with, including retired ones. */
export const recordedProjectScopeSchema = z.enum(["complete_brand", "naming_only", "visual_identity_only"]);
const projectStageSchema = z.enum(["discovery", "strategy", "naming", "identity", "guidelines"]);
const standaloneKindSchema = z.enum(["idea", "name", "handle", "domain", "trademark"]);

const researchSourceSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string().trim().min(1).max(300),
  retrievedAt: z.iso.datetime({ offset: true }),
});

const checkEvidenceSchema = z.strictObject({
  id: z.string().min(1).max(128),
  provider: z.string().trim().min(1).max(100),
  method: z.string().trim().min(1).max(100),
  checkedAt: z.iso.datetime({ offset: true }),
  // A stored check is evidence of that observation only, never purchase or clearance.
  status: z.enum(["unknown", "not_checked", "available", "unavailable", "inconclusive", "blocked"]),
  sourceUrl: z.url({ protocol: /^https?$/ }).optional(),
  limitations: z.string().max(2000).optional(),
});

export const audienceSegmentSchema = z.strictObject({
  id: z.uuid(),
  label: z.string().trim().min(1).max(180),
  needs: z.array(z.string().trim().min(1).max(2000)).max(12),
  reason: z.string().trim().max(2000),
  selected: z.boolean().default(false),
  origin: z.enum(["user", "proposal"]),
  sources: z.array(researchSourceSchema).max(20).default([]),
});

/** User-provided websites are references only. They are never fetched by this contract. */
export const competitorWebsiteSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      if (/[\u0000-\u0020\u007f]/u.test(value)) return false;
      try {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          Boolean(url.hostname) &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    },
    { message: "Use a complete http:// or https:// website without login details." },
  );

export const competitorSchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string().trim().min(1).max(160),
    relevance: z.string().trim().max(2000),
    url: competitorWebsiteSchema.optional(),
    origin: z.enum(["user", "research"]),
    selected: z.boolean().default(false),
    sources: z.array(researchSourceSchema).max(20).default([]),
  })
  .refine((value) => value.origin !== "research" || value.sources.length > 0, {
    message: "Researched competitors require a source",
    path: ["sources"],
  });

export const personalitySchema = z.strictObject({
  sincerity: z.number().int().min(0).max(100),
  excitement: z.number().int().min(0).max(100),
  competence: z.number().int().min(0).max(100),
  sophistication: z.number().int().min(0).max(100),
  ruggedness: z.number().int().min(0).max(100),
});
export type Personality = z.infer<typeof personalitySchema>;

export const guidedStageSchema = z.enum(["competitors", "audience", "positioning", "personality", "slogan"]);
export type GuidedStage = z.infer<typeof guidedStageSchema>;
const guidedIdentifier = z.string().min(1).max(128);
export const guidedTurnSchema = z
  .strictObject({
    id: guidedIdentifier,
    userMessageId: guidedIdentifier.nullable(),
    stage: guidedStageSchema,
    purpose: z.enum(["research", "message", "propose"]),
    inputRevision: z.number().int().positive(),
  })
  .superRefine((turn, ctx) => {
    if (turn.purpose !== "propose" && turn.userMessageId === null) {
      ctx.addIssue({
        code: "custom",
        path: ["userMessageId"],
        message: "Research and replies must reference an actual user message",
      });
    }
    if (turn.purpose === "research" && turn.stage !== "competitors") {
      ctx.addIssue({ code: "custom", path: ["stage"], message: "Research belongs to the competitors stage" });
    }
  });
export type GuidedTurn = z.infer<typeof guidedTurnSchema>;
const guidedAnswerSchema = z
  .strictObject({
    stage: guidedStageSchema,
    turnId: guidedIdentifier,
    optionIds: z.array(guidedIdentifier).max(20),
    customText: z.string().trim().min(1).max(12_000).nullable(),
    confirmedAt: z.iso.datetime({ offset: true }),
  })
  .refine((answer) => new Set(answer.optionIds).size === answer.optionIds.length, {
    message: "Selected options must be unique",
  });
/** User decisions and request references only. Assistant content belongs to owned job results. */
export const guidedInterviewStateSchema = z
  .strictObject({
    version: z.literal(1),
    stage: z.enum(["competitors", "audience", "positioning", "personality", "slogan", "complete"]),
    turns: z.array(guidedTurnSchema).max(48),
    answers: z.array(guidedAnswerSchema).max(5),
  })
  .superRefine((state, ctx) => {
    if (new Set(state.turns.map((turn) => turn.id)).size !== state.turns.length)
      ctx.addIssue({ code: "custom", path: ["turns"], message: "Interview turns must have unique identifiers" });
    if (state.turns.some((turn, index) => index > 0 && turn.inputRevision <= state.turns[index - 1]!.inputRevision))
      ctx.addIssue({
        code: "custom",
        path: ["turns"],
        message: "Interview turns must follow increasing saved revisions",
      });
    if (new Set(state.answers.map((answer) => answer.stage)).size !== state.answers.length)
      ctx.addIssue({ code: "custom", path: ["answers"], message: "Each stage has one current decision" });
    for (const [index, answer] of state.answers.entries()) {
      if (!state.turns.some((turn) => turn.id === answer.turnId && turn.stage === answer.stage))
        ctx.addIssue({
          code: "custom",
          path: ["answers", index, "turnId"],
          message: "A decision must reference its interview turn",
        });
    }
    if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 32_768)
      ctx.addIssue({ code: "custom", message: "Interview metadata exceeds its byte limit" });
  });
export type GuidedInterviewState = z.infer<typeof guidedInterviewStateSchema>;

/** User-supplied intake details and edit position; never proof of generated output. */
export const intakeDetailsSchema = z.strictObject({
  suppliedName: z.string().max(180).default(""),
  namingNotes: z.string().max(2000).default(""),
  identityNotes: z.string().max(2000).default(""),
  step: z.enum(["description", "review", "competitors", "audience", "personality", "positioning"]).default("review"),
  audienceReviewedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  personalityReviewedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  positioningReviewedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  conversation: conversationSchema.optional(),
  guidedInterview: guidedInterviewStateSchema.optional(),
  example: z.boolean().default(false),
});

export const contextSnapshotSchema = z
  .strictObject({
    description: z.string().trim().max(12000).default(""),
    activity: z.string().trim().max(2000).default(""),
    offering: z.string().trim().max(2000).default(""),
    knownAudience: z.string().trim().max(2000).default(""),
    reformulationConfirmed: z.boolean().default(false),
    audienceSegments: z.array(audienceSegmentSchema).max(30).default([]),
    competitors: z.array(competitorSchema).max(50).default([]),
    competitorReviewComplete: z.boolean().default(false),
    personality: personalitySchema.nullable().default(null),
    positioning: z.string().trim().max(5000).default(""),
    selectedName: z.string().trim().max(200).nullable().default(null),
    // Original standalone source, retained when a later explicit name edit changes selectedName.
    namingSource: namingSourceSchema.optional(),
    creativeLocale: z.string().trim().min(2).max(30).default("en"),
    intake: intakeDetailsSchema.default(() => intakeDetailsSchema.parse({})),
  })
  .superRefine((context, ctx) => {
    for (const [index, turn] of (context.intake.guidedInterview?.turns ?? []).entries()) {
      if (
        turn.userMessageId !== null &&
        !context.intake.conversation?.some((event) => event.kind === "user_message" && event.id === turn.userMessageId)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["intake", "guidedInterview", "turns", index, "userMessageId"],
          message: "Interview turns must reference actual user messages",
        });
      }
    }
    for (const key of ["audienceSegments", "competitors"] as const) {
      const ids = context[key].map((item) => item.id);
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: "custom", path: [key], message: "Duplicate item identifier" });
    }
    if (context.reformulationConfirmed && (!context.activity || !context.offering)) {
      ctx.addIssue({
        code: "custom",
        path: ["reformulationConfirmed"],
        message: "Confirm activity and offering before continuing",
      });
    }
    if (context.competitorReviewComplete) {
      context.competitors.forEach((competitor, index) => {
        if (competitor.selected && !competitor.relevance)
          ctx.addIssue({
            code: "custom",
            path: ["competitors", index, "relevance"],
            message: "Add a relevance reason for every retained competitor before completing the review",
          });
      });
    }
    if (context.intake.personalityReviewedAt && !context.personality) {
      ctx.addIssue({
        code: "custom",
        path: ["intake", "personalityReviewedAt"],
        message: "Choose a personality profile before confirming its review",
      });
    }
    if (context.intake.positioningReviewedAt) {
      if (!context.positioning)
        ctx.addIssue({
          code: "custom",
          path: ["positioning"],
          message: "Write a positioning statement before confirming its review",
        });
      // The guided interview asks positioning before personality; the older form asked it last.
      if (!context.intake.guidedInterview && !context.intake.personalityReviewedAt)
        ctx.addIssue({
          code: "custom",
          path: ["intake", "positioningReviewedAt"],
          message: "Review the personality before confirming positioning",
        });
    }
  });
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;

const originSchema = z.strictObject({
  kind: standaloneKindSchema,
  sourceId: z.uuid(),
  evidence: z.array(checkEvidenceSchema).max(100),
  promotedAt: z.iso.datetime({ offset: true }),
});

export const projectSchema = z.strictObject({
  id: z.uuid(),
  ownerId: z.uuid(),
  title: z.string().trim().min(1).max(160),
  scope: projectScopeSchema,
  stage: projectStageSchema,
  revision: z.number().int().positive(),
  context: contextSnapshotSchema,
  origin: originSchema.optional(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  scope: projectScopeSchema,
  context: contextSnapshotSchema,
  requestKey: z.uuid().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export function missingStrategy(context: ContextSnapshot) {
  const missing: Array<"reformulation" | "competitors" | "audience" | "personality" | "positioning"> = [];
  if (!context.intake.guidedInterview && !context.reformulationConfirmed) missing.push("reformulation");
  if (!context.competitorReviewComplete) missing.push("competitors");
  if (
    !context.audienceSegments.some((segment) => segment.selected) ||
    (context.intake.guidedInterview && !context.intake.audienceReviewedAt)
  )
    missing.push("audience");
  if (!context.personality || !context.intake.personalityReviewedAt) missing.push("personality");
  if (!context.intake.guidedInterview && (!context.positioning || !context.intake.positioningReviewedAt))
    missing.push("positioning");
  return missing;
}

const standaloneSourceSchema = z.strictObject({
  id: z.uuid(),
  ownerId: z.uuid(),
  kind: standaloneKindSchema,
  label: z.string().trim().min(1).max(160),
  context: contextSnapshotSchema,
  evidence: z.array(checkEvidenceSchema).max(100),
});
type StandaloneSource = z.infer<typeof standaloneSourceSchema>;

/** Persistence must load this source through an authenticated, owner-scoped repository. */
export function createBrandFromStandalone(input: {
  actorId: string;
  projectId: string;
  source: StandaloneSource;
  now: string;
}): Project {
  if (input.source.ownerId !== input.actorId) throw new Error("Source not found");
  const source = standaloneSourceSchema.parse(input.source);
  return projectSchema.parse({
    id: input.projectId,
    ownerId: input.actorId,
    title: source.label,
    scope: "complete_brand",
    stage: source.context.reformulationConfirmed ? "strategy" : "discovery",
    revision: 1,
    context: structuredClone(source.context),
    origin: {
      kind: source.kind,
      sourceId: source.id,
      evidence: structuredClone(source.evidence),
      promotedAt: input.now,
    },
    createdAt: input.now,
    updatedAt: input.now,
  });
}
