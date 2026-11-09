import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { createOpenAIResponsesTransport } from '@/server/ai/openai-transport';
import { readFile } from 'node:fs/promises';
import { asRole, OWNER_A, resetFixture, type TestDatabase } from './local-supabase';
import { WEB } from './logo-vector-proposal-admission-fixture';
const WORKER = 'fluid_logo_worker_feature_fixture';
import { textEditFixture } from '../features/logo-vector/text-edit-fixtures';
import { providerFixture } from '../server/logo-vector-proposal-provider-fixtures';
import { proposalPolicy } from '../server/logo-vector-proposal-fixtures';
import { canonicalLogoDocumentBytes } from '@/features/logo-vector/server/revisions';
import { serializeLogoSvg } from '@/features/logo-vector/model/svg';
import { captureLogoComponentLocks } from '@/features/logo-vector/model/locks';
import { createLogoServices } from '@/server/runtime/logo-services';
import type { IdentityConnectionFactory } from '@/server/data/identity-transaction';
import type { AuthenticatedContext } from '@/server/auth/context';
import type { LogoWorkerConnection } from '@/server/data/logo-jobs';
import { logoDispatchReceiptSchema, legacyLogoCostQuoteSchema } from '@/domain/logo-jobs';
import { logoVectorProposalRecordSchema } from '@/domain/logo-vector-proposal-jobs';
import { logoVectorProposalApplicationSchema, type ApplyLogoVectorProposalCommand } from '@/features/logo-vector/model/proposal-materialization';
import { startLogoProductionWorker } from '../../worker/logo-production-startup';
import { startLogoProductionHost } from '../../worker/logo-production-host';
import type { IdentityPoolPort, IdentityPoolClientPort } from '@/server/runtime/identity-pool';
import { freezeLogoWorkerManifest } from '../../worker/logo-readiness';
import { ownerQuery, startLogoFixture } from "./logo-project-fixture";

export const candidateNames = ['logo-vector-proposals.sql', 'logo-vector-proposal-quotes.sql', 'logo-vector-proposal-admission.sql', 'logo-vector-proposal-observations.sql', 'logo-vector-proposal-completion.sql', 'logo-vector-proposal-materialization.sql', 'logo-vector-proposal-capabilities.sql'];
export const integratedCandidates = await Promise.all(candidateNames.map(name => readFile(new URL('../../supabase/candidates/' + name, import.meta.url), 'utf8')));
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

/** Synthetic existing source/history and local private blobs. Every operation
 * under test uses real production services and restricted PostgreSQL functions.
 * Fonts are imported through the real owned catalog service, then read/checked
 * and shaped from pinned bytes. No proposal or output candidate is seeded. */
