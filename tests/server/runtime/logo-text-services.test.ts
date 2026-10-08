import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createLogoServices } from "@/server/runtime/logo-services";
import type { AuthenticatedContext } from "@/server/auth/context";
import type { IdentityAssetReservation, IdentityAssetWrite } from "@/server/data/identity-asset-store";
import type { IdentityTransactionConnection } from "@/server/data/identity-transaction";
import type { IdentityAssetPublication, VerifiedFileObservation } from "@/domain/logo-deliverables";
import type { LogoVectorDocument } from "@/domain/logo-vector";
import type { AssetVersionReference } from "@/domain/asset-library";
import { logoMutationReceiptSchema, type LogoManualCommand, type LogoStageRevision } from "@/domain/logo-workspace";
import { canonicalLogoDocumentBytes, verifyLogoVectorRevision } from "@/features/logo-vector/server/revisions";
import { serializeLogoSvg } from "@/features/logo-vector/model/svg";
import { textEditFixture } from "../../features/logo-vector/text-edit-fixtures";
import { syntheticLogoBatch, syntheticLogoWorkspace } from "../../fixtures/logo-creation";

const time = "2026-10-07T00:00:00Z";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pathFor = (ref: AssetVersionReference) => `${ref.ownerId}/${ref.projectId}/${ref.assetId}/${ref.versionId}`;
type RpcResponse = { data: unknown; error: { code: string; message: string } | null };
type RpcBuilder = PromiseLike<RpcResponse> & { abortSignal(signal: AbortSignal): RpcBuilder };

/** Original local records and real pinned OFL bytes. Only external account RPC,
 * SQL and private object storage are synthetic; all composed services are real. */
