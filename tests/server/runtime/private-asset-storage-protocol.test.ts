import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  createSupabasePrivateAssetStorage,
  type SupabasePrivateAssetTransport,
} from "@/server/runtime/private-asset-storage";
import { createHomeAttachmentService, type HomeAttachmentBackend } from "@/server/home-attachments";
import type { AuthenticatedContext } from "@/server/auth/context";
import { PROPOSED_HOME_ATTACHMENT_POLICY, type OwnedAttachmentRef } from "@/domain/attachments";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const blobVersionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  requestKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const path = `${ownerId}/home/${id}/${blobVersionId}`;
const bytes = new TextEncoder().encode("The exact private brief retained for reconciliation.\n");
function storage(transport: SupabasePrivateAssetTransport) {
  return createSupabasePrivateAssetStorage({
    transport,
    scope: { kind: "home", ownerId },
    maxFileBytes: 4096,
    deadlineMs: 1000,
  });
}
function duplicate(statusCode: unknown, code: unknown = "KeyAlreadyExists") {
  return Response.json(
    { statusCode, error: "Duplicate", code, message: "The resource already exists" },
    { status: 400, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}
describe("observed Supabase Storage response compatibility", () => {
  it.each(["text/plain; charset=UTF-8", 'Text/Plain; charset="utf-8"', "text/plain; description=brief; charset=UTF-8"])(
    "preserves bytes and returns the media-type essence: %s",
    async (contentType) => {
      const adapter = storage(
        async () =>
          new Response(bytes, { headers: { "content-type": contentType, "content-length": String(bytes.length) } }),
      );
      expect(await adapter.read(path)).toEqual({ bytes, mimeType: "text/plain" });
    },
  );
  it.each([
    "text/plain; charset",
    'text/plain; charset="unterminated',
    "text/plain; charset=UTF-8; CHARSET=US-ASCII",
    "text/plain, image/png",
    "text/plain; x=a b",
    `text/plain; x=${"a".repeat(513)}`,
  ])("rejects malformed, ambiguous or oversized media-type metadata: %s", async (contentType) => {
    const adapter = storage(async () => new Response(bytes, { headers: { "content-type": contentType } }));
    await expect(adapter.read(path)).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it.each(["409", 409])(
    "accepts only a bounded existing-key conflict wrapper for outer readback: %s",
    async (statusCode) => {
      const adapter = storage(async () => duplicate(statusCode));
      await expect(adapter.putIfAbsent(path, bytes, "text/plain")).resolves.toBeUndefined();
    },
  );
  it.each([
    { statusCode: "400", code: "KeyAlreadyExists" },
    { statusCode: undefined, code: "KeyAlreadyExists" },
    { statusCode: "409 ", code: "KeyAlreadyExists" },
    { statusCode: [409], code: "KeyAlreadyExists" },
    { statusCode: "409", code: "InvalidRequest" },
    { statusCode: "409", code: ["KeyAlreadyExists"] },
  ])("rejects generic 400 or malformed conflict data: %j", async ({ statusCode, code }) => {
    await expect(
      storage(async () => duplicate(statusCode, code)).putIfAbsent(path, bytes, "text/plain"),
    ).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it.each([
    new Response("{broken", { status: 400, headers: { "content-type": "application/json" } }),
    new Response(JSON.stringify({ statusCode: "409", code: "KeyAlreadyExists" }), {
      status: 400,
      headers: { "content-type": "text/html" },
    }),
    Response.json({ statusCode: "400", code: "KeyAlreadyExists" }, { status: 409 }),
  ])("rejects malformed acknowledgements and contradictory response metadata", async (response) => {
    await expect(storage(async () => response).putIfAbsent(path, bytes, "text/plain")).rejects.toMatchObject({
      code: "integration_unavailable",
    });
  });
  it("continues to bound legacy 400 conflict bodies", async () => {
    await expect(
      storage(
        async () => new Response("x".repeat(16_385), { status: 400, headers: { "content-type": "application/json" } }),
      ).putIfAbsent(path, bytes, "text/plain"),
    ).rejects.toMatchObject({ code: "integration_unavailable" });
  });
});

describe("exact-request Home reconciliation still requires verified immutable bytes", () => {
  function fixture(contentType = "text/plain; charset=UTF-8", stored = bytes) {
    const ref: OwnedAttachmentRef = {
      id,
      ownerId,
      projectId: null,
      projectRevision: null,
      blobVersionId,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      mimeType: "text/plain",
      byteLength: bytes.length,
      name: "brief.txt",
      sourceReceiptId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      state: "staged",
    };
    const reservation = { requestKey, storagePath: path, ref, verified: false };
    const observe = vi.fn(async () => ref),
      methods: string[] = [];
    const backend: HomeAttachmentBackend = {
      prepare: async () => reservation,
      lookup: async () => reservation,
      observe,
      resolve: async () => [reservation],
      save: async () => {
        throw Error("No project should be created while staging");
      },
      lookupProject: async () => ({ status: "not_found" }),
    };
    const adapter = storage(async (_url, init) => {
      methods.push(init.method!);
      expect(init.redirect).toBe("error");
      if (init.method === "POST") {
        expect(new Headers(init.headers).get("x-upsert")).toBe("false");
        return duplicate("409");
      }
      return new Response(stored, {
        headers: { "content-type": contentType, "content-length": String(stored.length) },
      });
    });
    return {
      service: createHomeAttachmentService({ backend, storage: adapter, policy: PROPOSED_HOME_ATTACHMENT_POLICY }),
      observe,
      ref,
      methods,
    };
  }
  it("recovers the original reserved key through create-only conflict and MIME-parameter readback", async () => {
    const f = fixture();
    expect(
      await f.service.stageHomeAttachment(
        { userId: ownerId } as AuthenticatedContext,
        { requestKey, name: f.ref.name, mimeType: "text/plain", contentHash: f.ref.contentHash },
        bytes,
      ),
    ).toEqual(f.ref);
    expect(f.methods).toEqual(["POST", "GET"]);
    expect(f.observe).toHaveBeenCalledOnce();
  });
  it.each(["application/json; charset=UTF-8", "image/png; charset=UTF-8"])(
    "cannot certify a conflicting stored MIME essence: %s",
    async (contentType) => {
      const f = fixture(contentType);
      await expect(
        f.service.stageHomeAttachment(
          { userId: ownerId } as AuthenticatedContext,
          { requestKey, name: f.ref.name, mimeType: "text/plain", contentHash: f.ref.contentHash },
          bytes,
        ),
      ).rejects.toMatchObject({ name: "HomeAttachmentUncertainError" });
      expect(f.observe).not.toHaveBeenCalled();
    },
  );
  it("cannot certify corrupt bytes after an accepted duplicate wrapper", async () => {
    const corrupted = new Uint8Array(bytes);
    corrupted[0] = corrupted[0]! ^ 1;
    const f = fixture("text/plain; charset=UTF-8", corrupted);
    await expect(
      f.service.stageHomeAttachment(
        { userId: ownerId } as AuthenticatedContext,
        { requestKey, name: f.ref.name, mimeType: "text/plain", contentHash: f.ref.contentHash },
        bytes,
      ),
    ).rejects.toMatchObject({ name: "HomeAttachmentUncertainError" });
    expect(f.observe).not.toHaveBeenCalled();
  });
});
