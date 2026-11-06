// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import type { AccountWorkspace } from "@/components/workspace/account-draft-memory";
import { initialGuidedContext } from "@/components/workspace/guided-interview-client";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { accountProjectSchema } from "@/domain/project-api";
import { strategyJobSchema, strategyOverviewResponseSchema, type StrategyJob, type StrategyOverview } from "@/domain/strategy-jobs";

const strategy = vi.hoisted(() => ({
  overview: null as StrategyOverview | null, pending: false, readError: null as string | null, actionError: null as string | null,
  refresh: vi.fn(), enqueue: vi.fn(), retryDelivery: vi.fn(), cancel: vi.fn(),
}));
vi.mock("@/components/workspace/use-strategy-jobs", () => ({ useStrategyJobs: () => strategy }));

const account = { status: "ready" as const, userId: "aaaaaaaa-1111-4111-8111-111111111111", generation: 1 };
const when = "2026-10-19T10:00:00Z";
const available: StrategyOverview["availability"] = { status: "available", operations: [{ operation: "strategy.competitors", maximumCostMicrousd: 100000, interviewVersion: 1 }] };
const reasons = [
  ["budget_unavailable", "No AI requests are available for this account."],
  ["worker_unavailable", "AI replies are unavailable right now."],
  ["runtime_disabled", "AI is not enabled in this workspace."],
  ["subscription_unavailable", "The ChatGPT connection is unavailable."],
  ["quota_unavailable", "The current AI request limit is unavailable."],
  ["request_unresolved", "A previous request needs review before another can start. Check its status before trying again."],
  ["request_active", "A request is already in progress. Wait for it to finish, then check status."],
] as const;
let root: Root, host: HTMLDivElement, workspace: AccountWorkspace;
const saveContext = vi.fn();

