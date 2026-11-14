// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import type { AccountWorkspace } from "@/components/workspace/account-draft-memory";
import { initialGuidedContext } from "@/components/workspace/guided-interview-client";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { accountProjectSchema } from "@/domain/project-api";
import { strategyJobSchema, type StrategyJob, type StrategyOverview } from "@/domain/strategy-jobs";

const strategy = vi.hoisted(() => ({
  overview: null as StrategyOverview | null,
  pending: false,
  readError: null,
  actionError: null,
  refresh: vi.fn(),
  enqueue: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/components/workspace/use-strategy-jobs", () => ({ useStrategyJobs: () => strategy }));

const account = { status: "ready" as const, userId: "aaaaaaaa-1111-4111-8111-111111111111", generation: 1 };
const when = "2026-10-19T10:00:00Z";
let root: Root, host: HTMLDivElement, workspace: AccountWorkspace, height: number;
const saveContext = vi.fn();
const scrollTo = vi.fn(function (this: HTMLDivElement, options: ScrollToOptions) {
  this.scrollTop = Math.max(0, Math.min(options.top ?? 0, height - 400));
});

function reply(turnId = workspace.saved.context.intake.guidedInterview!.turns[0]!.id): StrategyJob {
  return strategyJobSchema.parse({
    id: "cccccccc-1111-4111-8111-111111111111",
    owner_id: account.userId,
    project_id: workspace.saved.id,
    operation: "strategy.competitors",
    input_revision: 1,
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
          operation: "strategy.competitors",
          proposal: { message: "A focused question", competitors: [] },
          guidance: {
            kind: "choices",
            turnId,
            stage: "competitors",
            message: "Compare these businesses",
            question: "Which competitors?",
            selectionMode: "multiple",
            options: [
              {
                id: "dddddddd-1111-4111-8111-111111111111",
                stage: "competitors",
                label: "Existing Studio",
                description: "A branding studio",
                recommended: true,
                recommendationReason: "Similar service",
                payload: {
                  id: "dddddddd-1111-4111-8111-111111111111",
                  name: "Existing Studio",
                  relevance: "Similar service",
                  origin: "research",
                  selected: false,
                  sources: [{ url: "https://example.com", title: "Fixture", retrievedAt: when }],
                },
              },
            ],
          },
        },
      },
    ],
  });
}
function area() {
  return host.querySelector<HTMLDivElement>(".guided-interview-scroll")!;
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
  height = 1000;
  saveContext.mockReset();
  scrollTo.mockClear();
  strategy.enqueue.mockReset();
  strategy.overview = {
    availability: { status: "unavailable", reason: "worker_unavailable", operations: [] },
    jobs: [],
  };
  const project = accountProjectSchema.parse({
    id: "bbbbbbbb-1111-4111-8111-111111111111",
    owner_id: account.userId,
    title: "Synthetic scroll fixture",
    scope: "complete_brand",
    current_revision: 1,
    created_at: when,
    context: { description: "A neighborhood kitchen" },
  });
  const saved = { ...project, context: initialGuidedContext(project.context, 1, when) };
  workspace = { ownerId: account.userId, generation: 1, saved, draft: accountProjectDraft(saved), conflict: false };
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("guided-interview-scroll") ? height : 0;
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("guided-interview-scroll") ? 400 : 0;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const top = this.classList.contains("guided-assistant-message") ? 900 - area().scrollTop : 0;
    return { top, bottom: top, left: 0, right: 0, x: 0, y: top, width: 0, height: 0, toJSON: () => ({}) };
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: scrollTo });
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

