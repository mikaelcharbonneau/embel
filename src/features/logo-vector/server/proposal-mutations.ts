import 'server-only';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { fontRecordSchema, type FontRecord, type PermittedFont } from '@/domain/logo-directions';
import { logoVectorDetailSchema, type LogoVectorDetail, type VerifiedAssetBytes } from '@/domain/logo-deliverables';
import { logoBriefRevisionSchema, logoWorkspaceV2Schema, type LogoWorkspaceV2 } from '@/domain/logo-workspace';
import type { LogoVectorDocument, LogoVectorComponent } from '@/domain/logo-vector';
import type { LogoVectorProposalEdit } from '@/domain/logo-vector-proposals';
import type { AuthenticatedContext } from '@/server/auth/context';
import type { IdentityAssetStore } from '@/server/data/identity-asset-store';
import { logoId, logoOwner, parseLogoInput, parseLogoStored, type LogoMutationProducer } from '@/server/data/logo-transaction';
import { ApiError } from '@/server/http/errors';
import { fontPurposeAllowed } from '@/features/identity-directions/model/font-rights';
import { applyLogoVectorProposalCommandSchema, logoVectorProposalApplicationSchema, type LogoVectorProposalApplication } from '../model/proposal-materialization';
import { LogoVectorError } from '../model/errors';
import { applyLogoManualEdit } from '../model/edits';
import { validateLogoVectorProposal } from '../model/proposal';
import { assertLogoConversionNotAborted, verifyLogoRasterSource } from './converter';
import { canonicalLogoDocumentBytes, verifyLogoVectorRevision } from './revisions';
import { buildLogoVectorProposalContext } from './proposal-context';
import { applyLogoTextEdit, type LogoTextEditDependencies } from './text-edits';
import { stageLogoVectorEditCandidate } from './prepare-edit';

export type LogoVectorProposalMutationDependencies = {
 assetStore: IdentityAssetStore;
 textEdits: LogoTextEditDependencies;
 readApplication(auth: AuthenticatedContext, projectId: string, proposalId: string, signal?: AbortSignal): Promise<LogoVectorProposalApplication>;
 getWorkspace(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal): Promise<LogoWorkspaceV2>;
 readCurrentVectorRevisionId(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal): Promise<string | null>;
 readVectorDetail(auth: AuthenticatedContext, projectId: string, revisionId: string, signal?: AbortSignal): Promise<LogoVectorDetail>;
};
const mismatch = (): never => { throw new LogoVectorError('source_mismatch', 'The proposal must use its exact owned saved vector, source, brief and permitted fonts.'); };
const snapshot = (file: VerifiedAssetBytes): VerifiedAssetBytes => ({ ...structuredClone({ ...file, bytes: undefined }), bytes: Uint8Array.from(file.bytes) });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Independent narrow-output check; geometry, painting, spelling, component IDs
 * and root mapping outside the one allowed control may not change. */
export function assertLogoProposalCandidatePreservation(base: LogoVectorDocument, candidate: LogoVectorDocument, edit: LogoVectorProposalEdit): void {
 if (base.version !== candidate.version || !isDeepStrictEqual(base.viewBox, candidate.viewBox) || base.components.length !== candidate.components.length) return mismatch();
 const expected = structuredClone(base), byId = new Map(candidate.components.map(component => [component.id, component]));
 if (byId.size !== base.components.length || base.components.some(component => !byId.has(component.id))) return mismatch();
 const target = (id: string): LogoVectorComponent => { const item = expected.components.find(component => component.id === id); if (!item) return mismatch(); return item; };
 if (edit.kind === 'arrangement') {
  for (const placement of edit.placements) target(placement.componentId).transform = { ...placement.transform };
  const parts = new Map(expected.components.map(component => [component.id, component]));
  expected.components = edit.order.map(id => { const component = parts.get(id); if (!component) return mismatch(); return component; });
 } else {
  const component = target(edit.componentId), after = byId.get(edit.componentId)!;
  if (edit.kind === 'size') component.transform.scale = edit.scale;
  else if (edit.kind === 'rotation') component.transform.rotation = edit.degrees;
  else if (edit.kind === 'color') {
   component.paths = component.paths.map(path => ({ ...path, fill: path.fill ? { ...path.fill, color: edit.fill! } : null, stroke: path.stroke ? { ...path.stroke, color: edit.stroke! } : null }));
  } else {
   if (component.editingKind !== 'editable_text' || after.editingKind !== 'editable_text') return mismatch();
   component.paths = structuredClone(after.paths);
   if (edit.kind === 'font') { component.textSource.font = { ...after.textSource.font }; component.textSource.rightsEvidenceId = after.textSource.rightsEvidenceId; }
   else { component.textSource.letterSpacing = edit.letterSpacing; component.textSource.lineHeight = edit.lineHeight; }
  }
 }
 if (!isDeepStrictEqual(expected, candidate) || Buffer.from(canonicalLogoDocumentBytes(base)).equals(Buffer.from(canonicalLogoDocumentBytes(candidate)))) return mismatch();
}

/** Distinct authenticated producer. Original-body replay is owned by the existing
 * transaction service before this is invoked. No provider/worker capability exists here. */
