// Additive development-only upgrade. Keep the original installation marker,
// manifest, and predecessor fingerprint so an incompatible checkout fails closed.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripReviewedTransactionEnvelope } from '../prepare-shared-production-migration.mjs';
import { CATALOG_FINGERPRINT_SQL, sqlLiteral as q } from './shared-schema.mjs';

export const SUPPLEMENTAL_PACKET = Object.freeze({
 source: 'development/brainstorm-supplemental-membership-v1.sql',
 sha256: '16caac86a9c39045c0245b7a75168c75fb4366d72d6151a99c4125d7910bc3be',
});
const catalog = '(' + CATALOG_FINGERPRINT_SQL.trim().replace(/;$/, '') + ')';
// Privileges on base objects can legitimately change when local principals are
// provisioned. The new proof surfaces, in contrast, have fixed role grants.
const additionalAuthority = `(select encode(sha256(convert_to(jsonb_build_object(
 'functions', (select jsonb_agg(jsonb_build_array(p.oid::regprocedure::text, pg_get_functiondef(p.oid), p.proacl::text) order by p.oid::regprocedure::text)
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where
   n.nspname='fluid_private' and (starts_with(p.proname::text,'naming_brainstorm_supplemental_') or p.proname='repair_partial_brainstorm_v1') or
   n.nspname='public' and p.proname='get_naming_brainstorm_sources_v2'),
 'relations', (select jsonb_agg(jsonb_build_array(c.relname,c.relkind,c.relowner::regrole::text,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) order by c.relname)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='fluid_private' and starts_with(c.relname::text,'naming_brainstorm_supplemental_')),
 'columns', (select jsonb_agg(jsonb_build_array(c.relname,a.attname,a.atttypid::regtype::text,a.attnotnull,a.attacl::text,a.attgenerated,
   pg_get_expr(d.adbin,d.adrelid)) order by c.relname,a.attnum)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
   left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='fluid_private' and
   starts_with(c.relname::text,'naming_brainstorm_supplemental_') and a.attnum>0 and not a.attisdropped),
 'triggers', (select jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid),t.tgenabled) order by c.relname,t.tgname)
   from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where
   n.nspname='fluid_private' and starts_with(c.relname::text,'naming_brainstorm_supplemental_') and not t.tgisinternal)
 )::text,'UTF8')),'hex'))`;

export async function composeSupplementalUpgrade(settings, manifestHash, root) {
 const packet = await readFile(path.join(root, 'supabase', SUPPLEMENTAL_PACKET.source), 'utf8');
 const body = stripReviewedTransactionEnvelope(packet, SUPPLEMENTAL_PACKET.sha256);
 const origin = q('http://127.0.0.1:' + settings.apiPort);
 const marker = 'fluid_private.portable_development_installation';
 const receipt = 'brainstorm_supplement_v1';
 return `begin;
 set local search_path='';
 set local embel.portable_development='true';
 set local embel.portable_origin=${origin};
 select pg_advisory_xact_lock(743182914);
 lock table ${marker} in share row exclusive mode;
 do $$ begin
 if current_user<>'postgres' or session_user<>current_user or current_database()<>'postgres'
 or not exists(select 1 from ${marker} where singleton and project_id=${q(settings.projectId)} and manifest_sha256=${q(manifestHash)} and origin=${origin})
 or not exists(select 1 from fluid_private.shared_http_target where singleton and mode='development' and origin=${origin})
 or not exists(select 1 from fluid_private.shared_storage_target where singleton and origin=${origin})
 then raise exception 'portable_upgrade_target_mismatch'; end if;
 end $$;
 select not (to_jsonb(i) ? '${receipt}') as first_install from ${marker} i where singleton
 \\gset
 \\if :first_install
 do $$ begin
 if ${catalog} is distinct from (select catalog_sha256 from ${marker} where singleton)
 then raise exception 'portable_upgrade_predecessor_changed'; end if;
 end $$;
 ${body}
 alter table ${marker} add column ${receipt} jsonb;
 update ${marker} set ${receipt}=jsonb_build_object(
 'source',${q(SUPPLEMENTAL_PACKET.sha256)}, 'predecessor',catalog_sha256,
 'catalog',${catalog}, 'authority',${additionalAuthority}) where singleton;
 notify pgrst,'reload schema';
 \\endif
 do $$ begin
 if not exists(select 1 from ${marker} where singleton and ${receipt}=jsonb_build_object(
 'source',${q(SUPPLEMENTAL_PACKET.sha256)}, 'predecessor',catalog_sha256,
 'catalog',${catalog}, 'authority',${additionalAuthority}))
 then raise exception 'portable_upgrade_integrity_mismatch'; end if;
 end $$;
 commit;\n`;
}