async function fixture(editable = false, sourceKind: "refinement" | "concept" = "refinement") {
  const source = await textEditFixture(editable), { projectId } = source, ownerId = source.revision.ownerId;
  const scope = { ownerId, projectId };
  const workspace = { ...structuredClone(syntheticLogoWorkspace()), ...scope };
  workspace.heads.workspaceRevision = workspace.heads.stageRevisions.brief_references = 1;
  workspace.stages.brief_references = { stage: "brief_references", id: source.brief.id, revision: 1 };
  const batch = structuredClone(syntheticLogoBatch(Array(6).fill("queued")));
  Object.assign(batch, scope, { briefRevisionId: source.brief.id, referenceSnapshotId: source.brief.payload.referenceSnapshotId });
  if (sourceKind === "concept") {
    const slot = batch.slots[4]!, attempt = slot.attempts[0]!;
    Object.assign(attempt, { preview: source.refinement.preview, providerResponseReceiptId: randomUUID(), state: "succeeded", billing: { status: "recorded", confirmedMicrousd: 0 } });
    slot.acceptedPreview = source.refinement.preview;
    source.revision.source = { kind: "concept", batchId: batch.id, slotId: slot.id, attemptId: attempt.id };
  }
  const command: Extract<LogoManualCommand, { method: "saveLogoEdit" }> = { method: "saveLogoEdit", body: {
    requestKey: randomUUID(), expected: structuredClone(workspace.heads), baseVectorRevisionId: source.revision.id,
    edit: editable ? { kind: "spacing", componentId: "synthetic-lettering", letterSpacing: 0.5, lineHeight: 1 }
      : { kind: "replace_outlined_lettering", componentId: "synthetic-lettering", text: source.brief.payload.name, fontVersionId: source.input.font.record.id },
  } };
  const rows = new Map<string, IdentityAssetReservation>();
  const objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const publications: { row: IdentityAssetReservation; publication: IdentityAssetPublication }[] = [];
  const sqlCalls: string[] = [], rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const controls: {
    onRpc?: (name: string, args: Record<string, unknown>) => void;
    holdRpc?: (name: string, args: Record<string, unknown>) => boolean;
    onHeldRpc?: (signal: AbortSignal | undefined) => void;
    onStorageRead?: (path: string) => void;
    fontRecord: unknown; fonts: unknown; brief: unknown; raster: unknown; batch: unknown;
  } = {
    fontRecord: source.input.font.record, fonts: [source.input.font.record], brief: source.brief, raster: source.refinement, batch,
  };
  function addFile(reference: AssetVersionReference, bytes: Uint8Array, mimeType: string) {
    const row: IdentityAssetReservation = { id: randomUUID(), requestKey: randomUUID(), reference: { ...reference }, storagePath: pathFor(reference), mimeType, byteLength: bytes.length,
      purpose: "brand_asset", sourceReceiptId: randomUUID(), rightsEvidenceId: null, publicationState: "committed" };
    rows.set(reference.versionId, row); objects.set(row.storagePath, { bytes: Uint8Array.from(bytes), mimeType });
  }
  addFile(source.revision.documentAsset, canonicalLogoDocumentBytes(source.document), "application/json");
  addFile(source.revision.svgAsset, serializeLogoSvg(source.document), "image/svg+xml");
  addFile(source.raster.reference, source.raster.bytes, source.raster.mimeType);
  addFile(source.input.font.record.asset, source.input.font.bytes, "font/ttf");
  const client = { rpc(name: string, args: Record<string, unknown>) {
    rpcCalls.push({ name, args });
    let signal: AbortSignal | undefined, response: Promise<RpcResponse> | undefined;
    // Like PostgREST, the transport starts only when its configured builder is
    // awaited. Held reads have no success path and settle only on abort.
    function execute(): RpcResponse | Promise<RpcResponse> {
      if (controls.holdRpc?.(name, args)) {
        controls.onHeldRpc?.(signal);
        return new Promise(resolve => {
          const abort = () => resolve({ data: null, error: { code: "", message: "AbortError: Synthetic read cancelled" } });
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      controls.onRpc?.(name, args);
      if (signal?.aborted) return { data: null, error: { code: "", message: "AbortError: Synthetic read cancelled" } };
      let data: unknown;
      if (name === "read_logo_asset") data = rows.get((args.p_reference as AssetVersionReference).versionId);
      else if (name === "get_logo_workspace") data = workspace;
      else if (name === "read_logo_current_vector") data = { ...scope, vectorRevisionId: source.revision.id };
      else if (name === "read_logo_font_record") { expect(args.p_font_version_id).toBe(source.input.font.record.id); data = controls.fontRecord; }
      else if (name === "list_logo_input_fonts") data = controls.fonts;
      else if (name === "read_logo_workspace_record") {
        const records: Record<string, [string, unknown]> = { vector: [source.revision.id, source.revision], vector_source_preview: [source.revision.id, source.refinement.preview],
          stage: [source.brief.id, controls.brief], raster_refinement: [source.refinement.id, controls.raster], concept_batch: [batch.id, controls.batch] };
        const found = records[String(args.p_kind)];
        if (!found || args.p_id !== found[0]) throw new Error("Unexpected synthetic record read");
        data = found[1];
      } else throw new Error("Unexpected synthetic account RPC");
      if ("p_project_id" in args) expect(args.p_project_id).toBe(projectId);
      return { data: structuredClone(data), error: null };
    }
    const builder: RpcBuilder = {
      abortSignal(value) { signal = value; return builder; },
      then(onFulfilled, onRejected) { response ??= Promise.resolve().then(execute); return response.then(onFulfilled, onRejected); },
    };
    return builder;
  } };
  const auth = { userId: ownerId, client } as unknown as AuthenticatedContext;
  let evidence: Record<string, unknown> | undefined;
  const connection: IdentityTransactionConnection = {
    async query(sql, parameters) {
      sqlCalls.push(sql);
      if (sql.includes("session_user::text")) return { rows: [{ role_name: "synthetic_logo_owner", role_oid: 123 }] };
      if (sql.includes("read_logo_trusted_request")) return { rows: [{ value: null }] };
      if (sql.includes("prepare_logo_asset")) {
        expect(parameters?.[0]).toBe(projectId);
        const write = JSON.parse(String(parameters?.[1])) as IdentityAssetWrite;
        if (write.kind !== "stage") throw new Error("Text edits must stage immutable output");
        const publication = write.publication;
        const reference = { ...scope, assetId: randomUUID(), versionId: randomUUID(), contentHash: publication.contentHash };
        const row: IdentityAssetReservation = { id: randomUUID(), requestKey: publication.requestKey, reference, storagePath: pathFor(reference), mimeType: publication.mimeType,
          byteLength: publication.byteLength, purpose: "brand_asset", sourceReceiptId: publication.source.sourceId, rightsEvidenceId: null, publicationState: "staged" };
        rows.set(reference.versionId, row); publications.push({ row, publication });
        return { rows: [{ value: row }] };
      }
      if (sql.includes("observe_logo_asset")) {
        const row = [...rows.values()].find(item => item.id === parameters?.[0]);
        if (!row) throw new Error("Missing synthetic reservation");
        return { rows: [{ value: { id: row.id, reference: row.reference, verification: JSON.parse(String(parameters?.[1])), purpose: row.purpose,
          sourceReceiptId: row.sourceReceiptId, rightsEvidenceId: null, publicationState: row.publicationState } }] };
      }
      if (sql.includes("apply_logo_trusted_command")) {
        expect(JSON.parse(String(parameters?.[1]))).toEqual(command);
        evidence = JSON.parse(String(parameters?.[2])) as Record<string, unknown>;
        const revision: LogoStageRevision<"refinements"> = { version: 2, id: randomUUID(), ...scope, stage: "refinements", revision: 1, parentRevisionId: null,
          inputRevisions: source.revision.inputRevisions, inputHash: String(evidence.documentHash), createdAt: time,
          payload: { rasterRevisionIds: [], vectorRevisionId: randomUUID(), approvalId: null, sourceRequestKey: command.body.requestKey } };
        const next = structuredClone(workspace);
        next.heads.workspaceRevision++; next.heads.stageRevisions.refinements++;
        next.stages.refinements = { stage: "refinements", id: revision.id, revision: 1 };
        return { rows: [{ value: logoMutationReceiptSchema.parse({ ...scope, requestKey: command.body.requestKey, workspace: next, revision }) }] };
      }
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.startsWith("SET LOCAL ")) return { rows: [] };
      throw new Error("Unexpected synthetic SQL");
    },
    release() {}, discard() {},
  };
  const acquire = vi.fn(async (owner: string) => { expect(owner).toBe(ownerId); return { connection, binding: { ownerId, roleName: "synthetic_logo_owner", roleOid: 123 } }; });
  const read = vi.fn(async (path: string) => { controls.onStorageRead?.(path); const file = objects.get(path); if (!file) throw new Error("Missing synthetic object"); return file; });
  const putIfAbsent = vi.fn(async (path: string, bytes: Uint8Array, mimeType: string) => { if (objects.has(path)) throw new Error("Synthetic immutable collision"); objects.set(path, { bytes: Uint8Array.from(bytes), mimeType }); });
  const dependencies = { connections: { acquire }, storage: { read, putIfAbsent } };
  const runtime = createLogoServices(dependencies);
  const save = (signal?: AbortSignal) => runtime.transactions.run(auth, projectId, command, signal);
  return { source, workspace, command, controls, runtime, auth, projectId, publications, objects, rows, dependencies, sqlCalls, rpcCalls, save, evidence: () => evidence };
}

describe("explicit runtime text-edit composition", () => {
  it("does no I/O while composing its exact owned text, input and asset dependencies", async () => {
    const f = await fixture();
    expect(f.runtime.configured).toBe(true);
    expect(f.dependencies.connections.acquire).not.toHaveBeenCalled();
    expect(f.dependencies.storage.read).not.toHaveBeenCalled();
    expect(f.dependencies.storage.putIfAbsent).not.toHaveBeenCalled();
    expect(f.rpcCalls).toEqual([]);
  });

  it.each(["refinement", "concept"] as const)("outlines owned %s lettering through the factory and the real font resolver", async sourceKind => {
    const f = await fixture(false, sourceKind);
    const result = await f.save();
    expect(result).toMatchObject({ requestKey: f.command.body.requestKey, workspace: { approvedLogo: null } });
    expect(f.publications).toHaveLength(2);
    const document = f.publications.find(item => item.publication.mimeType === "application/json")!;
    const svg = f.publications.find(item => item.publication.mimeType === "image/svg+xml")!;
    const file = (item: typeof document) => {
      const stored = f.objects.get(item.row.storagePath)!;
      const verification: VerifiedFileObservation = { status: "verified", checkedAt: time, contentHash: hash(stored.bytes), mimeType: stored.mimeType, byteLength: stored.bytes.length };
      return { ...stored, bytes: Uint8Array.from(stored.bytes), reference: item.row.reference, verification };
    };
    const decoded = JSON.parse(new TextDecoder().decode(file(document).bytes)) as LogoVectorDocument;
    expect(decoded.components[1]).toMatchObject({ editingKind: "editable_text", textSource: { text: f.source.brief.payload.name, font: f.source.input.font.record.asset, rightsEvidenceId: f.source.input.font.record.rights.id } });
    expect(decoded.components[0]).toEqual(f.source.document.components[0]);
    expect(decoded.components[1]!.paths).not.toEqual(f.source.document.components[1]!.paths);
    expect(new TextDecoder().decode(file(svg).bytes)).not.toMatch(/<(text|image)\b/);
    expect(f.evidence()).toMatchObject({ baseVectorRevisionId: f.source.revision.id, documentPublicationId: document.row.id, svgPublicationId: svg.row.id, documentHash: hash(file(document).bytes) });
    expect(f.evidence()).not.toHaveProperty("approvalId");
    expect(await verifyLogoVectorRevision({ revision: { ...f.source.revision, id: randomUUID(), parentRevisionId: f.source.revision.id,
      documentAsset: document.row.reference, svgAsset: svg.row.reference, documentHash: hash(file(document).bytes), proof: f.evidence()!.proof as typeof f.source.revision.proof }, document: file(document), svg: file(svg) })).toEqual(decoded);
    expect(f.rpcCalls).toContainEqual({ name: "read_logo_workspace_record", args: { p_project_id: f.projectId, p_kind: "stage", p_id: f.source.brief.id } });
    expect(f.dependencies.storage.read).toHaveBeenCalledWith(pathFor(f.source.input.font.record.asset), expect.any(AbortSignal));
    expect(f.sqlCalls).toContain("COMMIT");
    expect(f.source.document.components[1]!.editingKind).toBe("outlined_custom");
  });

  it("finds an existing editable font through the same input service before reshaping spacing", async () => {
    const f = await fixture(true);
    await f.save();
    const document = f.publications.find(item => item.publication.mimeType === "application/json")!;
    const decoded = JSON.parse(new TextDecoder().decode(f.objects.get(document.row.storagePath)!.bytes)) as LogoVectorDocument;
    expect(decoded.components[1]).toMatchObject({ textSource: { letterSpacing: 0.5, lineHeight: 1, font: f.source.input.font.record.asset } });
    expect(decoded.components[1]!.paths).not.toEqual(f.source.document.components[1]!.paths);
    expect(f.rpcCalls).toContainEqual({ name: "list_logo_input_fonts", args: { p_project_id: f.projectId } });
  });

  it("fails closed without explicitly injected SQL and storage dependencies", async () => {
    const f = await fixture();
    await expect(createLogoServices(null).transactions.run(f.auth, f.projectId, f.command)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(f.rpcCalls).toEqual([]); expect(f.sqlCalls).toEqual([]); expect(f.publications).toEqual([]);
  });

  it.each(["owner", "project", "id", "revision", "stage"])("rejects a brief with the wrong %s before any publication", async mismatch => {
    const f = await fixture(), brief = structuredClone(f.source.brief);
    if (mismatch === "owner") brief.ownerId = randomUUID();
    if (mismatch === "project") brief.projectId = randomUUID();
    if (mismatch === "id") brief.id = randomUUID();
    if (mismatch === "revision") { brief.revision++; brief.parentRevisionId = randomUUID(); }
    f.controls.brief = mismatch === "stage" ? { ...brief, stage: "concepts", payload: { batchIds: [], selected: null } } : brief;
    await expect(f.save()).rejects.toBeDefined();
    expect(f.publications).toEqual([]); expect(f.dependencies.storage.putIfAbsent).not.toHaveBeenCalled();
    expect(f.rpcCalls.some(call => call.name === "read_logo_font_record")).toBe(false);
  });

  it.each(["owner", "project", "id", "preview", "basis"])("rejects a raster source with mismatched %s before publication", async mismatch => {
    const f = await fixture(), raster = structuredClone(f.source.refinement);
    if (mismatch === "owner") raster.ownerId = raster.preview!.reference.ownerId = randomUUID();
    if (mismatch === "project") raster.projectId = raster.preview!.reference.projectId = randomUUID();
    if (mismatch === "id") raster.id = randomUUID();
    if (mismatch === "preview") raster.preview!.reference.versionId = randomUUID();
    if (mismatch === "basis") raster.inputRevisions = [];
    f.controls.raster = raster;
    await expect(f.save()).rejects.toBeDefined();
    expect(f.publications).toEqual([]); expect(f.dependencies.storage.putIfAbsent).not.toHaveBeenCalled();
    expect(f.sqlCalls).not.toContain("BEGIN");
  });

  it("rejects a concept whose exact saved attempt no longer identifies the vector preview", async () => {
    const f = await fixture(false, "concept"), batch = structuredClone(f.controls.batch) as ReturnType<typeof syntheticLogoBatch>;
    const attempt = batch.slots[4]!.attempts[0]!;
    attempt.id = randomUUID(); f.controls.batch = batch;
    await expect(f.save()).rejects.toMatchObject({ code: "source_mismatch" });
    expect(f.publications).toEqual([]); expect(f.dependencies.storage.putIfAbsent).not.toHaveBeenCalled();
  });

  it.each(["owner", "id", "rights", "family", "license", "bytes"])("rejects a font with invalid %s through the real resolver", async mismatch => {
    const f = await fixture(), font = structuredClone(f.source.input.font.record);
    if (mismatch === "owner") font.asset.ownerId = randomUUID();
    if (mismatch === "id") font.id = randomUUID();
    if (mismatch === "rights") font.rights.permissions.outline = "denied";
    if (mismatch === "family") font.family = "Synthetic wrong family";
    if (mismatch === "license") font.rights.licenseTextHash = "f".repeat(64);
    if (mismatch === "bytes") f.objects.get(pathFor(font.asset))!.bytes.fill(0);
    f.controls.fontRecord = font;
    await expect(f.save()).rejects.toBeDefined();
    expect(f.publications).toEqual([]); expect(f.dependencies.storage.putIfAbsent).not.toHaveBeenCalled();
    expect(f.sqlCalls).not.toContain("BEGIN");
  });

  it("rejects a genuinely owned and permitted font from a different project", async () => {
    const f = await fixture(), font = structuredClone(f.source.input.font.record), otherProject = randomUUID();
    const row = f.rows.get(font.asset.versionId)!, file = f.objects.get(row.storagePath)!;
    font.asset.projectId = otherProject;
    row.reference = { ...font.asset }; row.storagePath = pathFor(font.asset);
    f.objects.set(row.storagePath, file); f.controls.fontRecord = font;
    await expect(f.save()).rejects.toMatchObject({ code: "source_mismatch" });
    expect(f.dependencies.storage.read).toHaveBeenCalledWith(row.storagePath, expect.any(AbortSignal));
    expect(f.publications).toEqual([]); expect(f.dependencies.storage.putIfAbsent).not.toHaveBeenCalled();
  });

  it.each(["missing", "foreign", "different_rights", "duplicate"])("requires exact project font-list membership for existing text: %s", async mismatch => {
    const f = await fixture(true), font = structuredClone(f.source.input.font.record);
    if (mismatch === "foreign") font.asset.projectId = randomUUID();
    if (mismatch === "different_rights") font.rights.id = randomUUID();
    f.controls.fonts = mismatch === "missing" ? [] : mismatch === "duplicate" ? [font, structuredClone(font)] : [font];
    await expect(f.save()).rejects.toBeDefined();
    expect(f.publications).toEqual([]); expect(f.dependencies.storage.putIfAbsent).not.toHaveBeenCalled();
  });

  it.each(["before", "brief", "source", "font_list", "font_record", "font_bytes"])("keeps cancellation fenced at %s", async boundary => {
    const f = await fixture(boundary === "font_list"), controller = new AbortController();
    f.controls.onRpc = (name, args) => {
      if (boundary === "brief" && args.p_kind === "stage" || boundary === "source" && args.p_kind === "raster_refinement"
        || boundary === "font_list" && name === "list_logo_input_fonts" || boundary === "font_record" && name === "read_logo_font_record") controller.abort();
    };
    f.controls.onStorageRead = path => { if (boundary === "font_bytes" && path === pathFor(f.source.input.font.record.asset)) controller.abort(); };
    if (boundary === "before") controller.abort();
    await expect(f.save(controller.signal)).rejects.toBeDefined();
    expect(f.publications).toEqual([]); expect(f.dependencies.storage.putIfAbsent).not.toHaveBeenCalled();
    expect(f.sqlCalls).not.toContain("BEGIN");
  });

  it.each(["vector", "vector_source_preview", "stage", "raster_refinement", "concept_batch", "font_record", "font_list"])("aborts a held %s transport with the exact save signal", async boundary => {
    const f = await fixture(boundary === "font_list", boundary === "concept_batch" ? "concept" : "refinement");
    const controller = new AbortController();
    let started!: (signal: AbortSignal | undefined) => void;
    const transportStarted = new Promise<AbortSignal | undefined>(resolve => { started = resolve; });
    f.controls.holdRpc = (name, args) => boundary === "font_record" ? name === "read_logo_font_record"
      : boundary === "font_list" ? name === "list_logo_input_fonts" : name === "read_logo_workspace_record" && args.p_kind === boundary;
    f.controls.onHeldRpc = started;
    const outcome = f.save(controller.signal).then(() => ({ status: "unexpected_success" }), error => ({ status: "rejected", error }));
    const transportSignal = await transportStarted;
    controller.abort();
    expect(transportSignal).toBe(controller.signal);
    await expect(outcome).resolves.toMatchObject({ status: "rejected", error: { code: "integration_unavailable" } });
    expect(f.publications).toEqual([]); expect(f.dependencies.storage.putIfAbsent).not.toHaveBeenCalled();
    expect(f.sqlCalls).not.toContain("BEGIN");
  });
});
