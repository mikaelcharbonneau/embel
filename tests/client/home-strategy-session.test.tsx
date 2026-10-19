// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectForm } from "@/components/workspace/project-editor";
import { clearLocalDrafts, createLocalDraft, DRAFT_STORAGE_KEY } from "@/components/workspace/local-drafts";
import { createHomeInputSession, type HomeInputSession } from "@/features/home-inputs/home-input-session";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { rememberPromptForSignIn } from "@/components/workspace/prompt-recovery";
const mock = vi.hoisted(() => ({ session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as VerifiedAccount | { status: "checking" | "signed_out"; generation: number }, memory: null as HomeInputSession | null, push: vi.fn(), current: vi.fn(), expire: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, homeInputSession: mock.memory, isCurrent: mock.current, expire: mock.expire, refresh: mock.refresh }) }));
let root: Root | null, host: HTMLDivElement, owner: string, fetcher: ReturnType<typeof vi.fn>;
const ready = { status: "available", operations: [{ operation: "strategy.reformulate", maximumCostMicrousd: 10000, interviewVersion: 1 }, { operation: "strategy.competitors", maximumCostMicrousd: 10000, interviewVersion: 1 }] };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
async function render(exampleId: string | undefined = "b2b") { await act(async () => root!.render(createElement(NewProjectForm, { initialScope: "complete_brand", home: true, exampleId }))); }
async function remountHome() { await act(async () => root!.unmount()); root = createRoot(host); await act(async () => root!.render(createElement(NewProjectForm, { initialScope: "complete_brand", home: true }))); }
async function signInLink() { const link = host.querySelector<HTMLAnchorElement>('a[href="/sign-in"]')!; link.addEventListener("click", event => event.preventDefault()); await act(async () => link.click()); }
async function click(label: string) { await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes(label))!.click()); }
const mutations = () => fetcher.mock.calls.filter(([, init]) => init.method === "POST");
const creations = () => mutations().filter(([path]) => path === "/api/projects");
async function defaultFetch(path: string, init: RequestInit) {
  if (path.endsWith("/capability")) return Response.json({ ownerId: owner, policy: null, reason: "Synthetic unavailable storage" });
  if (path === "/api/session") return Response.json({ user: { id: owner } });
  if (path === "/api/strategy") return Response.json({ availability: ready });
  if (path === "/api/projects") return Response.json({ project: { ...JSON.parse(String(init.body)), id: JSON.parse(String(init.body)).requestKey, owner_id: owner, current_revision: 1, created_at: "2026-10-07T00:00:00Z" } });
  if (init.method === "PATCH") { const body = JSON.parse(String(init.body)); return Response.json({ revision: { project_id: path.split("/")[3], owner_id: owner, revision: body.expectedRevision + 1, context: body.context, input_hash: "synthetic-context", created_at: "2026-10-07T00:00:00Z" } }); }
  if (path.endsWith("/strategy")) return Response.json({ job: { id: crypto.randomUUID(), owner_id: owner, project_id: path.split("/")[3], operation: "strategy.competitors", input_revision: JSON.parse(String(init.body)).expectedRevision, state: "queued", progress: 0, error_code: null, cancel_requested_at: null, created_at: "2026-10-07T00:00:00Z", finished_at: null, reserved_cost_microusd: 10000, actual_cost_microusd: 0, results: [] } });
  throw new Error(`Unexpected fixture request ${path}`);
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); HTMLElement.prototype.scrollTo = vi.fn();
  window.sessionStorage.clear(); window.localStorage.clear(); clearLocalDrafts(); owner = crypto.randomUUID(); mock.session = { status: "ready", userId: owner, generation: 1 }; mock.memory = createHomeInputSession(); mock.memory.bind(mock.session);
  mock.current.mockReset().mockImplementation((account: VerifiedAccount) => mock.session.status === "ready" && account.userId === mock.session.userId && account.generation === mock.session.generation);
  mock.push.mockReset(); mock.expire.mockReset(); mock.refresh.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  fetcher = vi.fn(defaultFetch); vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("Home account persistence and sign-in continuation", () => {
  it("keeps the current guest prompt and scope through sign-in, then saves without AI", async () => {
    mock.session = { status: "signed_out", generation: 2 }; mock.memory!.bind(null); await render();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent === "Name")!.click());
    const original = host.querySelector("textarea")!.value; await click("Send prompt");
    expect(mock.push).toHaveBeenCalledExactlyOnceWith("/sign-in"); expect(mutations()).toHaveLength(0);
    mock.session = { status: "ready", userId: owner, generation: 3 }; mock.memory!.bind(mock.session); await remountHome();
    expect(host.querySelector("textarea")!.value).toBe(original);
    expect(host.querySelector('button[aria-haspopup="menu"]')?.getAttribute("aria-label")).toBe("Project scope: Name");
    await click("Save project");
    expect(mutations()).toHaveLength(1); expect(creations()).toHaveLength(1);
    const stored = JSON.parse(window.localStorage.getItem(DRAFT_STORAGE_KEY)!);
    expect(stored.drafts).toHaveLength(1); expect(stored.drafts[0]).toMatchObject({ description: original, scope: "naming_only", ownerId: owner, accountProjectId: stored.drafts[0].id });
    expect(mock.push).toHaveBeenLastCalledWith(`/brands/account/${stored.drafts[0].id}/naming`);
  });

  it("retires current prompt recovery after confirmed Send and starts a distinct next project", async () => {
    mock.session = { status: "signed_out", generation: 2 }; mock.memory!.bind(null); await render();
    const original = host.querySelector("textarea")!.value; await signInLink();
    mock.session = { status: "ready", userId: owner, generation: 3 }; mock.memory!.bind(mock.session); await remountHome();
    expect(host.querySelector("textarea")!.value).toBe(original); await click("Send prompt");
    expect(creations()).toHaveLength(1); expect(mutations()).toHaveLength(2); expect(window.sessionStorage.getItem("fluid.prompt-sign-in.v1")).toBeNull();
    await remountHome(); expect(host.querySelector("textarea")!.value).toBe("");
    await click("A neighborhood coffee shop"); await click("Send prompt");
    expect(creations()).toHaveLength(2); expect(mutations()).toHaveLength(4);
    expect(JSON.parse(String(creations()[1]![1].body)).requestKey).not.toBe(JSON.parse(String(creations()[0]![1].body)).requestKey);
  });

  it("replays a lost creation acknowledgement exactly after remount without another AI admission", async () => {
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/projects" ? Promise.reject(new TypeError("Lost acknowledgement")) : defaultFetch(path, init));
    await render(); const original = host.querySelector("textarea")!.value; await click("Send prompt");
    expect(creations()).toHaveLength(1); expect(host.querySelector("textarea")!.readOnly).toBe(true);
    await remountHome(); expect(host.querySelector("textarea")!.value).toBe(original); expect(host.querySelector("textarea")!.readOnly).toBe(true);
    await click("A neighborhood coffee shop"); expect(host.querySelector("textarea")!.value).toBe(original);
    fetcher.mockImplementation(defaultFetch); await click("Check and retry save");
    expect(creations()).toHaveLength(2); expect(creations()[1]![1].body).toBe(creations()[0]![1].body);
    expect(mutations()).toHaveLength(2); expect(mock.push).toHaveBeenCalledOnce();
  });

  it("keeps legacy unowned history out of Home while preserving its original data", async () => {
    mock.session = { status: "signed_out", generation: 2 }; mock.memory!.bind(null); await render(); await signInLink();
    const original = window.localStorage.getItem(DRAFT_STORAGE_KEY)!; const draft = JSON.parse(original).drafts[0];
    window.sessionStorage.setItem("fluid.prompt-sign-in.v1", draft.id);
    await remountHome(); expect(host.querySelector("textarea")!.value).toBe(""); expect(host.textContent).not.toContain(draft.description);
    mock.session = { status: "ready", userId: owner, generation: 3 }; mock.memory!.bind(mock.session); await remountHome();
    expect(host.querySelector("textarea")!.value).toBe(""); expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(original); expect(mutations()).toHaveLength(0);
  });

  it("hides an owned prompt at sign-out and recovers its exact create only in the same account", async () => {
    const held = deferred<Response>();
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/projects" ? held.promise : defaultFetch(path, init));
    await render(); const original = host.querySelector("textarea")!.value; await click("Send prompt");
    const body = creations()[0]![1].body;
    mock.session = { status: "signed_out", generation: 2 }; mock.memory!.bind(null); await render();
    await act(async () => held.resolve(await defaultFetch("/api/projects", { method: "POST", body })));
    expect(host.querySelector("textarea")!.value).toBe(""); expect(host.textContent).not.toContain(original); expect(mock.push).not.toHaveBeenCalled();
    mock.session = { status: "ready", userId: owner, generation: 3 }; mock.memory!.bind(mock.session); fetcher.mockImplementation(defaultFetch); await remountHome();
    expect(host.querySelector("textarea")!.value).toBe(original); await click("Check and retry save");
    expect(creations()).toHaveLength(2); expect(creations()[1]![1].body).toBe(body); expect(mutations()).toHaveLength(2);
  });

  it("saves a Brand on Send even when AI is unavailable and returns Home without resurrecting its recovery buffer", async () => {
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/strategy" ? Promise.resolve(Response.json({ availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } })) : defaultFetch(path, init));
    await render(); const original = host.querySelector("textarea")!.value; await click("Send prompt");
    expect(mutations()).toHaveLength(1); expect(JSON.parse(String(creations()[0]![1].body)).context.description).toBe(original);
    expect(JSON.parse(String(creations()[0]![1].body)).context.intake.guidedInterview).toBeUndefined();
    expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${JSON.parse(String(creations()[0]![1].body)).requestKey}`);
    expect(window.sessionStorage.getItem(`fluid.prompt-buffer.v1:${owner}`)).toBeNull();
    await remountHome(); expect(host.querySelector("textarea")!.value).toBe(""); expect(host.textContent).not.toContain(original);
  });

  it("saves before checking research and binds the initial guided request to the acknowledged new revision", async () => {
    await render(); await click("Send prompt");
    const paths = fetcher.mock.calls.map(([path, init]) => `${init.method ?? "GET"} ${path}`), projectKey = JSON.parse(String(creations()[0]![1].body)).requestKey;
    expect(paths.indexOf("POST /api/projects")).toBeLessThan(paths.lastIndexOf("GET /api/strategy"));
    const patch = fetcher.mock.calls.find(([path, init]) => path === `/api/projects/${projectKey}` && init.method === "PATCH")!;
    expect(JSON.parse(String(patch[1].body)).context.intake.guidedInterview.turns[0].inputRevision).toBe(2);
    expect(JSON.parse(String(mutations().at(-1)![1].body))).toMatchObject({ operation: "strategy.competitors", expectedRevision: 2 });
  });

  it("sends a Name straight to the same saved project Naming route without researching competitors", async () => {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent === "Name")!.click());
    const reads = fetcher.mock.calls.filter(([path]) => path === "/api/strategy").length;
    await click("Send prompt");
    const body = JSON.parse(String(creations()[0]![1].body));
    expect(body.scope).toBe("naming_only"); expect(body.context.intake.guidedInterview).toBeUndefined();
    expect(mutations()).toHaveLength(1); expect(fetcher.mock.calls.filter(([path]) => path === "/api/strategy")).toHaveLength(reads);
    expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${body.requestKey}/naming`);
  });

  it("creates signed-in work with 50 legacy drafts without modifying their durable bytes", async () => {
    for (let i = 0; i < 50; i++) createLocalDraft({ title: `Legacy ${i}`, scope: "complete_brand", description: `Unattributed retained work ${i}`, suppliedName: "", namingNotes: "", identityNotes: "", example: false });
    const original = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    await render(); await click("Save project");
    expect(creations()).toHaveLength(1); expect(mock.push).toHaveBeenCalledOnce(); expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(original);
    await remountHome(); expect(host.querySelector("textarea")!.value).toBe(""); expect(window.localStorage.getItem(DRAFT_STORAGE_KEY)).toBe(original);
  });

  it("keeps a pending new-account brief private after switching to another verified owner", async () => {
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/projects" ? Promise.reject(new TypeError("Lost acknowledgement")) : defaultFetch(path, init));
    await render(); const original = host.querySelector("textarea")!.value; await click("Save project");
    const originalBuffer = window.sessionStorage.getItem(`fluid.prompt-buffer.v1:${owner}`);
    const firstOwner = owner; owner = crypto.randomUUID(); mock.session = { status: "ready", userId: owner, generation: 2 }; mock.memory!.bind(mock.session);
    await remountHome(); expect(host.querySelector("textarea")!.value).toBe(""); expect(host.textContent).not.toContain(original);
    expect(window.sessionStorage.getItem(`fluid.prompt-buffer.v1:${firstOwner}`)).toBe(originalBuffer); expect(creations()).toHaveLength(1);
  });

  it("requires an explicit continuation marker and lets a newer retained prompt take priority over an older account buffer", async () => {
    fetcher.mockImplementation((path: string, init: RequestInit) => path === "/api/projects" ? Promise.reject(new TypeError("Lost acknowledgement")) : defaultFetch(path, init));
    await render(); await click("Save project"); expect(window.sessionStorage.getItem(`fluid.prompt-buffer.v1:${owner}`)).not.toBeNull();
    window.sessionStorage.removeItem("fluid.prompt-sign-in.v1");
    await remountHome(); expect(host.querySelector("textarea")!.value).toBe("");
    const id = createLocalDraft({ title: "Explicitly retained prompt", scope: "naming_only", description: "My newer prompt for sign-in", suppliedName: "", namingNotes: "", identityNotes: "", example: false })!;
    rememberPromptForSignIn(id);
    await remountHome(); expect(host.querySelector("textarea")!.value).toBe("My newer prompt for sign-in");
    expect(host.querySelector('button[aria-haspopup="menu"]')?.getAttribute("aria-label")).toBe("Project scope: Name");
    expect(creations()).toHaveLength(1);
  });
});
