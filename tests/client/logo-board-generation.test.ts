import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountIdentityClient } from "@/components/identity/account-identity-client";
import { createIdentityGenerationController } from "@/components/identity/identity-generation-controller";
import { createIdentityDraftMemory } from "@/components/identity/identity-draft-memory";
import { identityBatchStateSchema, logoBoardAvailabilitySchema, logoBoardGenerationIntentSchema } from "@/domain/identity-jobs";
import { identityLogoSourceSchema } from "@/domain/identity-logo-source";
import { createIdentityInputSnapshot } from "@/domain/project-identity";
import { IMAGE_MODEL } from "@/domain/providers";
import { batchState, generationIntent, ownerId, projectId } from "../fixtures/identity-generation";
import { syntheticLogoBatch, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";

const concept = syntheticResolvedLogoConcept(), preview = syntheticLogoBatch().slots[0]!.acceptedPreview!;
const sourceLogo = identityLogoSourceSchema.parse({ version: 1, selectionRevision: 2, logoType: "wordmark",
  source: { kind: "concept", batchId: concept.input.batchId, slotId: concept.input.slotId, attemptId: concept.input.attemptId },
  brief: { ...concept.brief, ownerId, projectId }, preview: { ...preview, reference: { ...preview.reference, ownerId, projectId } } });
const intent = logoBoardGenerationIntentSchema.parse({ ...generationIntent, version: 3, expectedLogoRevision: 2, sourceLogo: sourceLogo.source });
const batch = () => identityBatchStateSchema.parse({ ...batchState(), intent, sourceLogo, sourceLogoCurrent: true,
  input: createIdentityInputSnapshot({ ...batchState().input, logoBrief: sourceLogo.brief }), usage: { status: "pending", knownCostMicrousd: 0 } });
const availability = logoBoardAvailabilitySchema.parse({ version: 3, spendControl: "uncapped", ownerId, projectId, status: "available",
  operation: "identity.image", requestedModel: IMAGE_MODEL, policyIdentity: intent.acceptedPolicyIdentity, handlerVersion: "identity-image-v1",
  targetCount: 3, maxReferenceImages: 4, maxReferenceBytes: 20_971_520, sourceLogo, estimatedCostMicrousd: 60000,
  expectedProjectRevision: 1, expectedReferenceRevision: 1, expectedPreferencesRevision: 0, expectedIdentityRevision: 0, expectedLogoRevision: 2 });
const account = { status: "ready" as const, userId: ownerId, generation: 1 };
afterEach(() => vi.unstubAllGlobals());

describe("three directions retain the chosen logo", () => {
  it("sends the exact chosen concept once with no vector approval or spending cap", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(batch())); vi.stubGlobal("fetch", fetcher);
    const client = createAccountIdentityClient(account, projectId, () => true, vi.fn());
    expect((await client.generate(intent))?.sourceLogo).toEqual(sourceLogo);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/projects/${projectId}/identity/batches`);
    expect(JSON.parse(init.body)).toEqual(intent);
    expect(JSON.parse(init.body)).not.toHaveProperty("acceptedMaxCostMicrousd");
    expect(JSON.parse(init.body)).not.toHaveProperty("approvedLogoId");
    client.dispose();
  });

  it("rejects a response that swaps the original concept or its owner", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ...batch(), sourceLogo: { ...sourceLogo,
      source: { ...sourceLogo.source, attemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } } }));
    vi.stubGlobal("fetch", fetcher);
    const client = createAccountIdentityClient(account, projectId, () => true, vi.fn());
    await expect(client.generate(intent)).rejects.toMatchObject({ status: 502 });
    fetcher.mockResolvedValue(Response.json({ ...batch(), sourceLogo: { ...sourceLogo,
      preview: { ...sourceLogo.preview, reference: { ...sourceLogo.preview.reference, ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } } } }));
    await expect(client.generate(intent)).rejects.toMatchObject({ status: 502 }); client.dispose();
  });

  it("starts after a deliberate click and checks an uncertain original without admitting a duplicate", async () => {
    const client = { current: () => true, generation: vi.fn().mockResolvedValue({ ownerId, projectId, availability, latest: null }),
      batch: vi.fn().mockResolvedValue(batch()), batchRequest: vi.fn().mockResolvedValue({ status: "found", batch: batch() }),
      generate: vi.fn().mockRejectedValue(new Error("Lost acknowledgment")), stopBatch: vi.fn(), closeBatchRequest: vi.fn() };
    const memory = createIdentityDraftMemory();
    const controller = createIdentityGenerationController({ account, projectId, client, memory, canStart: () => true });
    controller.activate(); await controller.refresh(); expect(client.generate).not.toHaveBeenCalled();
    await controller.start(intent); expect(client.generate).toHaveBeenCalledOnce();
    await controller.start({ ...intent, idempotencyKey: "a-second-click-must-not-start" }); expect(client.generate).toHaveBeenCalledOnce();
    expect(memory.generationRequest(ownerId, projectId)?.input).toEqual(intent);
    await controller.refresh(); expect(client.generate).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().batch?.sourceLogo).toEqual(sourceLogo); expect(memory.hasUnsaved()).toBe(false);
    controller.dispose();
  });

  it("permits a source to become stale but never silently changes its frozen brief", async () => {
    const client = { current: () => true, generation: vi.fn().mockResolvedValue({ ownerId, projectId, availability, latest: batch() }),
      batch: vi.fn().mockResolvedValue({ ...batch(), sourceLogoCurrent: false }), batchRequest: vi.fn(), generate: vi.fn(), stopBatch: vi.fn(), closeBatchRequest: vi.fn() };
    const controller = createIdentityGenerationController({ account, projectId, client, memory: createIdentityDraftMemory(), canStart: () => true });
    controller.activate(); await controller.refresh(); await controller.poll();
    expect(controller.getSnapshot().batch?.sourceLogoCurrent).toBe(false);
    client.batch.mockResolvedValue({ ...batch(), sourceLogoCurrent: false, sourceLogo: { ...sourceLogo,
      brief: { ...sourceLogo.brief, payload: { ...sourceLogo.brief.payload, activity: "Unrelated changed activity" } } } });
    await controller.poll();
    expect(controller.getSnapshot().error).toBeTruthy();
    expect(controller.getSnapshot().batch?.sourceLogo).toEqual(sourceLogo); controller.dispose();
  });
});
