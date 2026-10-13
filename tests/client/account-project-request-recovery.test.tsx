// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema, type AccountProject } from "@/domain/project-api";
import { accountDraftChanged, createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { AccountProjectEditor } from "@/components/workspace/account-project-editor";
import type { AccountStrategyEditor } from "@/components/workspace/account-strategy-editor";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({ session: null as VerifiedAccount | null, memory: null as ReturnType<typeof createAccountDraftMemory> | null, current: vi.fn(), expire: vi.fn(), refresh: vi.fn(), editor: null as ComponentProps<typeof AccountStrategyEditor> | null }));
vi.mock("@/components/workspace/account-session", () => ({ AccountStatus: () => null, useAccountSession: () => ({ session: mock.session, drafts: mock.memory, isCurrent: mock.current, expire: mock.expire, refresh: mock.refresh }) }));
vi.mock("@/components/workspace/account-strategy-editor", () => ({ AccountStrategyEditor: (props: ComponentProps<typeof AccountStrategyEditor>) => { mock.editor = props; return createElement("div", null, props.storage.actions); } }));
vi.mock("@/components/workspace/account-project-continuity", () => ({ AccountProjectContinuity: () => null }));
vi.mock("@/components/ideas/idea-source-banner", () => ({ IdeaSourceBanner: () => null }));
const projectId = "bbbbbbbb-1111-4111-8111-111111111111", when = "2026-10-08T00:00:00Z";
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let root: Root | null, host: HTMLDivElement, project: AccountProject, fetcher: ReturnType<typeof vi.fn>;
async function render() { await act(async () => root!.render(createElement(AccountProjectEditor, { projectId }))); }
async function expireRequest() { await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); }
async function click(label: string) { await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click()); }
const mutations = () => fetcher.mock.calls.filter(([, init]) => init.method !== "GET");
beforeEach(() => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mock.session = { status: "ready", userId: crypto.randomUUID(), generation: 1 }; mock.memory = createAccountDraftMemory(); mock.editor = null;
  mock.current.mockReset().mockImplementation((value: VerifiedAccount) => value.userId === mock.session!.userId && value.generation === mock.session!.generation);
  mock.expire.mockReset(); mock.refresh.mockReset();
  project = accountProjectSchema.parse({ id: projectId, owner_id: mock.session.userId, title: "Project recovery fixture", scope: "complete_brand", current_revision: 1, created_at: when, context: { description: "A neighborhood lunch kitchen" } });
  fetcher = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json({ project });
    throw new Error("Unexpected fixture mutation");
  });
  vi.stubGlobal("fetch", fetcher); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("saved-project HTTP recovery", () => {
  it("offers recovery when the initial project read stalls and ignores the late reply", async () => {
    const stalled = deferred<Response>(); fetcher.mockImplementationOnce(() => stalled.promise);
    await render(); expect(host.textContent).toContain("Loading your account project");
    await expireRequest(); expect(host.textContent).toContain("Check account and retry");
    await act(async () => stalled.resolve(Response.json({ project })));
    expect(mock.memory!.get(projectId)).toBeNull(); expect(mutations()).toHaveLength(0);
    mock.session = { ...mock.session!, generation: 2 }; await render();
    expect(mock.editor!.workspace.saved.id).toBe(projectId); expect(mock.expire).not.toHaveBeenCalled();
  });

  it("retains edits after a committed PATCH times out, fences a late reply, and resolves its revision conflict explicitly", async () => {
    await render();
    await act(async () => mock.editor!.storage.onUpdate({ description: "A seasonal lunch kitchen with local ingredients" }));
    const retainedDraft = mock.editor!.workspace.draft, stalled = deferred<Response>();
    let savedRevision: unknown, attempts = 0;
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "GET") return Response.json({ project });
      const body = JSON.parse(String(init.body));
      if (++attempts > 1) return new Response(null, { status: 409 });
      project = { ...project, current_revision: 2, title: body.title, context: body.context };
      savedRevision = { project_id: projectId, owner_id: project.owner_id, revision: 2, context: body.context, input_hash: "a".repeat(64), created_at: when };
      return stalled.promise;
    });
    await act(async () => { void mock.editor!.saveDraft(retainedDraft); });
    expect(mock.editor!.busy).toBe(true); await expireRequest();
    expect(mock.editor!.busy).toBe(false); expect(mock.editor!.workspace.saved.current_revision).toBe(1);
    expect(mock.editor!.workspace.draft).toEqual(retainedDraft); expect(accountDraftChanged(mock.editor!.workspace)).toBe(true);
    expect(mutations()).toHaveLength(1); expect(host.textContent).toContain("Save edits as browser copy");
    await act(async () => stalled.resolve(Response.json({ revision: savedRevision })));
    expect(mock.editor!.workspace.saved.current_revision).toBe(1); expect(mock.editor!.workspace.draft).toEqual(retainedDraft);
    await act(async () => { await mock.editor!.saveDraft(retainedDraft); });
    expect(mutations().map(([, init]) => JSON.parse(String(init.body)).expectedRevision)).toEqual([1, 1]);
    expect(mock.editor!.workspace.conflict).toBe(true); expect(mock.editor!.workspace.draft).toEqual(retainedDraft);
    await click("Load latest version"); await click("Replace with latest version");
    expect(mock.editor!.workspace.saved.current_revision).toBe(2); expect(mock.editor!.workspace.conflict).toBe(false);
    expect(mock.editor!.workspace.draft.description).toBe(retainedDraft.description); expect(mutations()).toHaveLength(2);
  });
});
