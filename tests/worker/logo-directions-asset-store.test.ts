import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createLogoDirectionsAssetStore } from '../../worker/logo-directions-asset-store';
import type { LogoDirectionsStorageAuthorization } from '../../worker/logo-directions-storage-authorization';
import type { IdentityAssetReservation } from '../../src/server/data/identity-asset-store';
import { subscriptionFixture } from '../features/identity-directions/subscription-fixtures';
import { fontBytes } from '../features/identity-directions/fixtures';
const uuid = randomUUID;
function fixture() {
  const f = subscriptionFixture(), reference = f.input.permittedFonts[0]!.asset, bytes = fontBytes();
  const row: IdentityAssetReservation = { id: uuid(), requestKey: uuid(), reference, storagePath: `${reference.ownerId}/${reference.projectId}/${reference.assetId}/${reference.versionId}`, mimeType: 'font/ttf', byteLength: bytes.length, purpose: 'brand_asset', rightsEvidenceId: f.input.permittedFonts[0]!.rights.id, sourceReceiptId: uuid(), publicationState: 'committed' };
  const events: string[] = []; const state = { live: true, afterRead: undefined as undefined | (() => void), row, availableJob: undefined as unknown };
  const live = () => { if (!state.live) throw Error('Synthetic lease revoked'); };
  const capability = { operation: 'identity.logo_directions' as const, policyIdentity: 'b'.repeat(64), handlerVersion: f.policy.handlerVersion, provider: 'openai', model: f.policy.model, engine: null, maxCostMicrousd: 0, billingMode: 'chatgpt_subscription' as const, policy: f.policy };
  const authorization: LogoDirectionsStorageAuthorization = { ownerId: f.job.ownerId, capability, close() {}, async assertAvailable(job) { events.push('probe'); live(); state.availableJob = job; }, async authorizeRead(scope) { events.push('authorize'); live(); expect(scope.reservation).toEqual(row); return { async read() { events.push('read'); live(); state.afterRead?.(); return { bytes, mimeType: row.mimeType }; } }; } };
  const connection = { async query<Row>(sql: string) { events.push(sql); live(); expect(sql).toContain('read_logo_asset_publication'); return { rows: [{ value: state.row }] as Row[] }; } };
  const options = { connection, authorization }, store = createLogoDirectionsAssetStore(options)!;
  return { ...f, reference, bytes, row, state, events, options, store };
}
describe('read-only directions asset store', () => {
  it('requires injected concrete capability and has no construction I/O', () => { const f = fixture(); expect(f.store).not.toBeNull(); expect(f.events).toEqual([]); expect(createLogoDirectionsAssetStore()).toBeNull(); expect(createLogoDirectionsAssetStore({ ...f.options, connection: null })).toBeNull(); expect(createLogoDirectionsAssetStore({ ...f.options, authorization: null })).toBeNull(); });
  it('uses exact per-call reservation and shared post-read lease recheck', async () => { const f = fixture(); const file = await f.store.readLeasedAsset(f.job, f.reference); expect(file.bytes).toEqual(f.bytes); expect(file.reference).toEqual(f.reference); expect(f.events.filter(e => e.includes('read_logo_asset_publication'))).toHaveLength(2); expect(f.events.filter(e => e === 'authorize')).toHaveLength(1); });
  it('denies staged, foreign owner/operation and revoked post-read metadata', async () => { const f = fixture(); f.row.publicationState = 'staged'; await expect(f.store.readLeasedAsset(f.job, f.reference)).rejects.toThrow(); expect(f.events).not.toContain('read'); f.row.publicationState = 'committed'; f.state.afterRead = () => { f.state.live = false; }; await expect(f.store.readLeasedAsset(f.job, f.reference)).rejects.toThrow(); });
  it('retains throwing compatibility methods without any write or owner capability', async () => { const f = fixture(); for (const key of ['publishLeasedAsset', 'publishOwnedUpload', 'stageOwnedAsset', 'readOwnedAsset'] as const) { await expect((f.store[key] as (...args: unknown[]) => Promise<unknown>)()).rejects.toThrow(); } expect(f.events).toEqual([]); });
  it('snapshots the job before deferred I/O and rejects a capability mismatch before reading', async () => { const f = fixture(); for (const patch of [{ ownerId: uuid() }, { operation: 'identity.logo_export' }, { actualCostMicrousd: 1 }, { input: { ...f.job.input as object, policyIdentity: 'c'.repeat(64) } }]) await expect(f.store.readLeasedAsset({ ...f.job, ...patch }, f.reference)).rejects.toThrow(); expect(f.events).toEqual([]); const pending = f.store.readLeasedAsset(f.job, f.reference); const id = f.job.id; f.job.id = uuid(); await pending; expect(f.state.availableJob).toHaveProperty('id', id); });
  it('keeps concurrent projects in separate per-call capabilities', async () => {
    const f = fixture(), other = structuredClone(f.job), second = structuredClone(f.row); other.id = uuid(); other.projectId = uuid(); (other.input as Record<string, unknown>).projectId = other.projectId;
    second.id = uuid(); second.reference.projectId = other.projectId; second.storagePath = `${second.reference.ownerId}/${other.projectId}/${second.reference.assetId}/${second.reference.versionId}`;
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const reads: string[] = [];
    const connection = { async query<Row>(_sql: string, args: unknown[] = []) { const row = args[0] === other.projectId ? second : f.row; return { rows: [{ value: row }] as Row[] }; } };
    const authorization: LogoDirectionsStorageAuthorization = { ...f.options.authorization, async assertAvailable() {}, async authorizeRead({ job, reservation }) {
      if (job.id === f.job.id) await wait; else release();
      expect(reservation.reference.projectId).toBe(job.projectId); const path = reservation.storagePath;
      return { async read() { reads.push(path); return { bytes: f.bytes, mimeType: 'font/ttf' }; } };
    } };
    const store = createLogoDirectionsAssetStore({ connection, authorization })!;
    const result = await Promise.all([store.readLeasedAsset(f.job, f.reference), store.readLeasedAsset(other, second.reference)]);
    expect(result.map(v => v.reference.projectId)).toEqual([f.job.projectId, other.projectId]); expect(reads.sort()).toEqual([f.row.storagePath, second.storagePath].sort());
  });

});
