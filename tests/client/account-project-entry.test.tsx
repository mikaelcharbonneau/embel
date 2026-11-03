// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProjectEntry } from "@/components/workspace/account-project-entry";
import { accountProjectSchema } from "@/domain/project-api";
import { createAccountDraftMemory, reconcileAccountWorkspace } from "@/components/workspace/account-draft-memory";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../fixtures/logo-creation";

const owner = id(1), projectId = id(2), base = `/api/projects/${projectId}`;
const account: VerifiedAccount = { status: "ready", userId: owner, generation: 1 };
const replace = vi.fn(), router = { replace }, expire = vi.fn();
let session: VerifiedAccount | { status: "checking"; generation: number }, drafts: ReturnType<typeof createAccountDraftMemory>;
const isCurrent = (value: VerifiedAccount) => session.status === "ready" && session.userId === value.userId && session.generation === value.generation;
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session, drafts, isCurrent, expire }), AccountStatus: () => <p>Checking account</p> }));
vi.mock("@/components/workspace/account-project-editor", () => ({ AccountProjectEditor: ({ navigation }: { navigation?: React.ReactNode }) => <>{navigation}<input aria-label="Strategy draft" defaultValue="Retained Strategy text" /></> }));
let root: Root, host: HTMLDivElement;
const project = () => accountProjectSchema.parse({ id: projectId, owner_id: owner, scope: "complete_brand", title: "Northline fixture", current_revision: 2, created_at: "2026-10-30T00:00:00Z", context: {} });
const logo = (started = true) => {
  const value = structuredClone(syntheticLogoWorkspace()); value.ownerId = owner; value.projectId = projectId; value.heads.projectRevision = 2;
  if (started) { value.stages.concepts = { stage: "concepts", id: id(99), revision: 1 }; value.heads.stageRevisions.concepts = 1; }
  return value;
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
const gate = () => { let resolve!: (response: Response) => void; const promise = new Promise<Response>(done => { resolve = done; }); return { promise, resolve }; };
async function render(view?: string) { await act(async () => root.render(<AccountProjectEntry projectId={projectId} view={view} />)); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); session = account; drafts = createAccountDraftMemory(); replace.mockReset(); expire.mockReset();
  window.history.replaceState(null, "", "/"); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture(saved = project(), workspace = logo()) {
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    expect(init.method).toBe("GET");
    if (path === base || path === `${base}/logo`) expect(init.headers).toMatchObject({ "X-Embel-Account": owner });
    if (path === base) return json({ project: saved });
    if (path === `${base}/logo`) return json(workspace);
    if (path === `${base}/logo/stages/concepts/revisions/${id(99)}`) return json({
      version: 2, id: id(99), ownerId: owner, projectId, revision: 1, parentRevisionId: null, inputRevisions: [],
      inputHash: "a".repeat(64), createdAt: "2026-10-30T00:00:00Z", stage: "concepts", payload: { batchIds: [], selected: null },
    });
    if (path === `${base}/logo/batches?limit=1`) return json({ ownerId: owner, projectId, items: [], nextCursor: null });
    throw new Error(`Unexpected entry read: ${path}`);
  });
  vi.stubGlobal("fetch", fetcher); return fetcher;
}

