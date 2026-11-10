-- UNAPPLIED LOCAL CANDIDATE. Not a migration or provisioning script.
-- Requires existing logo stage/job/readiness migrations and the provider's
-- auth.uid(), auth.jwt(), auth.sessions and storage.allow_only_operation().
-- No account, login, credential, binding, runtime policy enablement, default ACL
-- change, schema USAGE grant, provider function replacement or bucket change.
begin;

create table fluid_private.logo_storage_principals (
  auth_user_id uuid primary key references auth.users(id),
  owner_id uuid not null references auth.users(id),
  role_name name not null references fluid_private.logo_worker_principals(role_name),
  role_oid oid not null, worker_id text not null check(worker_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  enabled boolean not null default false,
  check(auth_user_id <> owner_id)
);
create table fluid_private.logo_storage_grants (
  session_id uuid not null references auth.sessions(id) on delete cascade,
  auth_user_id uuid not null references fluid_private.logo_storage_principals(auth_user_id),
  reservation_id uuid not null references public.logo_asset_publications(id),
  job_id uuid not null references public.jobs(id), lease_token uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(session_id,reservation_id)
);
alter table fluid_private.logo_storage_principals enable row level security;
alter table fluid_private.logo_storage_principals force row level security;
alter table fluid_private.logo_storage_grants enable row level security;
alter table fluid_private.logo_storage_grants force row level security;

-- Context comes only from the JWT verified by Auth/PostgREST/Storage, never RPC
-- arguments, request headers or user-editable metadata. Live session existence
-- makes sign-out effective without waiting for token expiry. not_after checks
-- explicit session timeboxing; project inactivity/single-session configuration
-- is not reimplemented here and remains provider-managed.
create function fluid_private.logo_storage_context() returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare claims jsonb := auth.jwt(); actor uuid := auth.uid(); sid uuid; result jsonb;
begin
  if actor is null or claims->>'sub' is distinct from actor::text
    or claims->>'role' is distinct from 'authenticated' or claims->>'aud' is distinct from 'authenticated'
    or claims->>'iss' is distinct from 'https://fricsfwqibyhemknqgyf.supabase.co/auth/v1'
    or claims->'is_anonymous' is distinct from 'false'::jsonb
    or not coalesce(fluid_private.logo_uuid(claims->'session_id'),false)
    or jsonb_typeof(claims->'exp') is distinct from 'number' then return null; end if;
  if (claims->>'exp')::numeric <= extract(epoch from clock_timestamp()) then return null; end if;
  sid := (claims->>'session_id')::uuid;
  select jsonb_build_object('ownerId',b.owner_id,'authUserId',b.auth_user_id,'sessionId',sid,
    'workerRoleName',b.role_name,'workerRoleOid',b.role_oid::bigint,'workerId',b.worker_id) into result
  from fluid_private.logo_storage_principals b
  join fluid_private.logo_worker_principals p on p.role_name=b.role_name and p.role_oid=b.role_oid and p.owner_id=b.owner_id
  join pg_catalog.pg_roles r on r.oid=p.role_oid and r.rolname=p.role_name
  join auth.sessions s on s.id=sid and s.user_id=b.auth_user_id
  join auth.users u on u.id=s.user_id
  where b.auth_user_id=actor and b.enabled and not u.is_anonymous
    and (s.not_after is null or s.not_after>clock_timestamp())
    and r.rolcanlogin and not r.rolinherit and not r.rolsuper and not r.rolbypassrls
    and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
    and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid);
  return result;
end;
$$;

