import { afterAll, beforeAll, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createTestDatabase, asRole, OWNER_A, type TestDatabase } from './local-supabase';
import { materializationCandidates, materializationFixture } from './logo-vector-proposal-materialization-fixture';
import { WEB } from './logo-vector-proposal-admission-fixture';
import { proposalFixture, proposalHash } from '../features/logo-vector/proposal-fixtures';
import { syntheticConversionInput } from '../features/logo-vector/raster-fixtures';
import { canonicalLogoDocumentBytes, verifyLogoVectorRevision } from '@/features/logo-vector/server/revisions';
import { serializeLogoSvg } from '@/features/logo-vector/model/svg';
import { createLogoVectorProposalMutationProducer } from '@/features/logo-vector/server/proposal-mutations';
import { createLogoTransactionService, LogoUncertainCommitError } from '@/server/data/logo-transaction';
import { createIdentityAssetStore, createPostgresIdentityAssetBackend } from '@/server/data/identity-asset-store';
import { createLogoWorkspaceService } from '@/server/data/logo-workspace';
import { readLogoVectorProposalApplication } from '@/server/data/logo-vector-proposal-application';
import type { IdentityConnectionFactory } from '@/server/data/identity-transaction';
import type { AuthenticatedContext } from '@/server/auth/context';
import { logoBriefRevisionSchema, logoMutationReceiptSchema } from '@/domain/logo-workspace';
import { logoVectorDocumentSchema } from '@/domain/logo-vector';
import { completionLedger } from './logo-vector-proposal-completion-fixture';
let db: TestDatabase;
beforeAll(async () => { db = await createTestDatabase({ additionalMigrations: materializationCandidates }); }, 60_000);
afterAll(async () => { await db?.close(); });

/** The provider metadata is synthetic; actual canonical/SVG/raster bytes pass
 * through production readers, producer, asset store/backend and transaction.
 * Only the private object storage is an immutable in-memory local fixture. */
