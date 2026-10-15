// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input = { title: "Shared source", scope: "complete_brand" as const, context: contextSnapshotSchema.parse({ description: "A retained project source" }) };
beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); vi.resetModules(); });

it("retains each pending source when another tab replaces the owner receipt array", async () => {
  const tabOne = await import("@/components/workspace/account-project-start-recovery");
  const firstId = crypto.randomUUID();
  const first = { ownerId: owner, draftId: firstId, projectId: null, request: { key: firstId, input } };
  tabOne.rememberReceipt(first, true);
  vi.resetModules();
  const tabTwo = await import("@/components/workspace/account-project-start-recovery");
  const secondId = crypto.randomUUID();
  const second = { ownerId: owner, draftId: secondId, projectId: null, attachedRequestKey: crypto.randomUUID() };
  tabTwo.rememberReceipt(second, true);
  expect(JSON.parse(window.localStorage.getItem(`fluid.project-starts.v3:${owner}`)!)).toEqual([second]);
  vi.resetModules();
  const recovered = await import("@/components/workspace/account-project-start-recovery");
  expect(recovered.readReceipt(owner, firstId)).toEqual(first);
  expect(recovered.readReceipt(owner, secondId)).toEqual(second);
});

it.each(["project", "attached"] as const)("a later local flush keeps the endpoint fence for a tab-only %s admission", async kind => {
  const drafts = await import("@/components/workspace/local-drafts");
  const recovery = await import("@/components/workspace/account-project-start-recovery");
  const draftInput = { title: input.title, description: input.context.description, scope: input.scope, suppliedName: "", namingNotes: "", identityNotes: "", example: false, ownerId: owner };
  const blocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
  let id: string, requestKey: string;
  try {
    id = drafts.createLocalDraft(draftInput)!;
    requestKey = kind === "project" ? id : crypto.randomUUID();
    recovery.rememberReceipt({ ownerId: owner, draftId: id, projectId: null, ...(kind === "project" ? { request: { key: requestKey, input } } : { attachedRequestKey: requestKey }) }, true);
    expect(drafts.getLocalDraft(id)!.accountSaveRequest).toEqual({ kind, key: requestKey });
    expect(window.localStorage.getItem(drafts.DRAFT_STORAGE_KEY)).toBeNull();
  } finally { blocked.mockRestore(); }
  // An unrelated new draft later flushes the retained in-memory draft array.
  drafts.createLocalDraft(draftInput);
  vi.resetModules();
  const otherTab = await import("@/components/workspace/account-project-start-recovery");
  expect(otherTab.readReceipt(owner, id!)).toEqual({ ownerId: owner, draftId: id!, projectId: null, ...(kind === "attached" ? { attachedRequestKey: requestKey! } : {}) });
});
