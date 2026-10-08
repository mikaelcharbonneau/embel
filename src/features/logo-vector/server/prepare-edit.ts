import 'server-only';
import type { IdentityAssetPublication, VerifiedAssetBytes } from '@/domain/logo-deliverables';
import type { LogoVectorDocument, LogoVectorRevision, LogoComponentLock } from '@/domain/logo-vector';
import type { AuthenticatedContext } from '@/server/auth/context';
import type { IdentityAssetStore } from '@/server/data/identity-asset-store';
import { LogoVectorError } from '../model/errors';
import { assertLogoConversionNotAborted } from './converter';
import { canonicalLogoDocumentBytes, validateLogoVectorCandidate } from './revisions';
import { requireVectorAssetReceipt, vectorMemberRequestKey } from './publication';

/** Shared byte validation/publication only. It neither creates a command nor
 * commits a revision: manual saves and proposal applications retain distinct provenance. */
export async function stageLogoVectorEditCandidate(input: {
 auth: AuthenticatedContext; projectId: string; requestKey: string; revision: LogoVectorRevision;
 document: LogoVectorDocument; candidate: LogoVectorDocument; source: VerifiedAssetBytes; locks: readonly LogoComponentLock[];
}, assetStore: IdentityAssetStore, signal: AbortSignal) {
 assertLogoConversionNotAborted(signal);
 const { auth, projectId, requestKey, revision, document, candidate, source, locks } = input;
 const derived = validateLogoVectorCandidate({ base: document, candidate, locks: revision.locks, expectedSource: revision.sourcePreview, source });
 const bytes = canonicalLogoDocumentBytes(candidate), common = { inputRevisions: revision.inputRevisions, source: { kind: 'vector' as const, sourceId: revision.id } };
 const documentPublication: IdentityAssetPublication = { ...common, requestKey: vectorMemberRequestKey(requestKey, 'document'), mimeType: 'application/json', contentHash: derived.documentHash, byteLength: bytes.length };
 const svgPublication: IdentityAssetPublication = { ...common, requestKey: vectorMemberRequestKey(requestKey, 'svg'), mimeType: 'image/svg+xml', contentHash: derived.proof.svgContentHash, byteLength: derived.svg.length };
 const d = requireVectorAssetReceipt(await assetStore.stageOwnedAsset(auth, projectId, documentPublication, bytes, signal), documentPublication, revision.ownerId, revision.projectId);
 assertLogoConversionNotAborted(signal);
 const s = requireVectorAssetReceipt(await assetStore.stageOwnedAsset(auth, projectId, svgPublication, derived.svg, signal), svgPublication, revision.ownerId, revision.projectId);
 assertLogoConversionNotAborted(signal);
 if (d.id === s.id || d.reference.assetId === s.reference.assetId || d.reference.versionId === s.reference.versionId) throw new LogoVectorError('source_mismatch', 'The candidate requires distinct immutable document and SVG members.');
 return { baseVectorRevisionId: revision.id, documentPublicationId: d.id, svgPublicationId: s.id, documentHash: derived.documentHash, proof: derived.proof, locks };
}
