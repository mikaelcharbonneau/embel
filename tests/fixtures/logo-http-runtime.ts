/** TEST ONLY. Real codecs, vector verification, pool and private-storage adapters;
 * only authenticated account RPC, SQL driver and HTTP object transport are local. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { vi } from "vitest";
import type { AuthenticatedContext } from "@/server/auth/context";
import type { AssetVersionReference } from "@/domain/asset-library";
import type { IdentityAssetReceipt } from "@/domain/logo-deliverables";
import type { LogoVectorRevision } from "@/domain/logo-vector";
import { logoManualCommandSchema, logoMutationReceiptSchema, type LogoManualCommand, type LogoMutationReceipt } from "@/domain/logo-workspace";
import type { IdentityAssetReservation, IdentityAssetWrite } from "@/server/data/identity-asset-store";
import { createPooledIdentityConnectionFactory, type IdentityPoolClientPort } from "@/server/runtime/identity-pool";
import { createSupabasePrivateAssetStorage } from "@/server/runtime/private-asset-storage";
import { ApiError } from "@/server/http/errors";
import { logoInputRequestSchema, type LogoInputRequestState } from "@/features/logo-inputs/model/contracts";
import { canonicalLogoDocumentBytes, validateLogoVectorCandidate } from "@/features/logo-vector/server/revisions";
import { serializeLogoSvg } from "@/features/logo-vector/model/svg";
import { separatedLogoDocument } from "../features/logo-vector/fixtures";
import { syntheticPng, syntheticSource } from "../features/logo-vector/raster-fixtures";
import { syntheticLogoWorkspace } from "./logo-creation";

const time = "2026-10-07T00:00:00Z";
export const pathFor = (ref: AssetVersionReference) => `${ref.ownerId}/${ref.projectId}/${ref.assetId}/${ref.versionId}`;
type RpcResponse = { data: unknown; error: unknown };
type RpcBuilder = PromiseLike<RpcResponse> & { abortSignal(signal: AbortSignal): RpcBuilder };
export function logoHttpFixture(ownerId = randomUUID(), projectId = randomUUID(), color = "#DB2777") {
  const scope = { ownerId, projectId }, workspace = { ...structuredClone(syntheticLogoWorkspace()), ...scope };
  const raster = syntheticSource(syntheticPng(4, 4, (x, y) => [x * 30, y * 30, parseInt(color.slice(1, 3), 16), 255]));
  Object.assign(raster.reference, scope, { assetId: randomUUID(), versionId: randomUUID() });
  const document = separatedLogoDocument(); document.components[0]!.paths[0]!.fill!.color = color;
  const proof = validateLogoVectorCandidate({ base: null, candidate: document, locks: [], expectedSource: raster.reference, source: raster });
  const revision: LogoVectorRevision = { ...scope, id: randomUUID(), parentRevisionId: null, source: { kind: "refinement", rasterRevisionId: randomUUID() }, sourcePreview: raster.reference,
    documentAsset: { ...scope, assetId: randomUUID(), versionId: randomUUID(), contentHash: proof.documentHash }, svgAsset: { ...scope, assetId: randomUUID(), versionId: randomUUID(), contentHash: proof.proof.svgContentHash },
    documentHash: proof.documentHash, proof: proof.proof, locks: [], inputRevisions: [], reviewStatus: "review_required", createdAt: time };
  const preview: IdentityAssetReceipt = { id: randomUUID(), reference: raster.reference, verification: raster.verification, purpose: "brand_asset", sourceReceiptId: randomUUID(), rightsEvidenceId: null, publicationState: "committed" };
  const stage = { version: 2, ...scope, id: randomUUID(), stage: "vector", revision: 1, parentRevisionId: null, inputRevisions: [], inputHash: proof.documentHash, createdAt: time, payload: { vectorRevisionId: revision.id, approvalId: null } };
  const controls: {
    workspace: unknown; principal: { role_name: string; role_oid: number };
    holdRpc?: (name: string, args: Record<string, unknown>) => boolean;
    heldRpc?: (signal: AbortSignal | undefined) => void;
    onRpc?: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => void;
    loseCommit: boolean; loseInputCommit: boolean;
  } = { workspace, principal: { role_name: "synthetic_logo_http", role_oid: 987 }, loseCommit: false, loseInputCommit: false };
  const rows = new Map<string, IdentityAssetReservation>(), objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const requests = new Map<string, LogoInputRequestState>(), mutations = new Map<string, { command: LogoManualCommand; receipt: LogoMutationReceipt }>();
  const rpcCalls: { name: string; args: Record<string, unknown>; signal?: AbortSignal }[] = [], sqlCalls: { sql: string; args: unknown[] }[] = [], storageCalls: { method: string; path: string; signal: AbortSignal | null | undefined }[] = [];
  function addFile(ref: AssetVersionReference, bytes: Uint8Array, mimeType: string) {
    const row: IdentityAssetReservation = { id: randomUUID(), requestKey: randomUUID(), reference: ref, storagePath: pathFor(ref), mimeType, byteLength: bytes.length, purpose: "brand_asset", sourceReceiptId: randomUUID(), rightsEvidenceId: null, publicationState: "committed" };
    rows.set(ref.versionId, row); objects.set(row.storagePath, { bytes: new Uint8Array(bytes), mimeType });
  }
  addFile(revision.documentAsset, canonicalLogoDocumentBytes(document), "application/json");
  addFile(revision.svgAsset, serializeLogoSvg(document), "image/svg+xml");
  addFile(raster.reference, raster.bytes, "image/png");
  function rpc(name: string, args: Record<string, unknown>): RpcBuilder {
    let signal: AbortSignal | undefined, response: Promise<RpcResponse> | undefined;
    const execute = async (): Promise<RpcResponse> => {
      rpcCalls.push({ name, args, signal }); controls.onRpc?.(name, args, signal);
      if (controls.holdRpc?.(name, args)) {
        controls.heldRpc?.(signal);
        await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      }
      if (signal?.aborted) return { data: null, error: { code: "", message: "Aborted synthetic transport" } };
      if ("p_project_id" in args && args.p_project_id !== projectId) return { data: null, error: { code: "P0002" } };
      let data: unknown;
      if (name === "get_logo_workspace") data = controls.workspace;
      else if (name === "read_logo_current_vector") data = { ...scope, vectorRevisionId: null };
      else if (name === "read_logo_workspace_record") {
        if (args.p_kind === "vector" && args.p_id === revision.id) data = revision;
        else if (args.p_kind === "vector_source_preview" && args.p_id === revision.id) data = preview;
        else if (args.p_kind === "stage" && args.p_id === stage.id) data = stage;
        else if (args.p_kind === "manual_request") { const saved = mutations.get(String(args.p_id)); data = saved ? { status: "succeeded", requestKey: args.p_id, receipt: saved.receipt } : { status: "not_found" }; }
        else return { data: null, error: { code: "P0002" } };
      } else if (name === "read_logo_asset") {
        const ref = args.p_reference as AssetVersionReference;
        if (ref.ownerId !== ownerId || ref.projectId !== projectId) return { data: null, error: { code: "P0002" } };
        data = rows.get(ref.versionId);
      } else if (name === "read_logo_input_request") data = requests.get(String(args.p_request_key)) ?? { status: "not_found" };
      else throw Error("Unexpected synthetic account RPC");
      return { data: structuredClone(data), error: null };
    };
    const builder: RpcBuilder = { abortSignal(value) { signal = value; return builder; }, then(resolve, reject) { response ??= Promise.resolve().then(execute); return response.then(resolve, reject); } };
    return builder;
  }
  const getUser = vi.fn(async () => ({ data: { user: { id: ownerId, is_anonymous: false, email_confirmed_at: "2026-10-13T10:00:00Z" } }, error: null }));
  const client = { rpc, auth: { getUser } }, auth = { userId: ownerId, client } as unknown as AuthenticatedContext;
  function receiptFor(command: LogoManualCommand, evidence: Record<string, unknown>) {
    const stageName = command.method === "saveLogoEdit" ? "refinements" : "vector", id = randomUUID();
    const next = structuredClone(workspace); next.heads.workspaceRevision = command.body.expected.workspaceRevision + 1;
    next.heads.stageRevisions[stageName] = command.body.expected.stageRevisions[stageName] + 1;
    next.stages[stageName] = { stage: stageName, id, revision: next.heads.stageRevisions[stageName] };
    return logoMutationReceiptSchema.parse({ ...scope, requestKey: command.body.requestKey, workspace: next, revision: { version: 2, ...scope, id, stage: stageName,
      revision: next.heads.stageRevisions[stageName], parentRevisionId: null, inputRevisions: [], inputHash: evidence.documentHash ?? revision.documentHash, createdAt: time,
      payload: stageName === "refinements" ? { rasterRevisionIds: [], vectorRevisionId: randomUUID(), approvalId: null, sourceRequestKey: command.body.requestKey } : { vectorRevisionId: revision.id, approvalId: null } } });
  }
  const connect = vi.fn(async (): Promise<IdentityPoolClientPort> => ({
    async query(input) {
      const { text: sql, values: args } = input; sqlCalls.push({ sql, args });
      if (sql.includes("session_user::text")) return { rows: [{ ...controls.principal }] };
      if (["BEGIN", "ROLLBACK"].includes(sql) || sql.startsWith("SET LOCAL ")) return { rows: [] };
      if (sql === "COMMIT") { if (controls.loseCommit) { controls.loseCommit = false; throw Error("Synthetic lost commit acknowledgement"); } return { rows: [] }; }
      if (sql.includes("read_logo_trusted_request") || sql.includes("apply_logo_trusted_command")) {
        if (args[0] !== projectId) throw new ApiError("not_found");
        const command = logoManualCommandSchema.parse(JSON.parse(String(args[1]))), saved = mutations.get(command.body.requestKey);
        if (saved && !isDeepStrictEqual(saved.command, command)) throw new ApiError("conflict");
        if (sql.includes("read_logo_trusted_request")) return { rows: [{ value: saved?.receipt ?? null }] };
        const receipt = receiptFor(command, JSON.parse(String(args[2]))); mutations.set(command.body.requestKey, { command, receipt });
        return { rows: [{ value: receipt }] };
      }
      if (sql.includes("prepare_logo_input") || sql.includes("commit_logo_input")) {
        if (args[0] !== projectId) throw new ApiError("not_found");
        const request = logoInputRequestSchema.parse(JSON.parse(String(args[1]))), saved = requests.get(request.input.requestKey);
        if (saved && saved.status !== "not_found" && !isDeepStrictEqual(saved.request, request)) throw new ApiError("conflict");
        if (saved?.status === "succeeded") return { rows: [{ value: saved }] };
        let state: LogoInputRequestState = { status: "pending", ...scope, requestKey: request.input.requestKey, request };
        if (sql.includes("commit_logo_input")) {
          if (request.kind !== "reference_upload") throw Error("This local fixture handles references only");
          const receipt = JSON.parse(String(args[2])) as IdentityAssetReceipt;
          state = { ...state, status: "succeeded", result: { referenceId: randomUUID(), sourceKind: "upload", aspects: request.input.aspects, rightsEvidenceId: receipt.rightsEvidenceId!, asset: receipt.reference, workspace } };
        }
        requests.set(request.input.requestKey, state);
        if (sql.includes("commit_logo_input") && controls.loseInputCommit) { controls.loseInputCommit = false; throw Error("Synthetic lost registration acknowledgement"); }
        return { rows: [{ value: state }] };
      }
      if (sql.includes("prepare_logo_asset")) {
        if (args[0] !== projectId) throw new ApiError("not_found");
        const write = JSON.parse(String(args[1])) as IdentityAssetWrite, body = write.kind === "upload" ? write.intent : write.publication;
        const existing = [...rows.values()].find(row => row.requestKey === body.requestKey); if (existing) return { rows: [{ value: existing }] };
        const reference = { ...scope, assetId: randomUUID(), versionId: randomUUID(), contentHash: body.contentHash };
        const row: IdentityAssetReservation = { id: randomUUID(), requestKey: body.requestKey, reference, storagePath: pathFor(reference), mimeType: body.mimeType,
          byteLength: write.kind === "upload" ? write.byteLength : write.publication.byteLength, purpose: write.kind === "upload" && write.intent.usage === "logo_reference" ? "reference_media" : "brand_asset",
          sourceReceiptId: write.kind === "stage" ? write.publication.source.sourceId : randomUUID(), rightsEvidenceId: write.kind === "upload" ? randomUUID() : null, publicationState: write.kind === "upload" ? "committed" : "staged" };
        rows.set(reference.versionId, row); return { rows: [{ value: row }] };
      }
      if (sql.includes("observe_logo_asset")) {
        const row = [...rows.values()].find(row => row.id === args[0]); if (!row) throw new ApiError("not_found");
        return { rows: [{ value: { id: row.id, reference: row.reference, verification: JSON.parse(String(args[1])), purpose: row.purpose, sourceReceiptId: row.sourceReceiptId, rightsEvidenceId: row.rightsEvidenceId, publicationState: row.publicationState } }] };
      }
      throw Error("Unexpected synthetic privileged SQL");
    }, on() {}, removeListener() {}, release() {}, async end() {},
  }));
  const connections = createPooledIdentityConnectionFactory([{ ...scope, roleName: "synthetic_logo_http", roleOid: 987, pool: { connect } }]);
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    const path = url.split("/fluid-assets/")[1]!; storageCalls.push({ method: init.method!, path, signal: init.signal });
    if (!path.startsWith(`${ownerId}/${projectId}/`)) throw Error("Foreign private object transport");
    if (init.method === "POST") {
      if (!objects.has(path)) objects.set(path, { bytes: new Uint8Array(init.body as Uint8Array), mimeType: (init.headers as Record<string, string>)["content-type"]! });
      return Response.json({ Id: randomUUID(), Key: `fluid-assets/${path}` });
    }
    const file = objects.get(path); return file ? new Response(Uint8Array.from(file.bytes), { headers: { "content-type": file.mimeType } }) : new Response(null, { status: 404 });
  });
  const storage = createSupabasePrivateAssetStorage({ scope: { kind: "identity", ...scope }, transport });
  const dependencies = { connections, storage };
  const edit = { requestKey: randomUUID(), expected: workspace.heads, baseVectorRevisionId: revision.id, edit: { kind: "color" as const, componentId: "synthetic-symbol", fill: "#123456", stroke: null } };
  const accept = { requestKey: randomUUID(), expected: workspace.heads, vectorRevisionId: revision.id, acceptEarlierBasis: false };
  const upload = { requestKey: randomUUID(), expected: workspace.heads, aspects: ["shape" as const], rightsDeclaration: "I own this synthetic reference and permit processing." };
  return { ...scope, auth, client, workspace, document, revision, stage, raster, controls, dependencies, objects, rows, requests, mutations, rpcCalls, sqlCalls, storageCalls, connect, transport, getUser, edit, accept, upload };
}
export type LogoHttpFixture = ReturnType<typeof logoHttpFixture>;
