-- Baseline parity fingerprint. Read-only catalog queries; no application data.
--
-- Run the same file against production (Supabase SQL editor or MCP execute_sql, which
-- are read-only here) and against a fresh local database built from supabase/migrations,
-- then diff the two outputs. Every row is (kind, identity, fingerprint); a difference in a
-- row means that object differs. The last rows ("summary") give one fingerprint per kind,
-- so the two databases can be compared at a glance before drilling into the rows.
--
-- Scope: the schemas the app owns (public, fluid_private), the app's roles, the extensions,
-- the storage bucket row and the app's policies and triggers on storage.objects and
-- auth.users. Role passwords, OIDs, statistics and the migration history are not compared.
with
app_schemas as (select unnest(array['public','fluid_private']) as nspname),
app_roles as (
  select r.oid, r.rolname from pg_roles r
  where r.rolname in ('embel_engine','fluid_identity_writer_definer_v1')
     or r.rolname like 'embel\_shared\_http\_%'
),
acl as (
  -- grantee=privileges, sorted; grantor and grant option are not compared. A null ACL means
  -- the owner's built-in default, so it is compared as that default (an explicit ACL that
  -- happens to equal the default, left behind by a REVOKE, is the same set of privileges).
  select a.oid, string_agg(coalesce(g.rolname, 'public') || '=' || p.privs, ' ' order by coalesce(g.rolname, 'public')) as text
  from (
    select c.oid, coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner)) as acl
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in (select nspname from app_schemas)
    union all select p.oid, coalesce(p.proacl, acldefault('f', p.proowner)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in (select nspname from app_schemas)
    union all select n.oid, coalesce(n.nspacl, acldefault('n', n.nspowner)) from pg_namespace n where n.nspname in ('public','fluid_private')
  ) a
  cross join lateral (
    select e.grantee, string_agg(e.privilege_type, ',' order by e.privilege_type) as privs
    from aclexplode(a.acl) e group by e.grantee
  ) p
  left join pg_roles g on g.oid = p.grantee
  where a.acl is not null
  group by a.oid
),
items as (
  -- roles the schema references (attributes only; never passwords)
  select 'role' as kind, r.rolname::text as identity,
    format('super=%s inherit=%s createrole=%s createdb=%s login=%s repl=%s bypassrls=%s connlimit=%s config=%s members_of=%s',
      r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, r.rolreplication, r.rolbypassrls, r.rolconnlimit,
      coalesce(array_to_string(r.rolconfig, ','), ''),
      coalesce((select string_agg(g.rolname, ',' order by g.rolname) from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid), '')) as definition
  from pg_roles r join app_roles ar on ar.oid = r.oid

  union all
  select 'extension', e.extname::text, format('schema=%s version=%s', n.nspname, e.extversion)
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace

  union all
  select 'schema', n.nspname::text, format('owner=%s acl=%s', pg_get_userbyid(n.nspowner), coalesce(acl.text, ''))
  from pg_namespace n left join acl on acl.oid = n.oid where n.nspname in ('public','fluid_private')

  union all
  select 'default_acl', format('%s.%s.%s', pg_get_userbyid(d.defaclrole), coalesce(n.nspname, '<global>'), d.defaclobjtype),
    (select string_agg(coalesce(g.rolname, 'public') || '=' || e.privilege_type, ' ' order by coalesce(g.rolname, 'public'), e.privilege_type)
       from aclexplode(d.defaclacl) e left join pg_roles g on g.oid = e.grantee)
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  where pg_get_userbyid(d.defaclrole) = 'postgres' and (n.nspname is null or n.nspname in (select nspname from app_schemas))

  union all
  select 'type', format('%s.%s', n.nspname, t.typname),
    case t.typtype
      when 'e' then 'enum ' || (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)
      when 'd' then 'domain ' || format_type(t.typbasetype, t.typtypmod) || ' notnull=' || t.typnotnull || coalesce(' default ' || t.typdefault, '')
        || coalesce((select ' check ' || string_agg(pg_get_constraintdef(c.oid), ' and ' order by c.conname) from pg_constraint c where c.contypid = t.oid), '')
      when 'c' then 'composite ' || (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ',' order by a.attnum) from pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped)
    end
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
  where n.nspname in (select nspname from app_schemas) and t.typtype in ('e','d','c')
    and not exists (select 1 from pg_class c where c.oid = t.typrelid and c.relkind <> 'c')

  union all
  select 'table', format('%s.%s', n.nspname, c.relname),
    format('kind=%s owner=%s rls=%s force=%s replica=%s acl=%s columns=[%s] comment=%s',
      c.relkind, pg_get_userbyid(c.relowner), c.relrowsecurity, c.relforcerowsecurity, c.relreplident, coalesce(acl.text, ''),
      (select string_agg(format('%s %s%s%s%s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
            case when a.attnotnull then ' not null' else '' end,
            coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ''),
            case when a.attidentity <> '' then ' identity ' || a.attidentity::text else '' end,
            case when a.attgenerated <> '' then ' generated ' || a.attgenerated::text else '' end,
            case when a.attcollation <> 0 and a.attcollation <> t.typcollation then ' collate ' || (select collname from pg_collation where oid = a.attcollation) else '' end
            || coalesce(' comment ' || col_description(a.attrelid, a.attnum), '')
            || coalesce(' acl ' || a.attacl::text, '')), ', ' order by a.attnum)
         from pg_attribute a join pg_type t on t.oid = a.atttypid left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
      coalesce(obj_description(c.oid, 'pg_class'), ''))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace left join acl on acl.oid = c.oid
  where n.nspname in (select nspname from app_schemas) and c.relkind in ('r','p','f')

  union all
  select 'view', format('%s.%s', n.nspname, c.relname),
    format('kind=%s owner=%s acl=%s def=%s', c.relkind, pg_get_userbyid(c.relowner), coalesce(acl.text, ''), pg_get_viewdef(c.oid, true))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace left join acl on acl.oid = c.oid
  where n.nspname in (select nspname from app_schemas) and c.relkind in ('v','m')

  union all
  select 'sequence', format('%s.%s', n.nspname, c.relname),
    format('owner=%s acl=%s type=%s start=%s inc=%s min=%s max=%s cache=%s cycle=%s owned_by=%s',
      pg_get_userbyid(c.relowner), coalesce(acl.text, ''), format_type(s.seqtypid, null), s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle,
      coalesce((select format('%s.%s.%s', dn.nspname, dc.relname, a.attname) from pg_depend d join pg_class dc on dc.oid = d.refobjid join pg_namespace dn on dn.oid = dc.relnamespace
                 join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
                 where d.objid = c.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a','i') limit 1), ''))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_sequence s on s.seqrelid = c.oid left join acl on acl.oid = c.oid
  where n.nspname in (select nspname from app_schemas) and c.relkind = 'S'

  union all
  select 'constraint', format('%s.%s.%s', n.nspname, c.relname, k.conname),
    format('%s deferrable=%s deferred=%s validated=%s', pg_get_constraintdef(k.oid), k.condeferrable, k.condeferred, k.convalidated)
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in (select nspname from app_schemas)

  union all
  select 'index', format('%s.%s', n.nspname, i.relname),
    format('%s valid=%s', pg_get_indexdef(i.oid), x.indisvalid)
  from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class c on c.oid = x.indrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in (select nspname from app_schemas)

  union all
  select 'trigger', format('%s.%s.%s', n.nspname, c.relname, t.tgname),
    format('%s enabled=%s', pg_get_triggerdef(t.oid), t.tgenabled)
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc f on f.oid = t.tgfoid join pg_namespace fn on fn.oid = f.pronamespace
  where not t.tgisinternal and (n.nspname in (select nspname from app_schemas) or fn.nspname in (select nspname from app_schemas))

  union all
  select 'policy', format('%s.%s.%s', n.nspname, c.relname, p.polname),
    format('cmd=%s permissive=%s roles=%s using=%s check=%s', p.polcmd, p.polpermissive,
      coalesce((select string_agg(coalesce(r.rolname, 'public'), ',' order by coalesce(r.rolname, 'public')) from unnest(p.polroles) u(oid) left join pg_roles r on r.oid = u.oid), ''),
      coalesce(pg_get_expr(p.polqual, p.polrelid), ''), coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
  from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in (select nspname from app_schemas) or (n.nspname = 'storage' and c.relname = 'objects')

  union all
  select 'function', format('%s.%s(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
    format('returns=%s src=%s config=%s owner=%s secdef=%s volatile=%s leakproof=%s strict=%s parallel=%s lang=%s cost=%s rows=%s kind=%s acl=%s argdefaults=%s',
      pg_get_function_result(p.oid), md5(coalesce(p.prosrc, '') || coalesce(pg_get_function_sqlbody(p.oid), '')), coalesce(array_to_string(p.proconfig, ','), ''),
      pg_get_userbyid(p.proowner), p.prosecdef, p.provolatile, p.proleakproof, p.proisstrict, p.proparallel, l.lanname, p.procost, p.prorows, p.prokind,
      coalesce(acl.text, ''), coalesce(pg_get_expr(p.proargdefaults, 0), ''))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang left join acl on acl.oid = p.oid
  where n.nspname in (select nspname from app_schemas)

  union all
  select 'storage_bucket', b.id::text,
    format('name=%s public=%s file_size_limit=%s allowed_mime_types=%s', b.name, b.public, coalesce(b.file_size_limit::text, ''), coalesce(array_to_string(b.allowed_mime_types, ','), ''))
  from storage.buckets b

  union all
  select 'storage_objects_acl', 'storage.objects', coalesce((select string_agg(coalesce(g.rolname, 'public') || '=' || e.privilege_type, ' ' order by coalesce(g.rolname, 'public'), e.privilege_type)
     from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) e left join pg_roles g on g.oid = e.grantee
     where n.nspname = 'storage' and c.relname = 'objects' and g.rolname in (select rolname from app_roles)), '')
),
rows_ as (select kind, identity, md5(definition) as fingerprint from items)
select kind, identity, fingerprint from rows_
union all
select 'summary', kind || ' (' || count(*) || ')', md5(string_agg(identity || ':' || fingerprint, ',' order by identity)) from rows_ group by kind
order by 1, 2;
