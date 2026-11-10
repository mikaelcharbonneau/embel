import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createAccountIdentityClient } from "@/components/identity/account-identity-client";
import { createIdentityDraftMemory } from "@/components/identity/identity-draft-memory";
import { fixtureInput, fixtureId, fixtureOwner, fixtureProject } from "./project-identity-fixtures";
import { batchState, generationIntent, ownerId, projectId } from "../fixtures/identity-generation";
function setup() {
  let current = true;
  const expire = vi.fn(),
    account = { status: "ready" as const, userId: ownerId, generation: 1 };
  const fetcher = vi.fn().mockResolvedValue(Response.json(batchState()));
  vi.stubGlobal("fetch", fetcher);
  const client = createAccountIdentityClient(account, projectId, () => current, expire);
  return {
    client,
    fetcher,
    expire,
    changeOwner() {
      current = false;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("Identity generation owned bounded transport", () => {
  it("uses only same-origin private requests, preserves the exact uncapped request and verifies its receipt", async () => {
    const f = setup();
    expect(await f.client.generate(generationIntent)).toMatchObject({ intent: generationIntent });
    const [path, init] = f.fetcher.mock.calls[0]!;
    expect(path).toBe(`/api/projects/${projectId}/identity/batches`);
    expect(init).toMatchObject({
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    expect(JSON.parse(init.body)).toEqual(generationIntent);
    expect(JSON.parse(init.body)).not.toHaveProperty("acceptedMaxCostMicrousd");
    f.client.dispose();
  });
  it("does not accept another owner's batch or a contradictory immutable input", async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      Response.json(
        JSON.parse(JSON.stringify(batchState()).replaceAll(ownerId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")),
      ),
    );
    expect(await f.client.generate(generationIntent)).toBeNull();
    expect(f.client.current()).toBe(false);
    expect(f.expire).toHaveBeenCalledOnce();
    const g = setup();
    g.fetcher.mockResolvedValueOnce(
      Response.json({ ...batchState(), intent: { ...generationIntent, acceptedPolicyIdentity: "b".repeat(64) } }),
    );
    await expect(g.client.generate(generationIntent)).rejects.toMatchObject({ status: 502 });
    g.client.dispose();
  });
  it("never turns a late response from an old account into visible results", async () => {
    const f = setup();
    let release!: (value: Response) => void;
    f.fetcher.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const response = f.client.batch(batchState().batchId);
    f.changeOwner();
    release(Response.json(batchState()));
    expect(await response).toBeNull();
    f.client.dispose();
  });
  it("does not admit on lookup and rejects mismatched original-key recovery", async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(Response.json({ status: "not_found" }));
    expect(await f.client.batchRequest(generationIntent.idempotencyKey)).toEqual({ status: "not_found" });
    expect(f.fetcher.mock.calls[0]![1]).toMatchObject({ method: "GET" });
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        status: "found",
        batch: { ...batchState(), intent: { ...generationIntent, idempotencyKey: "other-original-request" } },
      }),
    );
    await expect(f.client.batchRequest(generationIntent.idempotencyKey)).rejects.toMatchObject({ status: 502 });
    f.client.dispose();
  });
  it("expires a provider-rejected session and bounds response parsing", async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect(await f.client.batch(batchState().batchId)).toBeNull();
    expect(f.expire).toHaveBeenCalledOnce();
    const g = setup();
    g.fetcher.mockResolvedValueOnce(
      new Response("{}", {
        headers: { "Content-Type": "application/json", "Content-Length": String(17 * 1024 * 1024) },
      }),
    );
    await expect(g.client.batch(batchState().batchId)).rejects.toMatchObject({ status: 502 });
    g.client.dispose();
  });
  it("closes only the immutable original generation intent and rejects a contradictory not-admitted witness", async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      Response.json({ status: "not_admitted", ownerId, projectId, intent: generationIntent }),
    );
    expect(await f.client.closeBatchRequest(generationIntent)).toMatchObject({ status: "not_admitted" });
    const [path, init] = f.fetcher.mock.calls[0]!;
    expect(path).toBe(`/api/projects/${projectId}/identity/batches/requests/${generationIntent.idempotencyKey}/cancel`);
    expect(JSON.parse(init.body)).toEqual(generationIntent);
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        status: "not_admitted",
        ownerId,
        projectId,
        intent: { ...generationIntent, expectedProjectRevision: 2 },
      }),
    );
    await expect(f.client.closeBatchRequest(generationIntent)).rejects.toMatchObject({ status: 502 });
    f.client.dispose();
  });
});
describe("Identity pending raster retention", () => {
  const reference = fixtureInput().referenceSnapshot.selected[0]!.reference;
  function original() {
    return {
      ownerId: fixtureOwner,
      projectId: fixtureProject,
      file: new File([new Uint8Array([1, 2, 3])], "synthetic.png", { type: "image/png" }),
      input: {
        upload: {
          requestKey: fixtureId(90),
          expected: {
            projectRevision: 1,
            referenceRevision: 1,
            preferencesRevision: 0,
            workspaceRevision: 0,
            stageRevisions: {
              brief_references: 0,
              concepts: 0,
              vector: 0,
              refinements: 0,
              directions: 0,
              deliverables: 0,
            },
          },
          aspects: ["overall_feel" as const],
          rightsDeclaration: reference.attribution.rightsNote!,
        },
        metadata: {
          attribution: reference.attribution,
          relevantElements: reference.relevantElements,
          tags: reference.tags,
        },
      },
    };
  }
  it("retains exact File and metadata through rechecks, fences owner/project and refuses to overwrite pending evidence", () => {
    const memory = createIdentityDraftMemory(),
      value = original();
    expect(memory.retainReferenceUpload(value)).toBe(true);
    expect(memory.hasUnsaved()).toBe(true);
    expect(memory.referenceUpload(fixtureOwner, fixtureProject)?.file).toBe(value.file);
    expect(memory.referenceUpload(fixtureId(99), fixtureProject)).toBeNull();
    expect(
      memory.retainReferenceUpload({
        ...value,
        input: {
          ...value.input,
          metadata: {
            ...value.input.metadata,
            attribution: { ...value.input.metadata.attribution, label: "Replacement" },
          },
        },
      }),
    ).toBe(false);
    memory.resolveReferenceUpload(fixtureOwner, fixtureProject, fixtureId(91));
    expect(memory.hasUnsaved()).toBe(true);
    memory.resolveReferenceUpload(fixtureOwner, fixtureProject, value.input.upload.requestKey);
    expect(memory.hasUnsaved()).toBe(false);
  });
  it("rejects unsupported/oversized Files and clears pending private data with the owning account", () => {
    const memory = createIdentityDraftMemory(),
      value = original();
    expect(
      memory.retainReferenceUpload({ ...value, file: new File(["svg"], "x.svg", { type: "image/svg+xml" }) }),
    ).toBe(false);
    expect(
      memory.retainReferenceUpload({
        ...value,
        file: new File([new Uint8Array(33_554_433)], "large.png", { type: "image/png" }),
      }),
    ).toBe(false);
    expect(memory.retainReferenceUpload(value)).toBe(true);
    memory.clear();
    expect(memory.referenceUpload(fixtureOwner, fixtureProject)).toBeNull();
    expect(memory.hasUnsaved()).toBe(false);
  });
  it("cancels with the exact original bytes/heads/key on the existing server-tombstone route", async () => {
    const f = setup(),
      value = original();
    f.fetcher.mockImplementation(async (_path: string, options: RequestInit) =>
      Response.json({
        status: "rejected",
        reason: "cancelled_by_user",
        ownerId,
        projectId,
        requestKey: value.input.upload.requestKey,
        request: JSON.parse(String(options.body)),
      }),
    );
    expect(await f.client.cancelReferenceUpload(value.input, value.file)).toMatchObject({
      status: "rejected",
      reason: "cancelled_by_user",
    });
    const [path, options] = f.fetcher.mock.calls[0]!;
    expect(path).toBe(`/api/projects/${projectId}/logo/inputs/requests/${value.input.upload.requestKey}/cancel`);
    expect(JSON.parse(options.body)).toEqual({
      kind: "reference_upload",
      input: value.input.upload,
      file: {
        contentHash: createHash("sha256")
          .update(new Uint8Array([1, 2, 3]))
          .digest("hex"),
        byteLength: 3,
        mimeType: "image/png",
      },
    });
    f.client.dispose();
  });
  it("does not treat not-found or altered upload bytes as cancellation proof", async () => {
    const f = setup(),
      value = original();
    f.fetcher.mockResolvedValueOnce(Response.json({ status: "not_found" }));
    await expect(f.client.cancelReferenceUpload(value.input, value.file)).rejects.toMatchObject({ status: 502 });
    f.client.dispose();
  });
});
