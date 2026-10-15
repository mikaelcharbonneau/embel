// @vitest-environment jsdom
import { act, createElement, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { strategyJobSchema, type StrategyOverview } from "@/domain/strategy-jobs";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { useStrategyJobs } from "@/components/workspace/use-strategy-jobs";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({ memory: null as ReturnType<typeof createAccountDraftMemory> | null, current: vi.fn(), expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ drafts: mock.memory, isCurrent: mock.current, expire: mock.expire }) }));
const projectId = "bbbbbbbb-1111-4111-8111-111111111111", when = "2026-10-08T00:00:00Z";
const availability: StrategyOverview["availability"] = { status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 122880 }] };
const allowance = { billingMode: "openai_api" as const, maximumCostMicrousd: 122880 };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let root: Root | null, host: HTMLDivElement, api: ReturnType<typeof useStrategyJobs>, account: VerifiedAccount;
let overview: StrategyOverview, fetcher: ReturnType<typeof vi.fn>;
function Harness() {
  const workspace = useSyncExternalStore(mock.memory!.subscribe, () => mock.memory!.get(projectId)!);
  const value = useStrategyJobs({ account, workspace, blocked: false });
  useLayoutEffect(() => { api = value; });
  return null;
}
async function render() { await act(async () => root!.render(createElement(Harness))); }
async function expireRequest() { await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); }
const mutations = () => fetcher.mock.calls.filter(([, init]) => init.method !== "GET");
beforeEach(() => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.sessionStorage.clear(); account = { status: "ready", userId: crypto.randomUUID(), generation: 1 };
  mock.current.mockReset().mockImplementation((value: VerifiedAccount) => value.userId === account.userId && value.generation === account.generation);
  mock.expire.mockReset(); mock.memory = createAccountDraftMemory();
  const project = accountProjectSchema.parse({ id: projectId, owner_id: account.userId, title: "HTTP recovery fixture", scope: "complete_brand", current_revision: 1, created_at: when, context: { description: "A neighborhood lunch kitchen" } });
  mock.memory.set({ ownerId: account.userId, generation: 1, saved: project, draft: accountProjectDraft(project), conflict: false });
  const job = strategyJobSchema.parse({ id: "cccccccc-1111-4111-8111-111111111111", owner_id: account.userId, project_id: projectId, operation: "strategy.reformulate", input_revision: 1, state: "succeeded", progress: 100, reserved_cost_microusd: 122880, actual_cost_microusd: 1000, error_code: null, cancel_requested_at: null, created_at: when, finished_at: when, results: [{ stepKey: "response", output: { version: 1, provider: "openai", operation: "strategy.reformulate", model: "synthetic-model", responseId: "synthetic-response", requestId: null, generatedAt: when, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 }, proposal: { message: "Synthetic response", activity: "Kitchen", offering: "Lunch", knownAudience: "Neighbors", questions: [] } } }] });
  overview = { availability, jobs: [job] };
  fetcher = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json(overview);
    throw new Error("Unexpected fixture mutation");
  });
  vi.stubGlobal("fetch", fetcher); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("saved-project strategy HTTP recovery", () => {
  it("recovers a stalled poll without mutations and ignores its late older snapshot", async () => {
    const stalled = deferred<Response>(); fetcher.mockImplementationOnce(() => stalled.promise);
    await render(); expect(api.overview).toBeNull();
    await expireRequest(); expect(api.readError).toContain("could not be confirmed");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(api.overview?.jobs[0]?.state).toBe("succeeded"); expect(api.readError).toBeNull();
    await act(async () => stalled.resolve(Response.json({ availability, jobs: [] })));
    expect(api.overview?.jobs[0]?.state).toBe("succeeded"); expect(mutations()).toHaveLength(0);
  });

  it("unlocks a stalled enqueue and checks the durable job without an automatic second POST", async () => {
    const job = { ...overview.jobs[0]!, state: "queued" as const, progress: 0, finished_at: null, results: [] };
    overview = { availability, jobs: [] }; await render();
    const stalled = deferred<Response>();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "POST") { overview = { availability, jobs: [job] }; return stalled.promise; }
      return Response.json(overview);
    });
    await act(async () => { void api.enqueue("strategy.reformulate", 1, allowance); });
    await expireRequest();
    expect(api.pending).toBe(false); expect(api.actionError).toBeNull();
    expect(api.overview?.jobs[0]?.id).toBe(job.id); expect(mutations()).toHaveLength(1);
    await act(async () => stalled.resolve(Response.json({ job })));
    expect(mutations()).toHaveLength(1); expect(mock.expire).not.toHaveBeenCalled();
  });

  it.each([
    ["lost network acknowledgement", null], ["HTTP 408", 408], ["HTTP 500", 500],
    ["HTTP 502", 502], ["HTTP 503", 503], ["HTTP 504", 504],
  ])("clears an uncertain enqueue (%s) only when Check status confirms the matching saved request", async (_name, status) => {
    const job = overview.jobs[0]!;
    overview = { availability, jobs: [] }; await render();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "POST") {
        if (status) return new Response(null, { status });
        throw new TypeError("Synthetic lost acknowledgement");
      }
      return Response.json(overview);
    });
    await act(async () => { await api.enqueue("strategy.reformulate", 1, allowance); });
    expect(api.actionError).toBeTruthy();
    expect(api.overview?.jobs).toEqual([]);

    overview = { availability, jobs: [job] };
    await act(async () => api.refresh());
    expect(api.overview?.jobs[0]?.id).toBe(job.id);
    expect(api.actionError).toBeNull();
    expect(mutations()).toHaveLength(1);
  });

  it.each([
    ["operation", { operation: "strategy.competitors" }],
    ["input revision", { input_revision: 2 }],
    ["billing mode", { billingMode: "chatgpt_subscription", policyIdentity: "a".repeat(64) }],
    ["accepted allowance", { reserved_cost_microusd: allowance.maximumCostMicrousd + 1 }],
  ])("does not confirm an uncertain enqueue from a job with another %s", async (_name, difference) => {
    const job = strategyJobSchema.parse({ ...overview.jobs[0]!, ...difference, results: [] });
    overview = { availability, jobs: [] }; await render();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "POST") throw new TypeError("Synthetic lost acknowledgement");
      return Response.json(overview);
    });
    await act(async () => { await api.enqueue("strategy.reformulate", 1, allowance); });
    overview = { availability, jobs: [job] };
    await act(async () => api.refresh());
    expect(api.readError).toBeNull();
    expect(api.actionError).toContain("Check its status");
    expect(mutations()).toHaveLength(1);
  });

  it("keeps an uncertain enqueue warning when multiple durable jobs match its saved operation", async () => {
    const job = overview.jobs[0]!;
    overview = { availability, jobs: [] }; await render();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "POST") throw new TypeError("Synthetic lost acknowledgement");
      return Response.json(overview);
    });
    await act(async () => { await api.enqueue("strategy.reformulate", 1, allowance); });
    overview = { availability, jobs: [job, { ...job, id: "eeeeeeee-1111-4111-8111-111111111111" }] };
    await act(async () => api.refresh());
    expect(api.overview?.jobs).toHaveLength(2);
    expect(api.actionError).toContain("Check its status");
    expect(mutations()).toHaveLength(1);
  });

  it("confirms a single matching operation without confusing preexisting unrelated history", async () => {
    const job = overview.jobs[0]!;
    const historical = { ...job, id: "eeeeeeee-1111-4111-8111-111111111111", operation: "strategy.competitors" as const, results: [] };
    overview = { availability, jobs: [historical] }; await render();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "POST") throw new TypeError("Synthetic lost acknowledgement");
      return Response.json(overview);
    });
    await act(async () => { await api.enqueue("strategy.reformulate", 1, allowance); });
    expect(api.actionError).toContain("Check its status");
    overview = { availability, jobs: [job, historical] };
    await act(async () => api.refresh());
    expect(api.overview?.jobs).toHaveLength(2);
    expect(api.actionError).toBeNull();
    expect(mutations()).toHaveLength(1);
  });

  it.each(["owner_id", "project_id"])("rejects status confirmation with a foreign %s", async field => {
    const job = { ...overview.jobs[0]!, [field]: "dddddddd-1111-4111-8111-111111111111" };
    overview = { availability, jobs: [] }; await render();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "POST") throw new TypeError("Synthetic lost acknowledgement");
      return Response.json(overview);
    });
    await act(async () => { await api.enqueue("strategy.reformulate", 1, allowance); });
    overview = { availability, jobs: [job] };
    await act(async () => api.refresh());
    expect(api.actionError).toContain("Check its status");
    expect(api.overview?.jobs).toEqual([]);
    expect(mock.expire).toHaveBeenCalledWith(account);
    expect(mutations()).toHaveLength(1);
  });

  it.each([400, 403, 404, 409, 413, 422, 429])("retains a rejected enqueue error (%i) after a status read", async status => {
    const job = overview.jobs[0]!;
    overview = { availability, jobs: [] }; await render();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => init.method === "POST" ? new Response(null, { status }) : Response.json(overview));
    await act(async () => { await api.enqueue("strategy.reformulate", 1, allowance); });
    const error = api.actionError;
    expect(error).toBeTruthy();
    overview = { availability, jobs: [job] };
    await act(async () => api.refresh());
    expect(api.actionError).toBe(error);
    expect(mutations()).toHaveLength(1);
  });

  it("does not clear a newer error report when an uncertain enqueue is later found", async () => {
    const job = overview.jobs[0]!;
    overview = { availability, jobs: [] }; await render();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "POST") throw new TypeError("Synthetic lost acknowledgement");
      return Response.json(overview);
    });
    await act(async () => { await api.enqueue("strategy.reformulate", 1, allowance); });
    await act(async () => api.report("Your newer edits need review."));
    overview = { availability, jobs: [job] };
    await act(async () => api.refresh());
    expect(api.actionError).toBe("Your newer edits need review.");
    expect(mutations()).toHaveLength(1);
  });

  it("does not let an older confirmation read settle a newer in-flight mutation", async () => {
    const job = overview.jobs[0]!;
    overview = { availability, jobs: [] }; await render();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "POST") throw new TypeError("Synthetic lost acknowledgement");
      return Response.json(overview);
    });
    await act(async () => { await api.enqueue("strategy.reformulate", 1, allowance); });
    const oldRead = deferred<Response>(), newRequest = deferred<Response>();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => init.method === "POST" ? newRequest.promise : oldRead.promise);
    await act(async () => api.refresh());
    await act(async () => { void api.enqueue("strategy.competitors", 1, allowance); });
    await act(async () => oldRead.resolve(Response.json({ availability, jobs: [job] })));
    expect(api.pending).toBe(true);
    expect(api.overview?.jobs).toEqual([]);
    expect(api.actionError).toBeNull();
    await act(async () => { void api.enqueue("strategy.reformulate", 1, allowance); });
    expect(mutations()).toHaveLength(2);
  });

  it("recovers an applied revision after its HTTP reply stalls without replaying Apply", async () => {
    await render(); const job = overview.jobs[0]!, project = mock.memory!.get(projectId)!.saved;
    const saved = { ...project, current_revision: 2, context: { ...project.context, activity: "Kitchen" } };
    const application = { jobId: job.id, stepKey: "response", inputRevision: 1, appliedRevision: 2, appliedAt: when };
    const stalled = deferred<Response>();
    fetcher.mockImplementation(async (path: string, init: RequestInit) => {
      if (init.method === "POST") {
        overview = { availability, jobs: [{ ...job, results: job.results.map(result => ({ ...result, application })) }] };
        return stalled.promise;
      }
      return Response.json(path === `/api/projects/${projectId}` ? { project: saved } : overview);
    });
    await act(async () => { void api.apply(job, "response"); });
    await expireRequest();
    expect(api.pending).toBe(false); expect(mock.memory!.get(projectId)!.saved.current_revision).toBe(2);
    expect(mutations()).toHaveLength(1);
    await act(async () => stalled.resolve(Response.json({ project: saved, application })));
    expect(mock.memory!.get(projectId)!.saved.current_revision).toBe(2); expect(mutations()).toHaveLength(1);
  });

  it("unlocks stalled cancellation and leaves the retained job available for a status check", async () => {
    overview = { availability, jobs: [{ ...overview.jobs[0]!, state: "running", progress: 20, finished_at: null, results: [] }] };
    await render(); const stalled = deferred<Response>();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => init.method === "DELETE" ? stalled.promise : Response.json(overview));
    await act(async () => { void api.cancel(overview.jobs[0]!); });
    await expireRequest();
    expect(api.pending).toBe(false); expect(api.actionError).toContain("Check its status"); expect(mutations()).toHaveLength(1);
    overview = { availability, jobs: [{ ...overview.jobs[0]!, state: "cancelled", finished_at: when, cancel_requested_at: when }] };
    await act(async () => api.refresh());
    expect(api.overview?.jobs[0]?.state).toBe("cancelled"); expect(mutations()).toHaveLength(1);
  });
});
