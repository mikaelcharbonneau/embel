// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema, type AccountProject } from "@/domain/project-api";
import { accountDraftChanged, createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { AccountProjectEditor } from "@/components/workspace/account-project-editor";
import type { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({ session: null as VerifiedAccount | null, memory: null as ReturnType<typeof createAccountDraftMemory> | null, current: vi.fn(), expire: vi.fn(), refresh: vi.fn(), editor: null as ComponentProps<typeof AccountGuidedInterview> | null }));
vi.mock("@/components/workspace/account-session", () => ({ AccountStatus: () => null, useAccountSession: () => ({ session: mock.session, drafts: mock.memory, isCurrent: mock.current, expire: mock.expire, refresh: mock.refresh }) }));
vi.mock("@/components/workspace/account-guided-interview", () => ({ AccountGuidedInterview: (props: ComponentProps<typeof AccountGuidedInterview>) => { mock.editor = props; return createElement("div", null, props.storage.actions); } }));
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
    await expireRequest(); expect(host.textContent).toContain("Retry loading project");
    await act(async () => stalled.resolve(Response.json({ project })));
    expect(mock.memory!.get(projectId)).toBeNull(); expect(mutations()).toHaveLength(0);
    await click("Retry loading project");
    expect(mock.editor!.workspace.saved.id).toBe(projectId); expect(mock.expire).not.toHaveBeenCalled();
    expect(mock.refresh).not.toHaveBeenCalled(); expect(mock.session!.generation).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(mutations()).toHaveLength(0);
  });

  it("keeps repeated project-read failures retryable without refreshing the account", async () => {
    fetcher.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    fetcher.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    await render(); expect(host.textContent).toContain("Retry loading project");
    await click("Retry loading project"); expect(host.textContent).toContain("Retry loading project");
    await click("Retry loading project"); expect(mock.editor!.workspace.saved.id).toBe(projectId);
    expect(mock.refresh).not.toHaveBeenCalled(); expect(mock.session!.generation).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(3); expect(mutations()).toHaveLength(0);
  });

  it("reconciles a committed PATCH after timeout without appending a duplicate revision", async () => {
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
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(mock.editor!.busy).toBe(true); await expireRequest();
    expect(mock.editor!.busy).toBe(false); expect(mock.editor!.workspace.saved.current_revision).toBe(1);
    expect(mock.editor!.workspace.draft).toEqual(retainedDraft); expect(accountDraftChanged(mock.editor!.workspace)).toBe(true);
    expect(mutations()).toHaveLength(1); expect(host.textContent).toContain("Keep a recovery copy");
    await act(async () => stalled.resolve(Response.json({ revision: savedRevision })));
    expect(mock.editor!.workspace.saved.current_revision).toBe(1); expect(mock.editor!.workspace.draft).toEqual(retainedDraft);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mutations()).toHaveLength(1);
    await click("Retry save");
    expect(mock.editor!.workspace.saved.current_revision).toBe(2); expect(mock.editor!.workspace.conflict).toBe(false);
    expect(mock.editor!.workspace.draft.description).toBe(retainedDraft.description); expect(mutations()).toHaveLength(1);
    expect(mock.memory!.hasUnsaved()).toBe(false);
  });

  it.each([true, false])("retains a revert while an ordinary save is unacknowledged (committed: %s)", async committed => {
    await render();
    const original = mock.editor!.workspace.draft.description;
    const stalled = deferred<Response>(); let attempts = 0;
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "GET") return Response.json({ project });
      const body = JSON.parse(String(init.body));
      if (++attempts === 1) {
        if (committed) project = { ...project, current_revision: 2, title: body.title, context: body.context };
        return stalled.promise;
      }
      project = { ...project, current_revision: body.expectedRevision + 1, title: body.title, context: body.context };
      return Response.json({ revision: { project_id: projectId, owner_id: project.owner_id, revision: project.current_revision, context: body.context, input_hash: "c".repeat(64), created_at: when } });
    });
    await act(async () => mock.editor!.storage.onUpdate({ description: "Submitted edit before reverting" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    await act(async () => mock.editor!.storage.onUpdate({ description: original }));
    await expireRequest();
    expect(mock.memory!.hasUnsaved()).toBe(true);
    expect(mock.editor!.storage.saveLabel).toBe("Changes not saved");
    expect([...host.querySelectorAll("button")].find(button => button.textContent === "Retry save")!.disabled).toBe(false);
    const frozen = String(mutations()[0]![1].body);
    await act(async () => root!.unmount()); root = createRoot(host); await render();
    expect(mock.editor!.workspace.draft.description).toBe(original);
    if (!committed) {
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(mutations()).toHaveLength(1); expect(mock.memory!.hasUnsaved()).toBe(true);
      await click("Retry save");
      expect(String(mutations()[1]![1].body)).toBe(frozen);
    }
    expect(mock.editor!.workspace.saved.current_revision).toBe(2);
    expect(mock.editor!.workspace.draft.description).toBe(original);
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    const finalBody = JSON.parse(String(mutations().at(-1)![1].body));
    expect(finalBody.expectedRevision).toBe(2); expect(finalBody.context.description).toBe(original);
    expect(mock.editor!.workspace.saved.current_revision).toBe(3); expect(mock.memory!.hasUnsaved()).toBe(false);
  });

  it("keeps a conflicting pending branch when the owned head is not its exact submitted content", async () => {
    await render();
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      if (init.method === "GET") return Response.json({ project });
      project = { ...project, current_revision: 2, context: { ...project.context, description: "Another tab saved a different edit" } };
      throw new TypeError("Unknown save outcome");
    });
    await act(async () => mock.editor!.storage.onUpdate({ description: "My retained edit" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    await click("Retry save");
    expect(mutations()).toHaveLength(1); expect(mock.editor!.workspace.conflict).toBe(true);
    expect(mock.editor!.workspace.draft.description).toBe("My retained edit"); expect(mock.memory!.hasUnsaved()).toBe(true);
  });
  it("serializes automatic saves and preserves newer typing through the first response", async () => {
    await render();
    const first = deferred<Response>(); let initialBody: { title: string; context: AccountProject["context"] };
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.expectedRevision === 1) { initialBody = body; return first.promise; }
      return Response.json({ revision: { project_id: projectId, owner_id: project.owner_id, revision: 3, context: body.context, input_hash: "b".repeat(64), created_at: when } });
    });
    await act(async () => mock.editor!.storage.onUpdate({ description: "First saved edit" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    await act(async () => mock.editor!.storage.onUpdate({ description: "Newer typing while saving" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mutations()).toHaveLength(1);
    await act(async () => first.resolve(Response.json({ revision: { project_id: projectId, owner_id: project.owner_id, revision: 2, context: initialBody!.context, input_hash: "a".repeat(64), created_at: when } })));
    expect(mock.editor!.workspace.draft.description).toBe("Newer typing while saving");
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(mutations().map(([, init]) => JSON.parse(String(init.body)).expectedRevision)).toEqual([1, 2]);
    expect(mock.editor!.workspace.saved.context.description).toBe("Newer typing while saving");
    expect(accountDraftChanged(mock.editor!.workspace)).toBe(false);
  });

  it("cancels a delayed autosave when the verified account changes", async () => {
    await render();
    await act(async () => mock.editor!.storage.onUpdate({ description: "Private pending edit" }));
    mock.session = { status: "ready", userId: crypto.randomUUID(), generation: 2 };
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mutations()).toHaveLength(0);
    expect(mock.memory!.get(projectId)!.draft.description).toBe("Private pending edit");
  });

  it.each([400, 413, 422, 429])("allows correcting an ordinary draft after a definitive %s rejection", async status => {
    await render();
    let rejected = false;
    fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
      expect(init.method).toBe("PATCH");
      if (!rejected) { rejected = true; return new Response(null, { status }); }
      const body = JSON.parse(String(init.body));
      return Response.json({ revision: { project_id: projectId, owner_id: project.owner_id, revision: 2, context: body.context, input_hash: "a".repeat(64), created_at: when } });
    });
    await act(async () => mock.editor!.storage.onUpdate({ description: "An ordinary rejected edit" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(mock.editor!.workspace.pendingDraftSave).toBeUndefined();
    expect(mock.memory!.hasUnsaved()).toBe(true);
    await act(async () => mock.editor!.storage.onUpdate({ description: "My corrected ordinary edit" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(mutations()).toHaveLength(2);
    expect(JSON.parse(String(mutations()[1]![1].body)).context.description).toBe("My corrected ordinary edit");
    expect(mock.editor!.workspace.saved.context.description).toBe("My corrected ordinary edit");
    expect(mock.memory!.hasUnsaved()).toBe(false);
  });

});
