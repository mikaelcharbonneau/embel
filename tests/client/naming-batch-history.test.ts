import { expect, it, vi, afterEach } from "vitest";
import { createNamingRequestScope, readNamingBatchDetail } from "@/components/naming/use-project-naming";
import { contextSnapshotSchema } from "@/domain/projects";
import { initialNamingPreferences, namingStrategyBasis, namingStrategyKey } from "@/domain/project-naming";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
const id = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { status: "ready" as const, userId: id(1), generation: 1 }, projectId = id(2), at = "2026-10-16T12:00:00Z";
const context = contextSnapshotSchema.parse({ description: "Synthetic mixed Naming history" });
function detail(managed: boolean, ownerId = account.userId) {
  const batch = { id: id(3), ownerId, projectId, contextRevision: 1, strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), preferencesVersion: 1,
    preferences: managed ? { ...initialNamingPreferencesV2(context), approaches: ["invented"], directness: "all" } : initialNamingPreferences(context), favoritesSnapshot: [], acceptedPolicyIdentity: "a".repeat(64), targetCount: managed ? 100 : 250, sequence: 1, jobId: id(4), createdAt: at,
    ...(managed ? { version: 2, handlerVersion: "naming-brain-v1", billingMode: "openai_api", runId: id(5) } : {}) };
  const job = { id: id(4), owner_id: ownerId, project_id: projectId, operation: "naming.generate", input_revision: 1, state: "queued", progress: 0, error_code: null, cancel_requested_at: null, created_at: at, finished_at: null, batchId: id(3), sequence: 1, targetCount: batch.targetCount, results: [],
    ...(managed ? { version: 2, handlerVersion: "naming-brain-v1", billingMode: "openai_api", policyIdentity: null, acceptedPolicyIdentity: "a".repeat(64), runId: id(5) } : { billingMode: "chatgpt_subscription", policyIdentity: "a".repeat(64) }) };
  return { batch, job, result: null };
}
afterEach(() => vi.unstubAllGlobals());
it.each([false, true])("reads owned historical batch detail without changing its billing/provenance version (managed=%s)", async managed => {
  const fetcher = vi.fn(async () => Response.json(detail(managed))); vi.stubGlobal("fetch", fetcher);
  const scope = createNamingRequestScope(account, () => true, vi.fn());
  const result = await readNamingBatchDetail(scope, account.userId, projectId, id(3));
  expect(result?.job.billingMode).toBe(managed ? "openai_api" : "chatgpt_subscription");
  expect(fetcher.mock.calls).toHaveLength(1); scope.dispose();
});
it("never returns another owner's otherwise valid managed history", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(detail(true, id(99))))); const expire = vi.fn();
  const scope = createNamingRequestScope(account, () => true, expire);
  expect(await readNamingBatchDetail(scope, account.userId, projectId, id(3))).toBeNull(); expect(expire).toHaveBeenCalledWith(account); scope.dispose();
});
