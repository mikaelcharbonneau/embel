// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import type { StrategyOverview } from "@/domain/strategy-jobs";
import type { AccountWorkspace } from "@/components/workspace/account-draft-memory";
import { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { initialGuidedContext } from "@/components/workspace/guided-interview-client";
import { bindGuidedStartConsent, guidedStartContext, isGuidedStartTurn, markGuidedStartAttempt, readGuidedStartConsent, rememberGuidedStartConsent } from "@/components/workspace/guided-start-consent";

const strategy = vi.hoisted(() => ({ overview: null as StrategyOverview | null, pending: false, readError: null as string | null, actionError: null as string | null, refresh: vi.fn(), enqueue: vi.fn(), cancel: vi.fn() }));
vi.mock("@/components/workspace/use-strategy-jobs", () => ({ useStrategyJobs: () => strategy }));
const account = { status: "ready" as const, userId: "aaaaaaaa-1111-4111-8111-111111111111", generation: 1 };
const otherOwner = "cccccccc-1111-4111-8111-111111111111", otherProject = "dddddddd-1111-4111-8111-111111111111";
const allowance = { billingMode: "openai_api" as const, maximumCostMicrousd: 100000 };
const available = (cap = allowance.maximumCostMicrousd): StrategyOverview["availability"] => ({ status: "available", operations: [{ operation: "strategy.competitors", maximumCostMicrousd: cap, interviewVersion: 1 }] });
let root: Root, host: HTMLDivElement, workspace: AccountWorkspace;
const saveContext = vi.fn();
const turn = () => workspace.saved.context.intake.guidedInterview!.turns[0]!;
const receiptKey = () => `embel.guided-start-consent.v1:${account.userId}:${turn().id}`;
function button(label: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!; }
async function render() { await act(async () => root.render(createElement(AccountGuidedInterview, { account, workspace, busy: false, saveContext, storage: { kind: "account", saveLabel: "Saved", onUpdate: () => false } }))); }
async function remount() { await act(async () => root.unmount()); root = createRoot(host); await render(); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); HTMLElement.prototype.scrollTo = vi.fn(); window.localStorage.clear();
  strategy.overview = { availability: available(), jobs: [] }; strategy.pending = false; strategy.readError = null; strategy.actionError = null;
  strategy.refresh.mockReset(); strategy.enqueue.mockReset().mockResolvedValue(null); strategy.cancel.mockReset(); saveContext.mockReset();
  let saved = accountProjectSchema.parse({ id: "bbbbbbbb-1111-4111-8111-111111111111", owner_id: account.userId, title: "Saved start fixture", scope: "complete_brand", current_revision: 1, created_at: "2026-10-20T00:00:00Z", context: { description: "A neighborhood kitchen." } });
  saved = { ...saved, context: guidedStartContext(saved.context, account.userId, allowance) };
  workspace = { ownerId: account.userId, generation: 1, saved, draft: accountProjectDraft(saved), conflict: false };
  expect(bindGuidedStartConsent(account.userId, turn().id, saved.id)).toBe(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("durable guided start allowance", () => {
  it("supports a project-scoped initial turn saved at revision two", async () => {
    const context = { ...workspace.saved.context, intake: { ...workspace.saved.context.intake, guidedInterview: undefined } };
    const saved = { ...workspace.saved, current_revision: 2, context: guidedStartContext(context, account.userId, allowance, 2, workspace.saved.id) };
    workspace = { ...workspace, saved, draft: accountProjectDraft(saved) };
    expect(bindGuidedStartConsent(account.userId, turn().id, saved.id)).toBe(true);
    await render();
    expect(strategy.enqueue).toHaveBeenCalledExactlyOnceWith("strategy.competitors", 2, allowance);
    await remount(); expect(strategy.enqueue).toHaveBeenCalledOnce();
  });

  it("binds explicit review of a missing revision-two receipt to revision two", async () => {
    const context = { ...workspace.saved.context, intake: { ...workspace.saved.context.intake, guidedInterview: undefined } };
    const saved = { ...workspace.saved, current_revision: 2, context: guidedStartContext(context, account.userId, allowance, 2, workspace.saved.id) };
    workspace = { ...workspace, saved, draft: accountProjectDraft(saved) };
    window.localStorage.clear(); await render();
    await act(async () => button("Start research").click());
    expect(strategy.enqueue).toHaveBeenCalledExactlyOnceWith("strategy.competitors", 2, allowance);
    expect(readGuidedStartConsent(account.userId, turn().id)?.inputRevision).toBe(2);
  });
  it("binds acceptance to owner, turn, acknowledged project and first revision", () => {
    expect(isGuidedStartTurn(turn())).toBe(true);
    expect(readGuidedStartConsent(account.userId, turn().id)).toMatchObject({ ownerId: account.userId, projectId: workspace.saved.id, inputRevision: 1, allowance, attempted: false });
    expect(readGuidedStartConsent(otherOwner, turn().id)).toBeNull();
    expect(readGuidedStartConsent(account.userId, `guided-start-v1:${crypto.randomUUID()}`)).toBeNull();
    expect(bindGuidedStartConsent(account.userId, turn().id, otherProject)).toBe(false);
  });
  it("retains the exact accepted allowance after a dispatch attempt", () => {
    expect(markGuidedStartAttempt(account.userId, turn().id)).toBe(true);
    expect(rememberGuidedStartConsent(account.userId, turn().id, { ...allowance, maximumCostMicrousd: 200000 })).toBe(false);
    expect(readGuidedStartConsent(account.userId, turn().id)).toMatchObject({ allowance, attempted: true });
  });
  it.each(["missing", "corrupt", "wrong owner", "wrong project", "wrong revision"])("does not auto-admit a %s receipt", async kind => {
    const receipt = readGuidedStartConsent(account.userId, turn().id)!;
    if (kind === "missing") window.localStorage.removeItem(receiptKey());
    else window.localStorage.setItem(receiptKey(), kind === "corrupt" ? "{invalid" : JSON.stringify({ ...receipt, ...(kind === "wrong owner" ? { ownerId: otherOwner } : kind === "wrong project" ? { projectId: otherProject } : { inputRevision: 2 }) }));
    await render(); expect(strategy.enqueue).not.toHaveBeenCalled(); expect(host.textContent).toContain("Review the current research limit"); expect(button("Start research")).toBeDefined();
    expect(host.querySelector(".guided-thinking")).toBeNull();
  });
  it("admits a saved initial turn once using its exact accepted cap under a reduced current limit", async () => {
    strategy.overview = { availability: available(50000), jobs: [] };
    await render(); expect(strategy.enqueue).toHaveBeenCalledExactlyOnceWith("strategy.competitors", 1, allowance);
    expect(readGuidedStartConsent(account.userId, turn().id)?.attempted).toBe(true);
    await render(); expect(strategy.enqueue).toHaveBeenCalledOnce();
  });
  it("waits for explicit acceptance of a newly higher allowance before any admission", async () => {
    strategy.overview = { availability: available(200000), jobs: [] };
    await render(); expect(strategy.enqueue).not.toHaveBeenCalled(); expect(host.textContent).toContain("$0.20");
    await act(async () => button("Start research").click());
    expect(strategy.enqueue).toHaveBeenCalledExactlyOnceWith("strategy.competitors", 1, { ...allowance, maximumCostMicrousd: 200000 });
  });
  it("never retries an unknown admission on remount; explicit retry retains the exact key basis and cap", async () => {
    await render(); expect(strategy.enqueue).toHaveBeenCalledOnce();
    await remount(); expect(strategy.enqueue).toHaveBeenCalledOnce(); expect(host.textContent).toContain("request is not confirmed");
    await act(async () => button("Retry research").click());
    expect(strategy.enqueue).toHaveBeenCalledTimes(2); expect(strategy.enqueue.mock.calls[1]).toEqual(strategy.enqueue.mock.calls[0]);
  });
  it("does not expand a previously attempted request on explicit retry", async () => {
    markGuidedStartAttempt(account.userId, turn().id);
    strategy.overview = { availability: available(200000), jobs: [] }; await render();
    await act(async () => button("Retry research").click());
    expect(strategy.enqueue).not.toHaveBeenCalled(); expect(host.textContent).toContain("original request is kept");
  });
  it("fails closed when the attempted receipt cannot be durably written", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    await render(); expect(strategy.enqueue).not.toHaveBeenCalled(); expect(host.textContent).toContain("could not start safely");
  });
  it("requires fresh status before a missing-consent manual start", async () => {
    window.localStorage.removeItem(receiptKey()); strategy.readError = "Status unavailable";
    await render(); await act(async () => button("Start research").click());
    expect(strategy.enqueue).not.toHaveBeenCalled(); expect(strategy.refresh).toHaveBeenCalledOnce();
  });
  it("keeps historical unmarked turns on their existing path", async () => {
    const saved = { ...workspace.saved, context: initialGuidedContext({ ...workspace.saved.context, intake: { ...workspace.saved.context.intake, guidedInterview: undefined } }, 1) };
    workspace = { ...workspace, saved, draft: accountProjectDraft(saved) }; await render();
    expect(isGuidedStartTurn(turn())).toBe(false); expect(strategy.enqueue).toHaveBeenCalledExactlyOnceWith("strategy.competitors", 1, allowance);
  });
  it("does not admit from a pending edit, stale revision, unavailable worker, or unverified read", async () => {
    workspace = { ...workspace, draft: { ...workspace.draft, description: "Unsaved correction" } }; await render(); expect(strategy.enqueue).not.toHaveBeenCalled();
    workspace = { ...workspace, draft: accountProjectDraft(workspace.saved), saved: { ...workspace.saved, current_revision: 2 } }; await render(); expect(strategy.enqueue).not.toHaveBeenCalled();
    workspace = { ...workspace, saved: { ...workspace.saved, current_revision: 1 } };
    strategy.overview = { availability: { status: "unavailable", operations: [], reason: "worker_unavailable" }, jobs: [] }; await render(); expect(strategy.enqueue).not.toHaveBeenCalled();
    strategy.overview = null; await render(); expect(strategy.enqueue).not.toHaveBeenCalled(); expect(host.textContent).toContain("Checking research status");
  });
});