function unavailable(reason: NonNullable<StrategyOverview["availability"]["reason"]>) {
  strategy.overview = strategyOverviewResponseSchema.parse({ availability: { status: "unavailable", reason, operations: [] }, jobs: [] });
}
function addGuidedTurn() {
  const saved = { ...workspace.saved, context: initialGuidedContext(workspace.saved.context, 1, when) };
  workspace = { ...workspace, saved, draft: accountProjectDraft(saved) };
}
function boundJob(state: StrategyJob["state"]) {
  return strategyJobSchema.parse({ id: "cccccccc-1111-4111-8111-111111111111", owner_id: account.userId, project_id: workspace.saved.id,
    operation: "strategy.competitors", input_revision: 1, state, progress: 0, reserved_cost_microusd: 100000, actual_cost_microusd: 0,
    error_code: state === "failed" ? "provider_error" : null, cancel_requested_at: null, created_at: when, finished_at: state === "failed" ? when : null, results: [] });
}
function button(label: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label); }
function notice() { return host.querySelector(".guided-conversation-error")?.textContent ?? ""; }
async function render(saveLabel = "Saved", busy = false) {
  await act(async () => root.render(createElement(AccountGuidedInterview, { account, workspace, busy, saveContext,
    storage: { kind: "account", saveLabel, onUpdate: () => false,
      actions: createElement("p", { role: saveLabel === "Changes not saved" ? "alert" : "status", "aria-label": "Project save status" }, saveLabel),
    } })));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); HTMLElement.prototype.scrollTo = vi.fn();
  strategy.overview = null; strategy.pending = false; strategy.readError = null; strategy.actionError = null;
  strategy.refresh.mockReset(); strategy.enqueue.mockReset(); strategy.retryDelivery.mockReset(); strategy.cancel.mockReset(); saveContext.mockReset();
  const saved = accountProjectSchema.parse({ id: "bbbbbbbb-1111-4111-8111-111111111111", owner_id: account.userId, title: "Synthetic Strategy availability", scope: "complete_brand", current_revision: 1, created_at: when, context: { description: "Synthetic saved neighborhood kitchen brief." } });
  workspace = { ownerId: account.userId, generation: 1, saved, draft: accountProjectDraft(saved), conflict: false };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("guided Strategy availability presentation", () => {
  it("keeps fresh worker handoff quiet, offers a check after a real delay, and clears it once running", async () => {
    addGuidedTurn(); unavailable("request_active");
    const queued = { ...boundJob("queued"), dispatchState: "dispatch_pending", workerDelivery: "awaiting_worker", canRetryDelivery: false };
    strategy.overview!.jobs = [strategyJobSchema.parse(queued)];
    await render();
    expect(host.querySelector('[aria-label="Request queued…"]')).not.toBeNull();
    expect(button("Stop")?.disabled).toBe(false);
    expect(host.querySelector(".guided-delivery-notice")).toBeNull();
    expect(button("Retry delivery")).toBeUndefined(); expect(notice()).toBe("");
    strategy.overview!.jobs = [strategyJobSchema.parse({ ...queued, workerDelivery: "worker_delayed" })];
    await render();
    expect(host.querySelector(".guided-delivery-notice")?.textContent).toContain("still queued");
    expect(button("Retry delivery")).toBeUndefined();
    await act(async () => button("Check status")!.click());
    expect(strategy.refresh).toHaveBeenCalledOnce();
    strategy.overview!.jobs = [boundJob("running")];
    await render();
    expect(host.querySelector('[aria-label="Researching your competitors"]')).not.toBeNull();
    expect(host.querySelector(".guided-delivery-notice")).toBeNull();
    expect(strategy.retryDelivery).not.toHaveBeenCalled(); expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("does not treat temporary refusal of new requests as a failed admission in progress", async () => {
    addGuidedTurn(); unavailable("request_active"); strategy.pending = true;
    await render();
    expect(host.querySelector('[aria-label="Researching your competitors"]')).not.toBeNull();
    expect(notice()).toBe(""); expect(button("Retry research")).toBeUndefined();
  });
  it("offers exact delivery recovery after reload despite request_active without automatically retrying", async () => {
    addGuidedTurn(); unavailable("request_active");
    const job = strategyJobSchema.parse({ ...boundJob("queued"), dispatchState: "dispatch_pending", canRetryDelivery: true });
    strategy.overview!.jobs = [job];
    await render();
    expect(host.querySelector(".guided-delivery-notice")?.textContent).toContain("delivery to the worker is not confirmed");
    const recovery = host.querySelector('[role="group"][aria-label="Delivery recovery"]');
    expect(recovery).not.toBeNull();
    expect([...recovery!.querySelectorAll("button")].map(control => control.textContent)).toEqual(["Check status", "Retry delivery"]);
    expect(button("Retry delivery")?.disabled).toBe(false);
    expect(strategy.retryDelivery).not.toHaveBeenCalled(); expect(strategy.enqueue).not.toHaveBeenCalled();
    await act(async () => button("Check status")!.click());
    expect(strategy.refresh).toHaveBeenCalledOnce(); expect(strategy.retryDelivery).not.toHaveBeenCalled();
    await act(async () => button("Retry delivery")!.click());
    expect(strategy.retryDelivery).toHaveBeenCalledExactlyOnceWith(job);
    expect(saveContext).not.toHaveBeenCalled(); expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("keeps the queued audience request after saved competitor selection and removes recovery when delivery advances", async () => {
    const saved = { ...workspace.saved, current_revision: 2,
      context: initialGuidedContext({ ...workspace.saved.context, competitorReviewComplete: true }, 2, when) };
    workspace = { ...workspace, saved, draft: accountProjectDraft(saved) };
    unavailable("request_active");
    const job = strategyJobSchema.parse({ ...boundJob("queued"), operation: "strategy.audience", input_revision: 2,
      dispatchState: "dispatch_pending", canRetryDelivery: true });
    strategy.overview!.jobs = [job];
    await render();
    expect(button("Retry delivery")?.disabled).toBe(false);
    await act(async () => button("Retry delivery")!.click());
    expect(strategy.retryDelivery).toHaveBeenCalledExactlyOnceWith(job);
    strategy.overview!.jobs = [strategyJobSchema.parse({ ...job, state: "running", dispatchState: "published", canRetryDelivery: false })];
    await render();
    expect(button("Retry delivery")).toBeUndefined();
    expect(host.querySelector('[aria-label="Embel is thinking"]')).not.toBeNull();
    expect(saveContext).not.toHaveBeenCalled(); expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["ordinary queued", {}], ["published queued", { dispatchState: "published", canRetryDelivery: false }],
    ["unconfirmed but not recoverable", { dispatchState: "dispatch_pending", canRetryDelivery: false }],
    ["stale", { dispatchState: "dispatch_pending", canRetryDelivery: true, input_revision: 2 }],
    ["running", { dispatchState: "dispatch_pending", canRetryDelivery: true, state: "running" }],
  ])("does not describe %s work as failed delivery", async (_name, patch) => {
    addGuidedTurn(); unavailable("request_active");
    strategy.overview!.jobs = [strategyJobSchema.parse({ ...boundJob("queued"), ...patch })];
    await render();
    expect(button("Retry delivery")).toBeUndefined();
    expect(host.querySelector(".guided-delivery-notice")).toBeNull();
    expect(strategy.retryDelivery).not.toHaveBeenCalled(); expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("disables delivery while a request is in flight or saved content is conflicted", async () => {
    addGuidedTurn(); unavailable("request_active");
    strategy.overview!.jobs = [strategyJobSchema.parse({ ...boundJob("queued"), dispatchState: "dispatch_pending", canRetryDelivery: true })];
    strategy.pending = true; await render();
    expect(button("Retry delivery")?.disabled).toBe(true);
    strategy.pending = false; workspace = { ...workspace, conflict: true }; await render();
    expect(button("Retry delivery")?.disabled).toBe(true);
    expect(strategy.retryDelivery).not.toHaveBeenCalled();
  });

  it.each(reasons)("shows %s before the first turn without inventing request history or save completion", async (reason, expected) => {
    unavailable(reason);
    await render();
    expect(notice()).toContain(expected);
    expect(notice()).toContain("You can still edit and save your project.");
    expect(notice()).not.toMatch(/Your brief is saved|No AI request was sent|exhausted|billing|database|storage/i);
    expect(button("Start competitor research")).toBeUndefined();
    expect(host.querySelector(".guided-assistant-message")).toBeNull();
    expect(host.querySelector('[role="status"][aria-label="Project save status"]')?.textContent).toBe("Saved");
    await act(async () => button("Check status")!.click());
    expect(strategy.refresh).toHaveBeenCalledOnce(); expect(strategy.enqueue).not.toHaveBeenCalled(); expect(saveContext).not.toHaveBeenCalled();
  });

  it.each(["Saving…", "Changes not saved"])("keeps %s distinct from first-turn availability", async saveLabel => {
    unavailable("budget_unavailable");
    workspace = { ...workspace, draft: { ...workspace.draft, description: "Synthetic unsaved correction." } };
    const draft = workspace.draft, saved = workspace.saved;
    await render(saveLabel, saveLabel === "Saving…");
    expect(notice()).toContain("No AI requests are available for this account.");
    expect(notice()).not.toMatch(/brief is saved|prompt is saved/i);
    const saveState = saveLabel === "Saving…"
      ? host.querySelector('.conversation-compose-notices > p[role="status"]')
      : host.querySelector('[role="alert"][aria-label="Project save status"]');
    expect(saveState?.textContent).toBe(saveLabel);
    expect(workspace.draft).toBe(draft); expect(workspace.saved).toBe(saved);
    expect(workspace.draft.description).toBe("Synthetic unsaved correction.");
    expect(workspace.saved.context.description).toBe("Synthetic saved neighborhood kitchen brief.");
    expect(saveContext).not.toHaveBeenCalled(); expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("keeps a pending availability read distinct from an unavailable response", async () => {
    await render();
    expect(notice()).toBe(""); expect(button("Start competitor research")).toBeUndefined();
    expect(strategy.enqueue).not.toHaveBeenCalled(); expect(saveContext).not.toHaveBeenCalled();
  });

  it("prefers the current read failure over a stale availability reason", async () => {
    unavailable("budget_unavailable"); strategy.readError = "Strategy status could not be checked. Try checking again.";
    await render();
    expect(notice()).toContain(strategy.readError); expect(notice()).not.toContain("No AI requests are available");
    expect(button("Start competitor research")).toBeUndefined(); expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("retains the typed prompt and specific refusal when sending is unavailable", async () => {
    unavailable("request_unresolved"); workspace = { ...workspace, guidedInput: { prompt: "Synthetic follow-up to keep", selection: null } };
    await render();
    await act(async () => button("Send prompt")!.click());
    expect(notice()).toContain("A previous request needs review before another can start.");
    expect(notice()).toContain("No AI request was sent. Your prompt is kept.");
    expect(host.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")?.value).toBe("Synthetic follow-up to keep");
    expect(saveContext).not.toHaveBeenCalled(); expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it.each(["request_unresolved", "request_active"] as const)("does not offer a new retry when a failed turn is blocked by %s", async reason => {
    addGuidedTurn(); unavailable(reason); strategy.overview!.jobs = [boundJob("failed")];
    await render();
    expect(notice()).toContain(reasons.find(([value]) => value === reason)![1]);
    expect(notice()).not.toContain("You can retry research."); expect(button("Retry research")).toBeUndefined();
    expect(button("Check status")?.disabled).toBe(false);
    expect(saveContext).not.toHaveBeenCalled(); expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("keeps a known failed request retryable when the server allows new research", async () => {
    addGuidedTurn(); strategy.overview = { availability: available, jobs: [boundJob("failed")] };
    await render();
    expect(notice()).toContain("Research could not produce verified suggestions. Your prompt is saved. You can retry research.");
    expect(button("Retry research")?.disabled).toBe(false);
    await act(async () => button("Retry research")!.click());
    expect(saveContext).toHaveBeenCalledOnce();
    const retryContext = saveContext.mock.calls[0]![0];
    expect(retryContext.intake.guidedInterview.turns).toHaveLength(2);
    expect(retryContext.intake.guidedInterview.turns[1].inputRevision).toBe(2);
    expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("keeps a running bound request's thinking and Stop controls without reporting new-request refusal as its failure", async () => {
    addGuidedTurn(); unavailable("request_active"); const job = boundJob("running"); strategy.overview!.jobs = [job];
    await render();
    expect(host.querySelector('[aria-label="Researching your competitors"]')).not.toBeNull(); expect(notice()).toBe("");
    expect(button("Cancel research")?.disabled).toBe(false);
    await act(async () => button("Cancel research")!.click());
    expect(strategy.cancel).toHaveBeenCalledWith(job); expect(strategy.enqueue).not.toHaveBeenCalled();
  });

  it("shows thinking while the initial request acknowledgement is pending without a false unavailable message", async () => {
    addGuidedTurn(); strategy.overview = { availability: available, jobs: [] }; strategy.pending = true;
    await render();
    expect(host.querySelector('[aria-label="Researching your competitors"]')).not.toBeNull(); expect(notice()).toBe("");
    expect(button("Retry research")).toBeUndefined(); expect(strategy.enqueue).not.toHaveBeenCalled();
  });
});
