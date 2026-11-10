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

it("keeps fencing a source whose saved request uses a retired format, without blocking other sources", async () => {
  const recovery = await import("@/components/workspace/account-project-start-recovery");
  const oldId = crypto.randomUUID(), currentId = crypto.randomUUID(), freshId = crypto.randomUUID();
  // Written before "Name only" projects were retired on November 9, 2026.
  const retired = { ownerId: owner, draftId: oldId, projectId: null, request: { key: oldId, input: { ...input, scope: "naming_only" } } };
  const current = { ownerId: owner, draftId: currentId, projectId: null, request: { key: currentId, input } };
  const unreadable = { draftId: "not-a-source" };
  const foreign = { ownerId: crypto.randomUUID(), draftId: crypto.randomUUID(), projectId: null };
  window.localStorage.setItem(`fluid.project-starts.v3:${owner}`, JSON.stringify([retired, current, unreadable, foreign]));
  window.sessionStorage.setItem(`fluid.strategy-starts.v2:${owner}`, JSON.stringify([retired]));
  expect(recovery.readReceipt(owner, freshId)).toBeNull();
  expect(recovery.readReceipt(owner, oldId)).toEqual({ ownerId: owner, draftId: oldId, projectId: null });
  expect(recovery.readReceipt(owner, currentId)).toEqual(current);
  expect(recovery.readDraftFence(oldId)).toBe(true);
  expect(recovery.readDraftFence(freshId)).toBe(false);
});

it("treats an unreadable record under a source's own key as an unconfirmed save of that source", async () => {
  const recovery = await import("@/components/workspace/account-project-start-recovery");
  const id = crypto.randomUUID();
  window.localStorage.setItem(`fluid.project-source.v1:${owner}:${id}`, JSON.stringify({ ownerId: owner, draftId: id, projectId: null, request: { key: id, input: { scope: "visual_identity_only" } }, extra: true }));
  expect(recovery.readReceipt(owner, id)).toEqual({ ownerId: owner, draftId: id, projectId: null });
  window.localStorage.setItem(`fluid.project-source.v1:${owner}:${id}`, "not json");
  vi.resetModules();
  const fresh = await import("@/components/workspace/account-project-start-recovery");
  expect(fresh.readReceipt(owner, id)).toEqual({ ownerId: owner, draftId: id, projectId: null });
});

it("still refuses storage that isn't a list of records", async () => {
  const recovery = await import("@/components/workspace/account-project-start-recovery");
  window.localStorage.setItem(`fluid.project-starts.v3:${owner}`, "{\"not\":\"a list\"}");
  expect(() => recovery.readReceipt(owner, crypto.randomUUID())).toThrow(recovery.StartReceiptRecoveryError);
});