-- Internal predicate: not directly executable by clients. A reservation already
-- exists from the restricted DB worker and remains immutable across lease loss.
create function fluid_private.logo_storage_reservation_live(context jsonb,p_reservation uuid,p_job uuid,p_lease uuid)
returns boolean language sql volatile set search_path='' as $$
  select context is not null and exists (
    select 1 from public.logo_asset_publications p
    join public.jobs j on j.id=p.job_id and j.owner_id=p.owner_id and j.project_id=p.project_id
    join public.logo_concept_attempts a on a.job_id=j.id and a.id=p.source_receipt_id and a.owner_id=p.owner_id and a.project_id=p.project_id
    join public.logo_cost_quotes q on q.id=(j.input->>'quoteId')::uuid and q.owner_id=j.owner_id and q.project_id=j.project_id
    join fluid_private.logo_runtime_policies policy on policy.owner_id=j.owner_id and policy.operation=j.operation
    where p.id=p_reservation and j.id=p_job and p.owner_id::text=context->>'ownerId'
      and j.worker_id=context->>'workerId' and j.operation='identity.logo_concept'
      and j.state='running' and j.cancel_requested_at is null and j.lease_expires_at>clock_timestamp()
      and p.lease_token=p_lease and j.lease_token=p_lease and p_lease is not null
      and fluid_private.logo_job_policy_matches(j,policy)
      and policy.handler_version='logo-image-v1' and policy.provider='openai' and policy.model='gpt-image-2.5-sunburst-2026-09-08'
      and p.state in ('reserved','staged') and p.source_kind='concept' and p.purpose='brand_asset' and p.rights_evidence_id is null
      and p.source_receipt_id::text=j.input->>'attemptId' and p.input_hash=j.input_hash and p.input_revision=j.input_revision
      and p.mime_type in ('image/png','image/jpeg','image/webp')
      and p.request->>'kind'='stage' and p.request#>>'{publication,source,kind}'='concept'
      and p.request#>>'{publication,source,sourceId}'=p.source_receipt_id::text
      and p.request#>>'{publication,requestKey}'=p.request_key::text
      and p.request#>>'{publication,contentHash}'=p.content_hash and p.request#>>'{publication,mimeType}'=p.mime_type
      and p.request#>'{publication,byteLength}'=to_jsonb(p.byte_length)
      and p.request#>'{publication,inputRevisions}'=q.input_revisions
  )
$$;

-- This intentionally keeps disabled bindings fenced. Revoke by disabling, not
-- deleting the identity binding; deletion changes the identity's policy class.
create function fluid_private.logo_storage_identity_bound() returns boolean
language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and exists(select 1 from fluid_private.logo_storage_principals where auth_user_id=auth.uid())
$$;

create function fluid_private.logo_storage_object_allowed(p_bucket text,p_name text) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare context jsonb := fluid_private.logo_storage_context();
begin
  if context is null or p_bucket is distinct from 'fluid-assets' or p_name is null then return false; end if;
  return exists (
    select 1 from fluid_private.logo_storage_grants g join public.logo_asset_publications p on p.id=g.reservation_id
    where g.session_id=(context->>'sessionId')::uuid and g.auth_user_id=auth.uid()
      and p_name=p.owner_id::text||'/'||p.project_id::text||'/'||p.asset_id::text||'/'||p.version_id::text
      and fluid_private.logo_storage_reservation_live(context,p.id,g.job_id,g.lease_token)
  );
end;
$$;

-- Public wrappers are narrowly callable definer entrypoints because clients
-- have no private schema/table access. The private context validates auth.uid
-- before any lookup result or grant can escape. No caller-supplied owner/user.
create function public.logo_storage_session() returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare context jsonb := fluid_private.logo_storage_context();
begin
  if context is null then raise exception 'logo_storage_unavailable' using errcode='42501'; end if;
  return context;
