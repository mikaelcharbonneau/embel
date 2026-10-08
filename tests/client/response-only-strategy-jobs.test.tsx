// @vitest-environment jsdom
import { act, createElement, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { strategyJobSchema, type StrategyOverview } from "@/domain/strategy-jobs";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { rememberStrategyPlan, promptStrategyPlan, readStrategyIntent } from "@/components/workspace/account-strategy-client";
import { useStrategyJobs } from "@/components/workspace/use-strategy-jobs";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({ memory: null as ReturnType<typeof createAccountDraftMemory> | null, current: vi.fn(), expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ drafts: mock.memory, isCurrent: mock.current, expire: mock.expire }) }));
const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
const when = "2026-10-08T00:00:00Z";
const responseOnly: StrategyOverview["availability"] = { status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 122880 }] };
const full: StrategyOverview["availability"] = { status: "available", operations: [...responseOnly.operations, { operation: "strategy.competitors", maximumCostMicrousd: 3142880 }] };
let root: Root | null, host: HTMLDivElement, api: ReturnType<typeof useStrategyJobs>, account: VerifiedAccount;
let overview: StrategyOverview, fetcher: ReturnType<typeof vi.fn>;
function Harness() {
  const workspace = useSyncExternalStore(mock.memory!.subscribe, () => mock.memory!.get(projectId)!);
  const value = useStrategyJobs({ account, workspace, blocked: false });
  useLayoutEffect(() => { api = value; });
  return null;
}
async function render() { await act(async () => root!.render(createElement(Harness))); }
const mutations = () => fetcher.mock.calls.filter(([, init]) => init.method === "POST");
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.sessionStorage.clear(); account = { status: "ready", userId: crypto.randomUUID(), generation: 1 };
  mock.current.mockReset().mockImplementation((value: VerifiedAccount) => value.userId === account.userId && value.generation === account.generation);
  mock.expire.mockReset(); mock.memory = createAccountDraftMemory();
  const project = accountProjectSchema.parse({ id: projectId, owner_id: account.userId, title: "Response-only fixture", scope: "complete_brand", current_revision: 1, created_at: when, context: { description: "A neighborhood lunch kitchen" } });
  mock.memory.set({ ownerId: account.userId, generation: 1, saved: project, draft: accountProjectDraft(project), conflict: false });
  const job = strategyJobSchema.parse({ id: "cccccccc-1111-4111-8111-111111111111", owner_id: account.userId, project_id: projectId, operation: "strategy.reformulate", input_revision: 1, state: "succeeded", progress: 100, reserved_cost_microusd: 122880, actual_cost_microusd: 1000, error_code: null, cancel_requested_at: null, created_at: when, finished_at: when, results: [{ stepKey: "response", output: { version: 1, provider: "openai", operation: "strategy.reformulate", model: "synthetic-model", responseId: "synthetic-response", requestId: null, generatedAt: when, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 }, proposal: { message: "Synthetic response", activity: "Kitchen", offering: "Lunch", knownAudience: "Neighbors", questions: [] } } }] });
  overview = { availability: responseOnly, jobs: [job] };
  rememberStrategyPlan({ ownerId: account.userId, projectId, revision: 1 }, promptStrategyPlan(responseOnly)!);
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path === `/api/projects/${projectId}/strategy` && init.method === "GET") return Response.json(overview);
    if (path.endsWith("/apply") && init.method === "POST") {
      const next = { ...project, current_revision: 2, context: { ...project.context, activity: "Kitchen" } };
      const application = { jobId: job.id, stepKey: "response", inputRevision: 1, appliedRevision: 2, appliedAt: when };
      overview = { ...overview, jobs: [{ ...job, results: job.results.map(result => ({ ...result, application })) }] };
      return Response.json({ project: next, application });
    }
    throw new Error(`Unexpected mutation ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("response-only application and recovery", () => {
  it("never dispatches research after exact application, availability refresh, reconnect or remount", async () => {
    await render();
    await act(async () => api.apply(overview.jobs[0]!, "response"));
    expect(mock.memory!.get(projectId)!.saved.current_revision).toBe(2);
    expect(api.continuationAvailable).toBe(false);
    overview = { ...overview, availability: full };
    await act(async () => api.refresh());
    await act(async () => api.continueResearch());
    expect(api.continuationAvailable).toBe(false);
    expect(mutations()).toHaveLength(1);
    await act(async () => root!.unmount()); root = createRoot(host);
    account = { ...account, generation: 2 };
    mock.memory!.set({ ...mock.memory!.get(projectId)!, generation: 2 });
    await render();
    await act(async () => api.continueResearch());
    expect(api.continuationAvailable).toBe(false);
    expect(mutations()).toHaveLength(1);
    expect(readStrategyIntent(account.userId, projectId, 1)).toEqual({ ownerId: account.userId, projectId, revision: 1, kind: "response_only", billingMode: "openai_api", reformulationCap: 122880 });
  });
  it("retains receipt replay protection and refuses applying to a stale revision", async () => {
    await render(); await act(async () => api.apply(overview.jobs[0]!, "response"));
    await act(async () => api.apply(overview.jobs[0]!, "response"));
    expect(mutations()).toHaveLength(1);
    expect(mock.memory!.get(projectId)!.saved.current_revision).toBe(2);
    expect(mock.expire).not.toHaveBeenCalled();
  });
});
