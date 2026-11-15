// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import type { AccountWorkspace } from "@/components/workspace/account-draft-memory";
import { initialGuidedContext } from "@/components/workspace/guided-interview-client";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import type { ContextSnapshot } from "@/domain/projects";
import { accountProjectSchema } from "@/domain/project-api";
import { strategyJobSchema, type StrategyJob, type StrategyOverview } from "@/domain/strategy-jobs";

// A message typed after the interview is complete (docs/state-machines.md, J4) is a question or a comment: it
// never moves the stage back and never hides a finished step. Inspiration is a stand-in; no network or AI calls.
const strategy = vi.hoisted(() => ({
  overview: null as StrategyOverview | null,
  pending: false,
  readError: null as string | null,
  actionError: null as string | null,
  refresh: vi.fn(),
  enqueue: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/components/workspace/use-strategy-jobs", async () => {
  const { withStrategyView } = await import("./guided-strategy-hook");
  return { useStrategyJobs: () => withStrategyView(strategy) };
});
vi.mock("@/components/workspace/project-progress", () => ({ useProjectProgress: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/inspiration/inspiration-like-count", () => ({ InspirationLikeCount: () => null }));
vi.mock("@/components/inspiration/inspiration-workspace", () => ({
  InspirationWorkspace: () => <article data-inspiration />,
}));

const account = { status: "ready" as const, userId: "aaaaaaaa-3333-4333-8333-333333333333", generation: 1 };
const projectId = "bbbbbbbb-3333-4333-8333-333333333333",
  when = "2026-11-14T10:00:00Z";
const question = "Why does this personality fit Cedar?";
let root: Root, host: HTMLDivElement, workspace: AccountWorkspace;
const saveContext = vi.fn();

function identity() {
  return host.querySelector<HTMLElement>('[data-journey-section="identity"]');
}
function send() {
  return host.querySelector<HTMLButtonElement>('form[aria-label="Reply"] button[type="submit"]');
}
async function render() {
  await act(async () =>
    root.render(
      createElement(AccountGuidedInterview, {
        account,
        workspace,
        busy: false,
        saveContext,
        storage: { kind: "account", saveLabel: "Saved", onUpdate: () => false },
      }),
    ),
  );
}
/** The save the page asked for is confirmed: the project is at the next revision with that conversation. */
function confirmSave(context: ContextSnapshot) {
  const saved = { ...workspace.saved, context, current_revision: workspace.saved.current_revision + 1 };
  workspace = { ...workspace, saved, draft: accountProjectDraft(saved), guidedInput: undefined };
}
function replyJob(guidance: Record<string, unknown>): StrategyJob {
  const turn = workspace.saved.context.intake.guidedInterview!.turns.at(-1)!;
  return strategyJobSchema.parse({
    id: "cccccccc-3333-4333-8333-333333333333",
    owner_id: account.userId,
    project_id: projectId,
    operation: "strategy.reformulate",
    input_revision: turn.inputRevision,
    state: "succeeded",
    progress: 100,
    reserved_cost_microusd: 100000,
    actual_cost_microusd: 1000,
    error_code: null,
    cancel_requested_at: null,
    created_at: when,
    finished_at: when,
    results: [
      {
        stepKey: "guided-result",
        output: {
          version: 1,
          provider: "openai",
          model: "fixture",
          responseId: "fixture",
          requestId: null,
          generatedAt: when,
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 },
          operation: "strategy.reformulate",
          proposal: { message: "Synthetic", activity: "", offering: "", knownAudience: "", questions: [] },
          guidance: { turnId: turn.id, stage: turn.stage, ...guidance },
        },
      },
    ],
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  HTMLElement.prototype.scrollTo = vi.fn();
  saveContext.mockReset();
  strategy.enqueue.mockReset();
  strategy.overview = {
    availability: {
      status: "available",
      operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 100000, interviewVersion: 1 }],
    },
    jobs: [],
  };
  // Voice is finished: a name is chosen and the slogan question was skipped.
  const project = accountProjectSchema.parse({
    id: projectId,
    owner_id: account.userId,
    title: "Cedar",
    scope: "complete_brand",
    current_revision: 2,
    created_at: when,
    context: { description: "A neighborhood kitchen" },
  });
  const context = initialGuidedContext(project.context, 1, when),
    interview = context.intake.guidedInterview!;
  const saved = {
    ...project,
    context: {
      ...context,
      selectedName: "Cedar",
      intake: {
        ...context.intake,
        guidedInterview: {
          ...interview,
          stage: "complete" as const,
          turns: [
            ...interview.turns,
            {
              id: "slogan-turn",
              userMessageId: null,
              stage: "slogan" as const,
              purpose: "propose" as const,
              inputRevision: 2,
            },
          ],
          answers: [
            { stage: "slogan" as const, turnId: "slogan-turn", optionIds: [], customText: null, confirmedAt: when },
          ],
        },
      },
    },
  };
  workspace = {
    ownerId: account.userId,
    generation: 1,
    saved,
    draft: accountProjectDraft(saved),
    conflict: false,
    guidedInput: { prompt: question, selection: null },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a message typed on a finished interview", () => {
  it("keeps the interview complete and Identity shown, and asks Embel for a reply", async () => {
    await render();
    expect(identity()).not.toBeNull();
    expect(host.querySelector("[data-inspiration]")).not.toBeNull();
    // Inspiration takes no typed text: the box invites a question, not a change it would not make.
    expect(host.querySelector<HTMLTextAreaElement>(".workspace-reply textarea")?.placeholder).toBe(
      "Ask a question, or press Send to continue…",
    );
    saveContext.mockImplementation(async (context: ContextSnapshot) => {
      confirmSave(context);
      return workspace;
    });
    await act(async () => send()!.click());
    expect(saveContext).toHaveBeenCalledOnce();
    const state = workspace.saved.context.intake.guidedInterview!;
    expect(state.stage).toBe("complete");
    expect(state.answers.map((answer) => answer.stage)).toEqual(["slogan"]);
    expect(state.turns.at(-1)).toMatchObject({ purpose: "message", inputRevision: 3 });
    await render();
    expect(identity()).not.toBeNull();
    expect(host.querySelector("[data-inspiration]")).not.toBeNull();
    expect(host.textContent).toContain(question);
    // The reply is requested once, for the saved revision; nothing else is saved.
    expect(strategy.enqueue).toHaveBeenCalledOnce();
    expect(strategy.enqueue.mock.calls[0]!.slice(0, 2)).toEqual(["strategy.reformulate", 3]);
    expect(saveContext).toHaveBeenCalledOnce();
  });

  it("shows Embel's answer in the chat and saves nothing more", async () => {
    saveContext.mockImplementation(async (context: ContextSnapshot) => {
      confirmSave(context);
      return workspace;
    });
    await render();
    await act(async () => send()!.click());
    await render();
    strategy.overview = {
      ...strategy.overview!,
      jobs: [replyJob({ kind: "answer", message: "Warm and dependable matches a neighborhood kitchen." })],
    };
    await render();
    const response = host.querySelector('article[aria-label="Embel response"][id^="guided-turn-"]')!;
    expect(response.textContent).toContain("Warm and dependable matches a neighborhood kitchen.");
    // The answer is not filed under an earlier step.
    expect(response.querySelector(".e-turn__meta")?.textContent).toBe("Embel");
    expect(identity()).not.toBeNull();
    expect(saveContext).toHaveBeenCalledOnce();
    expect(strategy.enqueue).toHaveBeenCalledOnce();
  });

  it("never reopens a step from a reply: an earlier answer changes only through Change answer", async () => {
    saveContext.mockImplementation(async (context: ContextSnapshot) => {
      confirmSave(context);
      return workspace;
    });
    await render();
    await act(async () => send()!.click());
    await render();
    strategy.overview = {
      ...strategy.overview!,
      jobs: [replyJob({ kind: "redirect", message: "Let's revisit your audience.", targetStage: "audience" })],
    };
    await render();
    expect(saveContext).toHaveBeenCalledOnce();
    expect(workspace.saved.context.intake.guidedInterview!.stage).toBe("complete");
    expect(identity()).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
