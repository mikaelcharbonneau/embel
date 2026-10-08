import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogoInputsController, type LogoInputClient } from "@/features/logo-inputs/client/controller";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../../fixtures/logo-creation";
import type { LogoInputRequestState } from "@/features/logo-inputs/model/contracts";
import type { LogoReferenceRegistration } from "@/domain/logo-workspace";
function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  const base = syntheticLogoWorkspace(), workspace = { ...base, capabilities: { ...base.capabilities, upload: { status: "available" as const } } };
  let current = true, lose = false, slow: (() => void) | null = null;
  const requests: Record<string, unknown>[] = [], states = new Map<string, LogoInputRequestState>();
  const file = new File([new Uint8Array([1, 2, 3])], "owned.png", { type: "image/png" });
  const client = {
    listLogoReferences: async () => ({ ownerId: workspace.ownerId, projectId: workspace.projectId, items: [], nextCursor: null }),
    listLogoFonts: async () => [], listCatalogLogoFonts: async () => [],
    listLogoInputRequests: async () => ({ ownerId: workspace.ownerId, projectId: workspace.projectId, items: [...states.values()].filter(state => state.status === "pending"), nextCursor: null }),
    async uploadLogoReference(input: Record<string, unknown>) {
      requests.push(input); if (slow) await new Promise<void>(resolve => { slow = resolve; });
      if (lose) throw Error("Synthetic lost acknowledgement");
      return { referenceId: id(51), asset: { ownerId: workspace.ownerId, projectId: workspace.projectId, assetId: id(52), versionId: id(53), contentHash: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" }, sourceKind: "upload", rightsEvidenceId: id(54), aspects: input.aspects, workspace } as LogoReferenceRegistration;
    },
    readLogoInputRequest: async (key: string) => states.get(key) ?? { status: "not_found" },
  } as unknown as LogoInputClient;
  const controller = createLogoInputsController({ ownerId: workspace.ownerId, projectId: workspace.projectId, client, getWorkspace: () => workspace, isCurrent: () => current, canWrite: () => true, createRequestKey: () => id(70) });
  return { controller, client, file, requests, states, workspace, lose: () => { lose = true; }, restore: () => { lose = false; }, changeOwner: () => { current = false; }, delay: () => { slow = () => {}; }, release: () => slow?.() };
}
afterEach(() => vi.unstubAllGlobals());
describe("owner-fenced input orchestration", () => {
  it("requires explicit permission and aspects before allocating or uploading a reference", async () => {
    const f = fixture();
    await f.controller.uploadReference(f.file, ["shape"], false); await f.controller.uploadReference(f.file, [], true);
    expect(f.requests).toEqual([]);
    await f.controller.uploadReference(f.file, ["shape", "composition"], true);
    expect(f.requests).toHaveLength(1); expect(f.controller.getSnapshot().references).toHaveLength(1);
    expect(f.controller.getSnapshot().message).toContain("Choose its aspects and save references");
  });
  it("double clicks make one request and an owner change hides late results", async () => {
    const f = fixture(); f.delay();
    const first = f.controller.uploadReference(f.file, ["shape"], true);
    const second = f.controller.uploadReference(f.file, ["shape"], true);
    for (let n = 0; n < 20 && !f.requests.length; n++) await new Promise(resolve => setTimeout(resolve, 2));
    expect(f.requests).toHaveLength(1); f.changeOwner(); f.release(); await Promise.all([first, second]);
    expect(f.controller.getSnapshot().references).toEqual([]); expect(f.controller.getSnapshot().pending).toBeNull();
  });
  it("lost acknowledgement keeps the same request and checking never retries it", async () => {
    const f = fixture(); f.lose(); await f.controller.uploadReference(f.file, ["lettering"], true);
    const pending = f.controller.getSnapshot().pending!; expect(pending.input.requestKey).toBe(id(70));
    await f.controller.check(); expect(f.requests).toHaveLength(1); expect(f.controller.getSnapshot().pending).toEqual(pending);
    expect(f.controller.getSnapshot().pendingStatus).toBe("not_found");
    f.restore(); await f.controller.retry(); expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(f.requests[0]);
    expect(f.controller.getSnapshot().pending).toBeNull();
  });
  it("reload discovery requires matching original bytes before an explicit retry", async () => {
    const f = fixture(), request = { kind: "reference_upload" as const, input: { requestKey: id(70), expected: f.workspace.heads, aspects: ["shape" as const], rightsDeclaration: "I have permission to use and process this image." }, file: { contentHash: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", byteLength: 3, mimeType: "image/png" as const } };
    f.states.set(id(70), { status: "pending", ownerId: f.workspace.ownerId, projectId: f.workspace.projectId, requestKey: id(70), request });
    await f.controller.refresh(); expect(f.controller.getSnapshot().unresolved).toHaveLength(1);
    await f.controller.recover(id(70)); await f.controller.retry(); expect(f.requests).toEqual([]);
    await f.controller.attachOriginalFile(new File([new Uint8Array([4, 5, 6])], "other.png", { type: "image/png" })); await f.controller.retry(); expect(f.requests).toEqual([]);
    await f.controller.attachOriginalFile(f.file); await f.controller.retry(); expect(f.requests).toHaveLength(1); expect(f.requests[0]!.requestKey).toBe(id(70));
  });
  it("rejects mismatched recovery receipts and never overwrites the original input", async () => {
    const f = fixture(); f.lose(); await f.controller.uploadReference(f.file, ["shape"], true); const request = f.controller.getSnapshot().pending!;
    if (request.kind !== "reference_upload") throw Error("Expected reference fixture");
    f.states.set(id(70), { status: "pending", ownerId: f.workspace.ownerId, projectId: f.workspace.projectId, requestKey: id(70), request: { ...request, file: { ...request.file, contentHash: "b".repeat(64) } } });
    await f.controller.check(); expect(f.controller.getSnapshot().pending).toEqual(request); expect(f.controller.getSnapshot().error).not.toBeNull(); expect(f.requests).toHaveLength(1);
  });
  it("closes an invalid absent request only through exact server cancellation evidence", async () => {
    const f = fixture(); f.lose(); await f.controller.uploadReference(f.file, ["shape"], true);
    const request = f.controller.getSnapshot().pending!;
    f.client.cancelLogoInputRequest = async input => ({ status: "rejected", reason: "cancelled_by_user", ownerId: f.workspace.ownerId, projectId: f.workspace.projectId, requestKey: input.input.requestKey, request: input });
    await f.controller.cancel(); expect(f.controller.getSnapshot().pendingStatus).toBe("rejected");
    expect(f.controller.getSnapshot().pending).toEqual(request); f.controller.dismissRejected(); expect(f.controller.getSnapshot().pending).toBeNull(); expect(f.requests).toHaveLength(1);
  });
  it("an uncertain or mismatched cancellation never discards the original input", async () => {
    const f = fixture(); f.lose(); await f.controller.uploadReference(f.file, ["shape"], true); const request = f.controller.getSnapshot().pending!;
    f.client.cancelLogoInputRequest = async () => { throw Error("Cancel response lost"); };
    await f.controller.cancel(); expect(f.controller.getSnapshot().pending).toEqual(request); expect(f.controller.getSnapshot().pendingStatus).toBe("uncertain");
    f.client.cancelLogoInputRequest = async input => { if (input.kind !== "reference_upload") throw Error("Expected reference fixture"); return { status: "rejected", reason: "cancelled_by_user", ownerId: f.workspace.ownerId, projectId: f.workspace.projectId, requestKey: input.input.requestKey, request: { ...input, input: { ...input.input, requestKey: id(999) } } }; };
    await f.controller.cancel(); expect(f.controller.getSnapshot().pending).toEqual(request); expect(f.controller.getSnapshot().pendingStatus).toBe("uncertain");
  });
  it("rejects unrepresentable and oversized metadata before retaining a request", async () => {
    const f = fixture(), file = new File([new Uint8Array(12)], "font.ttf", { type: "font/ttf" });
    for (const license of ["Terms\u0000", "\u0001".repeat(262000)]) { await f.controller.uploadFont(file, license, null, true); expect(f.controller.getSnapshot().pending).toBeNull(); }
    expect(f.requests).toEqual([]);
  });
  it("a proved head rejection can be cleared explicitly without changing old inputs", async () => {
    const f = fixture(); f.lose(); await f.controller.uploadReference(f.file, ["shape"], true); const request = f.controller.getSnapshot().pending!;
    f.states.set(id(70), { status: "rejected", reason: "inputs_changed", ownerId: f.workspace.ownerId, projectId: f.workspace.projectId, requestKey: id(70), request });
    await f.controller.check(); await f.controller.retry(); expect(f.requests).toHaveLength(1);
    f.controller.dismissRejected(); expect(f.controller.getSnapshot().pending).toBeNull(); expect(f.states.get(id(70))).toMatchObject({ status: "rejected" });
  });
});
