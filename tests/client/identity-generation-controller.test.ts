import { describe, expect, it, vi } from "vitest";
import { createIdentityGenerationController } from "@/components/identity/identity-generation-controller";
import { createIdentityDraftMemory } from "@/components/identity/identity-draft-memory";
import { AccountRequestError } from "@/components/workspace/account-api";
import { identityBatchStateSchema, identityBatchRequestCloseSchema, type IdentityBatchState } from "@/domain/identity-jobs";
import { IMAGE_MODEL } from "@/domain/providers";
import { batchState, generationIntent, ownerId, projectId } from "../fixtures/identity-generation";
import { fixtureSystem } from "./project-identity-fixtures";

function setup() {
  let current = true;
  const batch = identityBatchStateSchema.parse(batchState());
  const overview = { ownerId, projectId, availability: { version: 2 as const, spendControl: "uncapped" as const, ownerId, projectId, status: "available" as const,
    operation: "identity.image" as const, requestedModel: IMAGE_MODEL, policyIdentity: generationIntent.acceptedPolicyIdentity, handlerVersion: "identity-image-v1" as const, targetCount: 3 as const, maxReferenceImages: 4 as const, maxReferenceBytes: 20_971_520 as const }, latest: null };
  const client = { current: () => current, generation: vi.fn().mockResolvedValue(overview), batch: vi.fn().mockResolvedValue(batch),
    batchRequest: vi.fn().mockResolvedValue({ status: "not_found" }), generate: vi.fn().mockResolvedValue(batch), closeBatchRequest: vi.fn(), stopBatch: vi.fn().mockResolvedValue({ ...batch, status: "cancel_requested" }) };
  const memory = createIdentityDraftMemory(), canStart = vi.fn(() => true);
  const controller = createIdentityGenerationController({ account: { status: "ready", userId: ownerId, generation: 1 }, projectId, client, memory, canStart });
  controller.activate();
  return { controller, client, memory, batch, overview, canStart, expire() { current = false; } };
}
describe("Identity generation immutable request lifecycle", () => {
  it("checks availability without admission and starts only the explicitly approved uncapped request", async () => {
    const f = setup(); await f.controller.refresh(); expect(f.client.generate).not.toHaveBeenCalled();
    await f.controller.start(generationIntent); expect(f.client.generate).toHaveBeenCalledExactlyOnceWith(generationIntent, expect.any(AbortSignal));
    expect(f.controller.getSnapshot().batch).toEqual(f.batch); expect(f.memory.hasUnsaved()).toBe(false);
  });
  it("retains unknown admission across unmount and checks original key before explicit same-key retry", async () => {
    const f = setup(); await f.controller.refresh(); f.client.generate.mockRejectedValueOnce(new AccountRequestError(503));
    await f.controller.start(generationIntent); expect(f.memory.hasUnsaved()).toBe(true); f.controller.dispose();
    const recovered = createIdentityGenerationController({ account: { status: "ready", userId: ownerId, generation: 2 }, projectId, client: f.client, memory: f.memory, canStart: () => true });
    recovered.activate(); await recovered.refresh(); expect(f.client.generate).toHaveBeenCalledTimes(1); expect(recovered.getSnapshot().lookup).toBe("not_found");
    await recovered.retryOriginal(); expect(f.client.generate).toHaveBeenCalledTimes(2); for (const [input] of f.client.generate.mock.calls) expect(input).toEqual(generationIntent);
    expect(f.memory.hasUnsaved()).toBe(false); recovered.dispose();
  });
  it("recovers a lost admission acknowledgment through a read without any second admission", async () => {
    const f = setup(); await f.controller.refresh(); f.client.generate.mockRejectedValueOnce(new AccountRequestError(503)); await f.controller.start(generationIntent);
    f.client.batchRequest.mockResolvedValue({ status: "found", batch: f.batch }); await f.controller.refresh();
    expect(f.client.generate).toHaveBeenCalledTimes(1); expect(f.controller.getSnapshot().batch?.batchId).toBe(f.batch.batchId); expect(f.memory.hasUnsaved()).toBe(false);
  });
  it("keeps the original evidence if a lookup fails or contradicts its immutable intent", async () => {
    const f = setup(); await f.controller.refresh(); f.client.generate.mockRejectedValue(new AccountRequestError(503)); await f.controller.start(generationIntent);
    f.client.batchRequest.mockResolvedValue({ status: "found", batch: { ...f.batch, intent: { ...generationIntent, acceptedPolicyIdentity: "b".repeat(64) } } });
    await f.controller.retryOriginal(); expect(f.client.generate).toHaveBeenCalledTimes(1); expect(f.memory.hasUnsaved()).toBe(true); expect(f.controller.getSnapshot().error).toBeTruthy();
  });
  it("blocks duplicate starts, reconciliation and changed four-head readiness", async () => {
    const f = setup(); await f.controller.refresh(); f.canStart.mockReturnValue(false); await f.controller.start(generationIntent); expect(f.client.generate).not.toHaveBeenCalled();
    f.canStart.mockReturnValue(true); await f.controller.start(generationIntent); await f.controller.start({ ...generationIntent, idempotencyKey: "a-different-request-key" }); expect(f.client.generate).toHaveBeenCalledTimes(1);
    f.client.batch.mockResolvedValue({ ...f.batch, status: "needs_reconciliation", fulfillment: { targetCount: 3, acceptedCount: 0, status: "none" } }); await f.controller.poll();
    await f.controller.start({ ...generationIntent, idempotencyKey: "a-different-request-key" }); expect(f.client.generate).toHaveBeenCalledTimes(1);
    await f.controller.poll(); expect(f.client.batch).toHaveBeenCalledTimes(1);
  });
  it("Stop retains actual cancel-requested state until the server reports terminal cancellation", async () => {
    const f = setup(); await f.controller.refresh(); await f.controller.start(generationIntent); await f.controller.stop();
    expect(f.controller.getSnapshot().batch?.status).toBe("cancel_requested"); expect(f.controller.getSnapshot().batch?.terminal).toBe(false);
    f.client.batch.mockResolvedValue({ ...f.batch, status: "cancelled", terminal: true, fulfillment: { targetCount: 3, acceptedCount: 0, status: "none" } }); await f.controller.poll();
    expect(f.controller.getSnapshot().batch?.status).toBe("cancelled"); await f.controller.stop(); expect(f.client.stopBatch).toHaveBeenCalledTimes(1);
  });
  it("hides late responses after an owner switch and retains the original intent for its owner only", async () => {
    const f = setup(); await f.controller.refresh(); let complete!: (v: IdentityBatchState) => void;
    f.client.generate.mockImplementation(() => new Promise(resolve => { complete = resolve; })); const pending = f.controller.start(generationIntent);
    f.expire(); complete(f.batch); await pending;
    expect(f.controller.getSnapshot().batch).toBeNull(); expect(f.memory.generationRequest(ownerId, projectId)?.input).toEqual(generationIntent);
    expect(f.memory.generationRequest("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId)).toBeNull();
    f.memory.clear(); expect(f.memory.hasUnsaved()).toBe(false);
  });
  it("does not replace an unknown request with a fresh key or discard it on an inconclusive retry", async () => {
    const f = setup(); await f.controller.refresh(); f.client.generate.mockRejectedValue(new AccountRequestError(503)); await f.controller.start(generationIntent);
    await f.controller.start({ ...generationIntent, idempotencyKey: "do-not-replace-original" }); await f.controller.retryOriginal();
    expect(f.memory.generationRequest(ownerId, projectId)?.input).toEqual(generationIntent); expect(f.client.generate).toHaveBeenCalledTimes(2);
  });
  it("keeps real partial systems and refuses contradictory recovery that removes accepted work", async () => {
    const f = setup(); await f.controller.refresh(); await f.controller.start(generationIntent);
    const created = fixtureSystem(f.batch.input), system = { ...created, source: { kind: "generated" as const, batchId: f.batch.batchId, jobId: f.batch.jobId, stepKey: "identity.board.1" } };
    f.client.batch.mockResolvedValue({ ...f.batch, status: "running", systems: [system], fulfillment: { targetCount: 3, acceptedCount: 1, status: "partial" } }); await f.controller.poll();
    expect(f.controller.getSnapshot().batch?.systems).toEqual([system]);
    f.client.batch.mockResolvedValue(f.batch); await f.controller.poll(); expect(f.controller.getSnapshot().batch?.systems).toEqual([system]); expect(f.controller.getSnapshot().error).toBeTruthy();
    f.client.batch.mockResolvedValue({ ...f.batch, status: "partial", terminal: true, systems: [system], fulfillment: { targetCount: 3, acceptedCount: 1, status: "partial" } }); await f.controller.poll();
    expect(f.controller.getSnapshot().batch).toMatchObject({ status: "partial", terminal: true, systems: [system] });
    const reads = f.client.batch.mock.calls.length; await f.controller.poll(); expect(f.client.batch).toHaveBeenCalledTimes(reads);
  });
  it("clears an uncertain admission only after an exact owned durable not-admitted witness", async () => {
    const f = setup(); await f.controller.refresh(); f.client.generate.mockRejectedValueOnce(new AccountRequestError(503)); await f.controller.start(generationIntent);
    f.client.closeBatchRequest.mockResolvedValue(identityBatchRequestCloseSchema.parse({ status: "not_admitted", ownerId, projectId, intent: generationIntent }));
    await f.controller.closeOriginal(); expect(f.memory.hasUnsaved()).toBe(false); expect(f.controller.getSnapshot().batch).toBeNull(); expect(f.client.generate).toHaveBeenCalledTimes(1);
    expect(f.client.closeBatchRequest).toHaveBeenCalledExactlyOnceWith(generationIntent, expect.any(AbortSignal));
  });
  it("adopts the actual admitted cancellation state instead of claiming an unknown request never ran", async () => {
    const f = setup(); await f.controller.refresh(); f.client.generate.mockRejectedValueOnce(new AccountRequestError(503)); await f.controller.start(generationIntent);
    f.client.closeBatchRequest.mockResolvedValue({ status: "admitted", batch: { ...f.batch, status: "cancel_requested" } }); await f.controller.closeOriginal();
    expect(f.memory.hasUnsaved()).toBe(false); expect(f.controller.getSnapshot().batch).toMatchObject({ batchId: f.batch.batchId, status: "cancel_requested", terminal: false });
  });
  it("retains original evidence on failed, foreign or contradictory close acknowledgments", async () => {
    const f = setup(); await f.controller.refresh(); f.client.generate.mockRejectedValueOnce(new AccountRequestError(503)); await f.controller.start(generationIntent);
    f.client.closeBatchRequest.mockRejectedValueOnce(new AccountRequestError(503)); await f.controller.closeOriginal(); expect(f.memory.hasUnsaved()).toBe(true);
    f.client.closeBatchRequest.mockResolvedValueOnce({ status: "not_admitted", ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId, intent: generationIntent }); await f.controller.closeOriginal(); expect(f.memory.hasUnsaved()).toBe(true);
    f.client.closeBatchRequest.mockResolvedValueOnce(identityBatchRequestCloseSchema.parse({ status: "not_admitted", ownerId, projectId, intent: { ...generationIntent, expectedProjectRevision: 2 } })); await f.controller.closeOriginal();
    expect(f.memory.generationRequest(ownerId, projectId)?.input).toEqual(generationIntent); expect(f.controller.getSnapshot().error).toBeTruthy(); expect(f.client.generate).toHaveBeenCalledTimes(1);
  });
  it("permits an explicit Stop on admitted uncertainty while preserving unknown outcomes and blocking a fresh request", async () => {
    const f = setup(); await f.controller.refresh(); await f.controller.start(generationIntent);
    const unknown = identityBatchStateSchema.parse({ ...f.batch, status: "needs_reconciliation", fulfillment: { targetCount: 3, acceptedCount: 0, status: "none" } });
    f.client.batch.mockResolvedValue(unknown); await f.controller.poll(); f.client.stopBatch.mockResolvedValue(unknown);
    await f.controller.stop(); expect(f.client.stopBatch).toHaveBeenCalledExactlyOnceWith(unknown, expect.any(AbortSignal));
    expect(f.controller.getSnapshot()).toMatchObject({ batch: { status: "needs_reconciliation", terminal: false }, stopAcknowledgedBatchId: unknown.batchId });
    await f.controller.start({ ...generationIntent, idempotencyKey: "no-fresh-work-after-stop" }); await f.controller.stop(); expect(f.client.generate).toHaveBeenCalledTimes(1); expect(f.client.stopBatch).toHaveBeenCalledTimes(1);
    const checks = f.client.batch.mock.calls.length; await f.controller.poll(); expect(f.client.batch).toHaveBeenCalledTimes(checks);
  });
  it("does not claim a Stop acknowledgment when stopping an uncertain admitted request fails", async () => {
    const f = setup(); await f.controller.refresh(); await f.controller.start(generationIntent);
    f.client.batch.mockResolvedValue({ ...f.batch, status: "needs_reconciliation", fulfillment: { targetCount: 3, acceptedCount: 0, status: "none" } }); await f.controller.poll();
    f.client.stopBatch.mockRejectedValue(new AccountRequestError(503)); await f.controller.stop();
    expect(f.controller.getSnapshot()).toMatchObject({ batch: { status: "needs_reconciliation", terminal: false }, stopAcknowledgedBatchId: null }); expect(f.controller.getSnapshot().error).toBeTruthy();
  });
  // The generation engine refuses a round for credits or today's limit before admitting anything.
  it.each([
    [402, "You've used this month's credits. Your saved directions are kept."],
    [429, "You've reached today's limit for new directions. Your saved directions are kept. Try again tomorrow."],
  ])("treats an engine refusal (%i) as final: it says why, keeps no request and names no price", async (status, message) => {
    const f = setup(); await f.controller.refresh(); f.client.generate.mockRejectedValueOnce(new AccountRequestError(status));
    await f.controller.start(generationIntent);
    expect(f.controller.getSnapshot()).toMatchObject({ error: message, retained: null, batch: null });
    expect(f.memory.hasUnsaved()).toBe(false); expect(message).not.toMatch(/\$|cost|price/i);
    await f.controller.start({ ...generationIntent, idempotencyKey: "identity-generation-fixture-002" });
    expect(f.client.generate).toHaveBeenCalledTimes(2);
  });
});
