import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), resolve: vi.fn(), upload: vi.fn(), read: vi.fn() }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: mocks.auth }));
vi.mock("@/server/runtime/logo-request-services", () => ({ resolveLogoRequestServices: mocks.resolve }));
import { POST } from "@/app/api/projects/[projectId]/identity/references/uploads/route";
import { GET } from "@/app/api/projects/[projectId]/identity/references/uploads/[requestKey]/route";
import { identityReferenceUploadRecord } from "@/server/data/identity-reference-uploads";
import {
  fixtureInput,
  fixtureId,
  fixtureOwner as ownerId,
  fixtureProject as projectId,
} from "../client/project-identity-fixtures";
import { logoInputRequestSchema } from "@/features/logo-inputs/model/contracts";
import { ApiError } from "@/server/http/errors";
const key = fixtureId(90),
  context = { params: Promise.resolve({ projectId, requestKey: key }) };
const reference = fixtureInput().referenceSnapshot.selected[0]!.reference;
const entry = {
  reference,
  reaction: {
    referenceId: reference.id,
    ownerId,
    projectId,
    revision: 0,
    ensemble: false,
    elements: [],
    updatedAt: null,
  },
};
const metadata = {
  attribution: reference.attribution,
  relevantElements: reference.relevantElements,
  tags: reference.tags,
};
const input = {
  upload: {
    requestKey: key,
    expected: {
      projectRevision: 1,
      referenceRevision: 1,
      preferencesRevision: 0,
      workspaceRevision: 0,
      stageRevisions: { brief_references: 0, concepts: 0, refinements: 0, vector: 0, directions: 0, deliverables: 0 },
    },
    aspects: ["overall_feel"],
    rightsDeclaration: metadata.attribution.rightsNote,
  },
  metadata,
};
function request(body: unknown = input) {
  return new Request(`https://fixture.test/api/projects/${projectId}/identity/references/uploads`, {
    method: "POST",
    headers: { origin: "https://fixture.test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function read() {
  return new Request(`https://fixture.test/api/projects/${projectId}/identity/references/uploads/${key}`);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ORIGIN", "https://fixture.test");
  mocks.auth.mockResolvedValue({ userId: ownerId, client: { rpc: mocks.rpc } });
  mocks.resolve.mockResolvedValue({ inputs: { uploadLogoReference: mocks.upload, readLogoInputRequest: mocks.read } });
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) =>
    name === "prepare_shared_identity_reference_upload"
      ? { data: { status: "pending", ownerId, projectId, requestKey: key, request: args.p_request }, error: null }
      : { data: entry, error: null },
  );
  mocks.read.mockResolvedValue({ status: "not_found" });
});
afterEach(() => vi.unstubAllEnvs());
describe("Owned Identity reference bridge", () => {
  it("registers only the original committed upload key and attribution, without privileged upload or selection", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(entry);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("register_shared_identity_reference", {
      p_project_id: projectId,
      p_upload_request_key: key,
      p_metadata: metadata,
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("passes actual multipart bytes through the existing qualified raster publisher before registration", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]),
      body = new FormData();
    body.set("input", JSON.stringify(input));
    body.set("file", new File([bytes], "reference.png", { type: "image/png" }));
    const req = new Request(read().url, { method: "POST", headers: { origin: "https://fixture.test" }, body });
    expect((await POST(req, context)).status).toBe(201);
    expect(mocks.upload).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: ownerId }),
      projectId,
      input.upload,
      bytes,
      "image/png",
      expect.any(AbortSignal),
    );
    expect(mocks.rpc.mock.calls[0]).toEqual([
      "prepare_shared_identity_reference_upload",
      {
        p_project_id: projectId,
        p_request: {
          kind: "reference_upload",
          input: input.upload,
          file: {
            contentHash: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
            byteLength: 4,
            mimeType: "image/png",
          },
        },
      },
    ]);
    expect(mocks.rpc.mock.invocationCallOrder[0]!).toBeLessThan(mocks.upload.mock.invocationCallOrder[0]!);
    expect(mocks.upload.mock.invocationCallOrder[0]!).toBeLessThan(mocks.rpc.mock.invocationCallOrder[1]!);
  });
  it("never registers when verified upload publication fails", async () => {
    mocks.upload.mockRejectedValue(new ApiError("integration_unavailable"));
    const body = new FormData();
    body.set("input", JSON.stringify(input));
    body.set("file", new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
    expect(
      (
        await POST(
          new Request(read().url, { method: "POST", headers: { origin: "https://fixture.test" }, body }),
          context,
        )
      ).status,
    ).toBe(503);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.mock.calls[0]![0]).toBe("prepare_shared_identity_reference_upload");
  });
  it("rejects contradictory prepared intent before any privileged byte publication", async () => {
    mocks.rpc.mockImplementationOnce(async (_name: string, args: Record<string, unknown>) => {
      const original = logoInputRequestSchema.parse(args.p_request);
      return {
        data: {
          status: "pending",
          ownerId,
          projectId,
          requestKey: key,
          request: { ...original, input: { ...input.upload, rightsDeclaration: "Contradictory declaration" } },
        },
        error: null,
      };
    });
    const body = new FormData();
    body.set("input", JSON.stringify(input));
    body.set("file", new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
    expect(
      (
        await POST(
          new Request(read().url, { method: "POST", headers: { origin: "https://fixture.test" }, body }),
          context,
        )
      ).status,
    ).toBe(503);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("Check is strictly read-only and returns the immutable registered reference", async () => {
    expect(await (await GET(read(), context)).json()).toEqual({ status: "registered", entry });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("read_shared_identity_reference_upload", {
      p_project_id: projectId,
      p_upload_request_key: key,
    });
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("distinguishes an unregistered file from a registered reference without writing on Check", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect(await (await GET(read(), context)).json()).toEqual({ status: "upload", upload: { status: "not_found" } });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: ownerId }),
      projectId,
      key,
      expect.any(AbortSignal),
    );
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, ownerId: fixtureId(99) },
    { ...input, metadata: { ...metadata, asset: reference.media } },
    { ...input, metadata: { ...metadata, attribution: { ...metadata.attribution, rightsNote: "Invented license" } } },
  ])("rejects caller authority and altered permission declarations", async (value) => {
    expect((await POST(request(value), context)).status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects foreign or contradictory SQL receipts and sanitizes unknown errors", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ...entry,
        reference: { ...reference, attribution: { ...reference.attribution, label: "Changed by response" } },
      },
      error: null,
    });
    expect((await POST(request(), context)).status).toBe(503);
    mocks.rpc.mockResolvedValueOnce({
      data: { ...entry, reference: { ...reference, ownerId: fixtureId(99) } },
      error: null,
    });
    await expect(identityReferenceUploadRecord(await mocks.auth(), projectId, key)).rejects.toMatchObject({
      code: "integration_unavailable",
    });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "secret database error" } });
    const response = await POST(request(), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret database");
  });
  it("requires session, canonical resource IDs, same-origin mutation and no extra query authority", async () => {
    mocks.auth.mockRejectedValueOnce(new ApiError("unauthenticated"));
    expect((await GET(read(), context)).status).toBe(401);
    const badOrigin = new Request(read().url, {
      method: "POST",
      headers: { origin: "https://foreign.test", "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect((await POST(badOrigin, context)).status).toBe(403);
    expect((await GET(new Request(`${read().url}?owner=${ownerId}`), context)).status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