async function bridge(options: { cancelAfterStaging?: boolean; loseCommitResponse?: boolean } = {}) {
  const source = proposalFixture(), raster = syntheticConversionInput('combination').source.bytes;
  source.fonts = []; source.revision.sourcePreview.contentHash = proposalHash(raster); source.seal();
  const f = await materializationFixture(db, { stage: false, source, sourceRasterBytes: raster });
  const roleOid = (await db.query<{ oid: number }>('select oid from pg_roles where rolname=$1', [WEB])).rows[0]!.oid;
  let busy = false, loseCommit = options.loseCommitResponse === true, committed = 0;
  const factory: IdentityConnectionFactory = { async acquire(owner, signal) {
    if (owner !== OWNER_A || signal?.aborted || busy) throw Error('Invalid fixture connection acquisition');
    busy = true; await db.exec(`set session authorization ${WEB}`); let released = false;
    const release = async () => { if (!released) { released = true; await db.exec('set session authorization postgres'); busy = false; } };
    return { binding: { ownerId: OWNER_A, roleName: WEB, roleOid }, connection: {
      async query(sql, parameters) { const result = await db.query(sql, parameters ? [...parameters] : []); if (sql === 'COMMIT') { committed++; if (loseCommit) { loseCommit = false; throw Error('Synthetic lost committed response'); } } return result; }, release, discard: release,
    } };
  } };
  const allowed = new Set(['read_logo_asset','read_logo_vector_proposal_application','get_logo_workspace','read_logo_current_vector','read_logo_workspace_record']);
  const auth = { userId: OWNER_A, client: { rpc(name: string, args: Record<string, unknown>) {
    if (!allowed.has(name)) throw Error(`Unexpected fixture RPC ${name}`);
    const request = asRole(db, 'authenticated', OWNER_A, async () => {
      try { return { data: (await db.query<{ v: unknown }>(`select public.${name}(${Object.keys(args).map((key, index) => `${key}=>$${index + 1}`).join(',')}) v`, Object.values(args))).rows[0]!.v, error: null }; }
      catch (error) { return { data: null, error }; }
    });
    return Object.assign(request, { abortSignal: () => request });
  } } } as unknown as AuthenticatedContext;
  const blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const path = (ref: typeof source.revision.sourcePreview) => `${ref.ownerId}/${ref.projectId}/${ref.assetId}/${ref.versionId}`;
  blobs.set(path(source.revision.sourcePreview), { bytes: raster, mimeType: 'image/png' });
  blobs.set(path(source.revision.documentAsset), { bytes: canonicalLogoDocumentBytes(source.document), mimeType: 'application/json' });
  blobs.set(path(source.revision.svgAsset), { bytes: serializeLogoSvg(source.document), mimeType: 'image/svg+xml' });
  let reads = 0, staged = 0;
  const store = createIdentityAssetStore({ backend: createPostgresIdentityAssetBackend({ owned: factory, worker: null }), storage: {
    async putIfAbsent(key, bytes, mimeType) { const old = blobs.get(key); if (old && (old.mimeType !== mimeType || !Buffer.from(old.bytes).equals(Buffer.from(bytes)))) throw Error('Immutable storage conflict'); if (!old) blobs.set(key, { bytes: Uint8Array.from(bytes), mimeType }); },
    async read(key) { reads++; const value = blobs.get(key); if (!value) throw Error('Missing local immutable object'); return { ...value, bytes: Uint8Array.from(value.bytes) }; },
  } });
  const stage = store.stageOwnedAsset;
  store.stageOwnedAsset = async (...args) => {
    const result = await stage(...args); staged++;
    if (options.cancelAfterStaging && staged === 2) await f.rpc('cancel_logo_vector_edit', [f.workspace.projectId, f.command]);
    return result;
  };
  const workspace = createLogoWorkspaceService({ assetStore: store, verifyVectorRevision: verifyLogoVectorRevision });
  const producer = vi.fn(createLogoVectorProposalMutationProducer({ assetStore: store, readApplication: readLogoVectorProposalApplication,
    getWorkspace: workspace.getLogoWorkspace, readCurrentVectorRevisionId: workspace.readLogoCurrentVectorRevisionId, readVectorDetail: workspace.readLogoVectorDetail,
    textEdits: {
      readBriefRevision: async (owner, project, id, signal) => logoBriefRevisionSchema.parse(await workspace.getLogoStageRevision(owner, project, 'brief_references', id, signal)),
      readConceptBatch: workspace.readLogoConceptBatch, readRasterRefinement: workspace.readLogoRasterRefinement,
      listFonts: async () => [], resolveFont: async () => { throw Error('Geometry proposal must not request font shaping'); },
    },
  }));
  const transaction = createLogoTransactionService(factory, { applyLogoVectorProposal: producer });
  return { ...f, auth, store, blobs, producer, transaction, counts: () => ({ reads, staged, committed, busy }), run: () => transaction.run(auth, f.workspace.projectId, f.command) };
}
it('bridges verified actual bytes through producer, real staging and CAS, then replays before any byte or producer I/O', async () => {
  const f = await bridge(), before = await completionLedger(db, f.j.id), receipt = logoMutationReceiptSchema.parse(await f.run());
  expect(receipt.revision.stage).toBe('refinements'); if (receipt.revision.stage !== 'refinements') throw Error('Wrong stage');
  const vector = await createLogoWorkspaceService({ assetStore: f.store, verifyVectorRevision: verifyLogoVectorRevision }).readLogoVectorDetail(f.auth, f.workspace.projectId, receipt.revision.payload.vectorRevisionId!);
  expect(vector.document.components[0]!.transform.rotation).toBe(10); expect(vector.document.components[1]).toEqual(f.source.document.components[1]);
  expect(vector.revision.parentRevisionId).toBe(f.source.revision.id); expect(vector.revision.reviewStatus).toBe('review_required');
  expect(logoVectorDocumentSchema.parse(JSON.parse(new TextDecoder().decode((await f.store.readOwnedAsset(f.auth, vector.revision.documentAsset)).bytes)))).toEqual(vector.document);
  const counts = f.counts(); expect(await f.run()).toEqual(receipt); expect(f.counts()).toEqual(counts); expect(f.producer).toHaveBeenCalledTimes(1);
  expect(await f.read()).toMatchObject({ eligible: false, materialization: { vectorRevisionId: vector.revision.id } });
  expect(await completionLedger(db, f.j.id)).toEqual(before); expect(f.counts().busy).toBe(false);
});
it('actual staged bytes cannot cross an exact cancellation tombstone into immutable asset or vector history', async () => {
  const f = await bridge({ cancelAfterStaging: true }), before = await completionLedger(db, f.j.id);
  await expect(f.run()).rejects.toMatchObject({ code: 'conflict' });
  expect(f.counts()).toMatchObject({ staged: 2, committed: 0, busy: false }); expect(f.blobs.size).toBe(5);
  expect((await db.query("select state,count(*)::int n from public.logo_asset_publications group by state order by state")).rows).toEqual([{ state: 'committed', n: 3 }, { state: 'staged', n: 2 }]);
  expect((await db.query('select count(*)::int n from public.asset_versions')).rows).toEqual([{ n: 3 }]);
  expect((await db.query('select count(*)::int n from public.logo_vector_revisions')).rows).toEqual([{ n: 1 }]);
  expect(await f.rpc('read_logo_vector_edit_request', [f.workspace.projectId, f.command.body.requestKey])).toMatchObject({ status: 'cancelled', command: f.command });
  expect(await completionLedger(db, f.j.id)).toEqual(before);
});
it('a lost COMMIT response recovers the original association and receipt without recomputing or charging again', async () => {
  const f = await bridge({ loseCommitResponse: true }), before = await completionLedger(db, f.j.id);
  await expect(f.run()).rejects.toBeInstanceOf(LogoUncertainCommitError);
  const counts = f.counts(), recovered = logoMutationReceiptSchema.parse(await f.run());
  expect(f.producer).toHaveBeenCalledTimes(1); expect(f.counts()).toEqual(counts);
  expect(await f.rpc('read_logo_vector_edit_request', [f.workspace.projectId, f.command.body.requestKey])).toMatchObject({ status: 'succeeded', command: f.command, receipt: recovered });
  expect(await completionLedger(db, f.j.id)).toEqual(before);
});
