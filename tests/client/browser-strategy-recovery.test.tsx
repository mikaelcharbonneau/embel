// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { accountProjectDraft, createAccountInput } from "@/components/workspace/project-draft-adapter";
import { ProjectEditor } from "@/components/workspace/project-editor";
import type { LocalDraft } from "@/components/workspace/local-drafts";
const mock = vi.hoisted(() => ({ draft: null as LocalDraft | null, update: vi.fn(), push: vi.fn(), expire: vi.fn(), current: vi.fn(() => true) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 }, isCurrent: mock.current, expire: mock.expire }) }));
vi.mock("@/components/workspace/local-drafts", async importOriginal => ({ ...await importOriginal<typeof import("@/components/workspace/local-drafts")>(), useLocalDrafts: () => ({ loaded: true, drafts: [mock.draft], storage: "available" }), updateLocalDraft: mock.update }));
let root: Root | null, host: HTMLDivElement;
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mock.draft = accountProjectDraft({ id: crypto.randomUUID(), owner_id: owner, scope: "complete_brand", title: "Retained manual draft", current_revision: 1, created_at: "2026-10-07T00:00:00Z", context: contextSnapshotSchema.parse({ description: "The existing prompt" }) });
  mock.update.mockReset().mockReturnValue(true); mock.push.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); });
it("labels manual messages honestly and offers the existing explicit account-save then Request response path", async () => {
  const fetcher = vi.fn(async (path: string) => { if (path === "/api/session") return Response.json({ user: { id: owner } }); expect(path).toBe("/api/projects"); return Response.json({ project: { ...createAccountInput(mock.draft!), id: projectId, owner_id: owner, current_revision: 1, created_at: "2026-10-07T00:00:00Z" } }); }); vi.stubGlobal("fetch", fetcher);
  await act(async () => root!.render(createElement(ProjectEditor, { projectId: mock.draft!.id })));
  expect(host.querySelector('.conversation-composer button[type="submit"]')!.textContent).toBe("Save message");
  expect(host.textContent).toContain("Choose Save to account, then Request response");
  expect(host.textContent).toContain("It does not request an AI response");
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Save to account"))!.click());
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/api/session", "/api/projects"]);
  expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}`);
});
