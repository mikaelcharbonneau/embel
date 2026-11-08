// @vitest-environment jsdom
import { installDialogMethods } from "../helpers/dialog-methods";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema, type AccountProject } from "@/domain/project-api";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { AccountProjectEditor } from "@/components/workspace/account-project-editor";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({ account: null as VerifiedAccount | null, memory: null as ReturnType<typeof createAccountDraftMemory> | null, current: vi.fn(), expire: vi.fn(), refresh: vi.fn(), enqueue: vi.fn() }));
const overview = { availability: { status: "unavailable", reason: "worker_unavailable", operations: [] }, jobs: [] };
vi.mock("@/components/workspace/account-session", () => ({ AccountStatus: () => null, useAccountSession: () => ({ session: mock.account, drafts: mock.memory, isCurrent: mock.current, expire: mock.expire, refresh: mock.refresh }) }));
vi.mock("@/components/workspace/use-strategy-jobs", () => ({ useStrategyJobs: () => ({ overview, pending: false, readError: null, actionError: null, refresh: mock.refresh, enqueue: mock.enqueue }) }));
vi.mock("@/components/workspace/account-project-continuity", () => ({ AccountProjectContinuity: () => null }));
vi.mock("@/components/ideas/idea-source-banner", () => ({ IdeaSourceBanner: () => null }));

const projectId = "bbbbbbbb-1111-4111-8111-111111111111", when = "2026-10-17T00:00:00Z";
let root: Root, host: HTMLDivElement, project: AccountProject, fetcher: ReturnType<typeof vi.fn>;
async function render() { await act(async () => root.render(createElement(AccountProjectEditor, { projectId }))); await act(async () => host.querySelector<HTMLButtonElement>('.guided-brief-editor > button')!.click()); }
async function fill(node: HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); });
}
let restoreDialogs: () => void;
beforeEach(() => {
  restoreDialogs = installDialogMethods();
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); HTMLElement.prototype.scrollTo = vi.fn();
  mock.account = { status: "ready", userId: crypto.randomUUID(), generation: 1 }; mock.memory = createAccountDraftMemory(); mock.refresh.mockReset(); mock.enqueue.mockReset();
  mock.current.mockImplementation((account: VerifiedAccount) => account.userId === mock.account?.userId && account.generation === mock.account.generation);
  project = accountProjectSchema.parse({ id: projectId, owner_id: mock.account.userId, title: "Saved brand", scope: "complete_brand", current_revision: 1, created_at: when, context: { description: "A retained brand brief" } });
  fetcher = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "GET") return Response.json({ project });
    const body = JSON.parse(String(init.body));
    project = { ...project, title: body.title ?? project.title, current_revision: body.expectedRevision + 1, context: body.context };
    return Response.json({ revision: { project_id: projectId, owner_id: project.owner_id, revision: project.current_revision, context: project.context, input_hash: "synthetic-guided-edit", created_at: when } });
  });
  vi.stubGlobal("fetch", fetcher); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); restoreDialogs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("saved brief editing during unavailable Strategy", () => {
  it("keeps a real saved Brand editable and acknowledges its autosave without implying an AI answer", async () => {
    await render();
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Start competitor research")).toBeUndefined();
    expect(host.textContent).toContain("Edit brief");
    // The only Embel message is the invitation to start research; it can't start while Strategy is unavailable.
    const messages = host.querySelectorAll(".guided-assistant-message");
    expect(messages).toHaveLength(1); expect(messages[0]!.getAttribute("aria-label")).toBe("Start research");
    expect(messages[0]!.querySelector<HTMLButtonElement>("button.button.primary")!.disabled).toBe(true);
    const details = host.querySelector<HTMLDetailsElement>(".guided-brief-editor")!;
    expect(details.querySelector('button[aria-haspopup="dialog"]')).not.toBeNull();
    expect(details.querySelector("summary")).toBeNull();
    const brief = details.querySelector<HTMLTextAreaElement>("textarea")!; expect(brief.disabled).toBe(false);
    await fill(brief, "A more specific saved Brand brief"); expect(mock.memory!.hasUnsaved()).toBe(true); expect(details.textContent).toContain("Saving…");
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(mock.memory!.hasUnsaved()).toBe(false); expect(details.textContent).toContain("Saved"); expect(project.context.description).toBe("A more specific saved Brand brief");
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1); expect(mock.enqueue).not.toHaveBeenCalled();
    const check = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Check status")!;
    await act(async () => check.click()); expect(mock.refresh).toHaveBeenCalledOnce();
  });

  it("shows an actionable save error and retains the edited brief until the same save is retried", async () => {
    await render(); const brief = host.querySelector<HTMLTextAreaElement>(".guided-brief-editor textarea")!;
    const originalFetch = fetcher.getMockImplementation()! as (path: string, init: RequestInit) => Promise<Response>;
    fetcher.mockImplementation((path: string, init: RequestInit) => init.method === "PATCH" ? Promise.resolve(Response.json({}, { status: 503 })) : originalFetch(path, init));
    await fill(brief, "Keep this unsaved correction"); await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(brief.value).toBe("Keep this unsaved correction"); expect(mock.memory!.hasUnsaved()).toBe(true); expect(host.textContent).toContain("Changes not saved");
    const original = fetcher.mock.calls.find(([, init]) => init.method === "PATCH")![1].body;
    fetcher.mockImplementation(originalFetch);
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Retry save")!.click());
    expect(fetcher.mock.calls.filter(([, init]) => init.method === "PATCH").at(-1)![1].body).toBe(original); expect(mock.memory!.hasUnsaved()).toBe(false); expect(project.context.description).toBe("Keep this unsaved correction");
  });
});
