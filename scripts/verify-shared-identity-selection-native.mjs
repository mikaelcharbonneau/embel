import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';

/** Isolated native PG17 regression. Only Auth/board metadata and the socket
 * transport are fixtures: the shared HTTP runtime, qualifier, TypeScript
 * proposal builder and SQL prepare/commit/finish functions are production code.
 * No network, uploaded bytes, provider execution or production credentials. */
export async function verifySharedIdentitySelection({ sql, quote, assert, checkDenied, asVerifiedSession, sessions, origin, interactiveSql, correction }) {
  const bundle = await build({ stdin: { contents: `
    export { createSharedAccountHttpRuntime } from './src/server/shared-account/runtime';
    export { contextSnapshotSchema } from './src/domain/projects';
    export { createIdentityInputSnapshot, identitySystemVersionSchema, initialIdentityPreferences } from './src/domain/project-identity';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', conditions: ['react-server'], external: ['pg-native'],
    banner: { js: `import {createRequire as nativeCreateRequire} from 'node:module';const require=nativeCreateRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)});` } });
  const implementation = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));
  const role = 'embel_shared_http_identity_native', owner = sessions[1], other = sessions[0];
  const helpers = ['fluid_private.prepare_identity_transaction(uuid,jsonb,boolean)', 'fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)'];
  const json = value => quote(JSON.stringify(value));
  const membership = () => sql("select coalesce(jsonb_agg(to_jsonb(m) order by roleid,member,grantor),'[]') from pg_auth_members m;");
  const permissions = () => JSON.parse(sql(`select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'grantor',a.grantor::bigint,'grantee',a.grantee::bigint,'privilege',a.privilege_type,'grantable',a.is_grantable) order by p.oid,a.grantor,a.grantee,a.privilege_type)
    from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid in(${helpers.map(value => `${quote(value)}::regprocedure`).join(',')});`));
  assert(sql("select not rolsuper from pg_roles where rolname='postgres';") === 't', 'native-identity-wrapper-owner-is-not-superuser');
  assert(helpers.every(signature => sql(`select has_function_privilege('postgres',${quote(signature)},'EXECUTE');`) === 'f'), 'native-identity-reproduces-both-missing-writer-permissions');
  sql(`grant execute on function public.prepare_shared_identity_request(text,uuid,jsonb,boolean),public.commit_shared_identity_request(uuid,jsonb,jsonb),public.finish_shared_identity_request() to ${role};`);
  const context = implementation.contextSnapshotSchema.parse({ description: 'Explicit synthetic native Identity selection', selectedName: 'Cedar', intake: { suppliedName: 'Cedar' } });
  const project = asVerifiedSession(owner, `to_jsonb(public.create_project('complete_brand','Native Identity selection',${json(context)},${quote('a'.repeat(64))}))`);
  const references = JSON.parse(sql(`begin;set local request.jwt.claim.sub=${quote(owner.owner)};select fluid_private.capture_identity_reference_snapshot(${quote(project.id)},0);commit;`));
  const at = new Date().toISOString(), input = implementation.createIdentityInputSnapshot({ ownerId: owner.owner, projectId: project.id,
    scope: 'complete_brand', projectRevision: 1, context, referenceSnapshot: references, preferencesRevision: 0,
    preferences: implementation.initialIdentityPreferences(context), capturedAt: at });
  const systemId = randomUUID(), inputId = randomUUID(), batchId = randomUUID(), jobId = randomUUID(), assetId = randomUUID(), versionId = randomUUID(), stepKey = 'identity.native.synthetic.1';
  const asset = { ownerId: owner.owner, projectId: project.id, assetId, versionId, contentHash: 'b'.repeat(64), purpose: 'brand_asset', mimeType: 'image/png' };
  const direction = { direction: 'Synthetic coherent direction', usageNotes: 'Native SQL fixture only' };
  const system = implementation.identitySystemVersionSchema.parse({ id: systemId, ownerId: owner.owner, projectId: project.id, createdAt: at, input,
    source: { kind: 'generated', batchId, jobId, stepKey }, components: { logo: direction, graphics: direction, imagery: direction, composition: direction,
      colors: { swatches: [{ key: 'primary', name: 'Forest', hex: '#123456' }], usageNotes: 'Synthetic palette' },
      typography: { styles: [{ key: 'body', role: 'Body', family: 'Lora', weight: 400, style: 'normal' }], usageNotes: 'Specification only' } },
    board: { asset, depictsSystemVersionId: systemId, staleComponents: [] }, productionFiles: [] });
  const output = { identity: { version: 1, operation: 'identity.image', ownerId: owner.owner, projectId: project.id, batchId, jobId, stepKey, targetCount: 3, input, systems: [system] } };
  sql(`begin;
    insert into public.assets(id,owner_id,project_id,kind,purpose) values(${quote(assetId)},${quote(owner.owner)},${quote(project.id)},'Explicit synthetic native Identity board','brand_asset');
    insert into public.asset_versions(id,owner_id,project_id,asset_id,version,input_revision,input_hash,content_hash,mime_type,storage_path,provenance)
      values(${quote(versionId)},${quote(owner.owner)},${quote(project.id)},${quote(assetId)},1,1,${quote('a'.repeat(64))},${quote(asset.contentHash)},'image/png',${quote(`${owner.owner}/${project.id}/${assetId}/${versionId}`)},'{}');
    insert into public.identity_input_snapshots(id,project_id,owner_id,project_revision,reference_revision,preferences_revision,input,created_at)
      values(${quote(inputId)},${quote(project.id)},${quote(owner.owner)},1,0,null,${json(input)},${quote(at)});
    insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd,finished_at)
      values(${quote(jobId)},${quote(owner.owner)},${quote(project.id)},'identity.image',1,${quote('a'.repeat(64))},${json({ identity: input })},${quote('native-synthetic-' + jobId)},'succeeded',0,${quote(at)});
    insert into public.job_steps(job_id,owner_id,project_id,step_key,request_key,state,reserved_cost_microusd,output,completed_at)
      values(${quote(jobId)},${quote(owner.owner)},${quote(project.id)},${quote(stepKey)},${quote('native-synthetic-' + systemId)},'succeeded',0,${json(output)},${quote(at)});
    insert into public.identity_batches(id,project_id,owner_id,job_id,input_id) values(${quote(batchId)},${quote(project.id)},${quote(owner.owner)},${quote(jobId)},${quote(inputId)});
    insert into public.identity_system_versions(id,project_id,owner_id,input_id,source,components,board,production_files,created_at,root_system_id,created_at_text)
      values(${quote(systemId)},${quote(project.id)},${quote(owner.owner)},${quote(inputId)},${json(system.source)},${json(system.components)},${json(system.board)},'[]',${quote(at)},${quote(systemId)},${quote(at)});
    insert into public.identity_system_files(system_id,slot,project_id,owner_id,component,role,asset_id,version_id)
      values(${quote(systemId)},0,${quote(project.id)},${quote(owner.owner)},null,'board',${quote(assetId)},${quote(versionId)});
    insert into public.identity_generated_roots(system_id,project_id,owner_id,batch_id,job_id,step_key,output_index,board)
      values(${quote(systemId)},${quote(project.id)},${quote(owner.owner)},${quote(batchId)},${quote(jobId)},${quote(stepKey)},0,${json(asset)});
    commit;`);
  const request = { systemVersionId: systemId, expectedProjectRevision: 1, expectedReferenceRevision: 0, expectedPreferencesRevision: 0, expectedIdentityRevision: 0, acceptEarlierBasis: false };
  const issue = (session, args) => asVerifiedSession(session, `public.issue_shared_account_request('identity','identity',${json(args)})`);
  const failedToken = issue(owner, [project.id, request, false]);
  checkDenied(`begin;select public.prepare_shared_identity_request(${quote(failedToken.token)},${quote(project.id)},${json(request)},false);commit;`, role,
    'native-identity-public-prepare-reproduces-denied-private-writer', /permission denied for function prepare_identity_transaction/);
  assert(sql(`select not exists(select 1 from public.identity_selections where project_id=${quote(project.id)}) and not exists(select 1 from fluid_private.shared_http_contexts);`) === 't', 'native-identity-denied-prepare-leaves-no-selection-or-context');
  const membershipsBefore = membership(), aclBefore = permissions();
  sql(correction);
  const postgresOid = Number(sql("select oid from pg_roles where rolname='postgres';")), writerOid = Number(sql("select oid from pg_roles where rolname='fluid_identity_writer_definer_v1';"));
  const aclAfter = permissions(), added = aclAfter.filter(row => row.grantee === postgresOid);
  assert(isDeepStrictEqual(aclAfter.filter(row => row.grantee !== postgresOid), aclBefore) && added.length === 2
    && added.every(row => row.grantor === writerOid && row.privilege === 'EXECUTE' && !row.grantable), 'native-identity-correction-adds-only-two-postgres-executes');
  assert(membership() === membershipsBefore, 'native-identity-correction-preserves-all-role-memberships');
  assert(helpers.every(signature => sql(`select has_function_privilege('postgres',${quote(signature)},'EXECUTE') and not has_function_privilege(${quote(role)},${quote(signature)},'EXECUTE') and not has_function_privilege('authenticated',${quote(signature)},'EXECUTE');`) === 't'), 'native-identity-writers-remain-private-to-web-and-customer');

  // Keep one real backend for each checked-out connection. The psql adapter
  // only binds parameters and serializes rows; it never rewrites runtime SQL.
  const channels = new Set(), trace = [];
  function createPool() {
    let channel, checkedOut = false;
    const close = async () => { if (!channel) return; const value = channel; channel = null; value.child.stdin.end(); await value.done; channels.delete(value); };
    return { on() {}, end: close, async connect() {
      if (checkedOut) throw Error('native-identity-concurrent-checkout');
      if (!channel) { channel = interactiveSql(role); channels.add(channel); channel.child.stdin.write('\\set VERBOSITY verbose\n'); }
      checkedOut = true;
      return { on() {}, removeListener() {}, end: close, release(destroy) { checkedOut = false; if (destroy) void close(); },
        async query({ text, values }) {
          trace.push(text);
          const value = channel, marker = 'native_identity_' + randomUUID().replaceAll('-', '');
          if (!value) throw Error('native-identity-connection-closed');
          const literal = input => input === null ? 'null' : Array.isArray(input) ? `ARRAY[${input.map(literal).join(',')}]::text[]` : typeof input === 'boolean' ? String(input) : quote(input);
          const bound = text.replace(/\$(\d+)/g, (_, index) => literal(values[Number(index) - 1]));
          const source = /^\s*(?:SELECT|WITH)\b/i.test(bound) ? `select coalesce(jsonb_agg(to_jsonb(native_row)),'[]') from (${bound}) native_row;` : `${bound};select '[]';`;
          const start = value.out.length;
          value.child.stdin.write(source + '\n\\echo ' + marker + '\n');
          const rows = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => finish(() => reject(Error('native-identity-query-timeout'))), 10_000);
            const check = () => { const output = value.out.slice(start), end = output.indexOf(marker); if (end >= 0) finish(() => { try { resolve(JSON.parse(output.slice(0, end).trim())); } catch { reject(Error('native-identity-query-json')); } }); };
            const finish = action => { clearTimeout(timeout); value.child.stdout.removeListener('data', check); value.child.removeListener('close', ended); action(); };
            const ended = () => finish(() => reject(Object.assign(Error('native-identity-SQL-failed'), { code: value.err.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1] })));
            value.child.stdout.on('data', check); value.child.once('close', ended); check();
          });
          return { rows };
        } };
    } };
  }
  const auth = session => ({ userId: session.owner, client: { async rpc(name, args) {
    if (name !== 'issue_shared_account_request' || args.p_lane !== 'identity' || args.p_action !== 'identity') throw Error('native-identity-unexpected-RPC');
    return { data: issue(session, args.p_arguments), error: null };
  } } });
  const runtime = implementation.createSharedAccountHttpRuntime({ EMBEL_SHARED_ACCOUNT_HTTP_ENABLED: 'true', NEXT_PUBLIC_SUPABASE_URL: origin,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_nativefixture', EMBEL_SHARED_ACCOUNT_HTTP_CONFIG: JSON.stringify({ identity: {
      roleName: role, roleOid: Number(sql(`select oid from pg_roles where rolname=${quote(role)};`)), databaseUrl: `postgresql://${role}:inertfixture@db.${new URL(origin).hostname}:5432/postgres?sslmode=verify-full` } }) },
    { createPool, readCertificate: () => readFileSync(new URL('certs/supabase-prod-ca-2021.crt', import.meta.url), 'utf8'), fetch() { throw Error('native-identity-network-forbidden'); } });
  try {
    const lease = await runtime.acquireIdentity(auth(owner));
    assert(lease.value?.saveAvailability.status === 'available', 'native-identity-real-runtime-qualifies-restricted-web-login');
    const result = await lease.value.transactions.select(auth(owner), project.id, request);
    assert(result.currentSelection.selection.ownerId === owner.owner && result.currentSelection.system.id === systemId && result.session.identityRevision === 1,
      'native-identity-real-runtime-commits-exact-owner-direction-choice');
    assert(trace.some(value => value.includes('prepare_shared_identity_request')) && trace.some(value => value.includes('commit_shared_identity_request'))
      && trace.some(value => value.includes('finish_shared_identity_request')) && trace.includes('COMMIT'), 'native-identity-production-transport-runs-prepare-commit-finish');
    assert(sql(`select count(*)=1 from public.identity_selections where project_id=${quote(project.id)} and owner_id=${quote(owner.owner)} and system_id=${quote(systemId)};`) === 't'
      && sql(`select used from public.assets where id=${quote(assetId)};`) === 't', 'native-identity-choice-and-asset-use-persist-after-commit');
    assert(sql('select not exists(select 1 from fluid_private.shared_http_contexts);') === 't', 'native-identity-finish-clears-private-request-context');
    await lease.release();
    let foreignDenied = false;
    try { issue(other, [project.id, { ...request, expectedIdentityRevision: 1 }, false]); }
    catch (error) { foreignDenied = /shared_http_scope_missing/.test(String(error.stderr)); }
    assert(foreignDenied, 'native-identity-foreign-owner-cannot-obtain-selection-delegation');
  } finally {
    await runtime.close();
    for (const channel of channels) { channel.child.stdin.end(); await channel.done; }
  }
  assert(membership() === membershipsBefore, 'native-identity-selection-does-not-change-role-membership');
}