describe("generic account project entry", () => {
  it("resumes saved Logo stages for an expanded complete brand without reading image bytes or changing anything", async () => {
    const fetcher = fixture(); await render();
    expect(replace).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}/logo`);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      base, `${base}/logo`, `${base}/logo/stages/concepts/revisions/${id(99)}`, `${base}/logo/batches?limit=1`,
    ]);
    expect(drafts.get(projectId)!.saved.scope).toBe("complete_brand");
    expect(host.querySelector("input")).toBeNull();
  });
  it.each([["visual_identity_only", "logo"], ["naming_only", "naming"]] as const)("routes %s without requiring or creating Logo state", async (scope, path) => {
    const fetcher = fixture({ ...project(), scope }, logo(false)); await render();
    expect(replace).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}/${path}`);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(scope === "naming_only" ? [base] : [base, `${base}/logo`]);
  });
  it("resumes the missing Strategy review when the project has no Logo progress", async () => {
    fixture(project(), logo(false)); await render();
    expect(replace).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}?view=strategy#strategy-brief`);
  });
  it("keeps explicit Strategy access and a return link even with saved Logo work", async () => {
    const fetcher = fixture(); await render("strategy");
    expect(host.querySelector("input")).not.toBeNull(); expect(fetcher).not.toHaveBeenCalled();
    expect(host.querySelector(`a[href="/brands/account/${projectId}"]`)?.textContent).toBe("Return to saved work");
  });
  it("preserves old Strategy review bookmarks", async () => {
    window.history.replaceState(null, "", "#strategy-brief"); const fetcher = fixture(); await render();
    expect(host.querySelector("input")).not.toBeNull(); expect(fetcher).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
  });
  it.each(["dirty", "conflict", "prompt", "selection", "competitor", "pending"] as const)("keeps %s Strategy work mounted, including after its save is acknowledged", async kind => {
    const saved = project(), retained = reconcileAccountWorkspace(null, saved, 1);
    if (kind === "dirty") retained.draft.description = "Keep my edits";
    if (kind === "conflict") retained.conflict = true;
    if (kind === "prompt") retained.guidedInput = { prompt: "Unsent question", selection: null };
    if (kind === "selection") retained.guidedInput = { prompt: "", selection: { turnId: id(10), ids: [id(11)] } };
    if (kind === "competitor") retained.guidedInput = { prompt: "", selection: null, competitorDraft: { name: "", website: "https://example.test" } };
    if (kind === "pending") retained.pendingGuidedContext = saved.context;
    drafts.set(retained); const fetcher = fixture(); await render(); const editor = host.querySelector("input")!; editor.focus();
    await act(async () => { drafts.set(reconcileAccountWorkspace(null, saved, 1)); });
    expect(host.querySelector("input")).toBe(editor); expect(document.activeElement).toBe(editor);
    expect(fetcher).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
  });
  it("keeps a Strategy edit made while the Logo read is pending", async () => {
    const pending = gate(); const fetcher = fixture(); fetcher.mockImplementation(async path => path === base ? json({ project: project() }) : pending.promise);
    await render();
    await act(async () => { const saved = drafts.get(projectId)!; drafts.set({ ...saved, guidedInput: { prompt: "Keep this question", selection: null } }); });
    await act(async () => pending.resolve(json(logo())));
    expect(host.querySelector("input")).not.toBeNull(); expect(replace).not.toHaveBeenCalled();
  });
  it("offers a bounded retry after a failed read without treating failure as an empty workspace", async () => {
    let unavailable = true;
    const fetcher = fixture(), read = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, init) => path === `${base}/logo` && unavailable ? Promise.resolve(json({}, 503)) : read(path, init));
    await render(); expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.querySelector("input")).toBeNull(); expect(replace).not.toHaveBeenCalled();
    unavailable = false; await act(async () => host.querySelector("button")!.click());
    expect(replace).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}/logo`);
  });
  it("times out a stuck read and ignores its late response", async () => {
    vi.useFakeTimers(); const pending = gate(); const fetcher = fixture(); fetcher.mockImplementation(async path => path === base ? json({ project: project() }) : pending.promise);
    await render(); await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => pending.resolve(json(logo()))); expect(replace).not.toHaveBeenCalled();
  });
  it.each(["project", "logo"] as const)("rejects another owner's %s metadata", async mismatch => {
    const saved = project(), workspace = logo(); if (mismatch === "project") saved.owner_id = id(999); else workspace.ownerId = id(999);
    fixture(saved, workspace); await render(); expect(expire).toHaveBeenCalledExactlyOnceWith(account); expect(replace).not.toHaveBeenCalled();
  });
  it("rejects a Logo snapshot from another project revision", async () => {
    const workspace = logo(); workspace.heads.projectRevision = 1; fixture(project(), workspace); await render();
    expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(replace).not.toHaveBeenCalled();
  });
  it("fences a delayed read after account verification changes", async () => {
    const pending = gate(); const fetcher = fixture(); fetcher.mockImplementation(async path => path === base ? json({ project: project() }) : pending.promise);
    await render(); session = { status: "checking", generation: 2 }; await render();
    await act(async () => pending.resolve(json(logo())));
    expect(replace).not.toHaveBeenCalled(); expect(host.textContent).toContain("Checking account");
  });
});
