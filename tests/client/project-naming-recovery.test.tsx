// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { DEFAULT_SUBSCRIPTION_LIMITS } from "@/domain/strategy-jobs";
import { namingPreferencesV1Schema, getNamingReadiness, initialNamingPreferences, nameIdentityKey, namingStrategyBasis, namingStrategyKey, type NamingBatch, type ProjectNameEntry } from "@/domain/project-naming";
import { projectNamingOverviewSchema, type NamingJob, type ProjectNamingOverview } from "@/domain/naming-jobs";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { initialNamingView, useProjectNaming } from "@/components/naming/use-project-naming";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { reviewedStrategy } from "../fixtures/reviewed-strategy";

const mock = vi.hoisted(() => ({ memory: null as ReturnType<typeof createAccountDraftMemory> | null, current: vi.fn(), expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ drafts: mock.memory, isCurrent: mock.current, expire: mock.expire }) }));
const projectId = "bbbbbbbb-1111-4111-8111-111111111111", when = "2026-10-04T10:00:00.000Z", policyIdentity = "a".repeat(64);
const base = `/api/projects/${projectId}/naming`;
const id = (index: number) => `eeeeeeee-1111-4111-8111-${String(index).padStart(12, "0")}`;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let root: Root | null, host: HTMLDivElement, api: ReturnType<typeof useProjectNaming>, account: VerifiedAccount;
let state: ProjectNamingOverview, rows: ProjectNameEntry[], fetcher: ReturnType<typeof vi.fn>;
function Harness() {
  const value = useProjectNaming({ account, projectId });
  useLayoutEffect(() => { api = value; });
  return null;
}
async function render() { await act(async () => root!.render(createElement(Harness))); }
async function expireRequest() { await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); }
async function refresh() { await act(async () => api.refresh()); }
const writes = () => fetcher.mock.calls.filter(([, init]) => init.method !== "GET");
function candidate(index: number): ProjectNameEntry {
  const value = `Fixture ${index}`, createdAt = new Date(Date.parse(when) + index * 1000).toISOString();
  return { candidate: { id: id(index), ownerId: account.userId, projectId, value, identityKey: nameIdentityKey(value), rationale: "Synthetic imported name.", contextRevision: 1,
    strategyBasis: namingStrategyBasis(state.project.context), strategyKey: namingStrategyKey(state.project.context),
    origin: { kind: "local_import", ownerId: account.userId, projectId, candidateId: id(index), contextRevision: 1,
      source: { id: id(index), value, createdAt, origin: "manual", history: [] }, capturedContext: state.project.context }, createdAt },
    retention: { ownerId: account.userId, projectId, candidateId: id(index), revision: 0, favorite: false, saved: false, updatedAt: null } };
}
function overview(path = base) {
  const url = new URL(path, "https://fixture.invalid"), cursor = url.searchParams.get("cursorId");
  const start = cursor ? rows.findIndex(entry => entry.candidate.id === cursor) + 1 : 0;
  const items = rows.slice(start, start + 100), last = items.at(-1)?.candidate;
  return projectNamingOverviewSchema.parse({ ...state, candidates: { ownerId: account.userId, projectId, items, nextCursor: last && start + items.length < rows.length ? { id: last.id, createdAt: last.createdAt } : null } });
}
function admitted() {
  const batch: NamingBatch = { id: "cccccccc-1111-4111-8111-111111111111", ownerId: account.userId, projectId, contextRevision: 1, strategyBasis: namingStrategyBasis(state.project.context), strategyKey: namingStrategyKey(state.project.context), preferencesVersion: 1, preferences: namingPreferencesV1Schema.parse(state.preferences!.preferences), favoritesSnapshot: [], acceptedPolicyIdentity: policyIdentity, sequence: 1, targetCount: 250, jobId: "ffffffff-1111-4111-8111-111111111111", createdAt: when };
  const job: NamingJob = { id: batch.jobId, owner_id: account.userId, project_id: projectId, operation: "naming.generate", input_revision: 1, state: "queued", progress: 0, error_code: null, cancel_requested_at: null, created_at: when, finished_at: null, billingMode: "chatgpt_subscription", policyIdentity, batchId: batch.id, sequence: 1, targetCount: 250, results: [] };
  state = { ...state, session: { ...state.session!, latestBatchSequence: 1 }, batches: { ...state.batches, items: [{ batch, result: null }] }, jobs: [job] };
  return { batch, job, session: state.session };
}
beforeEach(() => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  account = { status: "ready", userId: crypto.randomUUID(), generation: 1 };
  mock.current.mockReset().mockImplementation((value: VerifiedAccount) => value.userId === account.userId && value.generation === account.generation);
  mock.expire.mockReset(); mock.memory = createAccountDraftMemory();
  const project = accountProjectSchema.parse({ id: projectId, owner_id: account.userId, title: "Naming recovery fixture", scope: "complete_brand", current_revision: 1, created_at: when, context: reviewedStrategy({ description: "A neighborhood lunch kitchen" }) });
  mock.memory.set({ ownerId: account.userId, generation: 1, saved: project, draft: accountProjectDraft(project), conflict: false });
  const owned = { ownerId: account.userId, projectId };
  state = projectNamingOverviewSchema.parse({ project, readiness: getNamingReadiness(project.context, project.scope),
    session: { ...owned, revision: 1, currentPreferencesVersion: 1, latestBatchSequence: 0, currentSelectionId: null, viewRevision: 1, viewState: initialNamingView, createdAt: when, updatedAt: when },
    preferences: { ...owned, version: 1, preferences: initialNamingPreferences(project.context), createdAt: when }, currentSelection: null,
    batches: { ...owned, items: [], nextCursor: null }, candidates: { ...owned, items: [], nextCursor: null },
    availability: { status: "available", operation: "naming.generate", billingMode: "chatgpt_subscription", policyIdentity, limits: { ...DEFAULT_SUBSCRIPTION_LIMITS, maxObservedWebSearchCalls: 0 } }, jobs: [],
    screening: { domains: { status: "not_checked", reason: "integration_unavailable" }, handles: { status: "not_checked", reason: "integration_unavailable" }, trademarks: { status: "not_checked", reason: "integration_unavailable" } } });
  rows = [];
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json(overview(path));
    throw new Error("Unexpected fixture mutation");
  });
  vi.stubGlobal("fetch", fetcher); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Naming acknowledgement recovery", () => {
  it("bounds a stalled first read and ignores its late snapshot after a successful refresh", async () => {
    const stalled = deferred<Response>(); fetcher.mockImplementationOnce(() => stalled.promise);
    await render(); await expireRequest();
    expect(api.readError).toContain("could not be confirmed");
    await refresh(); expect(api.overview?.project.current_revision).toBe(1);
    const next = { ...state.project, current_revision: 2, title: "Current saved title" };
    state = { ...state, project: next }; await refresh();
    await act(async () => stalled.resolve(Response.json({ ...overview(), project: { ...next, current_revision: 1, title: "Late title" } })));
    expect(api.overview?.project.title).toBe("Current saved title"); expect(writes()).toHaveLength(0);
  });

  it("unlocks a stalled batch acknowledgement and recovers the durable batch without a second POST", async () => {
    await render(); const stalled = deferred<Response>(); let response: ReturnType<typeof admitted>;
    fetcher.mockImplementation(async (path: string, init: RequestInit) => {
      if (init.method === "POST") { response = admitted(); return stalled.promise; }
      return Response.json(overview(path));
    });
    await act(async () => { void api.enqueue(); }); await expireRequest();
    expect(api.pending).toBe(false); expect(api.actionError).toContain("could not be confirmed");
    expect(api.overview?.jobs[0]?.state).toBe("queued"); expect(writes()).toHaveLength(1);
    await act(async () => stalled.resolve(Response.json(response!)));
    expect(writes()).toHaveLength(1); expect(mock.expire).not.toHaveBeenCalled();
  });

  it("reuses the original batch intent when the user explicitly retries an unconfirmed admission", async () => {
    await render(); const stalled = deferred<Response>();
    fetcher.mockImplementation(async (path: string, init: RequestInit) => {
      if (init.method === "POST") return writes().length === 1 ? stalled.promise : Response.json(admitted());
      return Response.json(overview(path));
    });
    await act(async () => { void api.enqueue(); }); await expireRequest();
    expect(writes()).toHaveLength(1); expect(api.pending).toBe(false);
    await act(async () => api.enqueue());
    expect(writes()).toHaveLength(2);
    expect(writes()[0]![1].body).toBe(writes()[1]![1].body);
    expect(api.overview?.jobs).toHaveLength(1);
  });

  it("recovers cancellation by reading its job without issuing another DELETE", async () => {
    const admittedBatch = admitted(); await render(); const stalled = deferred<Response>();
    fetcher.mockImplementation(async (path: string, init: RequestInit) => {
      if (init.method === "DELETE") {
        state = { ...state, jobs: [{ ...admittedBatch.job, state: "cancel_requested", cancel_requested_at: when }] };
        return stalled.promise;
      }
      return Response.json(overview(path));
    });
    await act(async () => { void api.cancel(admittedBatch.job); }); await expireRequest();
    expect(api.pending).toBe(false); expect(api.overview?.jobs[0]?.state).toBe("cancel_requested");
    expect(writes()).toHaveLength(1); expect(writes()[0]![1].method).toBe("DELETE");
  });

  it("keeps a selection and newer draft edits after its saved response is lost", async () => {
    rows = [candidate(1)]; await render(); const stalled = deferred<Response>();
    fetcher.mockImplementation(async (path: string, init: RequestInit) => {
      if (init.method === "POST") {
        const project = { ...state.project, current_revision: 2, context: { ...state.project.context, selectedName: rows[0]!.candidate.value, intake: { ...state.project.context.intake, suppliedName: rows[0]!.candidate.value } } };
        const selection = { id: id(999), ownerId: account.userId, projectId, candidateId: id(1), projectRevision: 2, previousSelectionId: null, acceptedEarlierContext: false, createdAt: when };
        state = { ...state, project, session: { ...state.session!, currentSelectionId: selection.id }, currentSelection: { selection, candidate: rows[0]!.candidate } };
        return stalled.promise;
      }
      return Response.json(overview(path));
    });
    await act(async () => { void api.select(rows[0]!, false); });
    await act(async () => { const before = mock.memory!.get(projectId)!; mock.memory!.set({ ...before, draft: { ...before.draft, title: "Newer unsaved strategy edit" } }); });
    await expireRequest();
    expect(api.pending).toBe(false); expect(api.overview?.currentSelection?.candidate.id).toBe(id(1));
    expect(mock.memory!.get(projectId)).toMatchObject({ draft: { title: "Newer unsaved strategy edit" }, conflict: true });
    expect(writes()).toHaveLength(1);
  });
});

