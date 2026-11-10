-- UNAPPLIED control-plane packet. No login, password, grant to a runtime login,
-- provider call or existing-user backfill is performed by installation.
-- Review Auth-trigger ownership and dedicated operator provisioning separately.
begin;

-- This manager cannot log in or access customer relations. PostgreSQL 17's
-- creator ADMIN edge is retained with INHERIT=false and SET=false. The existing
-- trusted database owner installs only fixed grant-option/helper capabilities.
do $$begin
 if current_user<>'postgres' or to_regrole('embel_account_role_manager') is not null then
  raise exception 'account_enrollment_manager_install_requires_reviewed_fresh_role'; end if;
end $$;
create role embel_account_role_manager nologin noinherit nosuperuser nocreatedb createrole noreplication nobypassrls;

create table fluid_private.account_service_enrollments (
 id uuid primary key default gen_random_uuid(), owner_id uuid unique not null,
 generation integer not null default 1 check(generation>0), revision bigint not null default 1 check(revision>0),
 eligibility text not null check(eligibility in('active','unconfirmed','suspended','deleted')),
 state text not null default 'pending' check(state in('pending','ready','revoking','revoked')),
 available_at timestamptz not null default clock_timestamp(),
 lease_token uuid, lease_until timestamptz, lease_role_name name, lease_role_oid oid,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 check((lease_token is null)=(lease_until is null)), check((lease_token is null)=(lease_role_name is null)),
 check((lease_token is null)=(lease_role_oid is null))
);
create table fluid_private.account_service_enrollment_steps (
 enrollment_id uuid not null references fluid_private.account_service_enrollments(id), generation integer not null,
 capability text not null check(capability in('home_attachments','identity_transactions','strategy','naming','logo')),
 operation_key uuid unique not null default gen_random_uuid(),
 phase text not null default 'pending' check(phase in('pending','provisioning','credential_reserved','provisioned','published','ready','blocked','uncertain','revoking','revoked')),
 effects_started boolean not null default false,
 credential_ref text, publication_receipt text, verification_receipt text, revocation_receipt text,revocation_verified_at timestamptz,
 reason text check(reason in('adapter_unavailable','store_unavailable','publication_unavailable','verification_unavailable','provision_unavailable','effect_unknown','account_unavailable')),
 updated_at timestamptz not null default clock_timestamp(), primary key(enrollment_id,generation,capability),
 check(credential_ref is null or credential_ref~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
 check(publication_receipt is null or publication_receipt~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
 check(verification_receipt is null or verification_receipt~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
);
create table fluid_private.account_enrollment_operators (
 role_name name primary key, role_oid oid unique not null,
 management_version smallint not null default 1 check(management_version in(1,2))
);
create table fluid_private.account_enrollment_managed_roles (
 owner_id uuid not null, capability text not null check(capability in('home_attachments','identity_transactions','strategy','naming','logo')),
 generation integer not null, manager_role_name name not null, manager_role_oid oid not null,
 role_name name unique not null, role_oid oid unique not null, operation_key uuid not null,
 credential_ref text unique not null, primary key(owner_id,capability)
);
create table fluid_private.account_enrollment_role_manager (
 singleton boolean primary key default true check(singleton),
 manager_role_name name not null,manager_role_oid oid not null,root_role_name name not null,root_role_oid oid not null,
 identity_owner_oid oid
);
create table fluid_private.account_service_actors (
 auth_user_id uuid primary key references auth.users(id) on delete cascade,
 purpose text not null check(purpose='logo_storage'),
 registration_receipt text not null check(registration_receipt~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$')
);
create function fluid_private.account_service_actor_immutable() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' or exists(select 1 from auth.users where id=old.auth_user_id) then
  raise exception 'immutable_account_service_actor' using errcode='55000'; end if;
 return old;
end $$;
create trigger account_service_actor_immutable before update or delete on fluid_private.account_service_actors
 for each row execute function fluid_private.account_service_actor_immutable();
insert into fluid_private.account_enrollment_role_manager(manager_role_name,manager_role_oid,root_role_name,root_role_oid,identity_owner_oid)
 select 'embel_account_role_manager',to_regrole('embel_account_role_manager')::oid,'postgres',to_regrole('postgres')::oid,
  to_regrole('fluid_identity_writer_definer_v1')::oid;
do $$declare relation_name text; acl_row record;begin
 foreach relation_name in array array['account_service_enrollments','account_service_enrollment_steps','account_enrollment_operators','account_enrollment_managed_roles','account_enrollment_role_manager','account_service_actors'] loop
  execute format('alter table fluid_private.%I enable row level security',relation_name);
  execute format('alter table fluid_private.%I force row level security',relation_name);
  execute format('revoke all on fluid_private.%I from public,anon,authenticated,service_role',relation_name);
  for acl_row in select distinct a.grantee from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   where c.oid=to_regclass('fluid_private.'||relation_name) and a.grantee<>c.relowner loop
   execute format('revoke all on table fluid_private.%I from %s cascade',relation_name,
    case when acl_row.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(acl_row.grantee)) end);
  end loop;
 end loop;
end $$;
create index account_service_enrollment_work on fluid_private.account_service_enrollments(available_at,created_at) where state<>'revoked';

create function fluid_private.account_enrollment_eligibility(p_owner uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare account jsonb;
begin
 select to_jsonb(u) into account from auth.users u where id=p_owner;
 if account is null or account->>'deleted_at' is not null then return 'deleted'; end if;
 if exists(select 1 from fluid_private.account_service_actors where auth_user_id=p_owner) then return 'suspended'; end if;
 if coalesce(account->>'is_anonymous','false')='true' or account->>'email_confirmed_at' is null then return 'unconfirmed'; end if;
 if coalesce((account->>'banned_until')::timestamptz,'-infinity'::timestamptz)>clock_timestamp() then return 'suspended'; end if;
 return 'active';
end $$;

create function fluid_private.account_enrollment_new_steps(p_id uuid,p_generation integer) returns void
language sql security definer set search_path='' as $$
 insert into fluid_private.account_service_enrollment_steps(enrollment_id,generation,capability)
 select p_id,p_generation,capability from unnest(array['home_attachments','identity_transactions','strategy','naming','logo']) capability;
$$;

create function fluid_private.refresh_account_enrollment(p_owner uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare current_eligibility text; e fluid_private.account_service_enrollments;
begin
 -- Auth row then enrollment row matches the Auth outbox trigger's lock order.
 perform 1 from auth.users where id=p_owner for share;
 current_eligibility:=fluid_private.account_enrollment_eligibility(p_owner);
 select * into e from fluid_private.account_service_enrollments where owner_id=p_owner for update;
 if not found then
  if current_eligibility<>'active' then return null; end if;
  insert into fluid_private.account_service_enrollments(owner_id,eligibility) values(p_owner,current_eligibility) returning * into e;
  perform fluid_private.account_enrollment_new_steps(e.id,e.generation); return e.id;
 end if;
 if e.eligibility is distinct from current_eligibility then
  update fluid_private.account_service_enrollments set eligibility=current_eligibility,revision=revision+1,
   lease_token=null,lease_until=null,lease_role_name=null,lease_role_oid=null,available_at=clock_timestamp(),updated_at=clock_timestamp()
   where id=e.id returning * into e;
  if current_eligibility<>'active' then
   update fluid_private.account_service_enrollments set state='revoking' where id=e.id;
   update fluid_private.account_service_enrollment_steps set phase='revoking',reason='account_unavailable',updated_at=clock_timestamp()
    where enrollment_id=e.id and generation=e.generation and phase<>'revoked';
  elsif e.state='revoked' then
   update fluid_private.account_service_enrollments set generation=generation+1,state='pending' where id=e.id returning * into e;
   perform fluid_private.account_enrollment_new_steps(e.id,e.generation);
  end if;
 end if;
 return e.id;
end $$;

create function fluid_private.account_enrollment_auth_outbox() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- DB-only outbox: never call a provider, create a login or publish a secret
 -- inside an Auth request. Deleted-user tombstones remain for revocation.
 if tg_op='DELETE' then perform fluid_private.refresh_account_enrollment(old.id); return old; end if;
 perform fluid_private.refresh_account_enrollment(new.id); return new;
end $$;
create trigger embel_account_service_enrollment_outbox after insert or update or delete on auth.users
 for each row execute function fluid_private.account_enrollment_auth_outbox();

create function fluid_private.account_enrollment_public(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('ownerId',e.owner_id,'generation',e.generation,
  'status',case when e.eligibility<>'active' then 'unavailable' when e.state='ready' then 'ready' else 'pending' end,
  'capabilities',coalesce((select jsonb_object_agg(s.capability,s.phase='ready' and e.eligibility='active')
    from fluid_private.account_service_enrollment_steps s where s.enrollment_id=e.id and s.generation=e.generation),'{}'::jsonb),
  'updatedAt',to_char(e.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
 from fluid_private.account_service_enrollments e where e.id=p_id;
$$;

create function public.ensure_account_service_enrollment() returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); enrollment_id uuid;
begin
 if owner is null or fluid_private.account_enrollment_eligibility(owner)<>'active' then raise exception 'account_enrollment_unauthenticated' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text||':account-enrollment',0));
 enrollment_id:=fluid_private.refresh_account_enrollment(owner);
 return fluid_private.account_enrollment_public(enrollment_id);
end $$;
create function public.get_account_service_enrollment() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); enrollment_id uuid;
begin
 if owner is null or fluid_private.account_enrollment_eligibility(owner)<>'active' then raise exception 'account_enrollment_unauthenticated' using errcode='42501'; end if;
 select id into enrollment_id from fluid_private.account_service_enrollments where owner_id=owner;
 if enrollment_id is null then return null; end if;
 return fluid_private.account_enrollment_public(enrollment_id);
end $$;

-- Read-only Auth-derived publication authority. No role, credential or caller
-- owner argument crosses the web boundary; each request rechecks real Auth state.
create function public.get_account_service_enrollment_binding() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); e fluid_private.account_service_enrollments; result jsonb;
begin
 if owner is null or fluid_private.account_enrollment_eligibility(owner)<>'active' then raise exception 'account_enrollment_unauthenticated' using errcode='42501'; end if;
 select * into e from fluid_private.account_service_enrollments where owner_id=owner and eligibility='active' and state not in('revoking','revoked');
 if not found then return null; end if;
 result:=jsonb_build_object('ownerId',owner,'generation',e.generation,'revision',e.revision,'identity',null,'attachments',null);
 return result||coalesce((select jsonb_object_agg(case s.capability when 'home_attachments' then 'attachments' else 'identity' end,
  jsonb_build_object('operationKey',s.operation_key,'publicationReceipt',s.publication_receipt,'ready',s.phase='ready'))
  from fluid_private.account_service_enrollment_steps s where s.enrollment_id=e.id and s.generation=e.generation
   and s.capability in('home_attachments','identity_transactions')),'{}'::jsonb);
end $$;

-- Restrictive only: the existing immutable-object policies still decide every
-- allowed operation. Unmanaged legacy owners and all non-Home paths retain the
-- existing policy behavior. Managed Home admission consults real Auth state,
-- including bans/deletion with a still-unexpired JWT.
create function fluid_private.account_enrollment_home_storage_allowed(p_bucket text,p_name text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare owner uuid:=auth.uid(); managed fluid_private.account_enrollment_managed_roles;
begin
 if p_bucket is distinct from 'fluid-assets' or split_part(p_name,'/',2) is distinct from 'home' then return true; end if;
 select * into managed from fluid_private.account_enrollment_managed_roles where capability='home_attachments' and owner_id::text=split_part(p_name,'/',1);
 if not found then
  -- A crash before principal creation still closes managed admission once an
  -- enrollment intent records effects. Never reinterpret partial work as legacy.
  return not exists(select 1 from fluid_private.account_service_enrollments e
   join fluid_private.account_service_enrollment_steps s on s.enrollment_id=e.id and s.generation=e.generation
   where e.owner_id::text=split_part(p_name,'/',1) and s.capability='home_attachments' and s.effects_started);
 end if;
 if owner is null or owner<>managed.owner_id or fluid_private.account_enrollment_eligibility(owner)<>'active' then return false; end if;
 return exists(select 1 from fluid_private.account_service_enrollments e
  join fluid_private.account_service_enrollment_steps s on s.enrollment_id=e.id and s.generation=e.generation and s.capability='home_attachments'
  where e.owner_id=owner and e.generation=managed.generation and e.eligibility='active' and e.state not in('revoking','revoked')
   and s.operation_key=managed.operation_key and s.phase='ready');
end $$;
create policy account_enrollment_home_storage_gate on storage.objects as restrictive for all to authenticated
 using(fluid_private.account_enrollment_home_storage_allowed(bucket_id,name))
 with check(fluid_private.account_enrollment_home_storage_allowed(bucket_id,name));

create function fluid_private.account_enrollment_operator() returns oid
language plpgsql stable security definer set search_path='' as $$
declare principal pg_catalog.pg_roles; managed_version integer; trusted_root oid;
begin
 select * into principal from pg_catalog.pg_roles where rolname=session_user;
 select management_version into managed_version from fluid_private.account_enrollment_operators where role_name=session_user and role_oid=principal.oid;
 select root_role_oid into trusted_root from fluid_private.account_enrollment_role_manager where singleton;
 if principal.oid is null or not principal.rolcanlogin or principal.rolinherit or principal.rolsuper or principal.rolbypassrls
  or principal.rolcreatedb or principal.rolcreaterole or principal.rolreplication
  or exists(select 1 from pg_catalog.pg_auth_members where member=principal.oid)
  or (exists(select 1 from pg_catalog.pg_auth_members where roleid=principal.oid) and not(managed_version=2
   and (select count(*) from pg_catalog.pg_auth_members where roleid=principal.oid)=1
   and exists(select 1 from pg_catalog.pg_auth_members where roleid=principal.oid and member=trusted_root and admin_option and not inherit_option and not set_option)))
  or managed_version is null
  or exists(select 1 from pg_class where relowner=principal.oid) or exists(select 1 from pg_namespace where nspowner=principal.oid)
 then raise exception 'account_enrollment_operator_unavailable' using errcode='42501'; end if;
 return principal.oid;
end $$;

create function fluid_private.account_enrollment_claim_json(e fluid_private.account_service_enrollments) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',e.id,'ownerId',e.owner_id,'generation',e.generation,'revision',e.revision,
  'leaseToken',e.lease_token,'leaseUntil',to_char(e.lease_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'mode',case when e.state='revoking' or e.eligibility<>'active' then 'revoke' else 'enroll' end,
  'steps',(select jsonb_agg(jsonb_build_object('capability',s.capability,'operationKey',s.operation_key,'phase',s.phase,'effectsStarted',s.effects_started,
    'credentialRef',s.credential_ref,'publicationReceipt',s.publication_receipt,'verificationReceipt',s.verification_receipt)
    order by s.capability) from fluid_private.account_service_enrollment_steps s where s.enrollment_id=e.id and s.generation=e.generation));
$$;

create function public.claim_account_service_enrollment(p_seconds integer default 60) returns jsonb
language plpgsql security definer set search_path='' as $$
declare operator_oid oid:=fluid_private.account_enrollment_operator(); e fluid_private.account_service_enrollments; candidate record;
begin
 if p_seconds is null or p_seconds not between 10 and 120 then raise exception 'invalid_account_enrollment_lease' using errcode='22023'; end if;
 for candidate in select id,owner_id from fluid_private.account_service_enrollments where state<>'revoked'
  and available_at<=clock_timestamp() and (lease_until is null or lease_until<clock_timestamp()) order by available_at,created_at limit 100 loop
  perform 1 from auth.users where id=candidate.owner_id for share;
  select * into e from fluid_private.account_service_enrollments where id=candidate.id and state<>'revoked'
   and available_at<=clock_timestamp() and (lease_until is null or lease_until<clock_timestamp()) for update skip locked;
  if found then exit; end if;
 end loop;
 if e.id is null then return null; end if;
 perform fluid_private.refresh_account_enrollment(e.owner_id);
 select * into e from fluid_private.account_service_enrollments where id=e.id for update;
 update fluid_private.account_service_enrollments set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_seconds),
  lease_role_name=session_user,lease_role_oid=operator_oid,updated_at=clock_timestamp() where id=e.id returning * into e;
 return fluid_private.account_enrollment_claim_json(e);
end $$;

create function fluid_private.lock_account_enrollment(p_id uuid,p_token uuid) returns fluid_private.account_service_enrollments
language plpgsql security definer set search_path='' as $$
declare operator_oid oid:=fluid_private.account_enrollment_operator(); e fluid_private.account_service_enrollments; current_eligibility text; owner uuid;
begin
 select owner_id into owner from fluid_private.account_service_enrollments where id=p_id;
 perform 1 from auth.users where id=owner for share;
 select * into e from fluid_private.account_service_enrollments where id=p_id for update;
 if not found or e.owner_id is distinct from owner or p_token is null or e.lease_token is distinct from p_token or e.lease_until<=clock_timestamp()
  or e.lease_role_name is distinct from session_user or e.lease_role_oid is distinct from operator_oid then
  raise exception 'account_enrollment_lease_unavailable' using errcode='42501'; end if;
 -- The Auth lock precedes this enrollment lock on every mutation path.
 current_eligibility:=fluid_private.account_enrollment_eligibility(e.owner_id);
 if current_eligibility is distinct from e.eligibility then raise exception 'account_enrollment_owner_changed' using errcode='42501'; end if;
 return e;
end $$;

create function public.read_account_service_enrollment_claim(p_id uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token);
begin return fluid_private.account_enrollment_claim_json(e); end $$;

create function public.record_account_service_enrollment(p_id uuid,p_token uuid,p_capability text,p_phase text,p_reference text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token); s fluid_private.account_service_enrollment_steps;
begin
 if e.eligibility<>'active' or e.state='revoking' then raise exception 'account_enrollment_owner_changed' using errcode='42501'; end if;
 select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability=p_capability for update;
 if not found then raise exception 'invalid_account_enrollment_capability' using errcode='22023'; end if;
 if p_capability not in('home_attachments','identity_transactions') and p_phase in('credential_reserved','published','ready') then
  raise exception 'account_enrollment_worker_proof_required' using errcode='55000'; end if;
 if p_phase='provisioning' then
  if s.phase not in('pending','provisioning','credential_reserved','blocked','uncertain') then raise exception 'account_enrollment_effect_conflict' using errcode='55000'; end if;
  update fluid_private.account_service_enrollment_steps set phase=p_phase,effects_started=true,reason=null,updated_at=clock_timestamp()
   where enrollment_id=e.id and generation=e.generation and capability=p_capability;
 elsif p_phase='credential_reserved' then
  if p_capability not in('home_attachments','identity_transactions') or p_reference is null or p_reference!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
   or s.phase not in('provisioning','credential_reserved','blocked','uncertain') or s.credential_ref is not null and s.credential_ref<>p_reference then
   raise exception 'account_enrollment_credential_conflict' using errcode='55000'; end if;
  update fluid_private.account_service_enrollment_steps set phase=p_phase,effects_started=true,credential_ref=p_reference,reason=null,updated_at=clock_timestamp()
   where enrollment_id=e.id and generation=e.generation and capability=p_capability;
 elsif p_phase='published' then
  if s.phase not in('provisioned','published') or p_reference is null or p_reference!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
   or s.publication_receipt is not null and s.publication_receipt<>p_reference then raise exception 'account_enrollment_publication_conflict' using errcode='55000'; end if;
  update fluid_private.account_service_enrollment_steps set phase=p_phase,publication_receipt=p_reference,reason=null,updated_at=clock_timestamp()
   where enrollment_id=e.id and generation=e.generation and capability=p_capability;
 elsif p_phase='ready' then
  if s.phase not in('published','ready') or p_reference is null or p_reference!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
   or s.verification_receipt is not null and s.verification_receipt<>p_reference then raise exception 'account_enrollment_verification_conflict' using errcode='55000'; end if;
  update fluid_private.account_service_enrollment_steps set phase=p_phase,verification_receipt=p_reference,reason=null,updated_at=clock_timestamp()
   where enrollment_id=e.id and generation=e.generation and capability=p_capability;
 elsif p_phase in('blocked','uncertain') then
  if p_reference not in('adapter_unavailable','store_unavailable','publication_unavailable','verification_unavailable','provision_unavailable','effect_unknown')
   or s.phase in('ready','revoking','revoked') then raise exception 'invalid_account_enrollment_failure' using errcode='22023'; end if;
  update fluid_private.account_service_enrollment_steps set phase=p_phase,reason=p_reference,updated_at=clock_timestamp()
   where enrollment_id=e.id and generation=e.generation and capability=p_capability;
 else raise exception 'invalid_account_enrollment_phase' using errcode='22023'; end if;
 return fluid_private.account_enrollment_claim_json(e);
end $$;

create function fluid_private.account_enrollment_http_helpers_ready(p_capability text) returns boolean
language sql stable security definer set search_path='' as $$
 with expected(signature,body_hash,definer,volatility,owner_name) as (
  select * from (values
   ('fluid_private.home_attachment_owner()','5b5f2a913343ce8c2785dc677e1e283aea7a5833f7c83a57b9da03197c4dd40b',true,'s','postgres'),
   ('fluid_private.prepare_home_attachment(jsonb,bigint)','c0eb091e034e62845fa67e75e8b8049a066c0677f980ebb7961d95866824a402',true,'v','postgres'),
   ('fluid_private.observe_home_attachment(uuid,jsonb)','fce80bafee4f77b9f1985e6d0235b065adeddfe26d3cab01f748f8e29e72edc8',true,'v','postgres'),
   ('fluid_private.lookup_home_attachment(uuid)','289abf1c70b7f4fdb9e2e195bb896b71b6f7ad4b22c4b28b1d45d384b38ea206',true,'s','postgres'),
   ('fluid_private.resolve_home_attachments(uuid[])','c3d252d83aa79a51c3c294e2b1071fbe2c59ee725af8d72df3a8bc2ebb41d849',true,'s','postgres')
  ) home where p_capability='home_attachments'
  union all select * from (values
   ('fluid_private.identity_web_owner()','49895b45e6a1cafd7aee6966881f462ab74fba3d024c2385563f0a13efb93721',false,'s','postgres'),
   ('fluid_private.prepare_identity_transaction(uuid,jsonb,boolean)','f6db4c816fa1418cb76b40f7d9f9b43effacfec3bbdcaa462325c52c1eabf166',true,'v','fluid_identity_writer_definer_v1'),
   ('fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)','63febf976e3504873425fc3d388c319e320291d83a6bc048a4fb56a36a671f6a',true,'v','fluid_identity_writer_definer_v1')
  ) identity_helpers where p_capability='identity_transactions'
 )
 select count(*)=(case when p_capability='home_attachments' then 5 when p_capability='identity_transactions' then 3 else -1 end)
  and coalesce(bool_and(p.oid is not null and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=e.body_hash
   and p.prosecdef=e.definer and p.provolatile::text=e.volatility and pg_get_userbyid(p.proowner)=e.owner_name
   and p.proconfig=array['search_path=""'] and not p.proleakproof
   and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')),false)
 from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature);
$$;

create function fluid_private.account_enrollment_role_name(p_owner uuid,p_capability text) returns text
language sql immutable set search_path='' as $$
 select (case p_capability when 'home_attachments' then 'embel_home_web_' when 'identity_transactions' then 'embel_identity_web_'
  when 'strategy' then 'fluid_api_text_worker_' when 'naming' then 'fluid_naming_brain_worker_' when 'logo' then 'fluid_logo_worker_' end)
  ||replace(p_owner::text,'-','');
$$;

create function fluid_private.account_enrollment_role_for_lease(p_id uuid,p_token uuid,p_capability text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token);
 s fluid_private.account_service_enrollment_steps; prior fluid_private.account_enrollment_managed_roles; manager fluid_private.account_enrollment_role_manager;
begin
 select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability=p_capability;
 if not found then raise exception 'invalid_account_enrollment_capability' using errcode='22023'; end if;
 select * into prior from fluid_private.account_enrollment_managed_roles where owner_id=e.owner_id and capability=p_capability;
 select * into manager from fluid_private.account_enrollment_role_manager where singleton;
 return jsonb_build_object('ownerId',e.owner_id,'generation',e.generation,'revision',e.revision,'mode',
  case when e.state='revoking' or e.eligibility<>'active' then 'revoke' else 'enroll' end,
  'capability',p_capability,'operationKey',s.operation_key,'phase',s.phase,'credentialRef',s.credential_ref,
  'revocationReceipt',s.revocation_receipt,'revocationVerifiedAt',s.revocation_verified_at,'claimUpdatedAt',e.updated_at,
  'roleName',fluid_private.account_enrollment_role_name(e.owner_id,p_capability),'roleOid',prior.role_oid::bigint,
  'priorOperationKey',prior.operation_key,'priorCredentialRef',prior.credential_ref,
  'managerRoleName',manager.manager_role_name,'managerRoleOid',manager.manager_role_oid::bigint);
end $$;

create function fluid_private.record_account_enrollment_managed_role(p_id uuid,p_token uuid,p_capability text,p_role_oid oid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token);
 s fluid_private.account_service_enrollment_steps; manager fluid_private.account_enrollment_role_manager; actual pg_catalog.pg_roles; desired_name text;
begin
 select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability=p_capability for update;
 select * into manager from fluid_private.account_enrollment_role_manager where singleton;
 desired_name:=fluid_private.account_enrollment_role_name(e.owner_id,p_capability);
 select * into actual from pg_catalog.pg_roles where oid=p_role_oid and rolname=desired_name;
 if e.eligibility<>'active' or e.state='revoking' or s.credential_ref is null or not s.effects_started
  or actual.oid is null or not actual.rolcanlogin or actual.rolconnlimit<>4 or actual.rolinherit or actual.rolsuper or actual.rolcreatedb or actual.rolcreaterole or actual.rolreplication or actual.rolbypassrls
  or exists(select 1 from pg_auth_members where member=actual.oid)
  or (select count(*) from pg_auth_members where roleid=actual.oid)<>1
  or not exists(select 1 from pg_auth_members where roleid=actual.oid and member=manager.manager_role_oid and admin_option and not inherit_option and not set_option)
  or exists(select 1 from pg_class where relowner=actual.oid) or exists(select 1 from pg_namespace where nspowner=actual.oid)
 then raise exception 'account_enrollment_managed_role_unsafe' using errcode='55000'; end if;
 insert into fluid_private.account_enrollment_managed_roles(owner_id,capability,generation,role_name,role_oid,manager_role_name,manager_role_oid,operation_key,credential_ref)
  values(e.owner_id,p_capability,e.generation,desired_name,actual.oid,manager.manager_role_name,manager.manager_role_oid,s.operation_key,s.credential_ref)
  on conflict(owner_id,capability) do update set generation=excluded.generation,role_oid=excluded.role_oid,
   manager_role_name=excluded.manager_role_name,manager_role_oid=excluded.manager_role_oid,operation_key=excluded.operation_key,credential_ref=excluded.credential_ref;
 return jsonb_build_object('ownerId',e.owner_id,'generation',e.generation,'capability',p_capability,'operationKey',s.operation_key,
  'roleName',desired_name,'roleOid',actual.oid::bigint,'managerRoleName',manager.manager_role_name,'managerRoleOid',manager.manager_role_oid::bigint,'credentialRef',s.credential_ref);
end $$;

create function public.account_enrollment_managed_principal() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r pg_catalog.pg_roles; manager pg_catalog.pg_roles; root_role pg_catalog.pg_roles; identity_owner pg_catalog.pg_roles;
 binding fluid_private.account_enrollment_managed_roles; manager_config fluid_private.account_enrollment_role_manager;
 e fluid_private.account_service_enrollments; s fluid_private.account_service_enrollment_steps; identity_safe boolean:=false;
begin
 select * into r from pg_roles where rolname=session_user;
 select * into binding from fluid_private.account_enrollment_managed_roles where role_name=session_user and role_oid=r.oid;
 select * into manager_config from fluid_private.account_enrollment_role_manager where singleton;
 select * into manager from pg_roles where oid=manager_config.manager_role_oid and rolname=manager_config.manager_role_name;
 select * into root_role from pg_roles where oid=manager_config.root_role_oid and rolname=manager_config.root_role_name;
 select * into e from fluid_private.account_service_enrollments where owner_id=binding.owner_id;
 select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability=binding.capability;
 if r.oid is null or binding.role_oid is null or not r.rolcanlogin or r.rolconnlimit<>4 or r.rolinherit or r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls
  or manager.oid is null or manager.rolcanlogin or manager.rolinherit or manager.rolsuper or manager.rolcreatedb or not manager.rolcreaterole or manager.rolreplication or manager.rolbypassrls
  or root_role.oid is null or not root_role.rolcanlogin or not(root_role.rolcreaterole or root_role.rolsuper)
  or binding.manager_role_oid<>manager.oid or binding.manager_role_name<>manager.rolname
  or e.id is null or e.generation<>binding.generation or e.eligibility<>'active' or e.state in('revoking','revoked')
  or fluid_private.account_enrollment_eligibility(e.owner_id)<>'active' or s.enrollment_id is null or s.operation_key<>binding.operation_key or s.phase not in('provisioned','published','ready')
  or exists(select 1 from pg_auth_members where member=r.oid)
  or (select count(*) from pg_auth_members where roleid=r.oid)<>1
  or not exists(select 1 from pg_auth_members where roleid=r.oid and member=manager.oid and admin_option and not inherit_option and not set_option)
  or (select count(*) from pg_auth_members where roleid=manager.oid)<>1
  or not exists(select 1 from pg_auth_members where roleid=manager.oid and member=root_role.oid and admin_option and not inherit_option and not set_option)
  or exists(select 1 from pg_auth_members m where m.member=manager.oid and (not m.admin_option or m.inherit_option or m.set_option
   or not exists(select 1 from fluid_private.account_enrollment_managed_roles p where p.role_oid=m.roleid and p.manager_role_oid=manager.oid)))
  or exists(select 1 from pg_class where relowner in(r.oid,manager.oid)) or exists(select 1 from pg_namespace where nspowner in(r.oid,manager.oid))
  or has_schema_privilege(manager.oid,'public','CREATE') or has_schema_privilege(manager.oid,'fluid_private','CREATE')
  or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','fluid_private','auth','storage')
   and c.relkind in('r','p','v','m','f') and (has_any_column_privilege(manager.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
    or has_table_privilege(manager.oid,c.oid,'DELETE,TRUNCATE,TRIGGER')))
 then raise exception 'account_enrollment_managed_principal_unavailable' using errcode='42501'; end if;
 select * into identity_owner from pg_roles where oid=manager_config.identity_owner_oid and rolname='fluid_identity_writer_definer_v1';
 identity_safe:=identity_owner.oid is not null and not identity_owner.rolcanlogin and not identity_owner.rolinherit and not identity_owner.rolsuper
  and not identity_owner.rolcreatedb and not identity_owner.rolcreaterole and not identity_owner.rolreplication and not identity_owner.rolbypassrls
  and not exists(select 1 from pg_auth_members where member=identity_owner.oid)
  and ((select count(*) from pg_auth_members where roleid=identity_owner.oid)=0 or
   ((select count(*) from pg_auth_members where roleid=identity_owner.oid)=1 and exists(select 1 from pg_auth_members where roleid=identity_owner.oid
    and member=root_role.oid and admin_option and not inherit_option and not set_option)));
 return jsonb_build_object('version',2,'ownerId',binding.owner_id,'generation',e.generation,'revision',e.revision,'capability',binding.capability,
  'operationKey',s.operation_key,'roleName',r.rolname,'roleOid',r.oid::bigint,'managerRoleName',manager.rolname,'managerRoleOid',manager.oid::bigint,
  'identityHelperOwnerQualified',coalesce(identity_safe,false));
end $$;

create function fluid_private.create_account_enrollment_login(p_id uuid,p_token uuid,p_capability text,p_verifier text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare context jsonb:=fluid_private.account_enrollment_role_for_lease(p_id,p_token,p_capability); actual pg_catalog.pg_roles; manager pg_catalog.pg_roles;
 desired_name text:=context->>'roleName';
begin
 select * into manager from pg_roles where rolname=current_user;
 if context->>'mode'<>'enroll' or context->>'credentialRef' is null or context->>'phase' not in('provisioning','credential_reserved','provisioned','published','ready','uncertain')
  or manager.oid is distinct from (context->>'managerRoleOid')::oid or manager.rolcanlogin or manager.rolinherit or manager.rolsuper
  or manager.rolcreatedb or not manager.rolcreaterole or manager.rolreplication or manager.rolbypassrls
  or desired_name is null then raise exception 'account_enrollment_role_manager_unavailable' using errcode='55000'; end if;
 if p_verifier is null or p_verifier!~'^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$' then
  raise exception 'invalid_account_enrollment_verifier' using errcode='22023'; end if;
 select * into actual from pg_roles where rolname=desired_name;
 if actual.oid is not null and (context->>'roleOid' is null or actual.oid<>(context->>'roleOid')::oid) then
  raise exception 'account_enrollment_role_collision' using errcode='55000'; end if;
 if context->>'priorOperationKey'=context->>'operationKey' then
  if context->>'priorCredentialRef' is distinct from context->>'credentialRef' or actual.oid is null or not actual.rolcanlogin
   then raise exception 'account_enrollment_principal_changed' using errcode='55000'; end if;
 else
  if actual.oid is null then execute format('create role %I login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 4 password %L',desired_name,p_verifier);
  else
   if actual.rolcanlogin or actual.rolinherit or actual.rolsuper or actual.rolcreatedb or actual.rolcreaterole or actual.rolreplication or actual.rolbypassrls
    then raise exception 'account_enrollment_principal_not_revoked' using errcode='55000'; end if;
   execute format('alter role %I login connection limit 4 password %L',desired_name,p_verifier);
  end if;
 end if;
 select * into actual from pg_roles where rolname=desired_name;
 execute format('grant connect on database %I to %I',current_database(),desired_name);
 execute format('grant usage on schema public,fluid_private to %I',desired_name);
 execute format('grant execute on function public.account_enrollment_managed_principal() to %I',desired_name);
 return fluid_private.record_account_enrollment_managed_role(p_id,p_token,p_capability,actual.oid);
end $$;

create function fluid_private.disable_account_enrollment_login(p_id uuid,p_token uuid,p_capability text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare context jsonb:=fluid_private.account_enrollment_role_for_lease(p_id,p_token,p_capability); actual pg_catalog.pg_roles;
begin
 if context->>'mode'<>'revoke' or to_regrole(current_user)::oid is distinct from (context->>'managerRoleOid')::oid then
  raise exception 'account_enrollment_revocation_not_requested' using errcode='55000'; end if;
 if p_capability in('strategy','naming','logo') and (context->>'revocationReceipt' is null or context->>'revocationVerifiedAt' is null
  or (context->>'revocationVerifiedAt')::timestamptz<(context->>'claimUpdatedAt')::timestamptz) then
  raise exception 'account_enrollment_worker_drain_required' using errcode='55000'; end if;
 if context->>'roleOid' is not null then
  select * into actual from pg_roles where oid=(context->>'roleOid')::oid and rolname=context->>'roleName';
  if actual.oid is null then raise exception 'account_enrollment_principal_changed' using errcode='55000'; end if;
  execute format('alter role %I nologin password null',actual.rolname);
 end if;
 return jsonb_build_object('ownerId',context->'ownerId','generation',context->'generation','capability',p_capability,'locked',true);
end $$;

create function fluid_private.grant_account_enrollment_http_login(p_id uuid,p_token uuid,p_capability text) returns void
language plpgsql security definer set search_path='' as $$
declare context jsonb:=fluid_private.account_enrollment_role_for_lease(p_id,p_token,p_capability); desired_name text:=context->>'roleName'; signature text;
begin
 if context->>'mode'<>'enroll' or context->>'roleOid' is null or to_regrole(current_user)::oid is distinct from (context->>'managerRoleOid')::oid
  or p_capability not in('home_attachments','identity_transactions') then raise exception 'account_enrollment_grant_unavailable' using errcode='55000'; end if;
 if p_capability='identity_transactions' then execute format('grant temporary on database %I to %I',current_database(),desired_name); end if;
 foreach signature in array (case when p_capability='home_attachments' then array[
  'fluid_private.home_attachment_owner()','fluid_private.prepare_home_attachment(jsonb,bigint)','fluid_private.observe_home_attachment(uuid,jsonb)',
  'fluid_private.lookup_home_attachment(uuid)','fluid_private.resolve_home_attachments(uuid[])'] else array[
  'fluid_private.prepare_identity_transaction(uuid,jsonb,boolean)','fluid_private.commit_identity_transaction(uuid,jsonb,jsonb)'] end) loop
  execute format('grant execute on function %s to %I',signature,desired_name);
  if not has_function_privilege(desired_name,signature,'EXECUTE') then raise exception 'account_enrollment_helper_grant_unavailable' using errcode='55000'; end if;
 end loop;
end $$;

create function public.provision_account_enrollment_http(p_id uuid,p_token uuid,p_capability text,p_credential_ref text,p_verifier text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token);
 s fluid_private.account_service_enrollment_steps; binding jsonb; desired_role_name text; actual_oid oid;
begin
 if e.eligibility<>'active' or e.state='revoking' then raise exception 'account_enrollment_owner_changed' using errcode='42501'; end if;
 select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability=p_capability for update;
 if not found or p_capability not in('home_attachments','identity_transactions') or s.credential_ref is distinct from p_credential_ref
  or s.phase not in('credential_reserved','provisioned','published','ready','uncertain') then raise exception 'account_enrollment_provision_unavailable' using errcode='55000'; end if;
 if not fluid_private.account_enrollment_http_helpers_ready(p_capability) then raise exception 'account_enrollment_helpers_unavailable' using errcode='55000'; end if;
 binding:=fluid_private.create_account_enrollment_login(p_id,p_token,p_capability,p_verifier);
 desired_role_name:=binding->>'roleName'; actual_oid:=(binding->>'roleOid')::oid;
 perform fluid_private.grant_account_enrollment_http_login(p_id,p_token,p_capability);
 if p_capability='home_attachments' then
  if exists(select 1 from fluid_private.home_attachment_principals p where (p.role_name=desired_role_name or p.role_oid=actual_oid) and p.owner_id<>e.owner_id)
   then raise exception 'account_enrollment_owner_collision' using errcode='55000'; end if;
  insert into fluid_private.home_attachment_principals(role_name,role_oid,owner_id) values(desired_role_name,actual_oid,e.owner_id)
   on conflict on constraint home_attachment_principals_pkey do update set role_oid=excluded.role_oid where home_attachment_principals.owner_id=excluded.owner_id;
 else
  if exists(select 1 from fluid_private.identity_web_principals p where (p.login_role_name=desired_role_name or p.login_role_oid=actual_oid or p.owner_id=e.owner_id)
   and (p.login_role_name<>desired_role_name or p.login_role_oid<>actual_oid or p.owner_id<>e.owner_id)) then raise exception 'account_enrollment_owner_collision' using errcode='55000'; end if;
  insert into fluid_private.identity_web_principals(login_role_name,login_role_oid,owner_id) values(desired_role_name,actual_oid,e.owner_id)
   on conflict(login_role_name) do update set login_role_oid=excluded.login_role_oid where identity_web_principals.owner_id=excluded.owner_id;
 end if;
 update fluid_private.account_service_enrollment_steps set phase=case when phase in('published','ready') then phase else 'provisioned' end,
  reason=null,updated_at=clock_timestamp() where enrollment_id=e.id and generation=e.generation and capability=p_capability;
 return binding||jsonb_build_object('managementVersion',2,'revision',e.revision);
end $$;

create function public.revoke_account_enrollment_http(p_id uuid,p_token uuid,p_capability text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if p_capability not in('home_attachments','identity_transactions') then raise exception 'invalid_account_enrollment_capability' using errcode='22023'; end if;
 return fluid_private.disable_account_enrollment_login(p_id,p_token,p_capability);
end $$;

-- SQL authorization/drain proof, not a network Storage observation. The
-- trusted publisher separately withdraws and re-reads its durable pointer.
-- Do not terminate backends: an uncertain commit must retain its receipt.
create function public.verify_account_http_revocation(p_id uuid,p_token uuid,p_capability text,p_withdrawn_receipt text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token);
 s fluid_private.account_service_enrollment_steps; managed fluid_private.account_enrollment_managed_roles; actual pg_catalog.pg_roles; helper pg_catalog.pg_proc;
 policy pg_catalog.pg_policy; observed timestamptz:=clock_timestamp(); receipt text;
begin
 if p_capability not in('home_attachments','identity_transactions') or e.state<>'revoking' or p_withdrawn_receipt is null
  or p_withdrawn_receipt!~'^http-binding:[0-9a-f]{64}$' then raise exception 'account_enrollment_revocation_unconfirmed' using errcode='55000'; end if;
 select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability=p_capability for update;
 select * into managed from fluid_private.account_enrollment_managed_roles where owner_id=e.owner_id and capability=p_capability;
 select * into actual from pg_roles where oid=managed.role_oid and rolname=managed.role_name;
 if not s.effects_started or (managed.role_oid is null and to_regrole(fluid_private.account_enrollment_role_name(e.owner_id,p_capability)) is not null)
  or (managed.role_oid is not null and (actual.oid is null or actual.rolcanlogin or managed.operation_key<>s.operation_key))
  or exists(select 1 from pg_stat_activity where usesysid=actual.oid and backend_type='client backend'
   and (state is distinct from 'idle' or xact_start is not null)) then
  raise exception 'account_enrollment_http_drain_unconfirmed' using errcode='55000'; end if;
 if p_capability='home_attachments' then
  select * into helper from pg_proc where oid=to_regprocedure('fluid_private.account_enrollment_home_storage_allowed(text,text)');
  select * into policy from pg_policy where polrelid=to_regclass('storage.objects') and polname='account_enrollment_home_storage_gate';
  if helper.oid is null or pg_get_userbyid(helper.proowner)<>'postgres' or not helper.prosecdef or helper.provolatile<>'s' or helper.proleakproof
   or helper.proconfig is distinct from array['search_path=""'] or helper.prolang<>(select oid from pg_language where lanname='plpgsql')
   or encode(sha256(convert_to(helper.prosrc,'UTF8')),'hex')<>'0027fbee2ffafa6d250e17bb2f8c49113d3a6547c96342ed9a8d3f413ffa4cd4'
   or exists(select 1 from aclexplode(coalesce(helper.proacl,acldefault('f',helper.proowner))) a
    where a.grantee not in(helper.proowner,to_regrole('authenticated')::oid) or a.privilege_type<>'EXECUTE' or a.grantee<>helper.proowner and a.is_grantable)
   or not has_function_privilege('authenticated',helper.oid,'EXECUTE')
   or policy.oid is null or policy.polpermissive or policy.polcmd<>'*' or policy.polroles is distinct from array[to_regrole('authenticated')::oid]
   or pg_get_expr(policy.polqual,policy.polrelid) is distinct from 'fluid_private.account_enrollment_home_storage_allowed(bucket_id, name)'
   or pg_get_expr(policy.polwithcheck,policy.polrelid) is distinct from 'fluid_private.account_enrollment_home_storage_allowed(bucket_id, name)'
   or not exists(select 1 from pg_class c join pg_roles a on a.rolname='authenticated' where c.oid=policy.polrelid
    and c.relrowsecurity and (c.relowner<>a.oid or c.relforcerowsecurity) and not a.rolsuper and not a.rolbypassrls)
   or fluid_private.account_enrollment_home_storage_allowed('fluid-assets',e.owner_id::text||'/home/proof/proof')
   then raise exception 'account_enrollment_storage_denial_unconfirmed' using errcode='55000'; end if;
 end if;
 receipt:='http-revoked:'||encode(sha256(convert_to(e.owner_id::text||':'||e.generation::text||':'||e.revision::text||':'||s.operation_key::text||':'||p_withdrawn_receipt,'UTF8')),'hex');
 update fluid_private.account_service_enrollment_steps set revocation_receipt=receipt,revocation_verified_at=observed,updated_at=observed
  where enrollment_id=e.id and generation=e.generation and capability=p_capability;
 return jsonb_build_object('ownerId',e.owner_id,'generation',e.generation,'revision',e.revision,'operationKey',s.operation_key,'capability',p_capability,
  'receipt',receipt,'observedAt',to_char(observed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'authorityDisabled',true,'runtimeStopped',true,'storageDenied',true);
end $$;

create function public.acknowledge_account_enrollment_revocation(p_id uuid,p_token uuid,p_capability text,p_receipt text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token); s fluid_private.account_service_enrollment_steps;
begin
 if e.state<>'revoking' and e.eligibility='active' then raise exception 'account_enrollment_revocation_not_requested' using errcode='55000'; end if;
 select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability=p_capability for update;
 if not found or p_receipt is null or p_receipt!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' then raise exception 'invalid_account_enrollment_revocation' using errcode='22023'; end if;
 if s.effects_started then
  if s.revocation_receipt is distinct from p_receipt or s.revocation_verified_at is null or s.revocation_verified_at<e.updated_at then
   raise exception 'account_enrollment_revocation_proof_required' using errcode='55000'; end if;
 elsif exists(select 1 from fluid_private.account_enrollment_managed_roles p left join pg_roles r on r.oid=p.role_oid and r.rolname=p.role_name
  where p.owner_id=e.owner_id and p.capability=p_capability and (r.oid is null or r.rolcanlogin)) then
  raise exception 'account_enrollment_revocation_unconfirmed' using errcode='55000';
 else
  update fluid_private.account_service_enrollment_steps set revocation_receipt=p_receipt,revocation_verified_at=clock_timestamp(),updated_at=clock_timestamp()
   where enrollment_id=e.id and generation=e.generation and capability=p_capability;
 end if;
 return jsonb_build_object('ownerId',e.owner_id,'generation',e.generation,'capability',p_capability,'acknowledged',true);
end $$;

create function public.finish_account_service_enrollment(p_id uuid,p_token uuid,p_revoked_capabilities text[] default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token); all_done boolean;
begin
 if cardinality(p_revoked_capabilities)>5 or array_position(p_revoked_capabilities,null) is not null
  or exists(select 1 from unnest(p_revoked_capabilities) capability where capability not in('home_attachments','identity_transactions','strategy','naming','logo')) then
  raise exception 'invalid_account_enrollment_capability' using errcode='22023'; end if;
 if e.state='revoking' or e.eligibility<>'active' then
  if exists(select 1 from fluid_private.account_service_enrollment_steps s where s.enrollment_id=e.id and s.generation=e.generation
   and s.capability=any(p_revoked_capabilities) and s.effects_started
   and (s.revocation_receipt is null or s.revocation_verified_at is null or s.revocation_verified_at<e.updated_at)) then
   raise exception 'account_enrollment_revocation_proof_required' using errcode='55000'; end if;
  if exists(select 1 from fluid_private.account_enrollment_managed_roles p
   left join pg_catalog.pg_roles r on r.oid=p.role_oid and r.rolname=p.role_name
   where p.owner_id=e.owner_id and p.capability=any(p_revoked_capabilities) and (r.oid is null or r.rolcanlogin)) then
   raise exception 'account_enrollment_revocation_unconfirmed' using errcode='55000'; end if;
  update fluid_private.account_service_enrollment_steps set phase='revoked',reason=null,updated_at=clock_timestamp()
   where enrollment_id=e.id and generation=e.generation and capability=any(p_revoked_capabilities);
  select count(*)=5 and bool_and(phase='revoked') into all_done from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation;
  if all_done and e.eligibility='active' then
   update fluid_private.account_service_enrollments set generation=generation+1,revision=revision+1,state='pending' where id=e.id returning * into e;
   perform fluid_private.account_enrollment_new_steps(e.id,e.generation);
  else update fluid_private.account_service_enrollments set state=case when all_done then 'revoked' else 'revoking' end where id=e.id returning * into e; end if;
 else
  if cardinality(p_revoked_capabilities)<>0 then raise exception 'account_enrollment_revocation_not_requested' using errcode='55000'; end if;
  select count(*)=5 and bool_and(phase='ready') into all_done from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation;
  update fluid_private.account_service_enrollments set state=case when all_done then 'ready' else 'pending' end where id=e.id returning * into e;
 end if;
 update fluid_private.account_service_enrollments set lease_token=null,lease_until=null,lease_role_name=null,lease_role_oid=null,
  available_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() where id=e.id;
 return fluid_private.account_enrollment_public(e.id);
end $$;

do $$declare target record; acl_row record;begin
 for target in select n.nspname,p.proname,p.oid,p.proowner,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='fluid_private' and p.proname in('account_enrollment_eligibility','account_enrollment_new_steps','refresh_account_enrollment',
    'account_enrollment_auth_outbox','account_enrollment_public','account_enrollment_operator','account_enrollment_claim_json','lock_account_enrollment','account_enrollment_http_helpers_ready','account_service_actor_immutable',
    'account_enrollment_home_storage_allowed','account_enrollment_role_name','account_enrollment_role_for_lease','record_account_enrollment_managed_role','create_account_enrollment_login',
    'disable_account_enrollment_login','grant_account_enrollment_http_login'))
   or (n.nspname='public' and p.proname in('ensure_account_service_enrollment','get_account_service_enrollment','get_account_service_enrollment_binding','claim_account_service_enrollment',
    'account_enrollment_managed_principal','read_account_service_enrollment_claim','record_account_service_enrollment','provision_account_enrollment_http','revoke_account_enrollment_http',
    'verify_account_http_revocation','acknowledge_account_enrollment_revocation','finish_account_service_enrollment')) loop
  execute format('revoke all on function %I.%I(%s) from public,anon,authenticated,service_role',target.nspname,target.proname,target.args);
  for acl_row in select distinct a.grantee from pg_proc function_row cross join lateral aclexplode(coalesce(function_row.proacl,acldefault('f',function_row.proowner))) a
   where function_row.oid=target.oid and a.grantee<>target.proowner loop
   execute format('revoke all on function %I.%I(%s) from %s cascade',target.nspname,target.proname,target.args,
    case when acl_row.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(acl_row.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.ensure_account_service_enrollment(),public.get_account_service_enrollment(),public.get_account_service_enrollment_binding() to authenticated;
grant execute on function fluid_private.account_enrollment_home_storage_allowed(text,text) to authenticated;

-- Exact grant-option capabilities only. The manager has no SELECT/INSERT/etc
-- on application, Auth, Storage or enrollment relations and cannot log in.
grant usage on schema public,fluid_private to embel_account_role_manager with grant option;
do $$begin execute format('grant connect,temporary on database %I to embel_account_role_manager with grant option',current_database()); end $$;
grant execute on function fluid_private.account_enrollment_role_for_lease(uuid,uuid,text),
 fluid_private.record_account_enrollment_managed_role(uuid,uuid,text,oid) to embel_account_role_manager;
grant execute on function public.account_enrollment_managed_principal() to embel_account_role_manager with grant option;
grant execute on function fluid_private.home_attachment_owner(),fluid_private.prepare_home_attachment(jsonb,bigint),
 fluid_private.observe_home_attachment(uuid,jsonb),fluid_private.lookup_home_attachment(uuid),fluid_private.resolve_home_attachments(uuid[])
 to embel_account_role_manager with grant option;

-- The temporary installer SET edge is separate from PG17's original creator
-- ADMIN edge (whose grantor can be the platform bootstrap role). Remove only
-- our own installer edge, preserving the supported noSET/noINHERIT admin path.
do $$begin
 if fluid_private.account_enrollment_http_helpers_ready('identity_transactions') then
  execute 'grant fluid_identity_writer_definer_v1 to postgres with inherit false,set true';
  execute 'set role fluid_identity_writer_definer_v1';
  execute 'grant execute on function fluid_private.prepare_identity_transaction(uuid,jsonb,boolean),fluid_private.commit_identity_transaction(uuid,jsonb,jsonb) to embel_account_role_manager with grant option';
  execute 'reset role';
  execute 'revoke fluid_identity_writer_definer_v1 from postgres granted by postgres';
 end if;
end $$;
grant create on schema fluid_private to embel_account_role_manager;
grant embel_account_role_manager to postgres with inherit false,set true;
alter function fluid_private.create_account_enrollment_login(uuid,uuid,text,text) owner to embel_account_role_manager;
alter function fluid_private.disable_account_enrollment_login(uuid,uuid,text) owner to embel_account_role_manager;
alter function fluid_private.grant_account_enrollment_http_login(uuid,uuid,text) owner to embel_account_role_manager;
set role embel_account_role_manager;
grant execute on function fluid_private.create_account_enrollment_login(uuid,uuid,text,text),
 fluid_private.disable_account_enrollment_login(uuid,uuid,text),fluid_private.grant_account_enrollment_http_login(uuid,uuid,text) to postgres;
reset role;
revoke create on schema fluid_private from embel_account_role_manager;
revoke embel_account_role_manager from postgres granted by postgres;
do $$begin
 -- Superuser-only disposable fixtures do not receive PG17's automatic creator
 -- edge. Production NOSUPER postgres retains its existing original edge.
 if not exists(select 1 from pg_auth_members where roleid=to_regrole('embel_account_role_manager')::oid) then
  execute 'grant embel_account_role_manager to postgres with admin true,inherit false,set false';
 end if;
 if (select count(*) from pg_auth_members where roleid=to_regrole('embel_account_role_manager')::oid)<>1
  or not exists(select 1 from pg_auth_members where roleid=to_regrole('embel_account_role_manager')::oid and member=to_regrole('postgres')::oid
   and admin_option and not inherit_option and not set_option) then raise exception 'account_enrollment_manager_admin_edge_unavailable'; end if;
end $$;
commit;
