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
let drafts: ReturnType<typeof createAccountDraftMemory>, pathname: string;
const isCurrent = (value: VerifiedAccount) => value === account, expire = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: account, drafts, isCurrent, expire }), AccountStatus: () => null }));
const project = accountProjectSchema.parse({ id: projectId, owner_id: owner, title: "Owned fixture", scope: "complete_brand", current_revision: 4, created_at: "2026-10-13T00:00:00Z", context: { description: "A lighting studio", selectedName: "Luma" } });
let root: Root | null, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); drafts = createAccountDraftMemory(); pathname = `/brands/account/${projectId}`; expire.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const response = (saved = project) => new Response(JSON.stringify({ project: saved }));
async function render(children: ReactNode = createElement("p", null, "Workspace")) { await act(async () => root!.render(<AccountProjectWorkspaceShell projectId={projectId}>{children}</AccountProjectWorkspaceShell>)); }
function Evidence({ evidenceOwner = owner, needsReview = false, revision = 4 }: { evidenceOwner?: string; needsReview?: boolean; revision?: number }) {
  useProjectLogoEvidence({ ownerId: evidenceOwner, projectId, projectRevision: revision, approved: true, needsReview }); return null;
}

describe("project progress is scoped to saved inputs", () => {
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