describe("Naming pagination resumes from current saved results", () => {
  it.each(["empty", "failed"] as const)("clears changed-query rows and old cursors while the new first page is pending, then %s", async outcome => {
    rows = Array.from({ length: 250 }, (_, index) => candidate(index + 1)); await render(); await act(async () => api.loadMore());
    expect(api.overview?.candidates.items).toHaveLength(200); expect(api.overview?.candidates.nextCursor?.id).toBe(id(200));
    const nextPage = deferred<Response>();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        state = { ...state, session: { ...state.session!, viewRevision: body.expectedViewRevision + 1, viewState: body.viewState } };
        return Response.json({ session: state.session });
      }
      return nextPage.promise;
    });
    await act(async () => api.saveView({ query: "Juniper", filter: "favorite", scrollCandidateId: null }));
    expect(api.listStatus).toBe("loading"); expect(api.overview?.session?.viewState).toMatchObject({ query: "Juniper", filter: "favorite" });
    expect(api.overview?.candidates.items).toEqual([]); expect(api.overview?.candidates.nextCursor).toBeNull();
    const requestCount = fetcher.mock.calls.length; await act(async () => api.loadMore()); expect(fetcher.mock.calls).toHaveLength(requestCount);
    const lastRead = fetcher.mock.calls.filter(([, init]) => init.method === "GET").at(-1)!;
    expect(lastRead[0]).toBe(`${base}?limit=100`); expect(lastRead[0]).not.toContain("cursor");
    rows = [];
    await act(async () => nextPage.resolve(outcome === "empty" ? Response.json(overview()) : new Response(null, { status: 503 })));
    expect(api.listStatus).toBe(outcome === "empty" ? "ready" : "failed");
    expect(api.overview?.candidates.items).toEqual([]); expect(api.overview?.candidates.nextCursor).toBeNull();
    await act(async () => api.loadMore()); expect(fetcher.mock.calls).toHaveLength(requestCount);
    expect(writes()).toHaveLength(1); expect(writes()[0]![1].method).toBe("PATCH");
  });

  it("uses only the new query's acknowledged cursor after a populated first page", async () => {
    rows = Array.from({ length: 250 }, (_, index) => candidate(index + 1)); await render(); await act(async () => api.loadMore());
    const newRows = Array.from({ length: 101 }, (_, index) => { const entry = candidate(index + 501); return { ...entry, retention: { ...entry.retention, revision: 1, favorite: true, updatedAt: when } }; });
    fetcher.mockImplementation(async (path: string, init: RequestInit) => {
      if (init.method === "PATCH") {
        const body = JSON.parse(String(init.body)); rows = newRows;
        state = { ...state, session: { ...state.session!, viewRevision: body.expectedViewRevision + 1, viewState: body.viewState } };
        return Response.json({ session: state.session });
      }
      return Response.json(overview(path));
    });
    await act(async () => api.saveView({ query: "Fixture", filter: "favorite", scrollCandidateId: null }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.readError).toBeNull();
    expect(api.overview?.candidates.items).toHaveLength(100); expect(api.overview?.candidates.nextCursor?.id).toBe(id(600));
    expect(api.overview?.candidates.items.some(entry => entry.candidate.id === id(1))).toBe(false);
    await act(async () => api.loadMore());
    expect(api.overview?.candidates.items).toHaveLength(101); expect(api.overview?.candidates.nextCursor).toBeNull();
    const page = new URL(fetcher.mock.calls.at(-1)![0], "https://fixture.invalid");
    expect(page.searchParams.get("query")).toBe("Fixture"); expect(page.searchParams.get("filter")).toBe("favorite");
    expect(page.searchParams.get("cursorId")).toBe(id(600)); expect(page.searchParams.get("cursorId")).not.toBe(id(200));
    expect(writes()).toHaveLength(1);
  });

  it("keeps an appended name reachable after all earlier pages were loaded", async () => {
    rows = Array.from({ length: 150 }, (_, index) => candidate(index + 1)); await render();
    await act(async () => api.loadMore()); expect(api.overview?.candidates.items).toHaveLength(150);
    expect(api.overview?.candidates.nextCursor).toBeNull();
    rows.push(candidate(151)); await refresh();
    if (!api.overview!.candidates.items.some(entry => entry.candidate.id === id(151))) await act(async () => api.loadMore());
    expect(api.overview?.candidates.items.map(entry => entry.candidate.id)).toContain(id(151));
    expect(writes()).toHaveLength(0);
  });

  it("refreshes retained flags in a loaded later page instead of keeping stale account state", async () => {
    rows = Array.from({ length: 150 }, (_, index) => candidate(index + 1)); await render(); await act(async () => api.loadMore());
    rows[149] = { ...rows[149]!, retention: { ...rows[149]!.retention, revision: 1, favorite: true, updatedAt: when } };
    await refresh();
    expect(api.overview?.candidates.items.find(entry => entry.candidate.id === id(150))?.retention).toMatchObject({ revision: 1, favorite: true });
    expect(writes()).toHaveLength(0);
  });

  it("retains the visible list when a refreshed continuation moves backwards", async () => {
    rows = Array.from({ length: 150 }, (_, index) => candidate(index + 1)); await render(); await act(async () => api.loadMore());
    const before = api.overview;
    fetcher.mockImplementation(async (path: string) => Response.json(path.includes("cursorId") ? overview() : overview(path)));
    await refresh();
    expect(api.readError).toContain("could not be verified");
    expect(api.overview).toBe(before); expect(writes()).toHaveLength(0);
  });

  it("ignores an older failed refresh after a newer read succeeded", async () => {
    await render(); const stalled = deferred<Response>(); fetcher.mockImplementationOnce(() => stalled.promise);
    await refresh(); await refresh();
    await act(async () => stalled.resolve(new Response(null, { status: 503 })));
    expect(api.readError).toBeNull(); expect(api.listStatus).toBe("ready");
  });
});

it("requests all 100 initial names and retains the same owned overview across route remount", async () => {
  rows = Array.from({ length: 100 }, (_, index) => candidate(index + 1));
  await render();
  expect(api.overview?.candidates.items).toHaveLength(100);
  expect(fetcher.mock.calls.some(([path]) => path === `${base}?limit=100`)).toBe(true);
  const saved = api.overview;
  fetcher.mockImplementation(() => new Promise(() => {}));
  await act(async () => root!.render(createElement(Harness, { key: "reopened" })));
  expect(api.overview).toBe(saved);
  await expireRequest();
  expect(api.overview).toBe(saved);
  expect(api.readError).toContain("could not be confirmed in time");
});
