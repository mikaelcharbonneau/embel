// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { accountProjectDraft, createAccountInput } from "@/components/workspace/project-draft-adapter";
import { useAccountStrategyStart } from "@/components/workspace/account-strategy-start";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({ session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as VerifiedAccount | { status: "checking" | "signed_out"; generation: number }, push: vi.fn(), refresh: vi.fn(), expire: vi.fn(), current: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire, refresh: mock.refresh }) }));
let owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ready = (cap = 10000) => ({ status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: cap }, { operation: "strategy.competitors", maximumCostMicrousd: cap }] });
const unavailable = (reason = "worker_unavailable") => ({ status: "unavailable", operations: [], reason });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let root: Root | null, host: HTMLDivElement, api: ReturnType<typeof useAccountStrategyStart>;
let draft: ReturnType<typeof accountProjectDraft>, fetcher: ReturnType<typeof vi.fn>;
let runtime: unknown;
function project() { return { ...createAccountInput(draft), id: projectId, owner_id: owner, current_revision: 1, created_at: "2026-10-07T00:00:00Z" }; }
function job() { return { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", owner_id: owner, project_id: projectId, operation: "strategy.reformulate", input_revision: 1, state: "queued", progress: 0, error_code: null, cancel_requested_at: null, created_at: "2026-10-07T00:00:00Z", finished_at: null, reserved_cost_microusd: 10000, actual_cost_microusd: 0, results: [] }; }
async function defaultFetch(path: string, init: RequestInit) {
  if (path === "/api/session") return Response.json({ user: { id: owner } });
  if (path === "/api/strategy") return Response.json({ availability: runtime });
  if (path === "/api/projects" && init.method === "POST") return Response.json({ project: project() });
  if (path === `/api/projects/${projectId}/strategy` && init.method === "POST") {
    const body = JSON.parse(String(init.body));
    return Response.json({ job: body.billingMode === "chatgpt_subscription" ? { ...job(), billingMode: body.billingMode, policyIdentity: body.acceptedPolicyIdentity } : job() });
  }
  throw new Error(`Unexpected request ${path}`);
}
function Harness() { const value = useAccountStrategyStart(); useLayoutEffect(() => { api = value; }); return createElement("div", null, value.notice); }
async function render() { await act(async () => root!.render(createElement(Harness))); }
async function start() { let result: boolean | undefined; await act(async () => { result = await api.start(draft); }); return result; }
const mutations = () => fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.sessionStorage.clear(); window.localStorage.clear(); owner = crypto.randomUUID(); mock.session = { status: "ready", userId: owner, generation: 1 };
  mock.current.mockReset().mockImplementation((value: VerifiedAccount) => mock.session.status === "ready" && value.userId === mock.session.userId && value.generation === mock.session.generation);
  mock.push.mockReset(); mock.refresh.mockReset(); mock.expire.mockReset();
  draft = accountProjectDraft({ id: crypto.randomUUID(), owner_id: owner, scope: "complete_brand", title: "Prompt recovery fixture", current_revision: 1, created_at: "2026-10-07T00:00:00Z", context: contextSnapshotSchema.parse({ description: "A genuinely retained prompt" }) });
  runtime = ready(); fetcher = vi.fn(defaultFetch); vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("AI prompt start readiness and recovery", () => {
  it("keeps signed-out account actions separated in a wrapping row", async () => {
    mock.session = { status: "signed_out", generation: 2 }; await render();
    const stylesheet = document.createElement("style");
    stylesheet.textContent = readFileSync("src/styles/globals.css", "utf8").replace(/^@import[^;]+;/, "");
    document.body.append(stylesheet);
    const signIn = host.querySelector<HTMLAnchorElement>('a[href="/sign-in"]')!;
    const recheck = [...host.querySelectorAll("button")].find(button => button.textContent === "Recheck account")!;
    expect(signIn.parentElement).toBe(recheck.parentElement);
    const layout = getComputedStyle(signIn.parentElement!);
    expect(layout.display).toBe("flex");
    expect(layout.flexWrap).toBe("wrap");
    expect(layout.gap).toBe("16px");
    await act(async () => recheck.click());
    expect(mock.refresh).toHaveBeenCalledOnce();
    expect(mutations()).toHaveLength(0);
  });
  it("rechecks both the verified session and live readiness before creating a project", async () => {
    await render(); await start();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/strategy", "/api/session", "/api/strategy", "/api/projects", `/api/projects/${projectId}/strategy`]);
    expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}`);
    expect(mutations().map(([, init]) => JSON.parse(init.body).operation).filter(Boolean)).toEqual(["strategy.reformulate"]);
  });
  it("does not turn unavailable AI into a manual conversation", async () => {
    runtime = unavailable(); await render(); expect(await start()).toBe(false);
    expect(mutations()).toHaveLength(0); expect(mock.push).not.toHaveBeenCalled();
    expect(host.textContent).toContain("worker is not ready"); expect(host.textContent).toContain("Recheck AI availability");
  });
  it.each(["signed_out", "checking"] as const)("keeps %s Send pending an explicit verified retry", async status => {
    mock.session = { status, generation: 2 }; await render(); expect(await start()).toBe(false);
    expect(mutations()).toHaveLength(0); expect(mock.push).not.toHaveBeenCalled();
    expect(host.textContent).toMatch(status === "signed_out" ? /Sign in/ : /Checking your account/);
    expect(host.textContent).not.toContain("Send starts a conversation");
  });
  it("waits for Send's fresh readiness read while initial readiness is still loading, then shows cost before dispatch", async () => {
    const old = deferred<Response>(), fresh = deferred<Response>(); let reads = 0;
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/strategy" ? (++reads === 1 ? old.promise : fresh.promise) : defaultFetch(path, init));
    await render(); let result!: Promise<boolean>;
    await act(async () => { result = api.start(draft); });
    expect(reads).toBe(2); expect(mutations()).toHaveLength(0); expect(mock.push).not.toHaveBeenCalled();
    await act(async () => { fresh.resolve(Response.json({ availability: ready() })); await result; });
    expect(await result).toBe(false); expect(host.textContent).toContain("Send again"); expect(mutations()).toHaveLength(0);
    await act(async () => old.resolve(Response.json({ availability: unavailable() })));
    expect(host.textContent).toContain("$0.02");
  });
  it("recovers newly available AI through a read-only Recheck and one explicit Send", async () => {
    runtime = unavailable(); await render(); await start(); runtime = ready();
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Recheck AI availability")!.click());
    expect(mutations()).toHaveLength(0); await start(); expect(mutations()).toHaveLength(2); expect(mock.push).toHaveBeenCalledOnce();
  });
  it("blocks a newly unavailable worker even when the previous displayed plan was ready", async () => {
    await render(); runtime = unavailable(); expect(await start()).toBe(false);
    expect(mutations()).toHaveLength(0); expect(mock.push).not.toHaveBeenCalled(); expect(host.textContent).toContain("worker is not ready");
  });
  it("does not accept a higher price than was shown at Send", async () => {
    await render(); runtime = ready(20000); expect(await start()).toBe(false);
    expect(mutations()).toHaveLength(0); expect(host.textContent).toContain("Send again"); expect(host.textContent).toContain("$0.04");
  });
  it("expires a session rejected during fresh verification before any mutation", async () => {
    await render(); fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/session" ? Promise.resolve(new Response(null, { status: 401 })) : defaultFetch(path, init));
    expect(await start()).toBe(false); expect(mock.expire).toHaveBeenCalledOnce(); expect(mutations()).toHaveLength(0); expect(mock.push).not.toHaveBeenCalled();
  });
  it("rejects a different verified owner returned by the fresh session read", async () => {
    await render(); fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/session" ? Promise.resolve(Response.json({ user: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } })) : defaultFetch(path, init));
    await start(); expect(mock.expire).toHaveBeenCalledOnce(); expect(mutations()).toHaveLength(0); expect(mock.push).not.toHaveBeenCalled();
  });
  it("admits at most one request chain under a same-turn double click", async () => {
    await render(); const gate = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/session" ? gate.promise : defaultFetch(path, init));
    let first!: Promise<boolean>, second!: Promise<boolean>;
    await act(async () => { first = api.start(draft); second = api.start(draft); });
    await act(async () => { gate.resolve(Response.json({ user: { id: owner } })); await Promise.all([first, second]); });
    expect(mutations()).toHaveLength(2); expect(mock.push).toHaveBeenCalledOnce();
  });
  it("fences a late readiness response after owner change", async () => {
    await render(); const gate = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/strategy" ? gate.promise : defaultFetch(path, init));
    let result!: Promise<boolean>; await act(async () => { result = api.start(draft); });
    mock.session = { status: "signed_out", generation: 2 }; await render();
    await act(async () => { gate.resolve(Response.json({ availability: ready() })); await result; });
    expect(mutations()).toHaveLength(0); expect(mock.push).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("$0.02");
  });
  it("retries an ambiguous creation with its original key and payload after remount", async () => {
    await render(); fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/projects" ? Promise.reject(new TypeError("Lost commit acknowledgement")) : defaultFetch(path, init));
    await start(); expect(mutations()).toHaveLength(1); expect(mock.push).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Check account brands");
    await act(async () => root!.unmount()); root = createRoot(host); await render(); await start();
    expect(mutations()).toHaveLength(2); expect(mutations()[1]![1].body).toBe(mutations()[0]![1].body); expect(host.textContent).toContain("Check account brands");
  });
  it("retains a confirmed account project when job submission is uncertain and opens its status without a second create", async () => {
    await render(); fetcher.mockImplementation((path: string, init: RequestInit) => path.endsWith("/strategy") && init.method === "POST" ? Promise.reject(new TypeError("Lost job acknowledgement")) : defaultFetch(path, init));
    expect(await start()).toBe(false); expect(mock.push).not.toHaveBeenCalled(); expect(host.textContent).toContain("not confirmed");
    expect(host.querySelector(`a[href='/brands/account/${projectId}']`)).not.toBeNull();
    await start(); expect(mutations()).toHaveLength(2); expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}`);
  });
  it("does not navigate or enqueue after a late project response crosses the owner fence", async () => {
    await render(); const gate = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/projects" ? gate.promise : defaultFetch(path, init));
    let result!: Promise<boolean>; await act(async () => { result = api.start(draft); });
    mock.session = { status: "signed_out", generation: 2 }; await render();
    await act(async () => { gate.resolve(Response.json({ project: project() })); await result; });
    expect(mutations()).toHaveLength(1); expect(mock.push).not.toHaveBeenCalled();
    expect(host.querySelector(`a[href='/brands/account/${projectId}']`)).toBeNull();
  });
  it("opens the known account recovery project even if runtime readiness cannot be read", async () => {
    await render(); fetcher.mockImplementation((path: string, init: RequestInit) => path.endsWith("/strategy") && init.method === "POST" ? Promise.reject(new TypeError("Lost job acknowledgement")) : defaultFetch(path, init));
    await start(); expect(mutations()).toHaveLength(2);
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/strategy" ? Promise.reject(new TypeError("Runtime read failed")) : defaultFetch(path, init));
    expect(await start()).toBe(true); expect(mutations()).toHaveLength(2); expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}`);
  });

  const limits = { maxInputBytes: 131072, maxOutputBytes: 262144, deadlineMs: 240000, maxObservedWebSearchCalls: 2, maxRequestsPerHour: 20, maxQueuedJobs: 3 };
  const subscription = (policyIdentity = "a".repeat(64), requests = 20) => ({ status: "available", operations: ["strategy.reformulate", "strategy.competitors"].map(operation => ({ operation, billingMode: "chatgpt_subscription", policyIdentity, limits: { ...limits, maxRequestsPerHour: requests } })) });
  it("shows every accepted subscription limit separately for response and research", async () => {
    runtime = subscription(); await render();
    for (const operation of ["Response", "Competitor research"]) {
      const text = host.querySelector(`[aria-label="${operation} usage limits"]`)?.textContent ?? "";
      for (const value of ["131,072 input bytes", "262,144 output bytes", "240 seconds", "2 observed web searches", "20 requests/hour", "3 queued requests"]) expect(text).toContain(value);
    }
  });
  it.each(["billing mode", "policy", "increased limit"])("requires renewed Send after changed %s and displays the actual subscription limits", async change => {
    runtime = change === "billing mode" ? ready() : subscription(); await render();
    runtime = subscription(change === "policy" ? "b".repeat(64) : "a".repeat(64), change === "increased limit" ? 25 : 20);
    expect(await start()).toBe(false); expect(mutations()).toHaveLength(0);
    expect(host.textContent).toContain("Send again"); expect(host.textContent).toContain(`${change === "increased limit" ? 25 : 20} requests/hour`);
    expect(await start()).toBe(true); expect(mutations()).toHaveLength(2);
    expect(JSON.parse(String(mutations()[1]?.[1].body))).toMatchObject({ billingMode: "chatgpt_subscription", acceptedPolicyIdentity: change === "policy" ? "b".repeat(64) : "a".repeat(64) });
  });
  it("requires renewed Send when changing from subscription to API billing", async () => {
    runtime = subscription(); await render(); runtime = ready(30000);
    expect(await start()).toBe(false); expect(mutations()).toHaveLength(0); expect(host.textContent).toContain("$0.06");
    expect(await start()).toBe(true); expect(mutations()).toHaveLength(2);
  });
  it("retires confirmed account-routing receipts whose browser drafts are gone", async () => {
    window.localStorage.clear();
    window.sessionStorage.setItem("fluid.strategy-starts.v1", JSON.stringify(Array.from({ length: 200 }, () => ({ ownerId: owner, draftId: crypto.randomUUID(), projectId }))));
    await render(); expect(await start()).toBe(true); expect(mutations()).toHaveLength(2);
    expect(host.textContent).not.toContain("save is not confirmed");
  });
  it("reports unresolved capacity before any POST and does not make it an unconfirmed new save", async () => {
    window.sessionStorage.setItem("fluid.strategy-starts.v1", JSON.stringify(Array.from({ length: 200 }, () => ({ ownerId: owner, draftId: crypto.randomUUID(), projectId: null }))));
    await render(); expect(await start()).toBe(false); expect(mutations()).toHaveLength(0);
    expect(host.textContent).toContain("Recovery storage is full"); expect(host.textContent).toContain("No new account project or AI request was sent");
    expect(api.locked).toBe(false); expect(host.textContent).not.toContain("account save is not confirmed");
    expect(host.querySelector('a[href="/brands"]')).not.toBeNull();
  });
  it("keeps unresolved guards across owner changes without letting one owner's capacity block another", async () => {
    const originalOwner = owner, blockedDraft = draft;
    window.sessionStorage.setItem("fluid.strategy-starts.v1", JSON.stringify([{ ownerId: owner, draftId: draft.id, projectId: null }, ...Array.from({ length: 199 }, () => ({ ownerId: owner, draftId: crypto.randomUUID(), projectId: null }))]));
    await render(); expect(await start()).toBe(false); expect(mutations()).toHaveLength(0);
    owner = crypto.randomUUID(); draft = { ...draft, id: crypto.randomUUID() }; mock.session = { status: "ready", userId: owner, generation: 2 }; await render();
    expect(await start()).toBe(true); expect(mutations()).toHaveLength(2);
    owner = originalOwner; draft = blockedDraft; mock.session = { status: "ready", userId: owner, generation: 3 }; await render();
    expect(await start()).toBe(false); expect(mutations()).toHaveLength(2); expect(host.textContent).toContain("earlier account save is not confirmed");
  });
  it.each([false, true])("retains uncertain guards on reverification when storage fails (durable unreadable: %s)", async durableUnavailable => {
    await render(); fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/projects" ? Promise.reject(new TypeError("Lost create acknowledgement")) : defaultFetch(path, init));
    await start(); expect(mutations()).toHaveLength(1);
    const originalGet = Storage.prototype.getItem, originalSet = Storage.prototype.setItem;
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function(this: Storage, key: string) { if (durableUnavailable || this === window.sessionStorage) throw new Error("Unavailable storage"); return originalGet.call(this, key); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, key: string, value: string) { if (durableUnavailable || this === window.sessionStorage) throw new Error("Unavailable storage"); return originalSet.call(this, key, value); });
    try {
      await act(async () => root!.unmount()); root = createRoot(host); mock.session = { status: "ready", userId: owner, generation: 2 }; await render();
      expect(await start()).toBe(false); expect(mutations()).toHaveLength(durableUnavailable ? 1 : 2);
      if (!durableUnavailable) expect(mutations()[1]![1].body).toBe(mutations()[0]![1].body);
    } finally { get.mockRestore(); set.mockRestore(); }
  });

  it("does not retire a confirmed receipt while its source remains in durable browser storage", async () => {
    const retainedId = crypto.randomUUID();
    window.localStorage.setItem("fluid.local-drafts.v1", JSON.stringify({ version: 1, drafts: [{ ...draft, id: retainedId }] }));
    window.sessionStorage.setItem("fluid.strategy-starts.v1", JSON.stringify([{ ownerId: owner, draftId: retainedId, projectId }]));
    await render(); expect(await start()).toBe(true);
    expect(JSON.parse(window.sessionStorage.getItem(`fluid.strategy-starts.v2:${owner}`)!)).toContainEqual({ ownerId: owner, draftId: retainedId, projectId });
    window.localStorage.clear();
  });
  it("does not use unavailable storage as proof that a confirmed receipt can retire", async () => {
    await render(); await start(); const firstDraft = draft;
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Unavailable storage"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Unavailable storage"); });
    try {
      draft = { ...firstDraft, id: crypto.randomUUID() }; await start(); expect(mutations()).toHaveLength(2);
      draft = firstDraft; await start(); expect(mutations()).toHaveLength(2); expect(mock.push).toHaveBeenCalledTimes(2);
    } finally { get.mockRestore(); set.mockRestore(); }
  });

});


describe("response-only Home start", () => {
  const responseOnly = () => ({ status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 122880 }] });
  it("saves the owned prompt and enqueues exactly one bounded response", async () => {
    runtime = responseOnly(); await render();
    expect(host.textContent).toContain("requests a response, up to $0.13");
    expect(host.textContent).toContain("Competitor research is unavailable");
    expect(await start()).toBe(true);
    expect(mutations()).toHaveLength(2);
    expect(JSON.parse(mutations()[0]![1].body)).toEqual({ ...createAccountInput(draft), requestKey: draft.id });
    expect(JSON.parse(mutations()[1]![1].body)).toMatchObject({ operation: "strategy.reformulate", expectedRevision: 1, acceptedMaxCostMicrousd: 122880 });
    expect(JSON.parse(window.sessionStorage.getItem("fluid.strategy-consent.v1")!)).toEqual([{ ownerId: owner, projectId, revision: 1, kind: "response_only", billingMode: "openai_api", reformulationCap: 122880 }]);
    expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}`);
  });
  it.each(["research became ready", "research became unavailable"])("requires a new explicit Send if %s during readiness verification", async change => {
    runtime = change === "research became ready" ? responseOnly() : ready(122880); await render();
    runtime = change === "research became ready" ? ready(122880) : responseOnly();
    expect(await start()).toBe(false); expect(mutations()).toHaveLength(0);
    expect(host.textContent).toContain("Send again");
    expect(await start()).toBe(true); expect(mutations()).toHaveLength(2);
  });
  it("retains response-only consent after an uncertain enqueue, remount and readiness change", async () => {
    runtime = responseOnly(); await render();
    fetcher.mockImplementation((path: string, init: RequestInit) => path.endsWith("/strategy") && init.method === "POST" ? Promise.reject(new TypeError("Lost job acknowledgement")) : defaultFetch(path, init));
    expect(await start()).toBe(false); expect(mutations()).toHaveLength(2);
    const consent = window.sessionStorage.getItem("fluid.strategy-consent.v1");
    expect(JSON.parse(consent!)[0]).toMatchObject({ kind: "response_only", reformulationCap: 122880 });
    runtime = ready(122880);
    await act(async () => root!.unmount()); root = createRoot(host); await render();
    expect(await start()).toBe(true);
    expect(mutations()).toHaveLength(2);
    expect(window.sessionStorage.getItem("fluid.strategy-consent.v1")).toBe(consent);
  });
});