end;
$$;
create function public.authorize_logo_storage_reservation(p_job uuid,p_lease uuid,p_reservation uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare context jsonb := fluid_private.logo_storage_context(); r public.logo_asset_publications; existing fluid_private.logo_storage_grants;
begin
  if context is null or not fluid_private.logo_storage_reservation_live(context,p_reservation,p_job,p_lease) then
    raise exception 'logo_storage_unavailable' using errcode='42501';
  end if;
  insert into fluid_private.logo_storage_grants(session_id,auth_user_id,reservation_id,job_id,lease_token)
    values((context->>'sessionId')::uuid,auth.uid(),p_reservation,p_job,p_lease) on conflict(session_id,reservation_id) do nothing;
  select * into existing from fluid_private.logo_storage_grants where session_id=(context->>'sessionId')::uuid and reservation_id=p_reservation;
  if existing.auth_user_id is distinct from auth.uid() or existing.job_id is distinct from p_job or existing.lease_token is distinct from p_lease then
    raise exception 'logo_storage_unavailable' using errcode='42501';
  end if;
  select * into r from public.logo_asset_publications where id=p_reservation;
  return context || jsonb_build_object('jobId',p_job,'leaseToken',p_lease,'reservation',fluid_private.logo_asset_reservation(r));
end;
$$;

-- Scrub inherited/default grants on ONLY the new relations and signatures.
-- Existing ACLs and default privileges are never changed.
do $$
declare object_name text; object_id oid; r record; c record;
begin
  foreach object_name in array array['fluid_private.logo_storage_principals','fluid_private.logo_storage_grants'] loop
    object_id:=to_regclass(object_name);
    for r in select distinct a.grantee from pg_catalog.pg_class t
      cross join lateral pg_catalog.aclexplode(coalesce(t.relacl,pg_catalog.acldefault('r',t.relowner))) a
      where t.oid=object_id and a.grantee<>t.relowner loop
      execute pg_catalog.format('revoke all on table %s from %s cascade',object_id::regclass,
        case when r.grantee=0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) end);
    end loop;
    for c in select at.attname,a.grantee from pg_catalog.pg_attribute at join pg_catalog.pg_class t on t.oid=at.attrelid
      cross join lateral pg_catalog.aclexplode(at.attacl) a where t.oid=object_id and a.grantee<>t.relowner loop
      execute pg_catalog.format('revoke all (%I) on table %s from %s cascade',c.attname,object_id::regclass,
        case when c.grantee=0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(c.grantee)) end);
    end loop;
  end loop;
  foreach object_name in array array['fluid_private.logo_storage_context()',
    'fluid_private.logo_storage_reservation_live(jsonb,uuid,uuid,uuid)','fluid_private.logo_storage_identity_bound()',
    'fluid_private.logo_storage_object_allowed(text,text)','public.logo_storage_session()',
    'public.authorize_logo_storage_reservation(uuid,uuid,uuid)'] loop
    object_id:=to_regprocedure(object_name);
    for r in select distinct a.grantee from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      where p.oid=object_id and a.grantee<>p.proowner loop
      execute pg_catalog.format('revoke all on function %s from %s cascade',object_id::regprocedure,
        case when r.grantee=0 then 'PUBLIC' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) end);
    end loop;
  end loop;
end;
$$;
grant execute on function public.logo_storage_session(),public.authorize_logo_storage_reservation(uuid,uuid,uuid),
  fluid_private.logo_storage_identity_bound(),fluid_private.logo_storage_object_allowed(text,text) to authenticated;

create policy fluid_logo_worker_storage_read on storage.objects as permissive for select to authenticated
  using(owner_id=(select auth.uid())::text and storage.allow_only_operation('object.get_authenticated')
    and fluid_private.logo_storage_object_allowed(bucket_id,name));
create policy fluid_logo_worker_storage_insert on storage.objects as permissive for insert to authenticated
  with check(owner_id=(select auth.uid())::text and storage.allow_only_operation('object.upload')
    and fluid_private.logo_storage_object_allowed(bucket_id,name));

-- Restrictive policies affect ONLY explicitly bound dedicated identities.
-- Ordinary owner's existing reads/uploads/signing remain byte-for-byte intact.
create policy fluid_logo_worker_storage_read_fence on storage.objects as restrictive for select to authenticated
  using(not fluid_private.logo_storage_identity_bound() or (owner_id=(select auth.uid())::text
    and storage.allow_only_operation('object.get_authenticated') and fluid_private.logo_storage_object_allowed(bucket_id,name)));
create policy fluid_logo_worker_storage_insert_fence on storage.objects as restrictive for insert to authenticated
  with check(not fluid_private.logo_storage_identity_bound() or (owner_id=(select auth.uid())::text
    and storage.allow_only_operation('object.upload') and fluid_private.logo_storage_object_allowed(bucket_id,name)));
create policy fluid_logo_worker_storage_update_fence on storage.objects as restrictive for update to authenticated
  using(not fluid_private.logo_storage_identity_bound()) with check(not fluid_private.logo_storage_identity_bound());
create policy fluid_logo_worker_storage_delete_fence on storage.objects as restrictive for delete to authenticated
  using(not fluid_private.logo_storage_identity_bound());
commit;
