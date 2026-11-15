// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import type { AccountWorkspace } from "@/components/workspace/account-draft-memory";
import { initialGuidedContext } from "@/components/workspace/guided-interview-client";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { accountProjectSchema } from "@/domain/project-api";
import type { StrategyAction } from "@/components/workspace/strategy-jobs-view";
import { UPDATES_DELAYED } from "@/domain/generation-words";
import {
  strategyJobSchema,
  strategyOverviewResponseSchema,
  type StrategyJob,
  type StrategyOverview,
} from "@/domain/strategy-jobs";

const strategy = vi.hoisted(() => ({
  overview: null as StrategyOverview | null,
  pending: false,
  readError: null as string | null,
  actionError: null as string | null,
  action: undefined as StrategyAction | undefined,
  refresh: vi.fn(),
  enqueue: vi.fn(),
  retryDelivery: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/components/workspace/use-strategy-jobs", async () => {
  const { withStrategyView } = await import("./guided-strategy-hook");
  return { useStrategyJobs: () => withStrategyView(strategy) };
});

const account = { status: "ready" as const, userId: "aaaaaaaa-1111-4111-8111-111111111111", generation: 1 };
const when = "2026-10-19T10:00:00Z";
const available: StrategyOverview["availability"] = {
  status: "available",
  operations: [{ operation: "strategy.competitors", maximumCostMicrousd: 100000, interviewVersion: 1 }],
};
const reasons = [
  ["budget_unavailable", "No AI requests are available for this account."],
  ["worker_unavailable", "AI replies are unavailable right now."],
  ["runtime_disabled", "AI is not enabled in this workspace."],
  ["quota_unavailable", "The current AI request limit is unavailable."],
  [
    "request_unresolved",
    "A previous request needs review before another can start. Check its status before trying again.",
  ],
  ["request_active", "A request is already in progress. Wait for it to finish, then check status."],
] as const;
let root: Root, host: HTMLDivElement, workspace: AccountWorkspace;
const saveContext = vi.fn();

function unavailable(reason: NonNullable<StrategyOverview["availability"]["reason"]>) {
  strategy.overview = strategyOverviewResponseSchema.parse({
    availability: { status: "unavailable", reason, operations: [] },
    jobs: [],
  });
}
function addGuidedTurn() {
  const saved = { ...workspace.saved, context: initialGuidedContext(workspace.saved.context, 1, when) };
  workspace = { ...workspace, saved, draft: accountProjectDraft(saved) };
}
function boundJob(state: StrategyJob["state"]) {
  return strategyJobSchema.parse({
    id: "cccccccc-1111-4111-8111-111111111111",
    owner_id: account.userId,
    project_id: workspace.saved.id,
    operation: "strategy.competitors",
    input_revision: 1,
    state,
    progress: 0,
    reserved_cost_microusd: 100000,
    actual_cost_microusd: 0,
    error_code: state === "failed" ? "provider_error" : null,
    cancel_requested_at: null,
    created_at: when,
    finished_at: state === "failed" ? when : null,
    results: [],
  });
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => (item.textContent || item.getAttribute("aria-label")) === label,
  );
}
function notice() {
  return host.querySelector(".guided-conversation-error")?.textContent ?? "";
}
async function render(saveLabel = "Saved", busy = false) {
  await act(async () =>
    root.render(
      createElement(AccountGuidedInterview, {
        account,
        workspace,
        busy,
        saveContext,
        storage: {
          kind: "account",
          saveLabel,
          onUpdate: () => false,
          actions: createElement(
            "p",
            { role: saveLabel === "Changes not saved" ? "alert" : "status", "aria-label": "Project save status" },
            saveLabel,
          ),
        },
      }),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollTo = vi.fn();
  strategy.overview = null;
  strategy.pending = false;
  strategy.readError = null;
  strategy.actionError = null;
  strategy.action = undefined;
  strategy.refresh.mockReset();
  strategy.enqueue.mockReset();
  strategy.retryDelivery.mockReset();
  strategy.cancel.mockReset();
  saveContext.mockReset();
  const saved = accountProjectSchema.parse({
    id: "bbbbbbbb-1111-4111-8111-111111111111",
    owner_id: account.userId,
    title: "Synthetic Strategy availability",
    scope: "complete_brand",
    current_revision: 1,
    created_at: when,
    context: { description: "Synthetic saved neighborhood kitchen brief." },
  });
  workspace = { ownerId: account.userId, generation: 1, saved, draft: accountProjectDraft(saved), conflict: false };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("guided Strategy availability presentation", () => {
  it("does not treat temporary refusal of new requests as a failed admission in progress", async () => {
    addGuidedTurn();
    unavailable("request_active");
    strategy.pending = true;
    await render();
    expect(host.querySelector('[aria-label="Researching your competitors"]')).not.toBeNull();
    expect(notice()).toBe("");
    expect(button("Try again")).toBeUndefined();
  });

  it.each([
    ["ordinary queued", {}],
    ["published queued", { dispatchState: "published", canRetryDelivery: false }],
    ["unconfirmed but not recoverable", { dispatchState: "dispatch_pending", canRetryDelivery: false }],
    ["stale", { dispatchState: "dispatch_pending", canRetryDelivery: true, input_revision: 2 }],
    ["running", { dispatchState: "dispatch_pending", canRetryDelivery: true, state: "running" }],
  ])("does not describe %s work as failed delivery", async (_name, patch) => {
    addGuidedTurn();
    unavailable("request_active");
    strategy.overview!.jobs = [strategyJobSchema.parse({ ...boundJob("queued"), ...patch })];
    await render();
    expect(button("Retry delivery")).toBeUndefined();
    expect(host.querySelector(".guided-delivery-notice")).toBeNull();
    expect(strategy.retryDelivery).not.toHaveBeenCalled();
    expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it.each(reasons)(
    "shows %s before the first turn without inventing request history or save completion",
    async (reason, expected) => {
      unavailable(reason);
      await render();
      expect(notice()).toContain(expected);
      expect(notice()).toContain("You can still edit and save your project.");
      expect(notice()).not.toMatch(/Your brief is saved|No AI request was sent|exhausted|billing|database|storage/i);
      expect(button("Start competitor research")).toBeUndefined();
      // Only Embel's fixed invitation to start and the reason; Send (Start research) is unavailable.
      expect([...host.querySelectorAll("article.e-turn")].map((item) => item.getAttribute("aria-label"))).toEqual([
        "Start research",
        "Embel status",
      ]);
      expect(button("Start research")?.disabled).toBe(true);
      expect(host.querySelector('[role="status"][aria-label="Project save status"]')?.textContent).toBe("Saved");
      await act(async () => button("Check status")!.click());
      expect(strategy.refresh).toHaveBeenCalledOnce();
      expect(strategy.enqueue).not.toHaveBeenCalled();
      expect(saveContext).not.toHaveBeenCalled();
    },
  );

  it("starts research from the saved brief with one deliberate click", async () => {
    strategy.overview = strategyOverviewResponseSchema.parse({ availability: available, jobs: [] });
    let release!: (value: AccountWorkspace | null) => void;
    saveContext.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await render();
    const start = button("Start research")!;
    expect(start.disabled).toBe(false);
    await act(async () => {
      start.click();
      start.click();
    });
    expect(saveContext).toHaveBeenCalledOnce();
    const turn = saveContext.mock.calls[0]![0].intake.guidedInterview.turns.at(-1);
    expect(turn).toMatchObject({ stage: "competitors", purpose: "research", inputRevision: 2 });
    // The request itself starts from the saved turn once the save is confirmed.
    expect(strategy.enqueue).not.toHaveBeenCalled();
    await act(async () => release(null));
  });

  it.each(["Saving…", "Changes not saved"])("keeps %s distinct from first-turn availability", async (saveLabel) => {
    unavailable("budget_unavailable");
    workspace = { ...workspace, draft: { ...workspace.draft, description: "Synthetic unsaved correction." } };
    const draft = workspace.draft,
      saved = workspace.saved;
    await render(saveLabel, saveLabel === "Saving…");
    expect(notice()).toContain("No AI requests are available for this account.");
    expect(notice()).not.toMatch(/brief is saved|prompt is saved/i);
    const saveState =
      saveLabel === "Saving…"
        ? host.querySelector('.workspace-reply__notice [role="status"]')
        : host.querySelector('[role="alert"][aria-label="Project save status"]');
    expect(saveState?.textContent).toBe(saveLabel);
    expect(workspace.draft).toBe(draft);
    expect(workspace.saved).toBe(saved);
    expect(workspace.draft.description).toBe("Synthetic unsaved correction.");
    expect(workspace.saved.context.description).toBe("Synthetic saved neighborhood kitchen brief.");
    expect(saveContext).not.toHaveBeenCalled();
    expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("keeps a pending availability read distinct from an unavailable response", async () => {
    await render();
    expect(notice()).toBe("");
    expect(button("Start competitor research")).toBeUndefined();
    expect(strategy.enqueue).not.toHaveBeenCalled();
    expect(saveContext).not.toHaveBeenCalled();
  });

  it("prefers the current read failure over a stale availability reason", async () => {
    unavailable("budget_unavailable");
    strategy.readError = "Strategy status could not be checked. Try checking again.";
    await render();
    expect(notice()).toContain(strategy.readError);
    expect(notice()).not.toContain("No AI requests are available");
    expect(button("Start competitor research")).toBeUndefined();
    expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("retains the typed prompt and specific refusal when sending is unavailable", async () => {
    unavailable("request_unresolved");
    workspace = { ...workspace, guidedInput: { prompt: "Synthetic follow-up to keep", selection: null } };
    await render();
    await act(async () => button("Send prompt")!.click());
    expect(notice()).toContain("A previous request needs review before another can start.");
    expect(notice()).toContain("No AI request was sent. Your prompt is kept.");
    expect(host.querySelector<HTMLTextAreaElement>(".workspace-reply textarea")?.value).toBe(
      "Synthetic follow-up to keep",
    );
    expect(saveContext).not.toHaveBeenCalled();
    expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it.each(["request_unresolved", "request_active"] as const)(
    "does not offer a new retry when a failed turn is blocked by %s",
    async (reason) => {
      addGuidedTurn();
      unavailable(reason);
      strategy.overview!.jobs = [boundJob("failed")];
      await render();
      expect(notice()).toContain(reasons.find(([value]) => value === reason)![1]);
      expect(button("Try again")).toBeUndefined();
      expect(button("Try again")).toBeUndefined();
      expect(button("Check status")?.disabled).toBe(false);
      expect(saveContext).not.toHaveBeenCalled();
      expect(strategy.enqueue).not.toHaveBeenCalled();
    },
  );

  it("keeps a known failed request retryable when the server allows new research", async () => {
    addGuidedTurn();
    strategy.overview = { availability: available, jobs: [boundJob("failed")] };
    await render();
    expect(notice()).toContain("Research could not produce verified suggestions. Your brief is saved.");
    expect(button("Try again")?.disabled).toBe(false);
    await act(async () => button("Try again")!.click());
    expect(saveContext).toHaveBeenCalledOnce();
    const retryContext = saveContext.mock.calls[0]![0];
    expect(retryContext.intake.guidedInterview.turns).toHaveLength(2);
    expect(retryContext.intake.guidedInterview.turns[1].inputRevision).toBe(2);
    expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("keeps a running bound request's thinking and Stop controls without reporting new-request refusal as its failure", async () => {
    addGuidedTurn();
    unavailable("request_active");
    const job = boundJob("running");
    strategy.overview!.jobs = [job];
    await render();
    expect(host.querySelector('[aria-label="Researching your competitors"]')).not.toBeNull();
    expect(notice()).toBe("");
    expect(button("Stop research")?.getAttribute("aria-disabled")).toBeNull();
    await act(async () => button("Stop research")!.click());
    expect(strategy.cancel).toHaveBeenCalledWith(job);
    expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("shows thinking while the initial request acknowledgement is pending without a false unavailable message", async () => {
    addGuidedTurn();
    strategy.overview = { availability: available, jobs: [] };
    strategy.pending = true;
    await render();
    expect(host.querySelector('[aria-label="Researching your competitors"]')).not.toBeNull();
    expect(notice()).toBe("");
    expect(button("Try again")).toBeUndefined();
    expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  // What may be repeated or stopped is the hook's reading (`view`, docs/state-machines.md J8).
  it.each([
    [402, "You’ve used this month’s credits. Your conversation is saved."],
    [429, "The current request limit was reached. Your draft is kept here. Try again when capacity is available."],
  ])("does not offer a retry that would be refused again after a %i start", async (httpStatus, sentence) => {
    addGuidedTurn();
    strategy.overview = { availability: available, jobs: [] };
    strategy.action = { sending: null, unconfirmed: null, problem: { during: "start", httpStatus, sentence } };
    await render();
    expect(notice()).toContain(sentence);
    expect(button("Retry request")).toBeUndefined();
    expect(button("Try again")).toBeUndefined();
    expect(button("Check status")?.disabled).toBe(false);
  });

  it.each([[500], [null], [400]])("keeps the retry after a start that may be repeated (%s)", async (httpStatus) => {
    addGuidedTurn();
    strategy.overview = { availability: available, jobs: [] };
    strategy.action = {
      sending: null,
      unconfirmed: null,
      problem: { during: "start", httpStatus, sentence: "The request could not be confirmed." },
    };
    await render();
    expect(notice()).toContain("The request could not be confirmed.");
    expect(button("Retry request")?.disabled).toBe(false);
  });

  it("shows a quiet updates-delayed note, with progress and Stop, when a status check fails while research runs", async () => {
    addGuidedTurn();
    const job = boundJob("running");
    strategy.overview = { availability: available, jobs: [job] };
    strategy.readError = "Strategy status could not be checked. Try checking again.";
    await render();
    expect(notice()).toBe("");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const progress = host.querySelector('[aria-label="Researching your competitors"]')!;
    expect(progress.textContent).toContain(UPDATES_DELAYED);
    expect(progress.querySelector(".e-progress")).not.toBeNull();
    await act(async () => button("Stop research")!.click());
    expect(strategy.cancel).toHaveBeenCalledWith(job);
  });

  it("does not offer Stop again while this tab's Stop is on its way", async () => {
    addGuidedTurn();
    strategy.overview = { availability: available, jobs: [boundJob("running")] };
    strategy.action = { sending: "stop", unconfirmed: null, problem: null };
    await render();
    expect(button("Stop research")).toBeUndefined();
    expect(button("Stopping…")?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => button("Stopping…")!.click());
    expect(strategy.cancel).not.toHaveBeenCalled();
  });
});