describe("stalled Home strategy request recovery", () => {
  it("releases a stalled readiness check without saving or sending, and ignores its late reply", async () => {
    vi.useFakeTimers(); await render();
    const stalled = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/strategy" ? stalled.promise : defaultFetch(path, init));
    let outcome: boolean | undefined;
    await act(async () => { void api.start(draft).then(value => { outcome = value; }); });
    expect(api.pending).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.pending).toBe(false); expect(outcome).toBe(false);
    expect(mutations()).toHaveLength(0);
    await act(async () => stalled.resolve(Response.json({ availability: ready() })));
    expect(mutations()).toHaveLength(0); expect(mock.push).not.toHaveBeenCalled();
    fetcher.mockImplementation(defaultFetch);
    expect(await start()).toBe(true); expect(mutations()).toHaveLength(2);
  });

  it("replays a timed-out save after remount without repeating AI", async () => {
    vi.useFakeTimers(); await render();
    const stalled = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/projects" ? stalled.promise : defaultFetch(path, init));
    await act(async () => { void api.start(draft); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.pending).toBe(false); expect(api.locked).toBe(true);
    expect(host.textContent).toContain("account save is not confirmed"); expect(mutations()).toHaveLength(1);
    await act(async () => root!.unmount()); root = createRoot(host); await render();
    await act(async () => stalled.resolve(Response.json({ project: project() })));
    fetcher.mockImplementation(defaultFetch);
    expect(await start()).toBe(true);
    expect(mutations()).toHaveLength(2); expect(mutations()[1]![1].body).toBe(mutations()[0]![1].body); expect(mock.push).toHaveBeenCalledOnce();
  });

  it("retains the saved project after a stalled enqueue and opens it without resubmitting", async () => {
    vi.useFakeTimers(); await render();
    const stalled = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) => path.endsWith("/strategy") && init.method === "POST" ? stalled.promise : defaultFetch(path, init));
    await act(async () => { void api.start(draft); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.pending).toBe(false); expect(mutations()).toHaveLength(2);
    expect(host.textContent).toContain("AI request is not confirmed");
    expect(host.querySelector(`a[href='/brands/account/${projectId}']`)).not.toBeNull();
    await act(async () => stalled.resolve(Response.json({ job: job() })));
    expect(mock.push).not.toHaveBeenCalled();
    expect(await start()).toBe(true);
    expect(mutations()).toHaveLength(2); expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}`);
  });
});
