// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { AccountCopyControl } from "@/components/workspace/account-projects";
import { accountProjectDraft, createAccountInput } from "@/components/workspace/project-draft-adapter";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({ session: null as VerifiedAccount | { status: "signed_out"; generation: number } | null, push: vi.fn(), current: vi.fn(), expire: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire }) }));
const projectId = "cccccccc-1111-4111-8111-111111111111", when = "2026-10-08T00:00:00Z";
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let root: Root | null, host: HTMLDivElement, owner: string, draft: ReturnType<typeof accountProjectDraft>, fetcher: ReturnType<typeof vi.fn>;
const project = () => ({ ...createAccountInput(draft), id: projectId, owner_id: owner, current_revision: 1, created_at: when });
async function defaultFetch(path: string, init: RequestInit) {
  if (path === "/api/session") return Response.json({ user: { id: owner } });
  if (path === "/api/projects" && init.method === "POST") return Response.json({ project: project() });
  throw new Error(`Unexpected fixture request ${path}`);
}
async function render() { await act(async () => root!.render(createElement(AccountCopyControl, { draft }))); }
async function click() { await act(async () => host.querySelector("button")!.click()); }
async function expireRequest() { await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); }
const mutations = () => fetcher.mock.calls.filter(([, init]) => init.method === "POST");
beforeEach(() => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.sessionStorage.clear();
  owner = crypto.randomUUID(); mock.session = { status: "ready", userId: owner, generation: 1 };
  mock.current.mockReset().mockImplementation((value: VerifiedAccount) => mock.session?.status === "ready" && value.userId === mock.session.userId && value.generation === mock.session.generation);
  mock.push.mockReset(); mock.expire.mockReset();
  draft = accountProjectDraft({ id: crypto.randomUUID(), owner_id: owner, title: "Manual browser copy fixture", scope: "complete_brand", current_revision: 1, created_at: when, context: contextSnapshotSchema.parse({ description: "A neighborhood lunch kitchen" }) });
  fetcher = vi.fn(defaultFetch); vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("manual browser-to-account copy recovery", () => {
  it("verifies the current owner, admits one same-turn copy and never requests AI", async () => {
    await render(); expect(fetcher).not.toHaveBeenCalled();
    await act(async () => { host.querySelector("button")!.click(); host.querySelector("button")!.click(); });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/session", "/api/projects"]);
    expect(JSON.parse(String(mutations()[0]![1].body))).toEqual(createAccountInput(draft));
    expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}`);
    expect(host.textContent).toContain("Open saved account project");
  });

  it("opens its confirmed copy after remount even if the independent browser draft changed", async () => {
    await render(); await click();
    draft = { ...draft, description: "Later browser-only changes" };
    await act(async () => root!.unmount()); root = createRoot(host); await render();
    expect(host.textContent).toContain("Your browser draft remains independent");
    await click(); expect(mutations()).toHaveLength(1); expect(mock.push).toHaveBeenCalledTimes(2);
  });

  it.each(["lost acknowledgement", "timeout"])("keeps %s fenced across remount and never repeats the create", async outcome => {
    const stalled = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/projects" ? outcome === "timeout" ? stalled.promise : Promise.reject(new TypeError("Lost acknowledgement")) : defaultFetch(path, init));
    await render(); await click(); if (outcome === "timeout") await expireRequest();
    expect(host.textContent).toContain("account save is not confirmed"); expect(host.querySelector("button")!.disabled).toBe(true);
    expect(host.querySelector('a[href="/brands"]')?.textContent).toBe("Check account projects");
    await act(async () => root!.unmount()); root = createRoot(host); await render();
    await act(async () => stalled.resolve(Response.json({ project: project() })));
    await click(); expect(mutations()).toHaveLength(1); expect(mock.push).not.toHaveBeenCalled();
  });

  it("recovers the Home create guard without a new account request", async () => {
    window.sessionStorage.setItem(`fluid.strategy-starts.v2:${owner}`, JSON.stringify([{ ownerId: owner, draftId: draft.id, projectId: null }]));
    await render(); await click();
    expect(fetcher).not.toHaveBeenCalled(); expect(host.querySelector("button")!.disabled).toBe(true);
    expect(host.textContent).toContain("earlier account save is not confirmed");
  });

  it("allows an explicit retry after a known validation rejection that did not create a project", async () => {
    let rejected = false;
    fetcher.mockImplementation((path: string, init: RequestInit) => {
      if (path === "/api/projects" && !rejected) { rejected = true; return Promise.resolve(new Response(null, { status: 422 })); }
      return defaultFetch(path, init);
    });
    await render(); await click(); expect(host.querySelector("button")!.disabled).toBe(false);
    expect(host.textContent).toContain("Some details could not be saved");
    await click(); expect(mutations()).toHaveLength(2); expect(mock.push).toHaveBeenCalledOnce();
  });

  it.each(["wrong owner", "expired session"])("rejects a fresh %s before copying", async failure => {
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/session" ? Promise.resolve(failure === "wrong owner" ? Response.json({ user: { id: crypto.randomUUID() } }) : new Response(null, { status: 401 })) : defaultFetch(path, init));
    await render(); await click(); expect(mutations()).toHaveLength(0); expect(mock.expire).toHaveBeenCalledOnce(); expect(mock.push).not.toHaveBeenCalled();
  });

  it("fences a late project response across sign-out and retains the original account's uncertain guard", async () => {
    const stalled = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/projects" ? stalled.promise : defaultFetch(path, init));
    await render(); await click(); expect(mutations()).toHaveLength(1);
    mock.session = { status: "signed_out", generation: 2 }; await render();
    await act(async () => stalled.resolve(Response.json({ project: project() })));
    expect(mock.push).not.toHaveBeenCalled(); expect(host.textContent).not.toContain("Open saved account project");
    mock.session = { status: "ready", userId: owner, generation: 3 }; await render(); await click();
    expect(mutations()).toHaveLength(1); expect(host.querySelector("button")!.disabled).toBe(true);
  });

  it("does not expose a previous owner's recovery destination when another account is verified", async () => {
    await render(); await click();
    mock.session = { status: "ready", userId: crypto.randomUUID(), generation: 2 }; await render();
    expect(host.textContent).not.toContain("Open saved account project");
    expect(host.textContent).not.toContain("An account copy is already saved");
    expect(host.querySelector("button")!.textContent).toContain("Save to account"); expect(mutations()).toHaveLength(1);
  });

  it("recovers a stalled session check without recording an uncertain project create", async () => {
    const stalled = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/session" ? stalled.promise : defaultFetch(path, init));
    await render(); await click(); await expireRequest();
    expect(host.querySelector("button")!.disabled).toBe(false); expect(mutations()).toHaveLength(0);
    fetcher.mockImplementation(defaultFetch); await click(); expect(mutations()).toHaveLength(1); expect(mock.push).toHaveBeenCalledOnce();
  });
});