function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill(selector: string, value: string) {
  const node = host.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function ready() {
  strategy.overview!.jobs = [reply()];
  await render();
}
it("adds a competitor as entered when research is unavailable, retaining selections after acknowledgment", async () => {
  await ready();
  const selected = host.querySelector<HTMLInputElement>(".guided-choices .e-choice input")!;
  await act(async () => selected.click());
  await click("Add a competitor");
  await fill(".competitor-add-form input", "Manual Studio");
  saveContext.mockImplementation(async (context) => {
    const saved = { ...workspace.saved, context, current_revision: workspace.saved.current_revision + 1 };
    workspace = { ...workspace, saved, draft: accountProjectDraft(saved) };
    return workspace;
  });
  await click("Add competitor");
  await render();
  expect(saveContext).toHaveBeenCalledOnce();
  expect(strategy.enqueue).not.toHaveBeenCalled();
  expect(workspace.saved.context.competitors[0]).toMatchObject({
    name: "Manual Studio",
    origin: "user",
    selected: true,
    sources: [],
  });
  expect([...host.querySelectorAll<HTMLInputElement>(".guided-choices .e-choice input:checked")]).toHaveLength(2);
  expect(host.querySelector<HTMLElement>(".competitor-add-form")!.hidden).toBe(true);
});
it("keeps manual entry visible after an unconfirmed save and rejects duplicate suggestions", async () => {
  await ready();
  await click("Add a competitor");
  await fill(".competitor-add-form input", "Existing Studio");
  await click("Add competitor");
  expect(saveContext).not.toHaveBeenCalled();
  expect(host.textContent).toContain("already listed");
  await fill(".competitor-add-form input", "Manual Studio");
  saveContext.mockRejectedValue(new Error("lost acknowledgment"));
  await click("Add competitor");
  expect(host.querySelector<HTMLInputElement>(".competitor-add-form input")!.value).toBe("Manual Studio");
  expect(host.querySelector<HTMLElement>(".competitor-add-form")!.hidden).toBe(false);
  expect(strategy.enqueue).not.toHaveBeenCalled();
});
it("does not request more suggestions while an earlier provider request is unresolved", async () => {
  await ready();
  strategy.overview!.availability = { status: "unavailable", reason: "request_unresolved", operations: [] };
  await render();
  expect(button("Suggest more").disabled).toBe(true);
  await click("Suggest more");
  expect(saveContext).not.toHaveBeenCalled();
  expect(strategy.enqueue).not.toHaveBeenCalled();
});
it("requests additional suggestions only after explicit action while retaining existing choices", async () => {
  await ready();
  strategy.overview!.availability = {
    status: "available",
    operations: [{ operation: "strategy.competitors", maximumCostMicrousd: 100000, interviewVersion: 1 }],
  };
  await render();
  await act(async () => host.querySelector<HTMLInputElement>(".guided-choices .e-choice input")!.click());
  saveContext.mockResolvedValue(workspace);
  await click("Suggest more");
  expect(saveContext).toHaveBeenCalledOnce();
  const context = saveContext.mock.calls[0]![0];
  expect(context.competitors).toHaveLength(1);
  expect(context.competitors[0]).toMatchObject({ name: "Existing Studio", selected: true, origin: "research" });
  expect(context.intake.guidedInterview.turns.at(-1)).toMatchObject({
    stage: "competitors",
    purpose: "research",
    inputRevision: 2,
  });
  expect(context.intake.conversation.at(-1).text).toContain("different from the competitors already saved");
});
it("researches an added competitor like the suggestions, in the same save, keeping existing choices", async () => {
  await ready();
  strategy.overview!.availability = {
    status: "available",
    operations: [{ operation: "strategy.competitors", maximumCostMicrousd: 100000, interviewVersion: 1 }],
  };
  await render();
  await act(async () => host.querySelector<HTMLInputElement>(".guided-choices .e-choice input")!.click());
  expect(host.querySelector(".competitor-add-form")!.textContent).toContain(
    "Embel looks it up like the other competitors",
  );
  await click("Add a competitor");
  await fill(".competitor-add-form input", "Turo");
  await fill('.competitor-add-form input[type="url"]', "https://turo.com");
  saveContext.mockResolvedValue(workspace);
  await click("Add competitor");
  expect(saveContext).toHaveBeenCalledOnce();
  const context = saveContext.mock.calls[0]![0];
  expect(context.competitors).toEqual([
    expect.objectContaining({ name: "Existing Studio", selected: true, origin: "research" }),
    expect.objectContaining({ name: "Turo", url: "https://turo.com", selected: true, origin: "user" }),
  ]);
  expect(context.intake.guidedInterview.turns.at(-1)).toMatchObject({
    stage: "competitors",
    purpose: "research",
    inputRevision: 2,
  });
  expect(context.intake.conversation.at(-1).text).toBe(
    "Add Turo (https://turo.com) to my competitors and research it like the others: its website, what it offers and why it competes with my brand. Keep my existing selections.",
  );
});
