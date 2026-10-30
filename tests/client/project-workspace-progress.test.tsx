// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { AccountProjectWorkspaceShell, useProjectLogoEvidence } from "@/components/workspace/project-workspace";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const owner = "d0000000-0000-4000-8000-000000000001", projectId = "d0000000-0000-4000-8000-000000000002";
const account: VerifiedAccount = { status: "ready", userId: owner, generation: 1 };
let drafts: ReturnType<typeof createAccountDraftMemory>, pathname: string, session: VerifiedAccount | { status: "checking" | "error" | "unavailable" | "signed_out"; generation: number };
const isCurrent = (value: VerifiedAccount) => value === account && session === account, expire = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session, drafts, isCurrent, expire }), AccountStatus: () => <p>Account status fixture</p> }));
const project = accountProjectSchema.parse({ id: projectId, owner_id: owner, title: "Owned fixture", scope: "complete_brand", current_revision: 4, created_at: "2026-10-13T00:00:00Z", context: { description: "A lighting studio", selectedName: "Luma" } });
let root: Root | null, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); session = account; drafts = createAccountDraftMemory(); pathname = `/brands/account/${projectId}`; expire.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const response = (saved = project) => new Response(JSON.stringify({ project: saved }));
async function render(children: ReactNode = createElement("p", null, "Workspace")) { await act(async () => root!.render(<AccountProjectWorkspaceShell projectId={projectId}>{children}</AccountProjectWorkspaceShell>)); }
function expectNoProjectBars() {
  expect(host.querySelectorAll(".project-workspace-header, .project-stage-navigation, .logo-journey-navigation")).toHaveLength(0);
}
function Evidence({ evidenceOwner = owner, needsReview = false, revision = 4 }: { evidenceOwner?: string; needsReview?: boolean; revision?: number }) {
  useProjectLogoEvidence({ ownerId: evidenceOwner, projectId, projectRevision: revision, approved: true, needsReview }); return null;
}

