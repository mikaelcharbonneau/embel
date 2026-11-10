import { describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { strategyJobSchema } from "@/domain/strategy-jobs";
import { appendGuidedTurn, initializeGuidedInterview } from "@/domain/guided-interview";
import {
  guidedAllowance,
  guidedMessageContext,
  guidedTimeline,
  guidedTurnResult,
  initialGuidedContext,
  nextGuidedProposal,
  withoutScoreScaleNote,
} from "@/components/workspace/guided-interview-client";
import { accountProjectDraft, draftContext } from "@/components/workspace/project-draft-adapter";
import { accountProjectSchema } from "@/domain/project-api";
import { accountDraftChanged, createAccountDraftMemory } from "@/components/workspace/account-draft-memory";

const now = "2026-10-14T20:00:00Z";
const ownerId = "aaaaaaaa-1111-4111-8111-111111111111",
  projectId = "bbbbbbbb-1111-4111-8111-111111111111";
function initial() {
  return initialGuidedContext(
    contextSnapshotSchema.parse({
      description: "A neighborhood bakery",
      intake: {
        conversation: [{ id: "initial-user", kind: "user_message", text: "A neighborhood bakery", createdAt: now }],
      },
    }),
    1,
    now,
  );
}
function job(context = initial()) {
  const turn = context.intake.guidedInterview!.turns[0]!;
  return strategyJobSchema.parse({
    id: "cccccccc-1111-4111-8111-111111111111",
    owner_id: ownerId,
    project_id: projectId,
    operation: "strategy.competitors",
    input_revision: 1,
    state: "succeeded",
    progress: 100,
    error_code: null,
    cancel_requested_at: null,
    created_at: now,
    finished_at: now,
    reserved_cost_microusd: 15_892_880,
    actual_cost_microusd: 1000,
    results: [
      {
        stepKey: "guided-result",
        output: {
          version: 1,
          provider: "openai",
          model: "fixture",
          responseId: "fixture",
          requestId: null,
          generatedAt: now,
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            webSearchCalls: 1,
          },
          operation: "strategy.competitors",
          proposal: { message: "A focused question", competitors: [] },
          guidance: {
            kind: "question",
            turnId: turn.id,
            stage: "competitors",
            message: "I need one useful detail.",
            question: "Which city will you serve?",
          },
        },
      },
    ],
  });
}

describe("guided conversation client boundaries", () => {
  it("requires the exact guided runtime marker and never silently uses legacy or subscription policies", () => {
    expect(
      guidedAllowance(
        { status: "available", operations: [{ operation: "strategy.competitors", maximumCostMicrousd: 123 }] },
        "strategy.competitors",
      ),
    ).toBeNull();
    expect(
      guidedAllowance(
        {
          status: "available",
          operations: [{ operation: "strategy.competitors", maximumCostMicrousd: 123, interviewVersion: 1 }],
        },
        "strategy.competitors",
      ),
    ).toEqual({ billingMode: "openai_api", maximumCostMicrousd: 123 });
    expect(
      guidedAllowance({ status: "unavailable", operations: [], reason: "worker_unavailable" }, "strategy.competitors"),
    ).toBeNull();
  });

  it("starts research from the actual prompt without adding an assistant or duplicate user event", () => {
    const context = initial();
    expect(context.intake.conversation).toHaveLength(1);
    expect(context.intake.guidedInterview!.turns[0]).toMatchObject({
      purpose: "research",
      inputRevision: 1,
      userMessageId: "initial-user",
      stage: "competitors",
    });
    expect(guidedTimeline(context).map((item) => item.kind)).toEqual(["user", "turn"]);
  });

  it("binds provider content to the owned project, operation, revision, stage and exact turn", () => {
    const context = initial(),
      result = job(context),
      turn = context.intake.guidedInterview!.turns[0]!;
    expect(guidedTurnResult([result], turn, ownerId, projectId)?.reply?.kind).toBe("question");
    expect(guidedTurnResult([result], turn, crypto.randomUUID(), projectId)).toBeNull();
    expect(guidedTurnResult([result], turn, ownerId, crypto.randomUUID())).toBeNull();
    expect(guidedTurnResult([{ ...result, input_revision: 2 }], turn, ownerId, projectId)).toBeNull();
    expect(guidedTurnResult([result], { ...turn, id: "wrong-turn" }, ownerId, projectId)?.reply).toBeNull();
    expect(guidedTurnResult([{ ...result, state: "running" }], turn, ownerId, projectId)?.reply).toBeNull();
  });

  it("anchors automatic next questions to actual selection messages without duplicating custom replies", () => {
    let context = guidedMessageContext(initial(), "Why this comparison?", 2, now);
    const anchor = context.intake.guidedInterview!.turns.at(-1)!.userMessageId;
    context = appendGuidedTurn(context, {
      id: "proposal",
      userMessageId: anchor,
      inputRevision: 3,
      purpose: "propose",
      stage: "competitors",
    });
    const items = guidedTimeline(context);
    expect(items.filter((item) => item.kind === "user")).toHaveLength(2);
    expect(items.map((item) => item.kind)).toEqual(["user", "turn", "user", "turn", "turn"]);
    expect(nextGuidedProposal(context, 4, anchor).intake.guidedInterview!.turns.at(-1)).toMatchObject({
      purpose: "propose",
      inputRevision: 4,
      userMessageId: anchor,
    });
  });

  it("retains guided state through the old draft adapter and protects failed automatic saves in account memory", () => {
    const project = accountProjectSchema.parse({
      id: projectId,
      owner_id: ownerId,
      scope: "complete_brand",
      title: "Bakery",
      current_revision: 1,
      created_at: now,
      context: initial(),
    });
    const draft = accountProjectDraft(project);
    expect(draftContext(draft, project.context)).toEqual(project.context);
    const memory = createAccountDraftMemory();
    const workspace = { ownerId, generation: 1, saved: project, draft, conflict: false };
    expect(accountDraftChanged(workspace)).toBe(false);
    const pendingGuidedContext = guidedMessageContext(project.context, "Toronto", 2, now);
    memory.set({ ...workspace, pendingGuidedContext });
    expect(memory.hasUnsaved()).toBe(true);
    expect(memory.get(projectId)?.pendingGuidedContext).toEqual(pendingGuidedContext);
    memory.clear();
    expect(memory.get(projectId)).toBeNull();
  });

  it("does not create an extra proposal after the completed personality decision", () => {
    const context = initializeGuidedInterview(contextSnapshotSchema.parse({}));
    const complete = contextSnapshotSchema.parse({
      ...context,
      intake: { ...context.intake, guidedInterview: { ...context.intake.guidedInterview!, stage: "complete" } },
    });
    expect(nextGuidedProposal(complete, 2, null)).toEqual(complete);
  });
});

describe("personality replies", () => {
  it("leave out how the scores are scaled and keep everything else", () => {
    expect(
      withoutScoreScaleNote(
        "Here are three directions. Scores use independent 1–5 scales for each Aaker personality dimension; they are not percentage allocations. Pick the one that feels right.",
      ),
    ).toBe("Here are three directions. Pick the one that feels right.");
    expect(withoutScoreScaleNote("Warmth leads, with competence close behind—not percentages. Choose one.")).toBe(
      "Warmth leads, with competence close behind. Choose one.",
    );
    expect(withoutScoreScaleNote("Sincerity scores high because your customers value honesty.")).toBe(
      "Sincerity scores high because your customers value honesty.",
    );
    expect(withoutScoreScaleNote("Scores are independent—not percentages.")).toBe(
      "Scores are independent—not percentages.",
    );
  });
});
