// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { strategyJobSchema, type StrategyOverview } from "@/domain/strategy-jobs";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { AccountStrategyEditor } from "@/components/workspace/account-strategy-editor";
import { promptStrategyPlan, readStrategyIntent, rememberStrategyPlan } from "@/components/workspace/account-strategy-client";
import type { useStrategyJobs } from "@/components/workspace/use-strategy-jobs";
import type { ProjectEditorForm } from "@/components/workspace/project-editor";

const mock = vi.hoisted(() => ({ strategy: null as unknown as ReturnType<typeof useStrategyJobs>, form: null as ComponentProps<typeof ProjectEditorForm> | null }));
vi.mock("@/components/workspace/use-strategy-jobs", () => ({ useStrategyJobs: () => mock.strategy }));
vi.mock("@/components/workspace/project-editor", () => ({ ProjectEditorForm: (props: ComponentProps<typeof ProjectEditorForm>) => {
  mock.form = props; return createElement("div", null, props.storage.promptNotice, props.storage.strategy);
} }));
const projectId = "bbbbbbbb-1111-4111-8111-111111111111", when = "2026-10-08T00:00:00Z";
const responseOnly: StrategyOverview["availability"] = { status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 122880 }] };
const full: StrategyOverview["availability"] = { status: "available", operations: [...responseOnly.operations, { operation: "strategy.competitors", maximumCostMicrousd: 3142880 }] };
let root: Root | null, host: HTMLDivElement, props: ComponentProps<typeof AccountStrategyEditor>;
async function render() { await act(async () => root!.render(createElement(AccountStrategyEditor, props))); }
async function retry() { await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Request response")!.click()); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.sessionStorage.clear();
  const owner = crypto.randomUUID();
  const project = accountProjectSchema.parse({ id: projectId, owner_id: owner, title: "Response-only fixture", scope: "complete_brand", current_revision: 1, created_at: when, context: { description: "A neighborhood kitchen" } });
  const workspace = { ownerId: owner, generation: 1, saved: project, draft: accountProjectDraft(project), conflict: false };
  props = { account: { status: "ready", userId: owner, generation: 1 }, workspace, busy: false, saveDraft: vi.fn().mockResolvedValue(workspace), storage: { kind: "account", saveLabel: "Saved", onUpdate: () => true } };
  mock.strategy = { overview: { availability: responseOnly, jobs: [] }, readError: null, actionError: null, pending: false, pendingLabel: "", continuationAvailable: false, enqueue: vi.fn().mockResolvedValue(null), cancel: vi.fn(), apply: vi.fn(), refresh: vi.fn(), report: vi.fn(), continueResearch: vi.fn() };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); });

describe("response-only account editor", () => {
  it("discloses only a response and does not expose unavailable competitor research", async () => {
    await render();
    expect(host.textContent).toContain("Sending uses OpenAI for a response, up to $0.13");
    expect(host.textContent).toContain("Competitor research is unavailable");
    expect(mock.form!.storage.strategyActions).not.toHaveProperty("competitors");
    await retry();
    expect(mock.strategy.enqueue).toHaveBeenCalledExactlyOnceWith("strategy.reformulate", 1, { billingMode: "openai_api", maximumCostMicrousd: 122880 });
    expect(readStrategyIntent(props.account.userId, projectId, 1)).toMatchObject({ kind: "response_only", reformulationCap: 122880 });
  });
  it("keeps the stored response-only retry and allowance when research later becomes ready", async () => {
    rememberStrategyPlan({ ownerId: props.account.userId, projectId, revision: 1 }, promptStrategyPlan(responseOnly)!);
    mock.strategy.overview = { availability: full, jobs: [] }; await render();
    expect(host.textContent).toContain("Response only · up to $0.13");
    await retry();
    expect(mock.strategy.enqueue).toHaveBeenCalledExactlyOnceWith("strategy.reformulate", 1, { billingMode: "openai_api", maximumCostMicrousd: 122880 });
    expect(readStrategyIntent(props.account.userId, projectId, 1)).not.toHaveProperty("competitorsCap");
    expect(mock.form!.storage.strategyActions!.competitors!.maximumCostLabel).toContain("$3.15");
    await act(async () => mock.form!.storage.onStrategyRequested!("competitors"));
    expect(mock.strategy.enqueue).toHaveBeenLastCalledWith("strategy.competitors", 1, { billingMode: "openai_api", maximumCostMicrousd: 3142880 });
    expect(readStrategyIntent(props.account.userId, projectId, 1)).not.toHaveProperty("competitorsCap");
  });
  it("does not silently downgrade saved full-plan consent when research becomes unavailable", async () => {
    rememberStrategyPlan({ ownerId: props.account.userId, projectId, revision: 1 }, promptStrategyPlan(full)!);
    await render(); await retry();
    expect(mock.strategy.enqueue).not.toHaveBeenCalled();
    expect(mock.strategy.report).toHaveBeenCalledWith(expect.stringContaining("request limits changed"));
    expect(readStrategyIntent(props.account.userId, projectId, 1)).toHaveProperty("competitorsCap", 3142880);
  });
  it("shows an admitted job awaiting publication without claiming a worker is processing it", async () => {
    const job = strategyJobSchema.parse({ id: "cccccccc-1111-4111-8111-111111111111", owner_id: props.account.userId, project_id: projectId, operation: "strategy.reformulate", input_revision: 1, state: "queued", progress: 0, reserved_cost_microusd: 122880, actual_cost_microusd: 0, error_code: null, cancel_requested_at: null, created_at: when, finished_at: null, results: [] });
    mock.strategy.overview = { availability: responseOnly, jobs: [{ ...job, ...{ dispatchState: "dispatch_pending" } }] }; await render();
    expect(host.textContent).toContain("Request saved. Waiting for dispatch confirmation.");
    expect(host.textContent).not.toContain("Waiting for the worker.");
    mock.strategy.overview = { availability: responseOnly, jobs: [{ ...job, state: "running", ...{ dispatchState: "dispatch_pending" } }] }; await render();
    expect(host.textContent).toContain("OpenAI is processing this saved version.");
    expect(host.textContent).not.toContain("Waiting for dispatch confirmation");
    mock.strategy.overview = { availability: responseOnly, jobs: [job] }; await render();
    expect(host.textContent).toContain("Request saved. Waiting to start.");
    expect(host.textContent).not.toContain("Waiting for the worker.");
  });
});