export async function vectorFeatureFixture(db: TestDatabase, options: { loseObservationAck?: boolean; loseCommitAck?: boolean; holdResponse?: boolean } = {}) {
  await resetFixture(db);
  for (const role of [WEB, WORKER]) await db.exec(`do $$begin if not exists(select 1 from pg_roles where rolname='${role}') then create role ${role} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;end if;end$$;grant usage on schema public,fluid_private to ${role};`);
  await db.exec(`grant execute on function fluid_private.quote_logo_vector_proposal(uuid,jsonb),fluid_private.read_logo_trusted_request(uuid,jsonb),fluid_private.apply_logo_trusted_command(uuid,jsonb,jsonb),fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid),fluid_private.prepare_logo_input(uuid,jsonb),fluid_private.commit_logo_input(uuid,jsonb,jsonb,jsonb) to ${WEB};
    grant execute on function fluid_private.logo_worker_owner(),public.report_logo_worker_ready(text,jsonb,integer),public.claim_logo_job(text,integer),public.register_logo_job_plan(uuid,uuid,jsonb),public.begin_logo_job_step(uuid,uuid,text,text,bigint),public.heartbeat_logo_job(uuid,uuid,integer),public.read_leased_logo_record(uuid,uuid,text,jsonb),public.record_logo_provider_response(uuid,uuid,jsonb),public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text),public.finish_logo_job(uuid,uuid,text),public.expire_logo_job_leases(),fluid_private.stage_logo_vector_proposal(uuid,uuid,jsonb,uuid) to ${WORKER};`);
  for (const [table, role] of [['logo_asset_web_principals', WEB], ['logo_worker_principals', WORKER]]) await db.query(`insert into fluid_private.${table}(role_name,role_oid,owner_id) select rolname,oid,$1 from pg_roles where rolname=$2 on conflict(role_name) do update set role_oid=excluded.role_oid,owner_id=excluded.owner_id`, [OWNER_A, role]);
  const roleOid = (await db.query<{ oid: number }>('select oid from pg_roles where rolname=$1', [WEB])).rows[0]!.oid;
  // The queue serializes actual session changes only, never emulates SQL outcomes.
  let pending = Promise.resolve();
  async function lock() { const before = pending; let unlock!: () => void; pending = new Promise<void>(resolve => { unlock = resolve; }); await before; return unlock; }
  async function serial<T>(run: () => Promise<T>): Promise<T> { const unlock = await lock(); try { return await run(); } finally { unlock(); } }
  const rpc = (name: string, args: unknown[]) => serial(() => asRole(db, 'authenticated', OWNER_A, async () => (await db.query<{ v: unknown }>(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) v`, args)).rows[0]!.v));
  const allowed = new Set(['read_logo_asset', 'read_logo_vector_proposal_application', 'get_logo_workspace', 'read_logo_current_vector', 'read_logo_workspace_record', 'list_logo_input_fonts', 'read_logo_font_record', 'read_logo_input_request']);
  const auth = { userId: OWNER_A, client: { rpc(name: string, args: Record<string, unknown>) {
    if (!allowed.has(name)) throw Error(`Unexpected authenticated fixture RPC ${name}`);
    const request = serial(() => asRole(db, 'authenticated', OWNER_A, async () => {
      try { return { data: (await db.query<{ v: unknown }>(`select public.${name}(${Object.keys(args).map((key, i) => `${key}=>$${i + 1}`).join(',')}) v`, Object.values(args))).rows[0]!.v, error: null }; }
      catch (error) { return { data: null, error }; }
    }));
    return Object.assign(request, { abortSignal: () => request });
  } } } as unknown as AuthenticatedContext;
  let reads = 0, writes = 0, commits = 0, loseCommit = options.loseCommitAck === true, lostObservation = false;
  const factory: IdentityConnectionFactory = { async acquire(owner, signal) {
    if (owner !== OWNER_A || signal?.aborted) throw Error('Foreign/aborted fixture acquisition');
    const unlock = await lock(); await db.exec(`set session authorization ${WEB}`); let released = false;
    const release = async () => { if (!released) { released = true; try { await db.exec('set session authorization postgres'); } finally { unlock(); } } };
    return { binding: { ownerId: OWNER_A, roleName: WEB, roleOid }, connection: {
      async query(sql, args) { const result = await db.query(sql, args ? [...args] : []); if (sql === 'COMMIT') { commits++; if (loseCommit) { loseCommit = false; throw Error('Synthetic lost actual COMMIT acknowledgement'); } } return result; }, release, discard: release,
    } };
  } };
  const blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  const services = createLogoServices({ connections: factory, storage: {
    async putIfAbsent(key, bytes, mimeType) { writes++; const old = blobs.get(key); if (old && (old.mimeType !== mimeType || !Buffer.from(old.bytes).equals(Buffer.from(bytes)))) throw Error('Immutable local object conflict'); if (!old) blobs.set(key, { bytes: Uint8Array.from(bytes), mimeType }); },
    async read(key) { reads++; const value = blobs.get(key); if (!value) throw Error('Missing immutable local bytes'); return { ...value, bytes: Uint8Array.from(value.bytes) }; },
  } });
  const source = await textEditFixture(true), initial = await startLogoFixture((sql, params) => serial(() => ownerQuery(db)(sql, params)), { requestKey: randomUUID(), brief: { name: source.input.source.text, activity: 'Synthetic local end-to-end qualification', audience: '', personality: '', logoTypes: ['combination'] } });
  const projectId = initial.projectId;
  const font = await services.inputs.importCatalogLogoFont(auth, projectId, { requestKey: randomUUID(), expected: initial.heads, catalogFontId: 'geist-sans-variable' });
  source.input.font.record = font; source.input.source.font = { ...font.asset }; source.input.source.rightsEvidenceId = font.rights.id;
  const lettering = source.document.components[1]!;
  if (lettering.editingKind !== 'editable_text') throw Error('Expected actual shaped lettering');
  lettering.textSource.font = { ...font.asset }; lettering.textSource.rightsEvidenceId = font.rights.id;
  source.revision.ownerId = OWNER_A; source.revision.projectId = projectId;
  source.brief = (await db.query<{ record: typeof source.brief }>('select record from public.logo_stage_revisions where id=$1', [initial.stages.brief_references!.id])).rows[0]!.record;
  source.revision.inputRevisions = [{ stage: 'brief_references', id: source.brief.id, revision: source.brief.revision }];
  for (const ref of [source.raster.reference, source.revision.sourcePreview, source.revision.documentAsset, source.revision.svgAsset]) { ref.ownerId = OWNER_A; ref.projectId = projectId; }
  source.seal(); source.revision.locks = structuredClone([...captureLogoComponentLocks(source.document, [source.document.components[0]!.id])]);
  const members = [
    { reference: source.revision.sourcePreview, bytes: source.raster.bytes, mimeType: 'image/png', kind: 'concept' },
    { reference: source.revision.documentAsset, bytes: canonicalLogoDocumentBytes(source.document), mimeType: 'application/json', kind: 'vector' },
    { reference: source.revision.svgAsset, bytes: serializeLogoSvg(source.document), mimeType: 'image/svg+xml', kind: 'vector' },
  ];
  let rasterReceipt: unknown;
  for (const { reference, bytes, mimeType, kind } of members) {
    blobs.set(`${reference.ownerId}/${reference.projectId}/${reference.assetId}/${reference.versionId}`, { bytes: Uint8Array.from(bytes), mimeType });
    const id = randomUUID(), key = randomUUID(), request = { kind: 'stage', publication: { requestKey: key, inputRevisions: source.revision.inputRevisions, mimeType, byteLength: bytes.length, contentHash: reference.contentHash, source: { kind, sourceId: source.revision.id } } };
    await db.query(`insert into public.logo_asset_publications(id,owner_id,project_id,request_key,request,asset_id,version_id,content_hash,mime_type,byte_length,purpose,source_receipt_id,source_kind,state,verification,input_revision,input_hash) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'brand_asset',$11,$12,'staged',$13,1,$8)`, [id, OWNER_A, projectId, key, request, reference.assetId, reference.versionId, reference.contentHash, mimeType, bytes.length, source.revision.id, kind, { status: 'verified', checkedAt: '2026-10-08T00:00:00Z', contentHash: reference.contentHash, mimeType, byteLength: bytes.length }]);
    await db.query('select fluid_private.logo_commit_asset(r) from public.logo_asset_publications r where id=$1', [id]);
    if (kind === 'concept') rasterReceipt = (await db.query<{ v: unknown }>('select fluid_private.logo_asset_receipt(r) v from public.logo_asset_publications r where id=$1', [id])).rows[0]!.v;
  }
  // Seed only the starting historical raster lineage, never an output proposal/candidate.
  const originalJob = randomUUID(), originalResponse = randomUUID();
  await db.query("insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd) values($1,$2,$3,'identity.logo_refine',1,$4,'{}',$5,'succeeded',0)", [originalJob, OWNER_A, projectId, 'a'.repeat(64), randomUUID()]);
  await db.query('insert into public.logo_provider_responses(id,owner_id,project_id,job_id,lease_token,observation) values($1,$2,$3,$4,$5,$6)', [originalResponse, OWNER_A, projectId, originalJob, randomUUID(), { billing: { status: 'recorded', confirmedMicrousd: 0 } }]);
  await db.query('insert into public.logo_raster_results(job_id,owner_id,project_id,preview,provider_response_receipt_id) values($1,$2,$3,$4,$5)', [originalJob, OWNER_A, projectId, rasterReceipt, originalResponse]);
  await db.query('insert into public.logo_raster_refinements(id,owner_id,project_id,request_key,job_id,source,logo_type,input_revisions) values($1,$2,$3,$4,$5,$6,$7,$8)', [source.refinement.id, OWNER_A, projectId, randomUUID(), originalJob, source.refinement.source, 'combination', source.revision.inputRevisions]);
  await db.query('insert into public.logo_vector_revisions(id,owner_id,project_id,record) values($1,$2,$3,$4)', [source.revision.id, OWNER_A, projectId, source.revision]);
  await db.query("select fluid_private.logo_append_stage($1,$2,'vector',$3,$4)", [OWNER_A, projectId, { vectorRevisionId: source.revision.id, approvalId: null }, source.revision.inputRevisions]);
  const workspace = await services.workspace.getLogoWorkspace(auth, projectId), policy = proposalPolicy();
  const identity = (await db.query<{ v: string }>("select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') v", [policy])).rows[0]!.v;
  await db.query("insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,max_cost_microusd,enabled,text_policy) values($1,'identity.logo_vector_propose',$2,'logo-vector-propose-v1','openai','gpt-6.1-sol',122880,true,$3)", [OWNER_A, identity, policy]);
  await db.query('update public.usage_accounts set limit_microusd=5000000 where owner_id=$1', [OWNER_A]);
  const capability = freezeLogoWorkerManifest([{ operation: 'identity.logo_vector_propose', policyIdentity: identity, handlerVersion: 'logo-vector-propose-v1', provider: 'openai', model: 'gpt-6.1-sol', engine: null, maxCostMicrousd: 122880, textPolicy: policy }])[0]!;
  const connection: LogoWorkerConnection = { query: <Row>(sql: string, args?: unknown[]) => serial(async () => {
    await db.exec(`set session authorization ${WORKER}`);
    try {
    const result = await db.query<Row>(sql, args);
    if (options.loseObservationAck && !lostObservation && sql.includes('record_logo_provider_response')) { lostObservation = true; throw Error('Synthetic lost actual observation acknowledgement'); }
    return result;
    } finally { await db.exec('set session authorization postgres'); }
  }) };
  await connection.query("select public.report_logo_worker_ready('proposal-fixture',$1,90)", [[capability]]);
  const request = { operation: 'propose_vector_edit', expected: workspace.heads, baseVectorRevisionId: source.revision.id, instruction: 'Increase the selected lettering spacing to two while preserving its spelling and locked symbol.', targetComponentIds: [lettering.id] };
  const quote = legacyLogoCostQuoteSchema.parse(await services.proposalQuotes.quoteLogoVectorProposal(auth, projectId, request));
  const intent = { requestKey: randomUUID(), quoteId: quote.id, acceptedMaxCostMicrousd: quote.maxCostMicrousd, expected: workspace.heads };
  const admission = logoDispatchReceiptSchema.parse(await rpc('admit_logo_operation', [projectId, intent]));
  const jobId = admission.jobIds[0]!, provider = providerFixture(), entered = deferred<void>(), releaseResponse = deferred<void>();
  const syntheticHttp = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method !== 'POST' || init.redirect !== 'error' || typeof init.body !== 'string') throw Error('Unexpected real transport request');
    JSON.parse(init.body); // Exercise the real serialized request at the HTTP seam.
    if (url === 'https://api.openai.com/v1/responses/input_tokens') return new Response(JSON.stringify({ input_tokens: 10 }), { headers: { 'content-type': 'application/json' } });
    if (url !== 'https://api.openai.com/v1/responses') throw Error('No network destination is permitted by this synthetic fixture');
    entered.resolve(); if (options.holdResponse) await releaseResponse.promise;
    const response = provider.response(); response.body.output[0]!.content[0]!.text = JSON.stringify({ version: 1, status: 'proposed', edit: { kind: 'spacing', componentId: lettering.id, letterSpacing: 2, lineHeight: 1 }, explanation: 'Synthetic bounded spacing qualification.' });
    return new Response(JSON.stringify(response.body), { headers: { 'content-type': 'application/json', 'x-request-id': response.requestId } });
  });
  const transport = createOpenAIResponsesTransport({ apiKey: 'synthetic-local-unusable-key', fetch: syntheticHttp });
  const inferenceCalls = () => syntheticHttp.mock.calls.filter(([url]) => url === 'https://api.openai.com/v1/responses').length;
  const start = () => startLogoProductionWorker({ enabled: true, ownerId: OWNER_A, workerId: 'proposal-fixture', connection, proposals: { capability, configuration: provider.configuration, transport } });
  async function runHost() {
    const stop = new AbortController();
    const workerOid = (await serial(() => db.query<{ oid: number }>('select oid from pg_roles where rolname=$1', [WORKER]))).rows[0]!.oid;
    const pool: IdentityPoolPort = { async connect() {
      const unlock = await lock(); await db.exec(`set session authorization ${WORKER}`);
      let released: Promise<void> | undefined;
      const reset = () => released ??= db.exec('set session authorization postgres').then(() => {}).finally(unlock);
      return Object.assign(new EventEmitter(), {
        async query(query: { text: string; values: unknown[] }) {
          const result = await db.query(query.text, query.values);
          if (query.text.includes('claim_logo_job') && result.rows.length === 0) stop.abort();
          return result;
        }, release() { void reset(); }, end: reset,
      }) satisfies IdentityPoolClientPort;
    } };
    const host = await startLogoProductionHost({ enabled: true, binding: { ownerId: OWNER_A, roleName: WORKER, roleOid: workerOid }, pool, workerId: 'proposal-fixture', pollMs: 10, proposals: { capability, configuration: provider.configuration, transport } });
    if (host.status !== 'qualified') throw Error(`Expected checked real host, received ${host.status}`);
    try { await host.run(stop.signal); } finally { stop.abort(); await host.close(); await pending; }
    return host.manifest;
  }
  async function retained() {
    const row = (await db.query<{ id: string }>('select id from fluid_private.logo_vector_proposals where job_id=$1', [jobId])).rows[0]!;
    return logoVectorProposalRecordSchema.parse(await rpc('read_logo_vector_proposal', [projectId, row.id]));
  }
  async function command(): Promise<ApplyLogoVectorProposalCommand> { const proposal = await retained(); return { method: 'applyLogoVectorProposal', body: { requestKey: randomUUID(), expected: workspace.heads, baseVectorRevisionId: source.revision.id, proposalId: proposal.id } }; }
  const application = async (proposalId: string) => logoVectorProposalApplicationSchema.parse(await rpc('read_logo_vector_proposal_application', [projectId, proposalId]));
  return { db, source, font, services, auth, workspace, projectId, quote, intent, admission, jobId, provider, inferenceCalls, syntheticHttp, start, runHost, retained, command, application, rpc, serial, entered, releaseResponse, counts: () => ({ reads, writes, commits }), drain: () => pending };
}
