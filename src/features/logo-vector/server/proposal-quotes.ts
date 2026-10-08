import 'server-only';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { logoCostQuoteSchema, type LogoCostQuote } from '@/domain/logo-jobs';
import { logoVectorDetailSchema, type LogoVectorDetail, type VerifiedAssetBytes } from '@/domain/logo-deliverables';
import { fontRecordSchema, type FontRecord, type PermittedFont, type FontPurpose } from '@/domain/logo-directions';
import { logoBriefRevisionSchema, logoWorkspaceV2Schema, type LogoBriefRevision, type LogoWorkspaceV2 } from '@/domain/logo-workspace';
import { logoJsonBytes } from '@/domain/logo-vector';
import { logoVectorProposalRequestSchema } from '@/domain/logo-vector-proposals';
import type { AuthenticatedContext } from '@/server/auth/context';
import type { IdentityAssetStore } from '@/server/data/identity-asset-store';
import type { IdentityConnectionFactory } from '@/server/data/identity-transaction';
import { logoOwner, logoId, parseLogoInput, parseLogoStored, logoDatabaseError } from '@/server/data/logo-transaction';
import { ApiError } from '@/server/http/errors';
import { fontPurposeAllowed } from '@/features/identity-directions/model/font-rights';
import { buildLogoVectorProposalContext } from './proposal-context';
import { canonicalLogoDocumentBytes, verifyLogoVectorRevision } from './revisions';
import { verifyLogoRasterSource } from './converter';

export type LogoVectorProposalQuoteDependencies = {
 connections: IdentityConnectionFactory;
 assets: Pick<IdentityAssetStore, 'readOwnedAsset'>;
 getWorkspace(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal): Promise<LogoWorkspaceV2>;
 readCurrentVectorRevisionId(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal): Promise<string | null>;
 readVectorDetail(auth: AuthenticatedContext, projectId: string, id: string, signal?: AbortSignal): Promise<LogoVectorDetail>;
 readBriefRevision(auth: AuthenticatedContext, projectId: string, id: string, signal?: AbortSignal): Promise<LogoBriefRevision>;
 listFonts(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal): Promise<FontRecord[]>;
 resolveFont(auth: AuthenticatedContext, id: string, purpose: FontPurpose, signal?: AbortSignal): Promise<PermittedFont>;
};
const principalSchema = z.strictObject({ role_name: z.string(), role_oid: z.coerce.number().int().positive() });
const active = (signal?: AbortSignal) => { if (signal?.aborted) throw new ApiError('integration_unavailable'); };
const snapshot = (f: VerifiedAssetBytes): VerifiedAssetBytes => ({ ...f, reference: { ...f.reference }, verification: { ...f.verification }, bytes: Uint8Array.from(f.bytes) });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Quote-only: actual owned verification precedes one fixed owner-bound SQL call.
 * No provider, candidate mutation, storage write or default dependency exists. */
