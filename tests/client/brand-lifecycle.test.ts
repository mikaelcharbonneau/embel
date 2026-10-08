import { describe, expect, it, vi } from "vitest";
import { contextSnapshotSchema, missingStrategy } from "@/domain/projects";
import { createLifecycleIntentMemory } from "@/features/brand-lifecycle/intent-memory";
import { executeLifecycleIntent } from "@/features/brand-lifecycle/execute-intent";
import type { AccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
import type { VerifiedAccount } from "@/components/workspace/account-session";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspace = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", key = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const account: VerifiedAccount = { status: "ready", userId: owner, generation: 1 };
const input = { requestKey: key, workspaceId: workspace, expectedWorkspaceRevision: 3, selection: { tool: "domains" as const, domain: "cedar.com" }, contextSource: null, title: "Cedar" };
const context = contextSnapshotSchema.parse({ description: "Existing brief", intake: { namingNotes: "Known notes" } });
const receipt = { ownerId: owner, requestKey: key, project: { id: key, owner_id: owner, title: "Cedar", scope: "complete_brand" as const, current_revision: 1, context, created_at: "2026-10-07T00:00:00Z" }, source: { id: workspace, ownerId: owner, workspaceId: workspace, workspaceRevision: 3, selection: input.selection, payloadHash: "a".repeat(64), contextSource: null, createdAt: "2026-10-07T00:00:00Z" } };
describe("explicit standalone promotion recovery", () => {
 it("promotion replay returns one brand with the same immutable source", async () => {
  const memory = createLifecycleIntentMemory(); memory.bind(account);
  const promote = vi.fn().mockRejectedValueOnce(new TypeError("Lost acknowledgement after persisted receipt"));
  const read = vi.fn().mockResolvedValue({ status: "committed", receipt });
  const client = { promoteStandaloneWorkspace: promote, readStandalonePromotionRequest: read } as unknown as AccountLifecycleClient;
  const intent = { kind: "standalone_promotion" as const, input, receipt: null, outcome: "pending" as const };
  const args = { account, memory, client, intent, signal: new AbortController().signal, recover: false };
  await expect(executeLifecycleIntent(args)).rejects.toThrow();
  expect(memory.get(account, intent.kind)?.outcome).toBe("uncertain");
  const result = await executeLifecycleIntent({ ...args, intent: memory.get(account, intent.kind)!, recover: true });
  expect(result?.receipt).toEqual(receipt); expect(promote).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledWith(key, expect.any(AbortSignal)); expect(memory.hasUnsaved()).toBe(false);
 });
 it("pending reads retain the same intent and dispatch no second promotion", async () => {
  const memory = createLifecycleIntentMemory(); memory.bind(account);
  const promote = vi.fn(), client = { promoteStandaloneWorkspace: promote, readStandalonePromotionRequest: vi.fn().mockResolvedValue({ status: "pending", requestKey: key }) } as unknown as AccountLifecycleClient;
  const intent = { kind: "standalone_promotion" as const, input, receipt: null, outcome: "uncertain" as const }; memory.set(account, intent);
  expect(await executeLifecycleIntent({ account, memory, client, intent, recover: true, signal: new AbortController().signal })).toBeNull();
  expect(memory.get(account, intent.kind)?.input).toEqual(input); expect(promote).not.toHaveBeenCalled();
 });
 it("an absent request permits only an explicit exact-key body retry", async () => {
  const memory = createLifecycleIntentMemory(); memory.bind(account);
  const promote = vi.fn().mockResolvedValue(receipt), client = { promoteStandaloneWorkspace: promote, readStandalonePromotionRequest: vi.fn().mockResolvedValue({ status: "not_found" }) } as unknown as AccountLifecycleClient;
  const intent = { kind: "standalone_promotion" as const, input, receipt: null, outcome: "uncertain" as const }; memory.set(account, intent);
  await executeLifecycleIntent({ account, memory, client, intent, recover: true, signal: new AbortController().signal });
  expect(promote).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal));
 });
 it("fences a delayed promotion after failed logout and restores only the original owner", async () => {
  const memory = createLifecycleIntentMemory(); memory.bind(account);
  let finish!: (value: typeof receipt) => void;
  const client = { promoteStandaloneWorkspace: vi.fn(() => new Promise(resolve => { finish = resolve; })) } as unknown as AccountLifecycleClient;
  const intent = { kind: "standalone_promotion" as const, input, receipt: null, outcome: "pending" as const };
  const operation = executeLifecycleIntent({ account, memory, client, intent, recover: false, signal: new AbortController().signal });
  memory.bind(null); finish(receipt); expect(await operation).toBeNull(); expect(memory.get(account, intent.kind)).toBeNull();
  const next = { ...account, generation: 3 }; memory.bind(next); expect(memory.get(next, intent.kind)?.input).toEqual(input);
 });
 it("promotion preserves known context without inventing reviews", () => {
  expect(context.intake.namingNotes).toBe("Known notes"); expect(missingStrategy(context)).toEqual(["reformulation", "competitors", "audience", "personality", "positioning"]);
 });
});
