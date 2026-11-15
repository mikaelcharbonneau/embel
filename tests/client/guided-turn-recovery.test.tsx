// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import type { AccountWorkspace } from "@/components/workspace/account-draft-memory";
import { guidedMessageContext, initialGuidedContext } from "@/components/workspace/guided-interview-client";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { accountProjectSchema } from "@/domain/project-api";
import type { ContextSnapshot } from "@/domain/projects";
import { strategyJobSchema, type StrategyJob, type StrategyOverview } from "@/domain/strategy-jobs";

// The steps the conversation takes on its own, when their save fails or the project moved on
// (docs/state-machines.md, J5).
const strategy = vi.hoisted(() => ({
  overview: null as StrategyOverview | null,
  pending: false,
  readError: null,
  actionError: null,
  refresh: vi.fn(),
  enqueue: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/components/workspace/use-strategy-jobs", async () => {
  const { withStrategyView } = await import("./guided-strategy-hook");
  return { useStrategyJobs: () => withStrategyView(strategy) };
});

const account = { status: "ready" as const, userId: "aaaaaaaa-1111-4111-8111-111111111111", generation: 1 };
const when = "2026-11-14T10:00:00Z";
let root: Root, host: HTMLDivElement, workspace: AccountWorkspace;
const saveContext = vi.fn<(context: ContextSnapshot) => Promise<AccountWorkspace | null>>();

/** Embel read the person's message as a change of direction: the page reopens Competitors by itself. */
function redirectReply(): StrategyJob {
  return strategyJobSchema.parse({
    id: "cccccccc-1111-4111-8111-111111111111",
    owner_id: account.userId,
    project_id: workspace.saved.id,
    operation: "strategy.reformulate",
    input_revision: 2,
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
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            webSearchCalls: 0,
          },
          operation: "strategy.reformulate",
          proposal: { message: "Looking again", activity: "", offering: "", knownAudience: "", questions: [] },
          guidance: {
            kind: "redirect",
            turnId: workspace.saved.context.intake.guidedInterview!.turns.at(-1)!.id,
            stage: "competitors",
            targetStage: "competitors",
            message: "Looking for competitors again.",
          },
        },
      },
    ],
  });
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: vi.fn() });
  saveContext.mockReset();
  strategy.enqueue.mockReset();
  const project = accountProjectSchema.parse({
    id: "bbbbbbbb-1111-4111-8111-111111111111",
    owner_id: account.userId,
    title: "Turn recovery fixture",
    scope: "complete_brand",
    current_revision: 2,
    created_at: when,
    context: { description: "A neighborhood kitchen" },
  });
  // The person's message was saved as version 2, and Embel's reply was made for that version.
  const saved = {
    ...project,
    context: guidedMessageContext(initialGuidedContext(project.context, 1, when), "Look wider.", 2, when),
  };
  workspace = { ownerId: account.userId, generation: 1, saved, draft: accountProjectDraft(saved), conflict: false };
  strategy.overview = {
    availability: { status: "unavailable", reason: "worker_unavailable", operations: [] },
    jobs: [redirectReply()],
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

describe("a step the conversation takes on its own", () => {
  it("is tried again after its save failed, once the failed save is settled", async () => {
    const clean = workspace;
    // The save fails the way the project page fails it: nothing is thrown, the change stays unsaved.
    saveContext.mockImplementation(async (context) => {
      workspace = { ...clean, pendingGuidedContext: context };
      return null;
    });
    await render();
    expect(saveContext).toHaveBeenCalledOnce();
    // While the failed save is on screen ("Not saved", Retry save) nothing is repeated.
    await render();
    await render();
    expect(saveContext).toHaveBeenCalledOnce();
    // "Load latest version" drops the unsaved change. The same step is still due and is taken again.
    workspace = clean;
    saveContext.mockImplementation(async (context) => ({
      ...clean,
      saved: { ...clean.saved, current_revision: 3, context },
    }));
    await render();
    expect(saveContext).toHaveBeenCalledTimes(2);
    expect(saveContext.mock.calls[1]![0].intake.guidedInterview!.turns).toHaveLength(3);
    // A confirmed step is not taken twice.
    await render();
    expect(saveContext).toHaveBeenCalledTimes(2);
  });

  it("is not repeated in a loop when its save fails and leaves nothing to settle", async () => {
    saveContext.mockResolvedValue(null);
    await render();
    await render();
    await render();
    expect(saveContext).toHaveBeenCalledOnce();
  });

  it("says so when its save throws, instead of failing unseen", async () => {
    saveContext.mockRejectedValue(new TypeError("Failed to fetch"));
    await render();
    expect(saveContext).toHaveBeenCalledOnce();
    expect(host.textContent).toContain(
      "This step could not be saved. Your conversation is kept. Reload the page to try again.",
    );
    expect(host.textContent).not.toContain("Failed to fetch");
  });

  it("says the project changed when a reply it would act on belongs to an earlier version", async () => {
    // The project was renamed in another tab while Embel was answering: the saved version moved on.
    workspace = { ...workspace, saved: { ...workspace.saved, current_revision: 3 } };
    await render();
    expect(saveContext).not.toHaveBeenCalled();
    expect(strategy.enqueue).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      "The project changed after this response was requested. Your conversation is kept. Send a new message to continue from the current version.",
    );
    // The way forward is open: the reply box takes a new message.
    expect(host.querySelector<HTMLTextAreaElement>(".workspace-reply textarea")!.readOnly).toBe(false);
  });
});