describe("project workspace retains account and saved-state safety without project bars", () => {
  it.each(["checking", "error", "unavailable", "signed_out"] as const)("keeps public account recovery during %s while masking all private work", async status => {
    drafts.set({ ownerId: owner, generation: 1, saved: project, draft: accountProjectDraft(project), conflict: false });
    session = { status, generation: 2 }; pathname = `/brands/account/${projectId}/identity`;
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await render(<input aria-label="Private retained editor" defaultValue="Private local input" />);
    expectNoProjectBars();
    expect(host.querySelector(".project-access-state")?.textContent).toContain("Account status fixture");
    expect(host.querySelector('a[href="/brands"]')?.textContent).toBe("Back to Projects");
    expect(host.textContent).not.toContain("Owned fixture"); expect(host.querySelector("input")).toBeNull();
    expect(drafts.get(projectId)?.saved.title).toBe("Owned fixture"); expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps the content and focused editor through an initial project-read failure with an actionable notice", async () => {
    let reject!: (error: Error) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_resolve, no) => { reject = no; })));
    pathname = `/brands/account/${projectId}/identity`;
    await render(<input aria-label="Retained editor" defaultValue="Keep local input" />);
    const content = host.querySelector(".project-workspace-content"), input = host.querySelector("input")!;
    expect(host.querySelector('[role="alert"]')).toBeNull(); input.focus();
    await act(async () => reject(new Error("Synthetic read failure")));
    expect(host.querySelector(".project-workspace-content")).toBe(content); expect(host.querySelector("input")).toBe(input); expect(document.activeElement).toBe(input);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The saved project could not be verified. Your existing work is kept.");
    expect(host.querySelector('button')?.textContent).toBe("Check saved project"); expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
    expect(input.value).toBe("Keep local input"); expectNoProjectBars();
  });
  it("immediately masks the owned title and editor when account verification is lost", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    const editor = <div><p>{project.title}</p><input aria-label="Private editor" defaultValue="Private retained input" /></div>;
    await render(editor); expect(host.textContent).toContain("Owned fixture"); expect(host.querySelector("input")).not.toBeNull();
    session = { status: "checking", generation: 2 }; await render(editor);
    expect(host.textContent).not.toContain("Owned fixture"); expect(host.querySelector("input")).toBeNull(); expectNoProjectBars();
    expect(host.querySelector(".project-access-state")).not.toBeNull();
    expect(drafts.get(projectId)?.saved.title).toBe("Owned fixture");
  });
  it("keeps the verification warning and retained project after a failed recheck without clearing or marking edits dirty", async () => {
    drafts.set({ ownerId: owner, generation: 1, saved: project, draft: accountProjectDraft(project), conflict: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Synthetic failed recheck"); }));
    await render(<input aria-label="Retained editor" defaultValue="Kept" />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The saved project could not be verified. Your existing work is kept.");
    expectNoProjectBars(); expect(drafts.hasUnsaved()).toBe(false);
    expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("Kept");
    expect(drafts.get(projectId)?.saved).toBe(project);
  });
  it.each(["checking", "dirty", "conflict", "naming_only"] as const)("keeps %s workspace state and focused editors without recreating removed bars", async state => {
    const saved = { ...project, scope: state === "naming_only" ? "naming_only" as const : project.scope };
    if (state !== "checking") drafts.set({ ownerId: owner, generation: 1, saved, draft: { ...accountProjectDraft(saved), ...(state === "dirty" ? { namingNotes: "Retain this edit" } : {}) }, conflict: state === "conflict" });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    pathname = `/brands/account/${projectId}/identity`;
    const editor = <input aria-label="Retained editor" defaultValue="Retained input" />;
    await render(editor);
    expectNoProjectBars();
    const content = host.querySelector(".project-workspace-content");
    const input = host.querySelector("input")!; input.focus();
    await render(editor);
    expect(host.querySelector("input")).toBe(input); expect(document.activeElement).toBe(input);
    expect(host.querySelector(".project-workspace-content")).toBe(content); expectNoProjectBars();
    expect(drafts.get(projectId)?.draft.namingNotes ?? "").toBe(state === "dirty" ? "Retain this edit" : "");
    if (state === "checking") expect(drafts.get(projectId)).toBeNull();
    else expect(drafts.get(projectId)?.saved).toBe(saved);
    if (state === "conflict") {
      expect(host.textContent).toContain("A newer project version is saved. Your edits are kept in this tab.");
      expect(host.querySelector(`a[href="/brands/account/${projectId}?view=strategy"]`)?.textContent).toContain("Resolve in Strategy");
    }
  });
  it("keeps one content frame and focused editor without bars through every actual project subpage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    const editor = <input aria-label="Retained editor" defaultValue="Unsaved local input" />;
    await render(editor);
    const content = host.querySelector(".project-workspace-content"), input = host.querySelector("input")!;
    for (const suffix of ["", "/naming", "/inspiration", "/logo", "/brand-board", "/logo/vector", "/logo/editor", "/logo/directions", "/identity", "/logo/deliverables"]) {
      input.focus(); pathname = `/brands/account/${projectId}${suffix}`; await render(editor);
      expect(host.querySelector(".project-workspace-content")).toBe(content); expectNoProjectBars();
      expect(host.querySelector("input")).toBe(input); expect(document.activeElement).toBe(input);
      expect(input.value).toBe("Unsaved local input");
    }
  });
  it("bounds a stuck verification even if fetch ignores abort and fences its late result", async () => {
    vi.useFakeTimers(); let resolve!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    await render(); await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(host.textContent).toContain("The saved project could not be verified");
    await act(async () => { resolve(response()); await Promise.resolve(); });
    expect(drafts.get(projectId)).toBeNull(); expect(host.textContent).not.toContain("Owned fixture");
  });
  it.each(["owner", "project"] as const)("rejects a read for another %s before it can enter draft memory", async mismatch => {
    const foreign = { ...project, [mismatch === "owner" ? "owner_id" : "id"]: "d0000000-0000-4000-8000-000000000009" };
    vi.stubGlobal("fetch", vi.fn(async () => response(foreign)));
    await render();
    expect(expire).toHaveBeenCalledExactlyOnceWith(account);
    expect(drafts.get(projectId)).toBeNull(); expectNoProjectBars();
  });
  it("marks a newly observed saved revision as a conflict without replacing dirty edits", async () => {
    const saved = { ...project, current_revision: 3 }, draft = { ...accountProjectDraft(saved), namingNotes: "Keep my edit" };
    drafts.set({ ownerId: owner, generation: 1, saved, draft, conflict: false });
    vi.stubGlobal("fetch", vi.fn(async () => response())); await render();
    expect(drafts.get(projectId)).toMatchObject({ saved: { current_revision: 3 }, conflict: true });
    expect(drafts.get(projectId)?.draft).toBe(draft);
    expect(host.textContent).toContain("A newer project version is saved");
  });
  it("retains the entered name and actionable Strategy review notice without a project progress bar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response())); await render();
    expectNoProjectBars();
    expect(drafts.get(projectId)?.saved.context.selectedName).toBe("Luma");
    expect(host.textContent).toContain("Luma"); expect(host.textContent).toContain("Strategy needs review");
    expect(host.querySelector(`a[href="/brands/account/${projectId}?view=strategy#strategy-brief"]`)?.textContent).toBe("Continue Strategy review");
  });
  it("shows actual stale Logo work without counting it as current approval", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response())); await render(createElement(Evidence, { needsReview: true }));
    expect(host.textContent).toContain("Logo needs review");
    expect(host.querySelector(`a[href="/brands/account/${projectId}/logo"]`)?.textContent).toContain("Review Logo");
  });
  it("rejects another owner's progress and requires recheck for an older project revision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response())); await render(createElement(Evidence, { evidenceOwner: "d0000000-0000-4000-8000-000000000009", needsReview: true }));
    expect(host.textContent).not.toContain("Logo needs review");
    await render(createElement(Evidence, { revision: 3 }));
    expect(host.textContent).toContain("Check Logo against the current project version"); expect(host.textContent).not.toContain("Logo approved");
  });
});