export function createLogoVectorProposalQuoteService(deps: LogoVectorProposalQuoteDependencies | null) {
 async function quoteLogoVectorProposal(auth: AuthenticatedContext, projectId: string, raw: unknown, signal?: AbortSignal): Promise<LogoCostQuote> {
  const owner = logoOwner(auth); projectId = logoId(projectId); const request = parseLogoInput(logoVectorProposalRequestSchema, raw); active(signal);
  if (!deps) throw new ApiError('integration_unavailable');
  async function current() {
   const workspace = parseLogoStored(logoWorkspaceV2Schema, await deps!.getWorkspace(auth, projectId, signal)); active(signal);
   if (workspace.ownerId !== owner || workspace.projectId !== projectId) throw new ApiError('not_found');
   if (!isDeepStrictEqual(workspace.heads, request.expected)) throw new ApiError('conflict');
   const id = await deps!.readCurrentVectorRevisionId(auth, projectId, signal); active(signal);
   if (id !== request.baseVectorRevisionId) throw new ApiError('conflict');
  }
  await current();
  const detail = parseLogoStored(logoVectorDetailSchema, await deps.readVectorDetail(auth, projectId, request.baseVectorRevisionId, signal)); active(signal);
  const base = detail.revision;
  if (base.ownerId !== owner || base.projectId !== projectId || base.id !== request.baseVectorRevisionId) throw new ApiError('not_found');
  const documentBytes = snapshot(await deps.assets.readOwnedAsset(auth, base.documentAsset, signal)); active(signal);
  const svgBytes = snapshot(await deps.assets.readOwnedAsset(auth, base.svgAsset, signal)); active(signal);
  const sourceBytes = snapshot(await deps.assets.readOwnedAsset(auth, base.sourcePreview, signal)); active(signal);
  const document = await verifyLogoVectorRevision({ revision: base, document: documentBytes, svg: svgBytes }, signal); active(signal);
  verifyLogoRasterSource(sourceBytes);
  if (!isDeepStrictEqual(sourceBytes.reference, base.sourcePreview) || !Buffer.from(canonicalLogoDocumentBytes(document)).equals(Buffer.from(canonicalLogoDocumentBytes(detail.document)))) throw new ApiError('integration_unavailable');
  const briefInputs = base.inputRevisions.filter(input => input.stage === 'brief_references');
  if (briefInputs.length !== 1) throw new ApiError('integration_unavailable');
  const brief = parseLogoStored(logoBriefRevisionSchema, await deps.readBriefRevision(auth, projectId, briefInputs[0]!.id, signal)); active(signal);
  const listed = parseLogoStored(z.array(fontRecordSchema).max(100), await deps.listFonts(auth, projectId, signal)); active(signal);
  if (new Set(listed.map(font => font.id)).size !== listed.length || listed.some(font => font.asset.ownerId !== owner || font.asset.projectId !== projectId)) throw new ApiError('not_found');
  const fonts: FontRecord[] = [];
  for (const font of listed) {
   if (!fontPurposeAllowed(font, 'render') || !fontPurposeAllowed(font, 'outline')) continue;
   const resolved = await deps.resolveFont(auth, font.id, 'outline', signal); active(signal);
   if (resolved.purpose !== 'outline' || !isDeepStrictEqual(font, resolved.record) || resolved.contentHash !== font.asset.contentHash || !(resolved.bytes instanceof Uint8Array) || sha256(resolved.bytes) !== font.asset.contentHash) throw new ApiError('integration_unavailable');
   fonts.push(structuredClone(font));
  }
  const context = buildLogoVectorProposalContext({ revision: base, document, brief, fonts, targetComponentIds: request.targetComponentIds });
  const evidence = { version: 1, request, context, baseRevision: base, brief, fonts };
  // Keep the existing source_inputs limit; do not enlarge quote/request ceilings.
  if (logoJsonBytes(evidence) > 1_048_576) throw new ApiError('invalid_input');
  await current(); active(signal);
  const acquired = await deps.connections.acquire(owner, signal); let failed = false;
  try {
   active(signal);
   if (acquired.binding.ownerId !== owner) throw new ApiError('not_found');
   const identity = parseLogoStored(principalSchema, (await acquired.connection.query('SELECT session_user::text AS role_name, pg_catalog.to_regrole(session_user)::oid::bigint AS role_oid')).rows[0]);
   if (identity.role_name !== acquired.binding.roleName || identity.role_oid !== acquired.binding.roleOid) throw new ApiError('integration_unavailable');
   active(signal);
   const response = await acquired.connection.query('SELECT fluid_private.quote_logo_vector_proposal($1::uuid,$2::jsonb) AS value', [projectId, JSON.stringify(evidence)]); active(signal);
   const row = parseLogoStored(z.strictObject({ value: z.unknown() }), response.rows[0]);
   const quote = parseLogoStored(logoCostQuoteSchema, row.value);
   if (quote.ownerId !== owner || quote.projectId !== projectId || !isDeepStrictEqual(quote.request, request)) throw new ApiError('integration_unavailable');
   return quote;
  } catch (error) { failed = true; throw logoDatabaseError(error); }
  finally { try { await acquired.connection.release(failed); } catch { try { await acquired.connection.discard(); } catch {} throw new ApiError('integration_unavailable'); } active(signal); }
 }
 return { quoteLogoVectorProposal };
}
