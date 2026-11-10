import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createLogoServices } from "@/server/runtime/logo-services";
import type { AuthenticatedContext } from "@/server/auth/context";
it("keeps private byte and transaction capabilities unavailable without explicit server dependencies", async () => {
  const runtime = createLogoServices(null);
  const auth = { userId: "d0000000-0000-4000-8000-000000000001", client: {} } as AuthenticatedContext;
  expect(runtime.configured).toBe(false);
  await expect(
    runtime.assets.readOwnedAsset(auth, {
      ownerId: auth.userId,
      projectId: "d0000000-0000-4000-8000-000000000002",
      assetId: "d0000000-0000-4000-8000-000000000003",
      versionId: "d0000000-0000-4000-8000-000000000004",
      contentHash: "a".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "integration_unavailable" });
});
it("performs no pool acquisition, storage I/O or provider work during configured composition", () => {
  const acquire = vi.fn(),
    read = vi.fn(),
    putIfAbsent = vi.fn();
  const runtime = createLogoServices({ connections: { acquire }, storage: { read, putIfAbsent } });
  expect(runtime.configured).toBe(true);
  expect(acquire).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(putIfAbsent).not.toHaveBeenCalled();
  expect(typeof runtime.workspace.restoreLogoStage).toBe("function");
  expect(typeof runtime.deliverables.getLogoDeliverables).toBe("function");
});
it("composes reference and font registration with the same explicit private dependencies", () => {
  expect(createLogoServices(null).inputs.configured).toBe(false);
  const acquire = vi.fn(),
    read = vi.fn(),
    putIfAbsent = vi.fn();
  const runtime = createLogoServices({ connections: { acquire }, storage: { read, putIfAbsent } });
  expect(runtime.inputs.configured).toBe(true);
  expect(typeof runtime.inputs.uploadLogoReference).toBe("function");
  expect(typeof runtime.inputs.cancelLogoInputRequest).toBe("function");
  expect(acquire).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(putIfAbsent).not.toHaveBeenCalled();
});
it("validates actual font and export archive bytes before attempting the injected backend", async () => {
  const { readFreeCatalogFont } = await import("@/features/identity-directions/server/fonts");
  const { zipSync } = await import("fflate");
  const { createHash } = await import("node:crypto");
  const acquire = vi.fn(async () => {
      throw Error("Synthetic connection unavailable");
    }),
    read = vi.fn(),
    putIfAbsent = vi.fn();
  const runtime = createLogoServices({ connections: { acquire }, storage: { read, putIfAbsent } });
  const owner = "d0000000-0000-4000-8000-000000000001",
    project = "d0000000-0000-4000-8000-000000000002",
    key = "d0000000-0000-4000-8000-000000000003";
  const auth = { userId: owner, client: {} } as AuthenticatedContext;
  const font = await readFreeCatalogFont("geist-sans-variable");
  await expect(
    runtime.assets.publishOwnedUpload(
      auth,
      project,
      {
        requestKey: key,
        usage: "font",
        mimeType: font.mimeType,
        contentHash: font.contentHash,
        rightsDeclaration: "Synthetic fixture: licensed OFL font",
      },
      font.bytes,
    ),
  ).rejects.toBeDefined();
  expect(acquire).toHaveBeenCalledTimes(1);
  const bytes = zipSync({ "readme.txt": new TextEncoder().encode("Synthetic export file") }),
    hash = createHash("sha256").update(bytes).digest("hex");
  await expect(
    runtime.assets.stageOwnedAsset(
      auth,
      project,
      {
        requestKey: key,
        source: { kind: "export", sourceId: key },
        inputRevisions: [],
        mimeType: "application/zip",
        contentHash: hash,
        byteLength: bytes.length,
      },
      bytes,
    ),
  ).rejects.toBeDefined();
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(putIfAbsent).not.toHaveBeenCalled();
});

it("isolates optional validator mutations from the reserved immutable publication", async () => {
  const { createHash } = await import("node:crypto");
  type Reservation = import("@/server/data/identity-asset-store").IdentityAssetReservation;
  type AssetWrite = import("@/server/data/identity-asset-store").IdentityAssetWrite;
  const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const assetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const versionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const requestKey = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const bytes = new TextEncoder().encode("{}");
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const rightsDeclaration = "Synthetic local fixture";
  let reservation: Reservation | undefined;
  let preparedWrite: AssetWrite | undefined;
  let stored: { bytes: Uint8Array; mimeType: string } | undefined;
  const connection = {
    async query(sql: string, parameters?: readonly unknown[]) {
      if (sql.includes("session_user::text")) return { rows: [{ role_name: "fixture_only", role_oid: 123 }] };
      if (sql.includes("prepare_logo_asset")) {
        preparedWrite = JSON.parse(String(parameters?.[1])) as AssetWrite;
        if (preparedWrite.kind !== "upload") throw new Error("Expected the original fixture upload");
        reservation = {
          id: requestKey,
          requestKey,
          reference: { ownerId, projectId, assetId, versionId, contentHash: preparedWrite.intent.contentHash },
          storagePath: `${ownerId}/${projectId}/${assetId}/${versionId}`,
          mimeType: preparedWrite.intent.mimeType,
          byteLength: preparedWrite.byteLength,
          purpose: "input_attachment",
          sourceReceiptId: requestKey,
          rightsEvidenceId: null,
          publicationState: "staged",
        };
        return { rows: [{ value: reservation }] };
      }
      if (sql.includes("observe_logo_asset") && reservation) {
        return {
          rows: [
            {
              value: {
                id: reservation.id,
                reference: reservation.reference,
                verification: JSON.parse(String(parameters?.[1])),
                purpose: reservation.purpose,
                sourceReceiptId: reservation.sourceReceiptId,
                rightsEvidenceId: null,
                publicationState: "committed",
              },
            },
          ],
        };
      }
      throw new Error("Unexpected fixture SQL");
    },
    async release() {},
    async discard() {},
  };
  const runtime = createLogoServices({
    connections: {
      async acquire() {
        return { connection, binding: { ownerId, roleName: "fixture_only", roleOid: 123 } };
      },
    },
    storage: {
      async putIfAbsent(_path, submitted, mimeType) {
        stored ??= { bytes: new Uint8Array(submitted), mimeType };
      },
      async read() {
        if (!stored) throw new Error("Fixture object missing");
        return stored;
      },
    },
    async validateBytes(write, inspectedBytes) {
      inspectedBytes.fill(0);
      if (write.kind === "upload")
        write.intent = { ...write.intent, rightsDeclaration: "Changed by optional inspection" };
    },
  });
  const outcome = await runtime.assets
    .publishOwnedUpload(
      { userId: ownerId, client: {} } as AuthenticatedContext,
      projectId,
      {
        requestKey,
        usage: "project_attachment",
        mimeType: "application/json",
        contentHash,
        rightsDeclaration,
      },
      bytes,
    )
    .catch((error) => error);

  expect(stored?.bytes).toEqual(new TextEncoder().encode("{}"));
  expect(preparedWrite).toMatchObject({ kind: "upload", intent: { contentHash, rightsDeclaration } });
  expect(outcome).toMatchObject({ publicationState: "committed", reference: { contentHash } });
  expect(bytes).toEqual(new TextEncoder().encode("{}"));
});