export function createLogoVectorProposalMutationProducer(deps: LogoVectorProposalMutationDependencies) {
 return async (...args: Parameters<LogoMutationProducer>) => {
  const [auth, rawProjectId, rawCommand, optionalSignal] = args, signal = optionalSignal ?? new AbortController().signal;
  const owner = logoOwner(auth), projectId = logoId(rawProjectId), command = parseLogoInput(applyLogoVectorProposalCommandSchema, rawCommand);
  function active() { assertLogoConversionNotAborted(signal); if (logoOwner(auth) !== owner) throw new ApiError('unauthenticated'); }
  active();
  const application = parseLogoStored(logoVectorProposalApplicationSchema, await deps.readApplication(auth, projectId, command.body.proposalId, signal)); active();
  const proposal = application.proposal;
  if (proposal.ownerId !== owner || proposal.projectId !== projectId || proposal.id !== command.body.proposalId) throw new ApiError('not_found');
  if (application.materialization !== null) throw new ApiError('conflict');
  if (!application.eligible || application.preparedId !== proposal.id || application.providerResponseReceiptId !== proposal.providerReceipt?.id || proposal.state !== 'succeeded' || proposal.payload?.status !== 'proposed') throw new ApiError('conflict');
  if (proposal.baseVectorRevisionId !== command.body.baseVectorRevisionId || !isDeepStrictEqual(proposal.expected, command.body.expected)) throw new ApiError('conflict');
  const payload = validateLogoVectorProposal(proposal.payload, proposal.context);
  if (payload.status !== 'proposed') throw new ApiError('conflict');
  async function current() {
   const workspace = parseLogoStored(logoWorkspaceV2Schema, await deps.getWorkspace(auth, projectId, signal)); active();
   if (workspace.ownerId !== owner || workspace.projectId !== projectId) throw new ApiError('not_found');
   if (!isDeepStrictEqual(workspace.heads, command.body.expected) || workspace.stages.brief_references?.id !== proposal.context.brief.id || workspace.stages.brief_references.revision !== proposal.context.brief.revision) throw new ApiError('conflict');
   const id = await deps.readCurrentVectorRevisionId(auth, projectId, signal); active();
   if (id !== proposal.baseVectorRevisionId) throw new ApiError('conflict');
  }
  await current();
  const detail = parseLogoStored(logoVectorDetailSchema, await deps.readVectorDetail(auth, projectId, proposal.baseVectorRevisionId, signal)); active();
  const revision = detail.revision;
  if (revision.ownerId !== owner || revision.projectId !== projectId || revision.id !== proposal.baseVectorRevisionId) throw new ApiError('not_found');
  const documentBytes = snapshot(await deps.assetStore.readOwnedAsset(auth, revision.documentAsset, signal)); active();
  const svgBytes = snapshot(await deps.assetStore.readOwnedAsset(auth, revision.svgAsset, signal)); active();
  const source = snapshot(await deps.assetStore.readOwnedAsset(auth, revision.sourcePreview, signal)); active();
  const document = await verifyLogoVectorRevision({ revision, document: documentBytes, svg: svgBytes }, signal); active();
  verifyLogoRasterSource(source);
  if (!isDeepStrictEqual(source.reference, revision.sourcePreview) || !isDeepStrictEqual(detail.sourcePreview.reference, revision.sourcePreview) || !isDeepStrictEqual(document, detail.document)) return mismatch();
  const refs = revision.inputRevisions.filter(ref => ref.stage === 'brief_references');
  if (refs.length !== 1) return mismatch();
  const brief = parseLogoStored(logoBriefRevisionSchema, await deps.textEdits.readBriefRevision(auth, projectId, refs[0]!.id, signal)); active();
  const listed = parseLogoStored(z.array(fontRecordSchema).max(100), await deps.textEdits.listFonts(auth, projectId, signal)); active();
  if (new Set(listed.map(font => font.id)).size !== listed.length || listed.some(font => font.asset.ownerId !== owner || font.asset.projectId !== projectId)) return mismatch();
  const fonts: FontRecord[] = [], resolvedFonts = new Map<string, PermittedFont>();
  for (const font of listed) {
   if (!fontPurposeAllowed(font, 'render') || !fontPurposeAllowed(font, 'outline')) continue;
   const resolved = await deps.textEdits.resolveFont(auth, font.id, 'outline', signal); active();
   if (!resolved || resolved.purpose !== 'outline' || !isDeepStrictEqual(font, resolved.record) || !(resolved.bytes instanceof Uint8Array) || resolved.contentHash !== font.asset.contentHash || hash(resolved.bytes) !== font.asset.contentHash) return mismatch();
   fonts.push(structuredClone(font)); resolvedFonts.set(font.id, { ...structuredClone({ ...resolved, bytes: undefined }), bytes: Uint8Array.from(resolved.bytes) });
  }
  const context = buildLogoVectorProposalContext({ revision, document, brief, fonts, targetComponentIds: proposal.context.targetComponentIds });
  if (!isDeepStrictEqual(context, proposal.context)) return mismatch();
  const edit = payload.edit;
  const textDeps: LogoTextEditDependencies = { ...deps.textEdits, readBriefRevision: async () => structuredClone(brief), listFonts: async () => structuredClone(fonts), resolveFont: async (_auth, id, purpose) => {
   active(); const font = resolvedFonts.get(id); if (!font || purpose !== 'outline') return mismatch();
   return { ...structuredClone({ ...font, bytes: undefined }), bytes: Uint8Array.from(font.bytes) };
  } };
  const candidate = edit.kind === 'font' || edit.kind === 'spacing'
   ? await applyLogoTextEdit({ auth, projectId, revision, document, edit }, textDeps, signal) : applyLogoManualEdit(document, edit);
  active(); assertLogoProposalCandidatePreservation(document, candidate, edit);
  await current();
  const evidence = await stageLogoVectorEditCandidate({ auth, projectId, requestKey: command.body.requestKey, revision, document, candidate, source, locks: revision.locks }, deps.assetStore, signal);
  active(); await current();
  return { ...evidence, proposalId: proposal.id, preparedId: application.preparedId!, providerResponseReceiptId: application.providerResponseReceiptId!, contextHash: proposal.contextHash, baseRevision: revision, brief, fonts };
 };
}
