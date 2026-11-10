import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asRole, createTestDatabase, OWNER_A, resetFixture, seedProject, type TestDatabase } from "./local-supabase";
vi.mock("server-only", () => ({}));
import {
  createIdentityAssetStore,
  type IdentityAssetReservation,
  type IdentityAssetBackend,
} from "@/server/data/identity-asset-store";
import {
  createHomeAttachmentService,
  type HomeAttachmentReservation,
  type HomeAttachmentBackend,
} from "@/server/home-attachments";
import { PROPOSED_HOME_ATTACHMENT_POLICY } from "@/domain/attachments";
import type { AuthenticatedContext } from "@/server/auth/context";

let png: Uint8Array;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const auth = { userId: OWNER_A } as AuthenticatedContext;
type Stored = { bytes: Uint8Array; mimeType: string };
type Damage = "none" | "wrong-length" | "wrong-hash" | "wrong-mime";
const damageBytes = (row: Stored, damage: Damage): Stored => {
  if (damage === "wrong-length") return { ...row, bytes: row.bytes.slice(1) };
  if (damage === "wrong-hash") {
    const bytes = row.bytes.slice();
    bytes[bytes.length - 1]! ^= 1;
    return { ...row, bytes };
  }
  if (damage === "wrong-mime") return { ...row, mimeType: "application/octet-stream" };
  return { ...row, bytes: row.bytes.slice() };
};

