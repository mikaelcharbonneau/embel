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
function Evidence({ evidenceOwner = owner, needsReview = false, revision = 4 }: { evidenceOwner?: string; needsReview?: boolean; revision?: number }) {
  useProjectLogoEvidence({ ownerId: evidenceOwner, projectId, projectRevision: revision, approved: true, needsReview }); return null;
}

describe("project progress is scoped to saved inputs", () => {
  it.each(["checking", "error", "unavailable", "signed_out"] as const)("keeps a public project frame during account %s while masking all private work", async status => {
    drafts.set({ ownerId: owner, generation: 1, saved: project, draft: accountProjectDraft(project), conflict: false });
    session = { status, generation: 2 }; pathname = `/brands/account/${projectId}/identity`;
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await render(<input aria-label="Private retained editor" defaultValue="Private local input" />);
    expect(host.querySelector(".project-workspace-header")).not.toBeNull();
    expect(host.querySelectorAll('nav[aria-label="Project stages"]')).toHaveLength(1);
    const pages = host.querySelector('nav[aria-label="Logo and identity pages"]')!;
    expect(pages.querySelectorAll("button:disabled")).toHaveLength(6); expect(pages.querySelectorAll("a")).toHaveLength(0);
    expect([...pages.querySelectorAll("button")].every(button => button.title === (status === "checking" ? "Checking your account…" : "Verify your account before continuing"))).toBe(true);
    expect(host.textContent).not.toContain("Owned fixture"); expect(host.textContent).not.toContain("Unsaved project edits"); expect(host.querySelector("input")).toBeNull();
    expect(drafts.get(projectId)?.saved.title).toBe("Owned fixture"); expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps the shell and editor through an initial project-read failure and uses a failed-check reason", async () => {
    let reject!: (error: Error) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_resolve, no) => { reject = no; })));
    pathname = `/brands/account/${projectId}/identity`;
    await render(<input aria-label="Retained editor" defaultValue="Keep local input" />);
    const header = host.querySelector(".project-workspace-header"), pages = host.querySelector('nav[aria-label="Logo and identity pages"]')!, input = host.querySelector("input")!;
    expect(host.textContent).toContain("Checking project…"); input.focus();
    await act(async () => reject(new Error("Synthetic read failure")));
    expect(host.querySelector(".project-workspace-header")).toBe(header); expect(host.querySelector("input")).toBe(input); expect(document.activeElement).toBe(input);
    expect(host.textContent).toContain("Project not verified"); expect(host.textContent).not.toContain("Checking project…"); expect(host.textContent).not.toContain("Unsaved project edits");
    expect([...pages.querySelectorAll("button")].every(button => button.title === "Check saved project before continuing")).toBe(true);
  });
  it("immediately masks the owned title and editor when account verification is lost", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    const editor = <input aria-label="Private editor" defaultValue="Private retained input" />;
    await render(editor); expect(host.textContent).toContain("Owned fixture"); expect(host.querySelector("input")).not.toBeNull();
    session = { status: "checking", generation: 2 }; await render(editor);
    expect(host.textContent).not.toContain("Owned fixture"); expect(host.querySelector("input")).toBeNull(); expect(host.querySelector(".project-workspace-header")).not.toBeNull();
    expect(drafts.get(projectId)?.saved.title).toBe("Owned fixture");
  });
  it("qualifies a retained saved project after a failed recheck without clearing its editor or marking it dirty", async () => {
    drafts.set({ ownerId: owner, generation: 1, saved: project, draft: accountProjectDraft(project), conflict: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Synthetic failed recheck"); }));
    await render(<input aria-label="Retained editor" defaultValue="Kept" />);
    expect(host.querySelector(".project-workspace-save")?.textContent).toBe("Last confirmed project · v4");
    expect(host.textContent).not.toContain("Unsaved project edits"); expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("Kept");
    expect(drafts.get(projectId)?.saved).toBe(project);
  });
  it.each(["checking", "dirty", "conflict", "naming_only"] as const)("applies the same %s lock to both visual navigation rows without remounting editors", async state => {
    const saved = { ...project, scope: state === "naming_only" ? "naming_only" as const : project.scope };
    if (state !== "checking") drafts.set({ ownerId: owner, generation: 1, saved, draft: { ...accountProjectDraft(saved), ...(state === "dirty" ? { namingNotes: "Retain this edit" } : {}) }, conflict: state === "conflict" });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    pathname = `/brands/account/${projectId}/identity`;
    const editor = <input aria-label="Retained editor" defaultValue="Retained input" />;
    await render(editor);
    const stages = host.querySelector('nav[aria-label="Project stages"]')!, subnav = host.querySelector('nav[aria-label="Logo and identity pages"]')!;
    const reason = state === "checking" ? "Checking saved project…" : state === "naming_only" ? "Expand the project scope first" : "Save or resolve your project edits first";
    const main = [...stages.querySelectorAll("button")].find(button => button.textContent === "Logo & identity")!;
    expect(main.disabled).toBe(true); expect(main.title).toBe(reason);
    expect(subnav.querySelectorAll("a")).toHaveLength(0);
    expect(subnav.querySelectorAll("button:disabled")).toHaveLength(6);
    expect([...subnav.querySelectorAll("button")].every(button => button.title === reason)).toBe(true);
    expect(subnav.querySelector('[aria-current="page"]')?.textContent).toBe("Moodboard & systems");
    const input = host.querySelector("input")!; input.focus();
    await render(editor);
    expect(host.querySelector("input")).toBe(input); expect(document.activeElement).toBe(input);
    expect(host.querySelector('nav[aria-label="Logo and identity pages"]')).toBe(subnav);
    expect(drafts.get(projectId)?.draft.namingNotes ?? "").toBe(state === "dirty" ? "Retain this edit" : "");
  });
  it("keeps one mounted project hierarchy and editor through every actual project subpage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    const editor = <input aria-label="Retained editor" defaultValue="Unsaved local input" />;
    await render(editor);
    const header = host.querySelector(".project-workspace-header"), stages = host.querySelector('nav[aria-label="Project stages"]'), input = host.querySelector("input")!;
    for (const [suffix, stage, page] of [
      ["", "Strategy", null], ["/naming", "Naming", null],
      ["/inspiration", "Logo & identity", "Inspiration"], ["/logo", "Logo & identity", "Logo concepts"],
      ["/brand-board", "Logo & identity", "Brand board"], ["/logo/vector", "Logo & identity", "Vector review"],
      ["/logo/editor", "Logo & identity", "Vector review"], ["/logo/directions", "Logo & identity", "Identity directions"],
      ["/identity", "Logo & identity", "Moodboard & systems"], ["/logo/deliverables", "Files", null],
    ]) {
      input.focus(); pathname = `/brands/account/${projectId}${suffix}`; await render(editor);
      expect(host.querySelector(".project-workspace-header")).toBe(header);
      expect(host.querySelector('nav[aria-label="Project stages"]')).toBe(stages);
      expect(stages?.querySelector('[aria-current="page"]')?.textContent).toBe(stage);
      expect(host.querySelectorAll('nav[aria-label="Project stages"]')).toHaveLength(1);
      const subnav = host.querySelector('nav[aria-label="Logo and identity pages"]');
      expect(subnav?.querySelector('[aria-current="page"]')?.textContent ?? null).toBe(page);
      expect(host.querySelector("input")).toBe(input); expect(document.activeElement).toBe(input);
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
  it("marks a newly observed saved revision as a conflict without replacing dirty edits", async () => {
    const saved = { ...project, current_revision: 3 }, draft = { ...accountProjectDraft(saved), namingNotes: "Keep my edit" };
    drafts.set({ ownerId: owner, generation: 1, saved, draft, conflict: false });
    vi.stubGlobal("fetch", vi.fn(async () => response())); await render();
    expect(drafts.get(projectId)).toMatchObject({ saved: { current_revision: 3 }, conflict: true });
    expect(drafts.get(projectId)?.draft).toBe(draft);
    expect(host.textContent).toContain("A newer project version is saved");
  });
  it("does not count an entered name as a verified approval or discard it when Strategy needs review", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response())); await render();
    expect(host.querySelector('nav[aria-label="Project stages"] [aria-current="page"]')?.textContent).toBe("Strategy");
    expect(host.textContent).not.toContain("verified approval");
    expect(drafts.get(projectId)?.saved.context.selectedName).toBe("Luma");
    expect(host.textContent).toContain("Luma"); expect(host.textContent).toContain("Strategy needs review");
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
