// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsWorkspace } from "@/components/workspace/projects-workspace";
import { ProjectEditor } from "@/components/workspace/project-editor";
import { clearLocalDrafts, createLocalDraft, getLocalDraft, updateLocalDraft } from "@/components/workspace/local-drafts";
import type { VerifiedAccount } from "@/components/workspace/account-session";
const mock = vi.hoisted(() => ({ session: null as VerifiedAccount | { status: "signed_out"; generation: number } | null, current: vi.fn(), expire: vi.fn(), push: vi.fn(), projectId: "cccccccc-1111-4111-8111-111111111111" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("@/components/workspace/account-session", async () => { const drafts = (await import("@/components/workspace/account-draft-memory")).createAccountDraftMemory(); return { useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire, drafts }), AccountStatus: () => createElement("a", { href: "/sign-in" }, "Sign in") }; });
let root: Root, host: HTMLDivElement, owner: string, fetcher: ReturnType<typeof vi.fn>, legacyId: string;
const makeDraft = (title: string, ownerId?: string) => createLocalDraft({ title, description: `Private brief for ${title}`, scope: "complete_brand", suppliedName: "", namingNotes: "", identityNotes: "", example: false, ownerId })!;
async function render(legacy = false) { await act(async () => root.render(legacy ? createElement(ProjectEditor, { projectId: legacyId }) : createElement(ProjectsWorkspace))); }
async function click(text: string) { await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes(text))!.click()); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.localStorage.clear(); window.sessionStorage.clear(); clearLocalDrafts();
  owner = crypto.randomUUID(); mock.session = { status: "ready", userId: owner, generation: 1 }; mock.push.mockReset(); mock.expire.mockReset();
  mock.current.mockReset().mockImplementation((account: VerifiedAccount) => mock.session?.status === "ready" && mock.session.userId === account.userId && mock.session.generation === account.generation);
  legacyId = makeDraft("Old unsaved project"); makeDraft("Other account private project", crypto.randomUUID());
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path.startsWith("/api/projects/page")) return Response.json({ ownerId: owner, items: [{ id: mock.projectId, owner_id: owner, scope: "complete_brand", title: "Saved project", current_revision: 1, lifecycle_version: 0, deleted_at: null, deletion_requested_at: null, deletion_state: "active", created_at: "2026-10-07T00:00:00Z" }], nextCursor: null });
    if (path === "/api/session") return Response.json({ user: { id: owner } });
    if (path === "/api/projects" && init.method === "POST") return Response.json({ project: { ...JSON.parse(String(init.body)), id: crypto.randomUUID(), owner_id: owner, current_revision: 1, lifecycle_version: 0, deleted_at: null, deletion_requested_at: null, deletion_state: "active", created_at: "2026-10-07T00:00:00Z" } });
    throw new Error(`Unexpected fixture request ${path}`);
  }); vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("account projects and explicit legacy recovery", () => {
  it("shows placeholder cards while loading and keeps Deleted projects a quiet link", async () => {
    let finish!: () => void;
    const original = fetcher.getMockImplementation() as (path: string, init: RequestInit) => Promise<Response>;
    fetcher.mockImplementation((path: string, init: RequestInit) => path.startsWith("/api/projects/page") ? new Promise<Response>(resolve => { finish = () => resolve(original(path, init)); }) : original(path, init));
    await render();
    const grid = host.querySelector(".projects-grid")!;
    expect(grid.getAttribute("aria-busy")).toBe("true"); expect(grid.querySelectorAll(".project-card-skeleton")).toHaveLength(8);
    expect(grid.querySelector('[role="status"]')?.textContent).toBe("Loading your projects…"); expect(host.querySelector(".project-card")).toBeNull();
    const deleted = host.querySelector('a[href="/brands?state=deleted"]')!;
    expect(deleted.className).toContain("text-link"); expect(deleted.className).not.toMatch(/button|projects-secondary/);
    const newProject = [...host.querySelectorAll("a")].find(link => link.textContent?.startsWith("New project"));
    expect(newProject?.getAttribute("href")).toBe("/"); expect(newProject?.className).toBe("button primary");
    await act(async () => { finish(); });
    expect(grid.hasAttribute("aria-busy")).toBe(false); expect(host.querySelector(".project-card-skeleton")).toBeNull(); expect(host.textContent).toContain("Saved project");
  });
  it("shows only saved projects in the normal library and hides all device content while signed out", async () => {
    await render();
    expect(host.textContent).toContain("Saved project"); expect(host.textContent).not.toContain("Old unsaved project"); expect(host.textContent).not.toContain("Other account private project");
    expect(host.querySelector('[aria-label="Filter projects by storage"]')).toBeNull();
    expect(host.querySelector('a[href^="/brands/account/"]')).not.toBeNull();
    mock.session = { status: "signed_out", generation: 2 }; await render();
    expect(host.textContent).toContain("Sign in"); expect(host.textContent).not.toContain("Saved project"); expect(host.textContent).not.toContain("Old unsaved project");
  });
  it("requires explicit selection and account confirmation before a one-time recovery without AI", async () => {
    await render(); await click("Recover unsaved projects");
    expect(host.textContent).toContain("Old unsaved project"); expect(host.textContent).not.toContain("Other account private project");
    expect(host.querySelector("input[type=checkbox]")).toBeNull();
    await act(async () => host.querySelector<HTMLInputElement>("input[type=radio]")!.click());
    expect(host.textContent).toContain("Private brief for Old unsaved project");
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "Save project")).toBe(false);
    await act(async () => host.querySelector<HTMLInputElement>("input[type=checkbox]")!.click()); await click("Save project");
    const writes = fetcher.mock.calls.filter(([, init]) => init.method === "POST");
    expect(writes).toHaveLength(1); expect(writes[0]![0]).toBe("/api/projects"); expect(JSON.parse(String(writes[0]![1].body)).requestKey).toBe(legacyId);
    expect(getLocalDraft(legacyId)).toMatchObject({ ownerId: owner, description: "Private brief for Old unsaved project", accountProjectId: expect.any(String) });
    expect(mock.push).toHaveBeenCalledOnce();
    await act(async () => root.unmount()); root = createRoot(host); await render();
    expect(host.textContent).not.toContain("Old unsaved project"); expect(host.textContent).not.toContain("Recover unsaved projects");
  });
  it("keeps legacy deep links read-only until explicit recovery and never exposes another owner's draft", async () => {
    await render(true); expect(host.textContent).not.toContain("Private brief"); expect(host.querySelector("textarea")).toBeNull();
    await click("Recover unsaved projects"); expect(host.textContent).toContain("Old unsaved project");
    await act(async () => updateLocalDraft(legacyId, { ownerId: crypto.randomUUID() }));
    expect(host.textContent).not.toContain("Old unsaved project"); expect(host.textContent).not.toContain("Private brief");
    expect(fetcher.mock.calls.some(([, init]) => init.method === "POST")).toBe(false);
  });
});