describe("real byte-verification gates over disposable Storage RLS transport", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    png = new Uint8Array(
      await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
        .png()
        .toBuffer(),
    );
  }, 60_000);
  beforeEach(async () => {
    await resetFixture(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  /** Provider HTTP/bytes are synthetic; every create/read authorization below
   * executes real PostgreSQL RLS as authenticated, never a privileged bypass.
   * Metadata backend responses below are fixtures, not hosted SQL observations.
   */
  function storage(damage: Damage) {
    const objects = new Map<string, Stored>();
    let inserts = 0,
      reads = 0;
    async function run<T>(op: string, fn: () => Promise<T>) {
      await db.query("select set_config('storage.operation',$1,false)", [op]);
      try {
        return await asRole(db, "authenticated", OWNER_A, fn);
      } finally {
        await db.query("select set_config('storage.operation','',false)");
      }
    }
    return {
      objects,
      counts: () => ({ inserts, reads }),
      async putIfAbsent(path: string, bytes: Uint8Array, mimeType: string) {
        inserts++;
        try {
          await run("storage.object.upload", () =>
            db.query("insert into storage.objects(bucket_id,name,owner_id) values('fluid-assets',$1,$2)", [
              path,
              OWNER_A,
            ]),
          );
          objects.set(path, { bytes: bytes.slice(), mimeType });
        } catch (error) {
          if ((error as { code?: string }).code !== "23505") throw error;
        }
      },
      async read(path: string) {
        reads++;
        const visible = await run("storage.object.get_authenticated", () =>
          db.query("select name from storage.objects where bucket_id='fluid-assets' and name=$1", [path]),
        );
        if (visible.rows.length !== 1 || !objects.has(path)) throw new Error("Storage object is unavailable");
        return damageBytes(objects.get(path)!, damage);
      },
    };
  }

  it.each(["none", "wrong-length", "wrong-hash", "wrong-mime"] as const)(
    "logo upload read-back: %s cannot mint a false receipt",
    async (damage) => {
      const project = (await seedProject(db)).id,
        key = randomUUID(),
        id = randomUUID(),
        assetId = randomUUID(),
        versionId = randomUUID(),
        sourceReceiptId = randomUUID();
      const intent = {
        requestKey: key,
        usage: "logo_reference" as const,
        contentHash: hash(png),
        mimeType: "image/png",
        rightsDeclaration: "Owned fixture",
      };
      await db.query(
        `insert into public.logo_asset_publications(id,owner_id,project_id,request_key,request,asset_id,version_id,content_hash,mime_type,byte_length,purpose,source_receipt_id,source_kind,input_revision,input_hash)
      values($1,$2,$3,$4,$5,$6,$7,$8,'image/png',$9,'reference_media',$10,'logo_reference',1,$8)`,
        [
          id,
          OWNER_A,
          project,
          key,
          { kind: "upload", intent, byteLength: png.length },
          assetId,
          versionId,
          hash(png),
          png.length,
          sourceReceiptId,
        ],
      );
      await db.query(
        "insert into public.logo_input_requests(owner_id,project_id,request_key,request) values($1,$2,$3,$4)",
        [
          OWNER_A,
          project,
          key,
          {
            kind: "reference_upload",
            input: { requestKey: key },
            file: { contentHash: hash(png), mimeType: "image/png", byteLength: png.length },
          },
        ],
      );
      const row = (
        await db.query<{ value: IdentityAssetReservation }>(
          "select fluid_private.logo_asset_reservation(p) value from public.logo_asset_publications p where id=$1",
          [id],
        )
      ).rows[0]!.value;
      let observations = 0;
      const backend: IdentityAssetBackend = {
        async prepare() {
          return row;
        },
        async resolve() {
          return row;
        },
        async observe(_access, observedId, verification) {
          observations++;
          expect(observedId).toBe(id);
          return {
            id,
            reference: row.reference,
            purpose: row.purpose,
            sourceReceiptId,
            rightsEvidenceId: null,
            publicationState: "committed",
            verification,
          };
        },
      };
      const transport = storage(damage),
        service = createIdentityAssetStore({ backend, storage: transport });
      const result = service.publishOwnedUpload(auth, project, intent, png);
      if (damage === "none") {
        await expect(result).resolves.toMatchObject({ id, publicationState: "committed" });
        expect(observations).toBe(1);
      } else {
        await expect(result).rejects.toMatchObject({ name: "IdentityAssetUncertainPublicationError" });
        expect(observations).toBe(0);
      }
      expect(transport.counts()).toEqual({ inserts: 1, reads: 1 });
      expect((await db.query("select count(*)::int n from public.asset_versions")).rows).toEqual([{ n: 0 }]);
      expect((await db.query("select state from public.logo_asset_publications")).rows).toEqual([
        { state: "reserved" },
      ]);
    },
  );

  it.each(["none", "wrong-length", "wrong-hash", "wrong-mime"] as const)(
    "Home read-back and lost-response replay: %s",
    async (damage) => {
      const bytes = new TextEncoder().encode("brief"),
        id = randomUUID(),
        version = randomUUID(),
        key = randomUUID();
      const input = { requestKey: key, name: "brief.txt", mimeType: "text/plain" as const, contentHash: hash(bytes) };
      await db.query(
        `insert into public.home_attachments(id,owner_id,request_key,input,blob_version_id,name,mime_type,content_hash,byte_length)
      values($1,$2,$3,$4,$5,'brief.txt','text/plain',$6,$7)`,
        [id, OWNER_A, key, input, version, hash(bytes), bytes.length],
      );
      const reservation = async () =>
        (
          await db.query<{ value: HomeAttachmentReservation }>(
            "select fluid_private.home_attachment_reservation(h) value from public.home_attachments h where id=$1",
            [id],
          )
        ).rows[0]!.value;
      let observations = 0;
      const backend: HomeAttachmentBackend = {
        prepare: reservation,
        lookup: reservation,
        async resolve() {
          return [await reservation()];
        },
        async observe(_auth, observedId, observed) {
          observations++;
          expect(observedId).toBe(id);
          expect(observed).toEqual({ contentHash: hash(bytes), mimeType: "text/plain", byteLength: bytes.length });
          await db.query("update public.home_attachments set verified=true where id=$1", [id]);
          return (await reservation()).ref;
        },
        async lookupProject() {
          return { status: "not_found" };
        },
        async save() {
          throw new Error("Outside this read-back fixture");
        },
      };
      const transport = storage(damage),
        service = createHomeAttachmentService({ backend, storage: transport, policy: PROPOSED_HOME_ATTACHMENT_POLICY });
      const result = service.stageHomeAttachment(auth, input, bytes);
      if (damage === "none") {
        const ref = await result;
        expect(ref.id).toBe(id);
        expect((await reservation()).verified).toBe(true);
        const replay = await service.stageHomeAttachment(auth, input, bytes);
        expect(replay).toEqual(ref);
        expect(transport.counts()).toEqual({ inserts: 2, reads: 2 });
        expect(transport.objects.size).toBe(1);
        expect(transport.objects.values().next().value!.bytes).toEqual(bytes);
        expect(observations).toBe(2);
      } else {
        await expect(result).rejects.toMatchObject({ name: "HomeAttachmentUncertainError" });
        expect(observations).toBe(0);
        expect((await reservation()).verified).toBe(false);
        expect(transport.counts()).toEqual({ inserts: 1, reads: 1 });
      }
      expect(service.getHomeAttachmentCapability()).toMatchObject({
        maxFiles: 5,
        maxFileBytes: 10_485_760,
        maxTotalBytes: 26_214_400,
      });
      expect(service.getHomeAttachmentCapability()!.allowedMimeTypes).not.toContain("application/pdf");
    },
  );
});
