import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { proposalCompletionFixture } from './logo-vector-proposal-completion-fixture';
import { proposalLogin, WEB } from './logo-vector-proposal-admission-fixture';
import { proposalFixture, proposalHash } from '../features/logo-vector/proposal-fixtures';
import { applyLogoManualEdit } from '@/features/logo-vector/model/edits';
import { canonicalLogoDocumentBytes } from '@/features/logo-vector/model/canonical';
import { serializeLogoSvg } from '@/features/logo-vector/model/svg';
import { vectorMemberRequestKey } from '@/features/logo-vector/server/publication';
import type { TestDatabase } from './local-supabase';
export const materializationCandidates = await Promise.all(['logo-vector-proposals.sql','logo-vector-proposal-quotes.sql','logo-vector-proposal-admission.sql','logo-vector-proposal-observations.sql','logo-vector-proposal-completion.sql','logo-vector-proposal-materialization.sql'].map(name => readFile(new URL('../../supabase/candidates/' + name, import.meta.url), 'utf8').catch(error => { if (name === 'logo-vector-proposal-materialization.sql' && error.code === 'ENOENT') return ''; throw error; })));
export async function materializationFixture(db: TestDatabase, options: { finish?: boolean; cancel?: boolean; stage?: boolean; locked?: boolean; source?: ReturnType<typeof proposalFixture>; sourceRasterBytes?: Uint8Array } = {}) {
  const source = options.source ?? proposalFixture();
  if (options.locked) source.seal([source.document.components[1]!.id]);
  const f = await proposalCompletionFixture(db, { source });
  // Synthetic committed source metadata only; byte/font validation is covered by
  // the authenticated producer suite. These fixtures never contact Storage.
  const originalMembers = [
    { reference: source.revision.sourcePreview, mimeType: 'image/png', byteLength: options.sourceRasterBytes?.byteLength ?? 8, kind: 'concept', rights: null },
    { reference: source.revision.documentAsset, mimeType: 'application/json', byteLength: canonicalLogoDocumentBytes(source.document).length, kind: 'vector', rights: null },
    { reference: source.revision.svgAsset, mimeType: 'image/svg+xml', byteLength: serializeLogoSvg(source.document).length, kind: 'vector', rights: null },
    ...source.fonts.map(font => ({ reference: font.asset, mimeType: 'font/ttf', byteLength: 100, kind: 'font', rights: font.rights.id })),
  ];
  for (const member of originalMembers) {
    const { reference, mimeType, byteLength } = member, id = randomUUID(), key = randomUUID();
    const request = { kind: 'stage', publication: { requestKey: key, inputRevisions: source.revision.inputRevisions, mimeType, byteLength, contentHash: reference.contentHash, source: { kind: member.kind, sourceId: source.revision.id } } };
    await db.query(`insert into public.logo_asset_publications(id,owner_id,project_id,request_key,request,asset_id,version_id,content_hash,mime_type,byte_length,purpose,source_receipt_id,rights_evidence_id,source_kind,state,verification,input_revision,input_hash)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'brand_asset',$11,$12,$13,'staged',$14,1,$8)`,
    [id, reference.ownerId, reference.projectId, key, request, reference.assetId, reference.versionId, reference.contentHash, mimeType, byteLength, source.revision.id, member.rights, member.kind,
      { status: 'verified', checkedAt: '2026-10-08T00:00:00Z', contentHash: reference.contentHash, mimeType, byteLength }]);
    await db.query('select fluid_private.logo_commit_asset(r) from public.logo_asset_publications r where id=$1', [id]);
  }
  const prepared = await f.stage();
  if (options.cancel) await f.rpc('request_job_cancel', [f.j.id]);
  await f.complete('succeeded', 34, { version: 1, kind: 'logo_vector_proposal', preparedId: prepared.id, providerResponseReceiptId: prepared.providerResponseReceiptId });
  if (options.finish !== false) await f.finish(options.cancel ? 'cancelled' : 'succeeded');
  await db.exec(`grant execute on function fluid_private.read_logo_trusted_request(uuid,jsonb),fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb),fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid) to ${WEB};`);
  const command = { method: 'applyLogoVectorProposal', body: { requestKey: randomUUID(), expected: f.workspace.heads, baseVectorRevisionId: source.revision.id, proposalId: prepared.id } };
  const candidate = applyLogoManualEdit(source.document, { kind: 'rotation', componentId: source.document.components[0]!.id, degrees: 10 });
  const document = canonicalLogoDocumentBytes(candidate), svg = serializeLogoSvg(candidate), documentHash = proposalHash(document);
  const proof = { ...source.revision.proof, documentHash, svgContentHash: proposalHash(svg) };
  const web = <T>(run: () => Promise<T>) => proposalLogin(db, WEB, run);
  const publication = async (member: 'document' | 'svg', key = command.body.requestKey) => {
    const bytes = member === 'document' ? document : svg, mimeType = member === 'document' ? 'application/json' : 'image/svg+xml';
    const p = { requestKey: vectorMemberRequestKey(key, member), inputRevisions: source.revision.inputRevisions, mimeType, contentHash: proposalHash(bytes), byteLength: bytes.length, source: { kind: 'vector', sourceId: source.revision.id } };
    const reservation = await web(async () => (await db.query<{ v: { id: string } }>('select fluid_private.prepare_logo_asset($1,$2,null,null) v', [f.workspace.projectId, { kind: 'stage', publication: p }])).rows[0]!.v);
    await web(() => db.query('select fluid_private.observe_logo_asset($1,$2,null,null)', [reservation.id, { status: 'verified', checkedAt: '2026-10-08T00:00:00Z', contentHash: p.contentHash, mimeType, byteLength: bytes.length }]));
    return reservation.id;
  };
  const evidence = { proposalId: prepared.id, preparedId: prepared.id, providerResponseReceiptId: prepared.providerResponseReceiptId, baseVectorRevisionId: source.revision.id, contextHash: prepared.contextHash,
    baseRevision: source.revision, brief: source.brief, fonts: source.fonts, documentPublicationId: randomUUID() as string, svgPublicationId: randomUUID() as string, documentHash, proof, locks: source.revision.locks };
  const stage = async () => { evidence.documentPublicationId = await publication('document'); evidence.svgPublicationId = await publication('svg'); };
  if (options.stage !== false) await stage();
  const preflight = (c: unknown = command) => web(async () => (await db.query<{ v: unknown }>('select fluid_private.read_logo_trusted_request($1,$2) v', [f.workspace.projectId, c])).rows[0]!.v);
  const apply = (c: unknown = command, e: unknown = evidence) => web(async () => (await db.query<{ v: { revision: { id: string; payload: { vectorRevisionId: string } }; [key: string]: unknown } }>('select fluid_private.apply_logo_trusted_command($1,$2,$3) v', [f.workspace.projectId, c, e])).rows[0]!.v);
  const read = () => f.rpc('read_logo_vector_proposal_application', [f.workspace.projectId, prepared.id]);
  return { ...f, source, prepared, command, evidence, web, publication, stage, preflight, apply, read };
}
