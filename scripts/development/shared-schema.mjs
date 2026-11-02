import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PACKET_NAMES, PACKET_SHA256, POST_INSTALL_PACKETS, stripReviewedTransactionEnvelope } from '../prepare-shared-production-migration.mjs';
import { digest, DevelopmentError, repositoryRoot, validateSettings } from './config.mjs';

// Reviewed predecessor chain used by the production composer's native catalog
// test. No production activation, old owner credentials or generated data.
export const LEGACY_PREDECESSORS = Object.freeze([
 ['candidates/logo_worker_storage.sql','b9aed06d6c96ca1d09c32542058f67d11d34d0dff27b5949103d4595d0f4b092'],
 ['candidates/logo_generative_storage.sql','9e4cd1a695b6956c8353fb87289714923c2d8dafbd891f58b9c5f7206722da19'],
 ['candidates/logo_local_concepts.sql','9f1a91f096d4584a3f5380b7ddf9b0f40bdbb9fb303b4ed137b9e96c33c71d9e'],
 ['activation/logo_concepts_50_publication_adjudication.sql','a0f0f5b73ee76672ad4da96f809b1de6f2138d53ee372fae32a66c1f261b832e'],
 ['candidates/logo_local_refinements.sql','62309319b976180f1a7c2e141d106f05aea0556ee456301bf5d391559623e45b'],
]);
export const sqlLiteral = value => "'" + String(value).replaceAll("'", "''") + "'";

// This operational repair originally pins the production installation address.
// Retarget only that exact, hash-pinned predicate. All predecessor, catalog,
// constraint and final-body checks remain unchanged, including PostgreSQL17.11.
export function developmentEventCapacity(source) {
 const production = "q.singleton AND q.mode='hosted'AND q.origin='https://fricsfwqibyhemknqgyf.supabase.co'";
 if (source.split(production).length !== 2) throw new DevelopmentError('Development repair predicate changed.');
 return source.replace(production, "q.singleton AND q.mode='development' AND q.origin=current_setting('embel.portable_origin') AND current_setting('embel.portable_development')='true'");
}
export function developmentStorageRepair(source) {
 const production = "t.singleton AND t.origin='https://fricsfwqibyhemknqgyf.supabase.co'";
 if (source.split(production).length !== 2) throw new DevelopmentError('Development storage repair predicate changed.');
 return source.replace(production, "t.singleton AND t.origin=current_setting('embel.portable_origin') AND current_setting('embel.portable_development')='true'");
}

// Runtime mutable rows and role grants are intentionally excluded. Each restart
// compares every installed application function's source, owner and execution
// attributes, as well as table constraints and RLS policies, against installation.
export const CATALOG_FINGERPRINT_SQL = `select encode(sha256(convert_to(jsonb_build_object(
 'functions',(select jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),p.prosrc,pg_get_userbyid(p.proowner),p.prosecdef,p.proleakproof,p.provolatile,p.proconfig) order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','fluid_private')),
 'constraints',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid)) order by n.nspname,c.relname,k.conname) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','fluid_private')),
 'policies',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) order by n.nspname,c.relname,p.polname) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','fluid_private','storage'))
 )::text,'UTF8')),'hex');`;

export async function composeDevelopmentSchema(settings, root = repositoryRoot) {
 settings = validateSettings(settings);
 const origin = 'http://127.0.0.1:' + settings.apiPort;
 const manifest = [];
 async function packet(relative, sha, envelope = true) {
  const source = await readFile(path.join(root, 'supabase', relative), 'utf8');
  if (sha && digest(source) !== sha) throw new DevelopmentError('Reviewed development SQL changed: ' + relative);
  manifest.push({ source: relative, sha256: digest(source) });
  return envelope ? stripReviewedTransactionEnvelope(source, sha) : source;
 }
 const sources = [];
 for (const [name, sha] of LEGACY_PREDECESSORS) sources.push(await packet(name, sha));
 for (const name of PACKET_NAMES) {
  sources.push(await packet('candidates/' + name, PACKET_SHA256[name]));
  if (name === 'shared_account_http.sql') {
   sources.push(await packet('development/portable-http-target.sql', null, false));
   sources.push(`insert into fluid_private.shared_http_target(mode,origin) values('development',${sqlLiteral(origin)});`);
  }
  if (name === 'shared_storage_authority.sql') sources.push(`insert into fluid_private.shared_storage_target(origin) values(${sqlLiteral(origin)});`);
 }
 for (const entry of POST_INSTALL_PACKETS) {
  const source = await packet('candidates/' + entry.name, entry.sha256);
  sources.push(entry.name === 'shared_naming_brainstorm_event_capacity.sql' ? developmentEventCapacity(source)
   : ['shared_storage_download_metadata.sql','shared_logo_storage_member.sql'].includes(entry.name) ? developmentStorageRepair(source) : source);
 }
 const manifestHash = digest(JSON.stringify({ version: 1, manifest, portableRepairVersion: 1 }));
 return { manifest, manifestHash, sql: `begin;
 set local search_path='';
 set local embel.portable_development='true';
 set local embel.portable_origin=${sqlLiteral(origin)};
 select pg_advisory_xact_lock(743182914);
 do $$ begin
 if session_user<>'postgres' or current_user<>session_user or current_database()<>'postgres'
  or current_setting('server_version_num')::int<>170011
  or to_regclass('fluid_private.shared_worker_slots') is not null
  or to_regclass('fluid_private.portable_development_installation') is not null
  or to_regclass('fluid_private.logo_storage_principals') is not null
 then raise exception 'portable_fresh_database_required'; end if;
 end $$;
 ${sources.join('\n')}
 create table fluid_private.portable_development_installation (
 singleton boolean primary key default true check(singleton), project_id text not null,
 manifest_sha256 text not null, origin text not null, catalog_sha256 text, installed_at timestamptz not null default now()
 );
 revoke all on table fluid_private.portable_development_installation from public,anon,authenticated,service_role;
 insert into fluid_private.portable_development_installation(project_id,manifest_sha256,origin)
 values(${sqlLiteral(settings.projectId)},${sqlLiteral(manifestHash)},${sqlLiteral(origin)});
 update fluid_private.portable_development_installation set catalog_sha256=(${CATALOG_FINGERPRINT_SQL.replace(/^select /, '').replace(/;$/, '')});
 notify pgrst,'reload schema';
 commit;\n` };
}
