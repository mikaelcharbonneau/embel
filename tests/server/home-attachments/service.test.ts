import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createHomeAttachmentService, type HomeAttachmentBackend, type HomeAttachmentReservation } from '@/server/home-attachments';
import { PROPOSED_HOME_ATTACHMENT_POLICY, type AttachedProjectDraftInput, type AttachedProjectDraftReceipt, type OwnedAttachmentRef } from '@/domain/attachments';
import { contextSnapshotSchema } from '@/domain/projects';
import type { AuthenticatedContext } from '@/server/auth/context';
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const auth = { userId: owner } as AuthenticatedContext;
const bytes = new TextEncoder().encode('The exact frozen brief');
const input = () => ({ requestKey: randomUUID(), name: 'brief.txt', mimeType: 'text/plain' as const, contentHash: createHash('sha256').update(bytes).digest('hex') });
function fixture() {
 const rows = new Map<string, HomeAttachmentReservation>(), objects = new Map<string, { bytes: Uint8Array; mimeType: string }>(), receipts = new Map<string, AttachedProjectDraftReceipt>();
 let writes = 0, saves = 0;
 const backend: HomeAttachmentBackend = {
  async prepare(a, i, byteLength) {
   const existing = [...rows.values()].find(r => r.ref.ownerId === a.userId && r.requestKey === i.requestKey);
   if (existing) { if (existing.ref.name !== i.name || existing.ref.contentHash !== i.contentHash || existing.ref.byteLength !== byteLength) throw Object.assign(Error(), { code: 'conflict' }); return structuredClone(existing); }
   const id = randomUUID(), blobVersionId = randomUUID();
   const ref: OwnedAttachmentRef = { id, blobVersionId, ownerId: a.userId, projectId: null, projectRevision: null, contentHash: i.contentHash, mimeType: i.mimeType, byteLength, name: i.name, sourceReceiptId: randomUUID(), state: 'staged' };
   const row = { requestKey: i.requestKey, storagePath: `${a.userId}/home/${id}/${blobVersionId}`, ref, verified: false }; rows.set(id, row); return structuredClone(row);
  },
  async lookup(a, key) { return structuredClone([...rows.values()].find(r => r.ref.ownerId === a.userId && r.requestKey === key) ?? null); },
  async observe(a, id, observation) { const r = rows.get(id)!; if (r.ref.ownerId !== a.userId || observation.contentHash !== r.ref.contentHash) throw Error('owner'); r.verified = true; return structuredClone({ ...r.ref, projectId: null, projectRevision: null, state: 'staged' as const }); },
  async resolve(a, ids) { return ids.map(id => { const row = rows.get(id); if (!row || row.ref.ownerId !== a.userId) throw Error('missing'); return structuredClone(row); }); },
  async save(a, i) {
   const old = receipts.get(i.requestKey); if (old) return structuredClone(old);
   saves++; const id = randomUUID(); const attachments = i.attachmentIds.map(key => { const r = rows.get(key)!; r.ref = { ...r.ref, projectId: id, projectRevision: 1, state: 'linked' }; return r.ref; });
   const result = { ownerId: a.userId, requestKey: i.requestKey, project: { id, owner_id: a.userId, ...i.project, current_revision: 1, created_at: '2026-10-07T00:00:00Z' }, attachments }; receipts.set(i.requestKey, structuredClone(result)); return structuredClone(result);
  },
  async lookupProject(_a, key) { const receipt = receipts.get(key); return receipt ? { status: 'committed', receipt: structuredClone(receipt) } : { status: 'not_found' }; },
 };
 const storage = { async putIfAbsent(path: string, b: Uint8Array, mimeType: string) { writes++; if (!objects.has(path)) objects.set(path, { bytes: b.slice(), mimeType }); }, async read(path: string) { const value = objects.get(path); if (!value) return null; return { ...value, bytes: value.bytes.slice() }; } };
 const service = createHomeAttachmentService({ backend, storage, policy: PROPOSED_HOME_ATTACHMENT_POLICY });
 const draft = (attachmentIds: string[]): AttachedProjectDraftInput => ({ requestKey: randomUUID(), project: { scope: 'complete_brand', title: 'Frozen title', context: contextSnapshotSchema.parse({ description: 'Frozen brief' }) }, attachmentIds });
 return { service, backend, storage, rows, objects, draft, counts: () => ({ writes, saves }) };
}
describe('owner-only Home byte staging and atomic save', () => {
 it('stores verified private bytes with no project and exact-key replay', async () => {
  const f = fixture(), i = input(); const ref = await f.service.stageHomeAttachment(auth, i, bytes);
  expect(ref).toMatchObject({ ownerId: owner, state: 'staged', projectId: null, projectRevision: null });
  expect(await f.service.stageHomeAttachment(auth, i, bytes)).toEqual(ref);
  expect(f.rows.size).toBe(1); expect(f.counts().saves).toBe(0);
  expect(await f.service.readHomeAttachmentRequest(auth, i.requestKey)).toEqual({ status: 'committed', receipt: ref });
  expect(await f.service.readHomeAttachmentRequest({ userId: other } as AuthenticatedContext, i.requestKey)).toEqual({ status: 'not_found' });
 });
 it('rejects malformed bytes before metadata writes', async () => {
  const f = fixture(); await expect(f.service.stageHomeAttachment(auth, input(), new Uint8Array([1]))).rejects.toMatchObject({ code: 'invalid_input' }); expect(f.rows.size).toBe(0);
 });
 it('freezes caller bytes before asynchronous work', async () => {
  const f = fixture(), supplied = bytes.slice(), original = f.backend.prepare;
  f.backend.prepare = async (...args) => { supplied.fill(0); return original(...args); };
  await f.service.stageHomeAttachment(auth, input(), supplied); expect([...f.objects.values()][0]!.bytes).toEqual(bytes);
 });
 it('does not expose foreign or arbitrary-path reservations to storage', async () => {
  const f = fixture(), prepare = f.backend.prepare;
  f.backend.prepare = async (...args) => ({ ...await prepare(...args), storagePath: `${other}/home/forged` });
  await expect(f.service.stageHomeAttachment(auth, input(), bytes)).rejects.toMatchObject({ code: 'not_found' }); expect(f.counts().writes).toBe(0);
 });
 it('retains partial upload and reconciles a lost observe acknowledgement without another object', async () => {
  const f = fixture(), observe = f.backend.observe, i = input();
  f.backend.observe = async (...args) => { await observe(...args); throw Error('lost acknowledgement'); };
  await expect(f.service.stageHomeAttachment(auth, i, bytes)).rejects.toMatchObject({ name: 'HomeAttachmentUncertainError', requestKey: i.requestKey });
  f.backend.observe = observe;
  const result = await f.service.readHomeAttachmentRequest(auth, i.requestKey); expect(result.status).toBe('committed'); expect(f.objects.size).toBe(1);
 });
 it('reports missing object as pending and reconciles a written unobserved object', async () => {
  const f = fixture(), i = input(), row = await f.backend.prepare(auth, i, bytes.length);
  expect(await f.service.readHomeAttachmentRequest(auth, i.requestKey)).toEqual({ status: 'pending', requestKey: i.requestKey });
  await f.storage.putIfAbsent(row.storagePath, bytes, i.mimeType);
  expect((await f.service.readHomeAttachmentRequest(auth, i.requestKey)).status).toBe('committed');
 });
 it('rejects corrupt stored bytes and never converts metadata to verified success', async () => {
  const f = fixture(), read = f.storage.read; f.storage.read = async p => { const r = await read(p); return r && { ...r, bytes: new Uint8Array([0]) }; };
  await expect(f.service.stageHomeAttachment(auth, input(), bytes)).rejects.toMatchObject({ name: 'HomeAttachmentUncertainError' }); expect([...f.rows.values()][0]!.verified).toBe(false);
 });
 it('atomically saves all verified files with the frozen draft and replays one project', async () => {
  const f = fixture(), refs = await Promise.all([f.service.stageHomeAttachment(auth, input(), bytes), f.service.stageHomeAttachment(auth, input(), bytes)]), i = f.draft(refs.map(r => r.id));
  const receipt = await f.service.saveAttachedProjectDraft(auth, i); expect(receipt.project.context).toEqual(i.project.context); expect(receipt.attachments.map(r => r.id)).toEqual(i.attachmentIds);
  expect(await f.service.saveAttachedProjectDraft(auth, i)).toEqual(receipt); expect(f.counts().saves).toBe(1);
  await expect(f.service.saveAttachedProjectDraft(auth, { ...i, project: { ...i.project, title: 'Changed' } })).rejects.toMatchObject({ code: 'conflict' });
 });
 it('does not create a project with unverified, linked, foreign or corrupt files', async () => {
  const f = fixture(), i = input(), row = await f.backend.prepare(auth, i, bytes.length);
  await expect(f.service.saveAttachedProjectDraft(auth, f.draft([row.ref.id]))).rejects.toMatchObject({ code: 'conflict' });
  const ref = await f.service.stageHomeAttachment(auth, i, bytes); f.objects.get(row.storagePath)!.bytes.fill(0);
  await expect(f.service.saveAttachedProjectDraft(auth, f.draft([ref.id]))).rejects.toBeDefined(); expect(f.counts().saves).toBe(0);
 });
 it('retains a lost project acknowledgement for exact-key recovery', async () => {
  const f = fixture(), ref = await f.service.stageHomeAttachment(auth, input(), bytes), i = f.draft([ref.id]), save = f.backend.save;
  f.backend.save = async (...args) => { await save(...args); throw Error('lost'); };
  await expect(f.service.saveAttachedProjectDraft(auth, i)).rejects.toMatchObject({ name: 'HomeAttachmentUncertainError', requestKey: i.requestKey });
  expect((await f.service.readAttachedProjectDraftRequest(auth, i.requestKey)).status).toBe('committed'); expect(f.counts().saves).toBe(1);
 });
 it('keeps capability unavailable until private storage and metadata are configured', async () => {
  const service = createHomeAttachmentService(null); expect(service.getHomeAttachmentCapability()).toBeNull();
  await expect(service.stageHomeAttachment(auth, input(), bytes)).rejects.toMatchObject({ code: 'integration_unavailable' });
 });
 it('advertises only the available bounded validators, excluding the proposed PDF type', async () => {
  const f = fixture(); expect(f.service.getHomeAttachmentCapability()?.allowedMimeTypes).toEqual(['text/plain','image/png','image/jpeg']);
  await expect(f.service.stageHomeAttachment(auth, { ...input(), mimeType: 'application/pdf' }, bytes)).rejects.toMatchObject({ code: 'integration_unavailable' });
  expect(f.rows.size).toBe(0); expect(f.counts().writes).toBe(0);
 });
 it('a PDF-only configuration has no available capability', async () => {
  const f = fixture(); const service = createHomeAttachmentService({ backend: f.backend, storage: f.storage, policy: { ...PROPOSED_HOME_ATTACHMENT_POLICY, allowedMimeTypes: ['application/pdf'] } });
  expect(service.getHomeAttachmentCapability()).toBeNull();
  await expect(service.stageHomeAttachment(auth, { ...input(), mimeType: 'application/pdf' }, bytes)).rejects.toMatchObject({ code: 'integration_unavailable' });
 });

 it('cannot recover or finalize a previously verified PDF through stored receipt paths', async () => {
  const f = fixture(), i = input(), ref = await f.service.stageHomeAttachment(auth, i, bytes);
  f.rows.get(ref.id)!.ref.mimeType = 'application/pdf';
  await expect(f.service.readHomeAttachmentRequest(auth, i.requestKey)).rejects.toMatchObject({ code: 'integration_unavailable' });
  await expect(f.service.saveAttachedProjectDraft(auth, f.draft([ref.id]))).rejects.toMatchObject({ code: 'integration_unavailable' });
  expect(f.counts().saves).toBe(0);
 });
 it('cannot advertise an old linked PDF project receipt as supported recovery', async () => {
  const f = fixture(), ref = await f.service.stageHomeAttachment(auth, input(), bytes), request = f.draft([ref.id]);
  const receipt = structuredClone(await f.service.saveAttachedProjectDraft(auth, request)); receipt.attachments[0]!.mimeType = 'application/pdf';
  f.backend.lookupProject = async () => ({ status: 'committed', receipt });
  await expect(f.service.readAttachedProjectDraftRequest(auth, request.requestKey)).rejects.toMatchObject({ code: 'integration_unavailable' });
 });

});
