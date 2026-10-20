// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import type { AccountWorkspace } from "@/components/workspace/account-draft-memory";
import { initialGuidedContext } from "@/components/workspace/guided-interview-client";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { accountProjectSchema } from "@/domain/project-api";
import { strategyJobSchema, type StrategyJob, type StrategyOverview } from "@/domain/strategy-jobs";

const strategy = vi.hoisted(() => ({
  overview: null as StrategyOverview | null, pending: false, readError: null, actionError: null,
  refresh: vi.fn(), enqueue: vi.fn(), cancel: vi.fn(),
}));
vi.mock("@/components/workspace/use-strategy-jobs", () => ({ useStrategyJobs: () => strategy }));

const account = { status: "ready" as const, userId: "aaaaaaaa-1111-4111-8111-111111111111", generation: 1 };
const when = "2026-10-19T10:00:00Z";
let root: Root, host: HTMLDivElement, workspace: AccountWorkspace, height: number;
const saveContext = vi.fn();
const scrollTo = vi.fn(function (this: HTMLDivElement, options: ScrollToOptions) { this.scrollTop = Math.max(0, Math.min(options.top ?? 0, height - 400)); });

function reply(turnId = workspace.saved.context.intake.guidedInterview!.turns[0]!.id): StrategyJob {
  return strategyJobSchema.parse({ id: "cccccccc-1111-4111-8111-111111111111", owner_id: account.userId, project_id: workspace.saved.id,
    operation: "strategy.competitors", input_revision: 1, state: "succeeded", progress: 100, reserved_cost_microusd: 100000, actual_cost_microusd: 1000,
    error_code: null, cancel_requested_at: null, created_at: when, finished_at: when, results: [{ stepKey: "guided-result", output: {
      version: 1, provider: "openai", model: "fixture", responseId: "fixture", requestId: null, generatedAt: when,
      usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 },
      operation: "strategy.competitors", proposal: { message: "A focused question", competitors: [] },
      guidance: { kind: "question", turnId, stage: "competitors", message: "I need one useful detail.", question: "Which city will you serve?" },
    } }] });
}
function area() { return host.querySelector<HTMLDivElement>(".guided-interview-scroll")!; }
async function render() {
  await act(async () => root.render(createElement(AccountGuidedInterview, { account, workspace, busy: false, saveContext,
    storage: { kind: "account", saveLabel: "Saved", onUpdate: () => false } })));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  height = 1000; saveContext.mockReset(); scrollTo.mockClear(); strategy.enqueue.mockReset();
  strategy.overview = { availability: { status: "unavailable", reason: "worker_unavailable", operations: [] }, jobs: [] };
  const project = accountProjectSchema.parse({ id: "bbbbbbbb-1111-4111-8111-111111111111", owner_id: account.userId,
    title: "Synthetic scroll fixture", scope: "complete_brand", current_revision: 1, created_at: when, context: { description: "A neighborhood kitchen" } });
  const saved = { ...project, context: initialGuidedContext(project.context, 1, when) };
  workspace = { ownerId: account.userId, generation: 1, saved, draft: accountProjectDraft(saved), conflict: false };
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("guided-interview-scroll") ? height : 0; });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) { return this.classList.contains("guided-interview-scroll") ? 400 : 0; });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const top = this.classList.contains("guided-assistant-message") ? 900 - area().scrollTop : 0;
    return { top, bottom: top, left: 0, right: 0, x: 0, y: top, width: 0, height: 0, toJSON: () => ({}) };
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: scrollTo });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("guided conversation response arrival", () => {
  it("exposes an accessible jump for a verified new reply without moving the reader or saving anything", async () => {
    await render();
    const composer = host.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")!; composer.focus();
    await act(async () => { area().scrollTop = 100; area().dispatchEvent(new Event("scroll", { bubbles: true })); });
    scrollTo.mockClear(); height = 1600; strategy.overview!.jobs = [reply()]; await render();
    expect(scrollTo).not.toHaveBeenCalled(); expect(area().scrollTop).toBe(100); expect(document.activeElement).toBe(composer);
    const jump = host.querySelector<HTMLButtonElement>(".guided-new-response button")!;
    expect(jump.textContent).toContain("View new response"); expect(jump.getAttribute("aria-controls")).toBe(area().id);
    await act(async () => jump.click());
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 876, behavior: "auto" });
    expect(document.activeElement).toBe(host.querySelector(".guided-assistant-message"));
    expect(host.querySelector(".guided-new-response")).toBeNull();
    expect(saveContext).not.toHaveBeenCalled(); expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("does not move or announce new content for an unmatched completed job", async () => {
    await render(); scrollTo.mockClear();
    strategy.overview!.jobs = [reply("unmatched-turn")]; await render();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(host.querySelector(".guided-new-response")).toBeNull();
    expect(host.querySelector(".guided-assistant-message")).toBeNull();
    expect(saveContext).not.toHaveBeenCalled(); expect(strategy.enqueue).not.toHaveBeenCalled();
  });
});
