// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { contextSnapshotSchema } from "@/domain/projects";
import { saveLocalDraftToAccount } from "@/components/workspace/save-local-draft-to-account";
import type { VerifiedAccount } from "@/components/workspace/account-session";
let account: VerifiedAccount;
const when = "2026-10-15T00:00:00Z";
const draft = () => ({
  ...accountProjectDraft({
    id: crypto.randomUUID(),
    owner_id: account.userId,
    title: "Stable source",
    scope: "complete_brand",
    current_revision: 1,
    created_at: when,
    context: contextSnapshotSchema.parse({ description: "A stable source for an account project" }),
  }),
  ownerId: account.userId,
});
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  account = { status: "ready", userId: crypto.randomUUID(), generation: 1 };
});
afterEach(() => vi.unstubAllGlobals());
it("retains a confirmed source destination after its full ephemeral receipt is retired", async () => {
  const requests: Array<{ requestKey: string }> = [],
    projects = new Map<string, unknown>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      if (path === "/api/session") return Response.json({ user: { id: account.userId } });
      const body = JSON.parse(String(init.body));
      requests.push(body);
      if (!projects.has(body.requestKey))
        projects.set(body.requestKey, {
          ...body,
          id: crypto.randomUUID(),
          owner_id: account.userId,
          current_revision: 1,
          created_at: when,
        });
      return Response.json({ project: projects.get(body.requestKey) });
    }),
  );
  const first = draft(),
    second = draft();
  const save = (value: typeof first) =>
    saveLocalDraftToAccount({
      account,
      draft: value,
      signal: new AbortController().signal,
      isCurrent: () => true,
      expire: vi.fn(),
    });
  const created = await save(first);
  await save(second);
  const replay = await save(first);
  expect(requests.map((request) => request.requestKey)).toEqual([first.id, second.id]);
  expect(projects.size).toBe(2);
  expect(replay?.receipt.projectId).toBe(created?.receipt.projectId);
});
it("saves a new account source when local writes fail and no durable source exists", async () => {
  const original = draft();
  const fetcher = vi.fn(async (path: string, init: RequestInit) =>
    path === "/api/session"
      ? Response.json({ user: { id: account.userId } })
      : Response.json({
          project: {
            ...JSON.parse(String(init.body)),
            id: original.id,
            owner_id: account.userId,
            current_revision: 1,
            created_at: when,
          },
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  const blocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  try {
    const result = await saveLocalDraftToAccount({
      account,
      draft: original,
      signal: new AbortController().signal,
      isCurrent: () => true,
      expire: vi.fn(),
    });
    expect(result?.receipt.projectId).toBe(original.id);
    expect(fetcher.mock.calls.find(([path]) => path === "/api/projects")![1].headers).toMatchObject({
      "X-Embel-Account": account.userId,
    });
  } finally {
    blocked.mockRestore();
  }
});
it("does not admit a previously durable source when its shared creation guard cannot be written", async () => {
  const original = draft();
  window.localStorage.setItem("fluid.local-drafts.v1", JSON.stringify({ version: 1, drafts: [original] }));
  const fetcher = vi.fn(async () => Response.json({ user: { id: account.userId } }));
  vi.stubGlobal("fetch", fetcher);
  const blocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  try {
    await expect(
      saveLocalDraftToAccount({
        account,
        draft: original,
        signal: new AbortController().signal,
        isCurrent: () => true,
        expire: vi.fn(),
      }),
    ).rejects.toThrow("No project request was sent");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    blocked.mockRestore();
  }
});
it("accepts the current saved head on exact replay without overwriting it", async () => {
  const original = draft();
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      if (path === "/api/session") return Response.json({ user: { id: account.userId } });
      if (++attempts === 1) throw new TypeError("Lost response");
      const body = JSON.parse(String(init.body));
      return Response.json({
        project: {
          ...body,
          id: original.id,
          owner_id: account.userId,
          title: "Later saved title",
          current_revision: 4,
          context: contextSnapshotSchema.parse({ description: "Later saved context" }),
          created_at: when,
        },
      });
    }),
  );
  const save = () =>
    saveLocalDraftToAccount({
      account,
      draft: original,
      signal: new AbortController().signal,
      isCurrent: () => true,
      expire: vi.fn(),
    });
  await expect(save()).rejects.toThrow();
  const replay = await save();
  expect(replay?.project).toMatchObject({
    title: "Later saved title",
    current_revision: 4,
    context: { description: "Later saved context" },
  });
});
