import "server-only";
import { createHash } from "node:crypto";
import type { ClaimedJob } from "../../../domain/jobs";
import { identityAssetReceiptSchema, type IdentityAssetReceipt, type IdentityAssetPublication } from "../../../domain/logo-deliverables";
import { logoVectorizeJobInputSchema } from "../../../domain/logo-jobs";
import { logoInputRevisionsSchema, logoVectorRevisionSchema, type LogoVectorDocument, type LogoVectorRevision } from "../../../domain/logo-vector";
import type { IdentityAssetStore } from "../../../server/data/identity-asset-store";
import { loadLogoVectorInput, readLeasedLogoRecord, type LogoWorkerConnection } from "../../../server/data/logo-jobs";
import { logoDatabaseError, logoId, parseLogoStored } from "../../../server/data/logo-transaction";
import { QUALIFIED_VTRACER } from "../../../server/image-process/engine";
import { LogoVectorError } from "../model/errors";
import { validateLogoVectorDocument } from "../model/geometry";
import { assertLogoConversionNotAborted, type LogoVectorConversionResult } from "./converter";
import { canonicalLogoDocumentBytes, validateLogoVectorCandidate, verifyLogoVectorRevision } from "./revisions";
import { VECTOR_LIMITS } from "../model/limits";

const mismatch = (): never => { throw new LogoVectorError("source_mismatch", "Vector publication must bind its verified immutable source and actual bytes."); };
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every(key => Object.hasOwn(y, key) && equal(x[key], y[key]));
};
/** Stable per-intent member keys preserve an uncertain upload's original identity. */
export function vectorMemberRequestKey(intentId: string, member: "document" | "svg"): string {
  const hash = createHash("sha256").update(`fluid.logo-vector.publication.v1:${intentId}:${member}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function requireVectorAssetReceipt(raw: unknown, publication: IdentityAssetPublication, ownerId: string, projectId: string): IdentityAssetReceipt {
  const receipt = identityAssetReceiptSchema.parse(raw);
  if (receipt.reference.ownerId !== ownerId || receipt.reference.projectId !== projectId || receipt.reference.contentHash !== publication.contentHash ||
    receipt.verification.mimeType !== publication.mimeType || receipt.verification.byteLength !== publication.byteLength ||
    receipt.purpose !== "brand_asset" || receipt.sourceReceiptId !== publication.source.sourceId || receipt.rightsEvidenceId !== null) return mismatch();
  return receipt;
}

/** Stores both members first; the existing completeStep transaction alone makes
 * this group visible as an immutable review-required revision. No acceptance. */
export async function publishLogoVectorResult(connection: LogoWorkerConnection, store: IdentityAssetStore, rawJob: ClaimedJob,
  rawResult: LogoVectorConversionResult, signal: AbortSignal = new AbortController().signal): Promise<IdentityAssetReceipt> {
  assertLogoConversionNotAborted(signal);
  if (!(rawResult.svg instanceof Uint8Array) || rawResult.svg.byteLength < 1 || rawResult.svg.byteLength > VECTOR_LIMITS.bytes) return mismatch();
  // Uint8Array.from is deliberate: Buffer.slice would retain the caller's bytes.
  const job = structuredClone(rawJob), input = logoVectorizeJobInputSchema.parse(job.input);
  const result = { ...structuredClone({ ...rawResult, svg: undefined }), svg: Uint8Array.from(rawResult.svg), document: validateLogoVectorDocument(rawResult.document) };
  const documentBytes = canonicalLogoDocumentBytes(result.document);
  if (job.operation !== input.operation || job.ownerId !== input.ownerId || job.projectId !== input.projectId ||
    input.engine.id !== "vtracer" || input.engine.version !== QUALIFIED_VTRACER.version || input.engine.artifactHash !== QUALIFIED_VTRACER.wasm ||
    result.engine.name !== "@visioncortex/vtracer" || result.engine.version !== input.engine.version || result.engine.artifactHash !== input.engine.artifactHash ||
    !equal(result.engine.settings, input.settings)) return mismatch();
  const loaded = await loadLogoVectorInput(connection, store, job, signal);
  assertLogoConversionNotAborted(signal);
  if (!equal(result.source, loaded.source.reference) || result.sourceContentHash !== loaded.source.reference.contentHash || result.logoType !== loaded.logoType) return mismatch();
  const derived = validateLogoVectorCandidate({ base: null, candidate: result.document, locks: [], expectedSource: loaded.source.reference, source: loaded.source });
  if (!Buffer.from(result.svg).equals(Buffer.from(derived.svg))) return mismatch();
  const inputRevisions = parseLogoStored(logoInputRevisionsSchema, await readLeasedLogoRecord(connection, job, "input_revisions"));
  assertLogoConversionNotAborted(signal);
  const common = { inputRevisions, source: { kind: "vector" as const, sourceId: job.id } };
  const jsonPublication: IdentityAssetPublication = { ...common, requestKey: vectorMemberRequestKey(job.id, "document"), mimeType: "application/json", contentHash: derived.documentHash, byteLength: documentBytes.length };
  const svgPublication: IdentityAssetPublication = { ...common, requestKey: vectorMemberRequestKey(job.id, "svg"), mimeType: "image/svg+xml", contentHash: derived.proof.svgContentHash, byteLength: derived.svg.length };
  const document = requireVectorAssetReceipt(await store.publishLeasedAsset(job, jsonPublication, documentBytes, signal), jsonPublication, job.ownerId, job.projectId);
  assertLogoConversionNotAborted(signal);
  const svg = requireVectorAssetReceipt(await store.publishLeasedAsset(job, svgPublication, derived.svg, signal), svgPublication, job.ownerId, job.projectId);
  assertLogoConversionNotAborted(signal);
  if (document.id === svg.id || document.reference.assetId === svg.reference.assetId || document.reference.versionId === svg.reference.versionId) return mismatch();
  const evidence = { documentPublicationId: document.id, svgPublicationId: svg.id, documentHash: derived.documentHash, proof: derived.proof };
  let response: { rows: { value: unknown }[] };
  try { response = await connection.query<{ value: unknown }>("select fluid_private.stage_logo_vector_publication($1::uuid,$2::uuid,$3::jsonb) value", [job.id, job.leaseToken, JSON.stringify(evidence)]); }
  catch (error) { throw logoDatabaseError(error); }
  assertLogoConversionNotAborted(signal);
  const receipt = requireVectorAssetReceipt(response.rows[0]?.value, svgPublication, job.ownerId, job.projectId);
  if (!equal(receipt, svg)) return mismatch();
  return receipt;
}

/** Frozen leased sources only. The database resolves the exact listed source
 * and never grants an arbitrary historical vector read under an unrelated job. */
export async function loadLeasedLogoVectorRevision(connection: LogoWorkerConnection, store: IdentityAssetStore, rawJob: ClaimedJob,
  vectorRevisionId: string, signal: AbortSignal = new AbortController().signal): Promise<{ revision: LogoVectorRevision; document: LogoVectorDocument }> {
  assertLogoConversionNotAborted(signal);
  const job = structuredClone(rawJob), id = logoId(vectorRevisionId);
  async function read(): Promise<LogoVectorRevision> {
    let response: { rows: { value: unknown }[] };
    try { response = await connection.query<{ value: unknown }>("select fluid_private.read_leased_logo_vector_revision($1::uuid,$2::uuid,$3::uuid) value", [logoId(job.id), logoId(job.leaseToken), id]); }
    catch (error) { throw logoDatabaseError(error); }
    assertLogoConversionNotAborted(signal);
    const revision = parseLogoStored(logoVectorRevisionSchema, response.rows[0]?.value);
    if (revision.id !== id || revision.ownerId !== job.ownerId || revision.projectId !== job.projectId) return mismatch();
    return revision;
  }
  const revision = await read();
  const rawDocument = await store.readLeasedAsset(job, revision.documentAsset, signal);
  const documentFile = { ...rawDocument, reference: { ...rawDocument.reference }, verification: { ...rawDocument.verification }, bytes: Uint8Array.from(rawDocument.bytes) };
  assertLogoConversionNotAborted(signal);
  const rawSvg = await store.readLeasedAsset(job, revision.svgAsset, signal);
  const svgFile = { ...rawSvg, reference: { ...rawSvg.reference }, verification: { ...rawSvg.verification }, bytes: Uint8Array.from(rawSvg.bytes) };
  const document = await verifyLogoVectorRevision({ revision, document: documentFile, svg: svgFile }, signal);
  if (!equal(await read(), revision)) return mismatch();
  return { revision, document };
}
