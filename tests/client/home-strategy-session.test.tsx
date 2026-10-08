// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectForm } from "@/components/workspace/project-editor";
import { clearLocalDrafts, DRAFT_STORAGE_KEY } from "@/components/workspace/local-drafts";
import { createHomeInputSession, type HomeInputSession } from "@/features/home-inputs/home-input-session";
import type { VerifiedAccount } from "@/components/workspace/account-session";
const mock = vi.hoisted(() => ({ session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as VerifiedAccount | { status: "checking" | "signed_out"; generation: number }, memory: null as HomeInputSession | null, push: vi.fn(), current: vi.fn(), expire: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, homeInputSession: mock.memory, isCurrent: mock.current, expire: mock.expire, refresh: mock.refresh }) }));
let root: Root | null, host: HTMLDivElement, owner: string;
const ready = { status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 10000 }, { operation: "strategy.competitors", maximumCostMicrousd: 10000 }] };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
async function render() { await act(async () => root!.render(createElement(NewProjectForm, { initialScope: "complete_brand", home: true, exampleId: "b2b" }))); }
async function click(label: string) { await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes(label))!.click()); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.sessionStorage.clear(); clearLocalDrafts(); owner = crypto.randomUUID(); mock.session = { status: "ready", userId: owner, generation: 1 }; mock.memory = createHomeInputSession(); mock.memory.bind(mock.session);
  mock.current.mockReset().mockImplementation((account: VerifiedAccount) => mock.session.status === "ready" && account.userId === mock.session.userId && account.generation === mock.session.generation);
  mock.push.mockReset(); mock.expire.mockReset(); mock.refresh.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("combined Home and real strategy-start recovery", () => {
  it("restores the same prompt and scope after a sign-in round trip without creating another draft", async () => {
    mock.session = { status: "signed_out", generation: 2 }; mock.memory!.bind(null);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unauthenticated" }, { status: 401 })));
    await render();
    await act(async () => host.querySelector<HTMLInputElement>('input[value="naming_only"]')!.click());
    const original = host.querySelector("textarea")!.value;
    const signIn = host.querySelector<HTMLAnchorElement>('a[href="/sign-in"]')!;
    signIn.addEventListener("click", event => event.preventDefault());
    await act(async () => signIn.click());
    await act(async () => root!.unmount()); root = createRoot(host);
    // Return through Home, which has no example or scope in its URL.
    await act(async () => root!.render(createElement(NewProjectForm, { initialScope: "complete_brand", home: true })));
    expect(host.querySelector("textarea")!.value).toBe(original);
    expect(host.querySelector<HTMLInputElement>('input[value="naming_only"]')!.checked).toBe(true);
    expect(host.textContent).toContain("Your prompt is ready to continue");
    await click("Save draft");
    const stored = JSON.parse(window.localStorage.getItem(DRAFT_STORAGE_KEY)!);
    expect(stored.drafts).toHaveLength(1);
    expect(stored.drafts[0]).toMatchObject({ description: original, scope: "naming_only" });
    expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/${stored.drafts[0].id}`);
  });

  it("holds the exact browser draft immutable through an uncertain save, session fence, and sign-in recovery", async () => {
    const save = deferred<Response>(); let accountBody: Record<string, unknown> | null = null;
    const fetcher = vi.fn(async (path: string, init: RequestInit) => {
      if (path.endsWith("/capability")) return Response.json({ ownerId: owner, policy: null, reason: "Fixture storage unavailable" });
      if (path === "/api/session") return Response.json({ user: { id: owner } });
      if (path === "/api/strategy") return Response.json({ availability: ready });
      if (path === "/api/projects" && init.method === "POST") { accountBody = JSON.parse(String(init.body)); return save.promise; }
      throw new Error(`Unexpected fixture request ${path}`);
    }); vi.stubGlobal("fetch", fetcher);
    await render(); const prompt = host.querySelector("textarea")!.value; await click("Send prompt");
    const saved = window.localStorage.getItem(DRAFT_STORAGE_KEY)!;
    expect(host.querySelector("textarea")!.readOnly).toBe(true);
    mock.session = { status: "signed_out", generation: 2 }; mock.memory!.bind(null); await render();
    await act(async () => save.resolve(Response.json({ project: { ...accountBody, id: crypto.randomUUID(), owner_id: owner, current_revision: 1, created_at: "2026-10-07T00:00:00Z" } })));
    expect(host.querySelector("textarea")!.readOnly).toBe(true);
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every(input => input.disabled)).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>(".example-card")].every(button => button.disabled)).toBe(true);
    expect(host.querySelector("textarea")!.value).toBe(prompt); expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(saved);
    const signIn = host.querySelector<HTMLAnchorElement>('a[href="/sign-in"]')!;
    signIn.addEventListener("click", event => event.preventDefault()); await act(async () => signIn.click());
    expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(saved);
    mock.session = { status: "ready", userId: owner, generation: 3 }; mock.memory!.bind(mock.session); await render(); await click("Send prompt");
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1); expect(mock.push).not.toHaveBeenCalled();
    expect(host.textContent).toContain("earlier account save is not confirmed"); expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(saved);
  });
  it("opens a blocked prompt's retained browser draft with its latest text and no AI mutation", async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path.endsWith("/capability")) return Response.json({ ownerId: owner, policy: null, reason: "Fixture storage unavailable" });
      if (path === "/api/session") return Response.json({ user: { id: owner } });
      if (path === "/api/strategy") return Response.json({ availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } });
      throw new Error(`Unexpected fixture mutation ${path}`);
    }); vi.stubGlobal("fetch", fetcher);
    await render(); await click("Send prompt"); await click("A neighborhood kitchen");
    const latest = host.querySelector("textarea")!.value;
    await act(async () => [...host.querySelectorAll("a")].find(link => link.textContent === "Open retained browser draft")!.click());
    const stored = JSON.parse(window.localStorage.getItem(DRAFT_STORAGE_KEY)!);
    expect(stored.drafts).toHaveLength(1); expect(stored.drafts[0].description).toBe(latest);
    expect(stored.drafts[0].conversation.find((item: { kind: string }) => item.kind === "user_message").text).toBe(latest);
    expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/${stored.drafts[0].id}`);
    expect(fetcher.mock.calls.every(([path]) => path !== "/api/projects")).toBe(true);
  });
});
