// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { accountProjectDraft, createAccountInput } from "@/components/workspace/project-draft-adapter";
import { ProjectEditor } from "@/components/workspace/project-editor";
import {
  clearLocalDrafts,
  copyToLocalDraft,
  getLocalDraft,
  type LocalDraft,
} from "@/components/workspace/local-drafts";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const mock = vi.hoisted(() => ({ push: vi.fn(), expire: vi.fn(), current: vi.fn(() => true) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({
    session: { status: "ready", userId: owner, generation: 1 },
    isCurrent: mock.current,
    expire: mock.expire,
  }),
}));
let root: Root, host: HTMLDivElement, draft: LocalDraft;
async function click(text: string) {
  await act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(text))!.click(),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.sessionStorage.clear();
  clearLocalDrafts();
  const context = contextSnapshotSchema.parse({
    description: "The existing prompt",
    selectedName: "Tablelight",
    intake: {
      namingNotes: "Keep the local name notes",
      conversation: [
        {
          id: "retained-user-message",
          kind: "user_message",
          text: "An actual earlier user message",
          createdAt: "2026-10-07T00:00:00Z",
        },
      ],
    },
  });
  const recovered = copyToLocalDraft({
    ...accountProjectDraft({
      id: crypto.randomUUID(),
      owner_id: owner,
      scope: "complete_brand",
      title: "Retained manual draft",
      current_revision: 1,
      created_at: "2026-10-07T00:00:00Z",
      context,
    }),
    preservedContext: context,
  })!;
  draft = getLocalDraft(recovered.id)!;
  mock.push.mockReset();
  mock.expire.mockReset();
  mock.current.mockReturnValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearLocalDrafts();
  vi.unstubAllGlobals();
});

it("requires explicit ownership confirmation before recovering the preserved strategy into the account without AI", async () => {
  const requests: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      if (path === "/api/session") return Response.json({ user: { id: owner } });
      expect(path).toBe("/api/projects");
      expect(init.method).toBe("POST");
      return Response.json({
        project: {
          ...createAccountInput(draft),
          id: projectId,
          owner_id: owner,
          current_revision: 1,
          created_at: "2026-10-07T00:00:00Z",
        },
      });
    }),
  );
  await act(async () => root.render(createElement(ProjectEditor, { projectId: draft.id })));
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.textContent).not.toContain("The existing prompt");
  expect(requests).toHaveLength(0);
  await click("Recover unsaved projects");
  await act(async () => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  expect(host.textContent).toContain("The existing prompt");
  expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Save project"))).toBe(
    false,
  );
  expect(requests).toHaveLength(0);
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(requests).toHaveLength(0);
  await click("Save project");
  expect(requests.map((request) => request.path)).toEqual(["/api/session", "/api/projects"]);
  const body = JSON.parse(String(requests[1]!.init.body));
  expect(body.requestKey).toBe(draft.id);
  expect(body.context).toMatchObject({
    selectedName: "Tablelight",
    intake: {
      namingNotes: "Keep the local name notes",
      conversation: [{ id: "retained-user-message", text: "An actual earlier user message" }],
    },
  });
  expect(mock.push).toHaveBeenCalledExactlyOnceWith(`/brands/account/${projectId}`);
  expect(getLocalDraft(draft.id)).toMatchObject({
    ownerId: owner,
    accountProjectId: projectId,
    description: "The existing prompt",
  });
});
