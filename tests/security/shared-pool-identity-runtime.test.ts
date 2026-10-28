import { beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
vi.mock("server-only", () => ({}));
import { createIdentityGenerationRuntimeAdapter } from "../../worker/identity/runtime";
import { createIdentityInputSnapshot, identitySystemVersionSchema } from "../../src/domain/project-identity";
import { createIdentityReferenceSnapshot } from "../../src/domain/identity-references";
import { identityGenerationObservationSchema } from "../../src/domain/identity-jobs";
import type { ClaimedJob } from "../../src/domain/jobs";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import {
  batchId, capability, hash, id, imageConfiguration, jobId, jobInput,
  leaseToken, ownerId, projectId, response, specification, textPolicy, timestamp,
} from "../worker/identity-generation-fixture";

let png: Uint8Array;
beforeAll(async () => {
  png = new Uint8Array(await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#987654" } }).png().toBuffer());
});

function fixture(referenceBytes: readonly Uint8Array[] = [png]) {
  const input = jobInput(hash(referenceBytes[0]!));
  if (referenceBytes.length > 1) {
    const original = input.input.referenceSnapshot.selected[0]!;
    const selected = referenceBytes.map((bytes, index) => ({
      reference: { ...original.reference, id: id(120 + index), media: { ...original.reference.media,
        assetId: id(130 + index), versionId: id(140 + index), contentHash: hash(bytes) } },
      reaction: { ...original.reaction, referenceId: id(120 + index) },
    }));
    const referenceSnapshot = createIdentityReferenceSnapshot({ ...input.input.referenceSnapshot,
      selectedReferenceCount: selected.length, selected });
    input.input = createIdentityInputSnapshot({ ...input.input, referenceSnapshot });
  }
  const job: ClaimedJob = { id: jobId, ownerId, projectId, operation: "identity.image", input, inputRevision: 1,
    leaseToken, status: "running", reservedCostMicrousd: 0, actualCostMicrousd: 0 };
  const prior = identitySystemVersionSchema.parse({ id: input.systemIds[0], ownerId, projectId, createdAt: timestamp,
    input: input.input, source: { kind: "generated", batchId, jobId, stepKey: "identity-system-v1:1" },
    components: specification().components,
    board: { asset: { ownerId, projectId, assetId: id(70), versionId: id(71), contentHash: "b".repeat(64), purpose: "brand_asset", mimeType: "image/png" }, depictsSystemVersionId: input.systemIds[0], staleComponents: [] }, productionFiles: [] });
  const systems = [prior];
  let stopped = false;
  const authorize = vi.fn(async () => ({ callId: id(80), disposition: "started" }));
  const mutateReceipt = vi.fn((value: unknown) => value);
  const connection: LogoWorkerConnection = { async query<Row>(sql: string, args: unknown[] = []) {
    let value: unknown;
    if (sql.includes("load_identity_generation_input")) value = { batch: { id: batchId, ownerId, projectId, jobId, targetCount: 3, input: input.input }, input, systems };
    else if (sql.includes("read_identity_generation_call")) value = null;
    else if (sql.includes("authorize_identity_generation_call")) value = await authorize();
    else if (sql.includes("record_identity_generation_response")) value = mutateReceipt({ id: id(81), ownerId, projectId, jobId, leaseToken, callId: args[2], observation: identityGenerationObservationSchema.parse(args[3]) });
    else throw Error("Unexpected independent fixture query");
    return { rows: [{ value }] as Row[] };
  } };
  const readLeasedAsset = vi.fn<IdentityAssetStore["readLeasedAsset"]>(async (_job, reference) => {
    const index = input.input.referenceSnapshot.selected.findIndex(entry => entry.reference.media.versionId === reference.versionId);
    const bytes = referenceBytes[index]!;
    return { reference, bytes: Uint8Array.from(bytes), mimeType: "image/png", verification: { status: "verified", checkedAt: timestamp,
      contentHash: hash(bytes), mimeType: "image/png", byteLength: bytes.byteLength } };
  });
  const publishLeasedAsset = vi.fn<IdentityAssetStore["publishLeasedAsset"]>();
  const countInputTokens = vi.fn(async () => 100);
  const createResponse = vi.fn(async () => response(specification(2)));
  const createImage = vi.fn(async (): Promise<never> => { throw Error("Independent test must not reach image dispatch"); });
  const handler = createIdentityGenerationRuntimeAdapter({ ownerId, capability, textProvider: { apiKey: "synthetic-test-only", model: textPolicy.model }, image: imageConfiguration,
    connection, assets: { readLeasedAsset, publishLeasedAsset, stageOwnedAsset: vi.fn(), publishOwnedUpload: vi.fn(), readOwnedAsset: vi.fn() },
    assertAvailable: async () => { if (stopped) throw Error("Stopped"); }, textTransport: { countInputTokens, createResponse }, imageTransport: { createImage } })!;
  return { job, systems, authorize, mutateReceipt, countInputTokens, createResponse, createImage, publishLeasedAsset, readLeasedAsset,
    stop: () => { stopped = true; }, execute: (index = 1) => handler.steps(job)[index]!.execute({ job, signal: new AbortController().signal }) };
}

describe("Independent shared Identity runtime authority review", () => {
  it("rejects a schema-valid foreign prior system before token inspection or paid dispatch", async () => {
    const f = fixture();
    const foreign = JSON.parse(JSON.stringify(f.systems[0]).replaceAll(ownerId, id(90)).replaceAll(projectId, id(91)));
    f.systems[0] = identitySystemVersionSchema.parse(foreign);
    expect((await f.execute()).status).toBe("failed");
    expect(f.countInputTokens).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.createResponse).not.toHaveBeenCalled();
  });

  it("rejects an owned prior system from another immutable batch before dispatch", async () => {
    const f = fixture();
    f.systems[0] = identitySystemVersionSchema.parse({ ...f.systems[0], source: { kind: "generated", batchId: id(92), jobId, stepKey: "identity-system-v1:1" } });
    expect((await f.execute()).status).toBe("failed");
    expect(f.countInputTokens).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
  });

  it("rejects a missing predecessor before the third system dispatch", async () => {
    const f = fixture();
    expect((await f.execute(2)).status).toBe("failed");
    expect(f.countInputTokens).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.createResponse).not.toHaveBeenCalled();
  });

  it("rejects reordered prior systems before constructing a different paid request", async () => {
    const f = fixture(), first = f.systems[0]!;
    const second = identitySystemVersionSchema.parse({ ...first, id: jobInput().systemIds[1],
      source: { kind: "generated", batchId, jobId, stepKey: "identity-system-v1:2" },
      board: { ...first.board, asset: { ...first.board.asset, assetId: id(72), versionId: id(73), contentHash: "c".repeat(64) }, depictsSystemVersionId: jobInput().systemIds[1] } });
    f.systems.splice(0, 1, second, first);
    expect((await f.execute(2)).status).toBe("failed");
    expect(f.countInputTokens).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.createResponse).not.toHaveBeenCalled();
  });

  it("rejects a substituted reference MIME before any paid phase", async () => {
    const f = fixture(), read = f.readLeasedAsset.getMockImplementation()!;
    f.readLeasedAsset.mockImplementation(async (...args) => {
      const result = await read(...args);
      return { ...result, mimeType: "image/jpeg", verification: { ...result.verification, mimeType: "image/jpeg" } };
    });
    expect((await f.execute()).status).toBe("failed");
    expect(f.readLeasedAsset).toHaveBeenCalledTimes(1);
    expect(f.countInputTokens).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.createResponse).not.toHaveBeenCalled();
    expect(f.createImage).not.toHaveBeenCalled();
  });

  it("rejects three individually bounded references exceeding total20MiB before paying for specifications", async () => {
    // Synthetic verified-port responses: byte metadata and hashes are exact.
    // The aggregate gate must run before any provider call or raster work.
    const bytes = new Uint8Array(8_388_608); bytes.set(png);
    const f = fixture([bytes, bytes, bytes]);
    expect((await f.execute()).status).toBe("failed");
    expect(f.readLeasedAsset).toHaveBeenCalledTimes(3);
    expect(f.countInputTokens).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.createResponse).not.toHaveBeenCalled();
    expect(f.createImage).not.toHaveBeenCalled();
  });

  it("does not issue a paid request when Stop lands after the durable call authorization", async () => {
    const f = fixture();
    f.authorize.mockImplementation(async () => { f.stop(); return { callId: id(80), disposition: "started" }; });
    expect((await f.execute()).status).toBe("needs_reconciliation");
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.createResponse).not.toHaveBeenCalled();
    expect(f.createImage).not.toHaveBeenCalled();
  });

  it("rejects a substituted call receipt without issuing the board or publishing bytes", async () => {
    const f = fixture();
    f.mutateReceipt.mockImplementation(value => ({ ...(value as Record<string, unknown>), callId: id(99) }));
    expect((await f.execute()).status).toBe("needs_reconciliation");
    expect(f.createResponse).toHaveBeenCalledTimes(1);
    expect(f.createImage).not.toHaveBeenCalled();
    expect(f.publishLeasedAsset).not.toHaveBeenCalled();
  });
});
