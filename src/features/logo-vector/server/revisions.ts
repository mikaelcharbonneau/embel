import "server-only";
import { createHash } from "node:crypto";
import type { AssetVersionReference } from "../../../domain/asset-library";
import { verifiedAssetBytesSchema, type VerifiedAssetBytes } from "../../../domain/logo-deliverables";
import { logoVectorRevisionSchema, type LogoComponentLock, type LogoVectorDocument, type LogoVectorProof, type LogoVectorRevision } from "../../../domain/logo-vector";
import { LogoVectorError } from "../model/errors";
import { validateLogoVectorDocument } from "../model/geometry";
import { assertLogoComponentLocks } from "../model/locks";
import { serializeLogoSvg, validateLogoVectorSvg } from "../model/svg";
import { VECTOR_LIMITS } from "../model/limits";
import { canonicalLogoDocumentBytes } from "../model/canonical";
import { verifyLogoRasterSource } from "./converter";
export { canonicalLogoDocumentBytes } from "../model/canonical";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const mismatch = (): never => { throw new LogoVectorError("source_mismatch", "Vector content does not match its exact immutable source and proof."); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function derive(document: LogoVectorDocument): { svg: Uint8Array; documentHash: string; proof: LogoVectorProof } {
  const svg = serializeLogoSvg(document), documentHash = digest(canonicalLogoDocumentBytes(document));
  return { svg, documentHash, proof: { version: 1, svgContentHash: digest(svg), documentHash,
    validator: { id: "fluid.logo-vector", version: "1" }, viewBox: [...document.viewBox], pathCount: document.components.reduce((count, component) => count + component.paths.length, 0),
    componentCount: document.components.length, externalFontDependencies: [] } };
}
function sameReference(a: AssetVersionReference, b: AssetVersionReference): boolean {
  return a.ownerId === b.ownerId && a.projectId === b.projectId && a.assetId === b.assetId && a.versionId === b.versionId && a.contentHash === b.contentHash;
}
export function validateLogoVectorCandidate(input: {
  base: LogoVectorDocument | null; candidate: LogoVectorDocument; locks: readonly LogoComponentLock[];
  expectedSource: AssetVersionReference; source: VerifiedAssetBytes;
}): { svg: Uint8Array; documentHash: string; proof: LogoVectorProof } {
  verifyLogoRasterSource(input.source);
  if (!sameReference(input.expectedSource, input.source.reference)) return mismatch();
  const document = validateLogoVectorDocument(input.candidate);
  if (input.base) assertLogoComponentLocks(input.base, document, input.locks);
  else if (input.locks.length) throw new LogoVectorError("locked_component_changed", "Locked components require the authoritative base document.");
  return derive(document);
}
function verifiedBytes(source: VerifiedAssetBytes, expected: AssetVersionReference, mimeType: string): Uint8Array {
  if (!verifiedAssetBytesSchema.safeParse(source).success || !sameReference(source.reference, expected) || source.mimeType !== mimeType || source.bytes.length > VECTOR_LIMITS.bytes || digest(source.bytes) !== expected.contentHash) return mismatch();
  return source.bytes;
}
/** Read verification accepts unapproved/historical revisions, never substitutes a current base or approval. */
export async function verifyLogoVectorRevision(input: { revision: LogoVectorRevision; document: VerifiedAssetBytes; svg: VerifiedAssetBytes }, signal?: AbortSignal): Promise<LogoVectorDocument> {
  if (signal?.aborted) throw new LogoVectorError("cancelled", "Vector verification was cancelled.");
  const parsed = logoVectorRevisionSchema.safeParse(input.revision);
  if (!parsed.success) return mismatch();
  const revision = parsed.data, documentBytes = verifiedBytes(input.document, revision.documentAsset, "application/json"), svgBytes = verifiedBytes(input.svg, revision.svgAsset, "image/svg+xml");
  let document: LogoVectorDocument;
  try { document = validateLogoVectorDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(documentBytes))); }
  catch { return mismatch(); }
  const actual = derive(document);
  validateLogoVectorSvg(svgBytes);
  if (actual.documentHash !== revision.documentHash || canonical(actual.proof) !== canonical(revision.proof) ||
    !Buffer.from(actual.svg).equals(Buffer.from(svgBytes)) || !Buffer.from(canonicalLogoDocumentBytes(document)).equals(Buffer.from(documentBytes))) return mismatch();
  // Saved locks must themselves bind the saved document, without requiring a historical base.
  assertLogoComponentLocks(document, document, revision.locks);
  if (signal?.aborted) throw new LogoVectorError("cancelled", "Vector verification was cancelled.");
  return document;
}
