-- UNAPPLIED worker control-plane packet. Requires account_service_enrollment.sql
-- and the separately reviewed Logo Storage candidates. Installs no runtime
-- login, credential, provider binding, approved profile, Storage actor or grant
-- to a live operator/reporter. Empty approval registries are deliberately closed.
begin;

create table fluid_private.account_worker_provider_approvals (
 binding_ref text primary key check(binding_ref~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
 provider text not null check(provider='openai'), destination text not null check(destination='api.openai.com'),
 model text not null, verification_receipt text not null check(verification_receipt~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
 approved_at timestamptz not null, expires_at timestamptz not null check(expires_at>approved_at)
);
create table fluid_private.account_worker_profile_approvals (
 profile_id text primary key, capability text not null check(capability in('strategy','naming','logo')),
 profile jsonb not null check(jsonb_typeof(profile)='object' and octet_length(profile::text)<=16384),
 policies jsonb not null check(jsonb_typeof(policies)='object' and octet_length(policies::text)<=32768),
 provider_binding_ref text not null references fluid_private.account_worker_provider_approvals(binding_ref),
 reporter_role_name name not null, reporter_role_oid oid not null,
 approved_at timestamptz not null, expires_at timestamptz not null check(expires_at>approved_at)
);
-- Revocations are separate from immutable approvals; reapproval uses a new ID.
create table fluid_private.account_worker_approval_revocations (
 kind text not null check(kind in('profile','provider','storage')), reference text not null,
 revoked_at timestamptz not null default clock_timestamp(), primary key(kind,reference)
);
create table fluid_private.account_worker_storage_approvals (
 identity_ref text not null, owner_id uuid not null references auth.users(id),
 auth_user_id uuid not null unique references auth.users(id), approved_at timestamptz not null,
 generation integer not null, operation_key uuid not null, registration_receipt text not null,
 expires_at timestamptz not null check(expires_at>approved_at), primary key(identity_ref,owner_id,generation),
 check(owner_id<>auth_user_id)
);
create table fluid_private.account_worker_actor_reservations (
 enrollment_id uuid not null references fluid_private.account_service_enrollments(id), owner_id uuid not null,
 generation integer not null, operation_key uuid not null, auth_user_id uuid not null unique,
 profile_id text not null references fluid_private.account_worker_profile_approvals(profile_id), identity_ref text not null,
 reservation_ref text not null unique check(reservation_ref~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
 cleanup_only boolean not null default false, created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,generation,operation_key)
);
create table fluid_private.account_worker_actor_retirements (
 auth_user_id uuid primary key references fluid_private.account_worker_actor_reservations(auth_user_id),
 retired_at timestamptz not null default clock_timestamp()
);
create table fluid_private.account_worker_bindings (
 owner_id uuid not null, capability text not null check(capability in('strategy','naming','logo')),
 enrollment_id uuid not null references fluid_private.account_service_enrollments(id),
 generation integer not null, revision bigint not null, operation_key uuid not null unique,
 role_name name not null unique, role_oid oid not null unique, credential_ref text not null,
 profile_id text not null references fluid_private.account_worker_profile_approvals(profile_id),
 profile_fingerprint text not null check(profile_fingerprint~'^[a-f0-9]{64}$'),
 worker_id text not null, deployment_id text not null,
 storage_auth_user_id uuid references auth.users(id), enabled boolean not null default false,
 disabled_at timestamptz, suspended_at timestamptz, primary key(owner_id,capability),
 foreign key(owner_id,capability) references fluid_private.account_enrollment_managed_roles(owner_id,capability)
);
create table fluid_private.account_worker_heartbeats (
 owner_id uuid not null, capability text not null, generation integer not null, revision bigint not null,
 operation_key uuid not null, role_oid oid not null, storage_session_id uuid,
 observed_at timestamptz not null, expires_at timestamptz not null,
 primary key(owner_id,capability), foreign key(owner_id,capability) references fluid_private.account_worker_bindings(owner_id,capability)
);
create table fluid_private.account_worker_process_reports (
 receipt text primary key check(receipt~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
 owner_id uuid not null, capability text not null, generation integer not null, revision bigint not null,
 operation_key uuid not null, binding jsonb not null, state text not null check(state in('running','stopped')),
 reporter_role_name name not null, reporter_role_oid oid not null, observed_at timestamptz not null,
 recorded_at timestamptz not null default clock_timestamp(),
 foreign key(owner_id,capability) references fluid_private.account_worker_bindings(owner_id,capability)
);

create function fluid_private.account_worker_immutable() returns trigger
language plpgsql set search_path='' as $$begin raise exception 'immutable_worker_enrollment_approval' using errcode='55000'; end $$;
do $$declare t text; grantee name;begin
 foreach t in array array['account_worker_provider_approvals','account_worker_profile_approvals','account_worker_storage_approvals','account_worker_actor_reservations','account_worker_actor_retirements','account_worker_process_reports','account_worker_approval_revocations'] loop
  execute format('create trigger immutable_worker_approval before update or delete on fluid_private.%I for each row execute function fluid_private.account_worker_immutable()',t);
 end loop;
 foreach t in array array['account_worker_provider_approvals','account_worker_profile_approvals','account_worker_storage_approvals','account_worker_actor_reservations','account_worker_actor_retirements','account_worker_approval_revocations','account_worker_bindings','account_worker_heartbeats','account_worker_process_reports'] loop
  execute format('alter table fluid_private.%I enable row level security',t);
  execute format('alter table fluid_private.%I force row level security',t);
  execute format('revoke all on fluid_private.%I from public,anon,authenticated,service_role',t);
  for grantee in select r.rolname from pg_class c,lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   join pg_roles r on r.oid=a.grantee where c.oid=to_regclass('fluid_private.'||t) and a.grantee<>c.relowner loop
   execute format('revoke all on table fluid_private.%I from %I cascade',t,grantee);
  end loop;
 end loop;
end $$;
create function fluid_private.account_worker_auth_actor_fence() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.id::text||':account-worker-storage-actor',0));
 if exists(select 1 from fluid_private.account_worker_actor_retirements where auth_user_id=new.id)
  then raise exception 'account_worker_service_actor_retired' using errcode='55000'; end if;
 return new;
end $$;
create trigger embel_account_worker_retired_actor before insert on auth.users
 for each row execute function fluid_private.account_worker_auth_actor_fence();
create index account_worker_process_latest on fluid_private.account_worker_process_reports(owner_id,capability,generation,revision,observed_at desc);

-- Match JSON.stringify of the trusted ASCII-keyed profile, without depending on
-- jsonb's whitespace or object-key ordering. No secret enters the fingerprint.
create function fluid_private.account_worker_canonical(p jsonb) returns text
language sql immutable set search_path='' as $$
 select case jsonb_typeof(p)
 when 'object' then '{'||coalesce((select string_agg(to_jsonb(key)::text||':'||fluid_private.account_worker_canonical(value),',' order by key collate "C") from jsonb_each(p)),'')||'}'
 when 'array' then '['||coalesce((select string_agg(fluid_private.account_worker_canonical(value),',' order by ordinality) from jsonb_array_elements(p) with ordinality),'')||']'
 else p::text end;
$$;
create function fluid_private.account_worker_profile(p_capability text,p_profile jsonb) returns fluid_private.account_worker_profile_approvals
language plpgsql stable security definer set search_path='' as $$
declare a fluid_private.account_worker_profile_approvals; provider fluid_private.account_worker_provider_approvals;
begin
 select * into a from fluid_private.account_worker_profile_approvals where profile_id=p_profile->>'profileId' and capability=p_capability and profile=p_profile;
 select * into provider from fluid_private.account_worker_provider_approvals where binding_ref=a.provider_binding_ref;
 if a.profile_id is null or a.approved_at>clock_timestamp() or a.expires_at<=clock_timestamp()
  or provider.binding_ref is null or provider.approved_at>clock_timestamp() or provider.expires_at<=clock_timestamp()
  or exists(select 1 from fluid_private.account_worker_approval_revocations where (kind='profile' and reference=a.profile_id) or (kind='provider' and reference=a.provider_binding_ref))
  or p_capability='logo' and exists(select 1 from fluid_private.account_worker_approval_revocations where kind='storage' and reference=p_profile->>'storageIdentityRef')
  or p_profile->>'capability' is distinct from p_capability or p_profile->'dispatchApproved' is distinct from 'true'::jsonb
  or p_profile->>'providerBindingRef' is distinct from provider.binding_ref or p_profile->>'model' is distinct from provider.model
  or p_profile->>'modelVerificationReceipt' is distinct from provider.verification_receipt
  or p_profile->>'supabaseOrigin' is distinct from 'https://fricsfwqibyhemknqgyf.supabase.co'
  or p_profile->>'applicationOrigin' is distinct from 'https://www.embel.xyz'
  or p_profile->>'deploymentId'!~'^dpl_[A-Za-z0-9_-]{1,196}$' or p_profile->>'sourceRevision'!~'^[a-f0-9]{40}$'
  or p_profile->>'artifactSha256'!~'^[a-f0-9]{64}$' or p_profile->>'managedProofSha256'!~'^[a-f0-9]{64}$'
  or p_profile->>'managedProofSha256' is distinct from (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid=to_regprocedure('public.account_enrollment_managed_principal()'))
  or (p_capability='strategy' and (p_profile->>'admissionContract' is distinct from 'hosted_strategy_owner_uncapped_v1' or p_profile->>'spendControl' is distinct from 'uncapped' or provider.model<>'gpt-6.1-sol'))
  or (p_capability='naming' and (p_profile->>'admissionContract' is distinct from 'hosted_owner_v1' or p_profile->'providerBudgetVersion' is distinct from '2'::jsonb
   or p_profile->>'spendControl' is distinct from 'uncapped' or provider.model<>'gpt-6-luna'))
  or (p_capability='logo' and (p_profile->>'admissionContract' is distinct from 'account_logo_operation' or p_profile->>'spendControl' is distinct from 'uncapped'
   or provider.model<>'gpt-image-2.5-sunburst-2026-09-08'
   or p_profile#>>'{policyIdentities,identity.logo_concept}' is distinct from p_profile#>>'{policyIdentities,identity.logo_refine}'))
 then raise exception 'account_worker_profile_unavailable' using errcode='55000'; end if;
 return a;
end $$;

create function fluid_private.account_worker_binding_json(b fluid_private.account_worker_bindings) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('ownerId',b.owner_id,'generation',b.generation,'revision',b.revision,'operationKey',b.operation_key,'capability',b.capability,
  'roleName',b.role_name,'roleOid',b.role_oid::bigint,'credentialRef',b.credential_ref,'workerId',b.worker_id,'deploymentId',b.deployment_id,
  'profileFingerprint',b.profile_fingerprint,'storageAuthUserId',b.storage_auth_user_id);
$$;

-- Register the service actor while it is still unconfirmed, then confirm it
-- through the approved Auth service. The marker precedes active eligibility;
-- customer signup cannot race a service account into recursive provisioning.
-- This private DB-owner-only operation has no runtime operator EXECUTE grant.
create function fluid_private.account_worker_register_storage_actor(p_actor uuid,p_owner uuid,p_identity_ref text,p_receipt text,p_expires timestamptz) returns void
language plpgsql security definer set search_path='' as $$
declare account jsonb; current_generation integer; storage_operation uuid;
begin
 perform 1 from auth.users where id=p_actor for update;
 select to_jsonb(u) into account from auth.users u where id=p_actor;
 if p_actor is null or p_owner is null or p_actor=p_owner or account is null or account->>'email_confirmed_at' is not null
  or coalesce(account->>'is_anonymous','false')='true' or fluid_private.account_enrollment_eligibility(p_owner)<>'active'
  or p_identity_ref is null or p_identity_ref!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  or p_receipt is null or p_receipt!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' or p_expires is null or p_expires<=clock_timestamp()
  or exists(select 1 from public.projects where owner_id=p_actor)
  or exists(select 1 from fluid_private.account_service_enrollments e join fluid_private.account_service_enrollment_steps s on s.enrollment_id=e.id where e.owner_id=p_actor and s.effects_started)
 then raise exception 'account_worker_service_actor_unavailable' using errcode='55000'; end if;
 select e.generation,s.operation_key into current_generation,storage_operation from fluid_private.account_service_enrollments e
  join fluid_private.account_service_enrollment_steps s on s.enrollment_id=e.id and s.generation=e.generation and s.capability='logo' where e.owner_id=p_owner;
 if current_generation is null then raise exception 'account_worker_service_actor_unavailable' using errcode='55000'; end if;
 insert into fluid_private.account_service_actors(auth_user_id,purpose,registration_receipt) values(p_actor,'logo_storage',p_receipt);
 insert into fluid_private.account_worker_storage_approvals(identity_ref,owner_id,auth_user_id,generation,operation_key,registration_receipt,approved_at,expires_at)
  values(p_identity_ref,p_owner,p_actor,current_generation,storage_operation,p_receipt,clock_timestamp(),p_expires);
end $$;

create function public.reserve_account_worker_storage_actor(p_id uuid,p_token uuid,p_actor uuid,p_profile jsonb,p_reservation_ref text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token);
 a fluid_private.account_worker_profile_approvals:=fluid_private.account_worker_profile('logo',p_profile); s fluid_private.account_service_enrollment_steps;
 prior fluid_private.account_worker_actor_reservations; account jsonb; expected_metadata jsonb;
begin
 select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability='logo' for update;
 if e.eligibility<>'active' or e.state in('revoking','revoked') or not s.effects_started or p_actor is null or p_actor=e.owner_id
  or p_reservation_ref is null or p_reservation_ref!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' then raise exception 'account_worker_service_actor_unavailable' using errcode='55000'; end if;
 select * into prior from fluid_private.account_worker_actor_reservations where owner_id=e.owner_id and generation=e.generation and operation_key=s.operation_key;
 if found then
  if prior.auth_user_id<>p_actor or prior.profile_id<>a.profile_id or prior.reservation_ref<>p_reservation_ref or prior.cleanup_only then raise exception 'account_worker_service_actor_conflict' using errcode='55000'; end if;
 else
  select to_jsonb(u) into account from auth.users u where id=p_actor;
  expected_metadata:=jsonb_build_object('version',1,'enrollmentId',e.id,'ownerId',e.owner_id,'generation',e.generation,'operationKey',s.operation_key,'storageIdentityRef',p_profile->>'storageIdentityRef','reservationRef',p_reservation_ref);
  if account is not null and account#>'{raw_app_meta_data,embel_worker_storage}' is distinct from expected_metadata then raise exception 'account_worker_service_actor_metadata_unavailable' using errcode='55000'; end if;
  insert into fluid_private.account_worker_actor_reservations(enrollment_id,owner_id,generation,operation_key,auth_user_id,profile_id,identity_ref,reservation_ref)
   values(e.id,e.owner_id,e.generation,s.operation_key,p_actor,a.profile_id,p_profile->>'storageIdentityRef',p_reservation_ref);
 end if;
 return jsonb_build_object('ownerId',e.owner_id,'generation',e.generation,'revision',e.revision,'operationKey',s.operation_key,'authUserId',p_actor,'storageIdentityRef',p_profile->>'storageIdentityRef','receipt',p_reservation_ref);
end $$;

create function public.register_account_worker_storage_actor(p_id uuid,p_token uuid,p_actor uuid,p_profile jsonb,p_reservation_ref text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token);
 a fluid_private.account_worker_profile_approvals:=fluid_private.account_worker_profile('logo',p_profile); s fluid_private.account_service_enrollment_steps;
 prior fluid_private.account_worker_storage_approvals; account jsonb; expected_metadata jsonb; expiry timestamptz;
begin
 select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability='logo' for update;
 if e.eligibility<>'active' or e.state in('revoking','revoked') or not s.effects_started
  or p_reservation_ref is null or p_reservation_ref!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' or p_actor is null or p_actor=e.owner_id
  then raise exception 'account_worker_service_actor_unavailable' using errcode='55000'; end if;
 if not exists(select 1 from fluid_private.account_worker_actor_reservations where enrollment_id=e.id and owner_id=e.owner_id and generation=e.generation and operation_key=s.operation_key
  and auth_user_id=p_actor and profile_id=a.profile_id and identity_ref=p_profile->>'storageIdentityRef' and reservation_ref=p_reservation_ref and not cleanup_only)
  then raise exception 'account_worker_service_actor_reservation_unavailable' using errcode='55000'; end if;
 select * into prior from fluid_private.account_worker_storage_approvals where identity_ref=p_profile->>'storageIdentityRef' and owner_id=e.owner_id and generation=e.generation;
 if found then
  if prior.auth_user_id<>p_actor or prior.operation_key<>s.operation_key or prior.registration_receipt<>p_reservation_ref
   or not exists(select 1 from fluid_private.account_service_actors where auth_user_id=p_actor and purpose='logo_storage' and registration_receipt=p_reservation_ref)
   then raise exception 'account_worker_service_actor_conflict' using errcode='55000'; end if;
 else
  perform 1 from auth.users where id=p_actor for update;
  select to_jsonb(u) into account from auth.users u where id=p_actor;
  expected_metadata:=jsonb_build_object('version',1,'enrollmentId',e.id,'ownerId',e.owner_id,'generation',e.generation,
   'operationKey',s.operation_key,'storageIdentityRef',p_profile->>'storageIdentityRef','reservationRef',p_reservation_ref);
  if account#>'{raw_app_meta_data,embel_worker_storage}' is distinct from expected_metadata
   then raise exception 'account_worker_service_actor_metadata_unavailable' using errcode='55000'; end if;
  expiry:=least(a.expires_at,clock_timestamp()+interval '1 hour');
  perform fluid_private.account_worker_register_storage_actor(p_actor,e.owner_id,p_profile->>'storageIdentityRef',p_reservation_ref,expiry);
 end if;
 return jsonb_build_object('ownerId',e.owner_id,'generation',e.generation,'revision',e.revision,'operationKey',s.operation_key,
  'authUserId',p_actor,'storageIdentityRef',p_profile->>'storageIdentityRef','receipt',p_reservation_ref);
end $$;

create function fluid_private.account_worker_storage_actor_active(p_actor uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users u join fluid_private.account_service_actors a on a.auth_user_id=u.id and a.purpose='logo_storage'
 where u.id=p_actor and coalesce(to_jsonb(u)->>'is_anonymous','false')='false' and to_jsonb(u)->>'email_confirmed_at' is not null
  and to_jsonb(u)->>'deleted_at' is null and coalesce((to_jsonb(u)->>'banned_until')::timestamptz,'-infinity'::timestamptz)<=clock_timestamp());
$$;

-- Called within trusted definer guards, never a web-supplied owner selector.
create function fluid_private.account_worker_observation_role(p_name name,p_oid oid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from fluid_private.account_worker_bindings b
 join fluid_private.account_enrollment_managed_roles m on m.owner_id=b.owner_id and m.capability=b.capability and m.role_name=b.role_name and m.role_oid=b.role_oid
 join fluid_private.account_service_enrollments e on e.id=b.enrollment_id and e.owner_id=b.owner_id and e.generation=b.generation and e.revision>=b.revision
 join fluid_private.account_service_enrollment_steps s on s.enrollment_id=e.id and s.generation=e.generation and s.capability=b.capability and s.operation_key=b.operation_key
 join fluid_private.account_enrollment_role_manager c on c.singleton
 join pg_catalog.pg_roles r on r.rolname=b.role_name and r.oid=b.role_oid
 join pg_catalog.pg_roles manager on manager.oid=c.manager_role_oid and manager.rolname=c.manager_role_name
 join pg_catalog.pg_roles root_role on root_role.oid=c.root_role_oid and root_role.rolname=c.root_role_name
 join fluid_private.account_worker_profile_approvals a on a.profile_id=b.profile_id and a.capability=b.capability
 join fluid_private.account_worker_provider_approvals provider on provider.binding_ref=a.provider_binding_ref
 where b.role_name=p_name and b.role_oid=p_oid and e.state<>'revoked'
 and m.generation=b.generation and m.operation_key=b.operation_key and m.credential_ref=b.credential_ref
 and m.manager_role_oid=manager.oid and m.manager_role_name=manager.rolname and s.phase in('provisioned','published','ready','revoking')
 and r.rolcanlogin and not(r.rolinherit or r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls)
 and not manager.rolcanlogin and not(manager.rolinherit or manager.rolsuper or manager.rolcreatedb or manager.rolreplication or manager.rolbypassrls) and manager.rolcreaterole
 and not exists(select 1 from pg_auth_members where member=r.oid)
 and (select count(*) from pg_auth_members where roleid=r.oid)=1
 and exists(select 1 from pg_auth_members where roleid=r.oid and member=manager.oid and admin_option and not inherit_option and not set_option)
 and root_role.rolcanlogin and (root_role.rolsuper or root_role.rolcreaterole)
 and (select count(*) from pg_auth_members where roleid=manager.oid)=1
 and exists(select 1 from pg_auth_members where roleid=manager.oid and member=root_role.oid and admin_option and not inherit_option and not set_option)
 and not exists(select 1 from pg_auth_members edge where member=manager.oid and (not edge.admin_option or edge.inherit_option or edge.set_option
  or not exists(select 1 from fluid_private.account_enrollment_managed_roles managed where managed.role_oid=edge.roleid and managed.manager_role_oid=manager.oid)))
 and not exists(select 1 from pg_class where relowner=r.oid) and not exists(select 1 from pg_namespace where nspowner=r.oid)
 and not exists(select 1 from pg_class t join pg_namespace n on n.oid=t.relnamespace where n.nspname in('public','fluid_private','auth','storage')
  and t.relkind in('r','p','v','m','f') and (has_any_column_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES') or has_table_privilege(r.oid,t.oid,'DELETE,TRUNCATE,TRIGGER')))
 and not has_schema_privilege(r.oid,'public','CREATE') and not has_schema_privilege(r.oid,'fluid_private','CREATE'));
$$;

create function fluid_private.account_worker_managed_role(p_name name,p_oid oid) returns boolean
language sql stable security definer set search_path='' as $$
 select fluid_private.account_worker_observation_role(p_name,p_oid) and exists(
  select 1 from fluid_private.account_worker_bindings b join fluid_private.account_service_enrollments e on e.id=b.enrollment_id and e.generation=b.generation and e.revision=b.revision
  join fluid_private.account_worker_profile_approvals a on a.profile_id=b.profile_id
  join fluid_private.account_worker_provider_approvals provider on provider.binding_ref=a.provider_binding_ref
  where b.role_name=p_name and b.role_oid=p_oid and b.enabled and e.eligibility='active' and e.state not in('revoking','revoked')
  and fluid_private.account_enrollment_eligibility(b.owner_id)='active'
  and a.approved_at<=clock_timestamp() and a.expires_at>clock_timestamp() and provider.approved_at<=clock_timestamp() and provider.expires_at>clock_timestamp()
  and not exists(select 1 from fluid_private.account_worker_approval_revocations where (kind='profile' and reference=a.profile_id) or (kind='provider' and reference=provider.binding_ref)
   or (b.capability='logo' and kind='storage' and reference=a.profile->>'storageIdentityRef')));
$$;
create function public.account_worker_observation_principal() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b fluid_private.account_worker_bindings;
begin
 select * into b from fluid_private.account_worker_bindings where role_name=session_user and role_oid=to_regrole(session_user)::oid;
 if b.owner_id is null or not fluid_private.account_worker_observation_role(b.role_name,b.role_oid)
  then raise exception 'account_worker_observation_unavailable' using errcode='42501'; end if;
 return fluid_private.account_worker_binding_json(b);
end $$;

-- The exact predecessor bodies are retained behind unchanged legacy branches.
-- Manager-created roles are never allowed to fall through after a binding/OID
-- is removed or changed: the manager ADMIN edge itself selects the v2 guard.
do $guards$
declare signature text; legacy text; expected text; definition text; body text; managed text;
begin
 for signature,legacy,expected in values
 ('fluid_private.api_text_restricted_role(name,oid)','account_worker_legacy_restricted_role','8ec031bab266ccbd5db8285fbde8b6bb6b1588c65604045fb1db031905dbfb45'),
 ('fluid_private.logo_worker_owner()','account_worker_legacy_logo_owner','2a874eb197e9e799a85a68b45d5bc7903c19370dee9da90dba25bc168c4021ff'),
 ('public.api_text_worker_owner()','account_worker_legacy_api_owner','93b39417918c0dedbe60331922e3b2184ff55fe91fb3f16ce692ea92334a8f73') loop
  select prosrc into body from pg_proc where oid=to_regprocedure(signature) and proconfig=array['search_path=""'] and not proleakproof
   and proowner=to_regrole('postgres')::oid and provolatile='s' and prosecdef=(signature<>'fluid_private.api_text_restricted_role(name,oid)') and prolang=(select oid from pg_language where lanname='sql');
  if body is null or encode(sha256(convert_to(body,'UTF8')),'hex')<>expected then raise exception 'unexpected_account_worker_guard_predecessor' using errcode='55000'; end if;
  definition:=pg_get_functiondef(to_regprocedure(signature));
  execute regexp_replace(definition,'^CREATE OR REPLACE FUNCTION [a-z_]+\.[a-z_]+','CREATE FUNCTION fluid_private.'||legacy);
 end loop;
end $guards$;
create or replace function fluid_private.api_text_restricted_role(p_name name,p_oid oid) returns boolean
language sql stable set search_path='' as $$
 select case when exists(select 1 from fluid_private.account_enrollment_managed_roles where role_name=p_name or role_oid=p_oid)
  or exists(select 1 from pg_auth_members where roleid=p_oid and member=to_regrole('embel_account_role_manager')::oid)
 then fluid_private.account_worker_observation_role(p_name,p_oid)
 else fluid_private.account_worker_legacy_restricted_role(p_name,p_oid) end;
$$;
create or replace function fluid_private.logo_worker_owner() returns uuid
language sql stable security definer set search_path='' as $$
 select case when exists(select 1 from fluid_private.account_enrollment_managed_roles where role_name=session_user)
  or exists(select 1 from pg_auth_members where roleid=to_regrole(session_user)::oid and member=to_regrole('embel_account_role_manager')::oid)
 then (select b.owner_id from fluid_private.account_worker_bindings b where b.capability='logo' and b.role_name=session_user
  and fluid_private.account_worker_observation_role(b.role_name,b.role_oid))
 else fluid_private.account_worker_legacy_logo_owner() end;
$$;

create or replace function public.api_text_worker_owner() returns uuid
language sql stable security definer set search_path='' as $$
 select case when exists(select 1 from fluid_private.account_enrollment_managed_roles where role_name=session_user)
  or exists(select 1 from pg_auth_members where roleid=to_regrole(session_user)::oid and member=to_regrole('embel_account_role_manager')::oid)
 then (select b.owner_id from fluid_private.account_worker_bindings b where b.capability='strategy' and b.role_name=session_user
  and fluid_private.account_worker_observation_role(b.role_name,b.role_oid))
 else fluid_private.account_worker_legacy_api_owner() end;
$$;

-- No arbitrary names or grant lists. Manager has only these reviewed EXECUTE
-- grant options, and delegates them only after the current owner lease check.
create function fluid_private.account_worker_grants(p_capability text) returns text[]
language sql immutable set search_path='' as $$
 select case p_capability when 'strategy' then array[
 'public.check_api_text_runtime(text,jsonb,text)','public.get_api_text_dispatch(uuid)','public.list_pending_api_text_dispatches(integer)',
 'public.mark_api_text_published(uuid,text,integer,text)','public.claim_api_text_job(uuid,text,integer,text,text)',
 'public.expire_api_text_job(uuid)','public.authorize_api_text_dispatch(uuid,uuid,text,text,text)',
 'public.heartbeat_job(uuid,uuid,integer)','public.register_job_plan(uuid,uuid,jsonb)',
 'public.begin_job_step(uuid,uuid,text,text,bigint)','public.complete_job_step(uuid,uuid,text,text,bigint,jsonb,text)',
 'public.finish_job(uuid,uuid,text,text)','public.read_account_worker_strategy_step(uuid,uuid,uuid,text)',
 'public.account_worker_strategy_has_results(uuid,uuid,uuid)']
 when 'naming' then array[
 'public.report_naming_brain_worker_status(jsonb,text,text,bigint,integer)','public.naming_brain_worker_maintenance_v2(text,text,bigint,text,jsonb)',
 'public.naming_brain_worker_action(uuid,uuid,text,jsonb)','public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)',
 'public.record_naming_brain_provider_receipt(uuid,uuid,jsonb)','public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb)',
 'public.claim_naming_brain_job(text,text,integer)','public.expire_naming_brain_leases(text,text)']
 when 'logo' then array[
 'fluid_private.logo_worker_owner()','public.report_logo_worker_ready(text,jsonb,integer)','public.claim_logo_job(text,integer)',
 'public.heartbeat_logo_job(uuid,uuid,integer)','public.register_logo_job_plan(uuid,uuid,jsonb)',
 'public.begin_logo_job_step(uuid,uuid,text,text,bigint)','public.record_logo_provider_response(uuid,uuid,jsonb)',
 'public.complete_logo_job_step(uuid,uuid,text,text,bigint,jsonb,text)','public.finish_logo_job(uuid,uuid,text)',
 'public.expire_logo_job_leases()','public.read_leased_logo_record(uuid,uuid,text,jsonb)',
 'fluid_private.prepare_logo_asset(uuid,jsonb,uuid,uuid)','fluid_private.observe_logo_asset(uuid,jsonb,uuid,uuid)',
 'fluid_private.read_logo_asset_publication(uuid,jsonb,uuid,uuid)'] else null end;
$$;
create function fluid_private.grant_account_worker_login(p_id uuid,p_token uuid,p_capability text) returns void
language plpgsql security definer set search_path='' as $$
declare context jsonb:=fluid_private.account_enrollment_role_for_lease(p_id,p_token,p_capability); signature text;
begin
 if context->>'mode'<>'enroll' or context->>'roleOid' is null or to_regrole(current_user)::oid is distinct from (context->>'managerRoleOid')::oid
  or p_capability not in('strategy','naming','logo') then raise exception 'account_worker_grant_unavailable' using errcode='55000'; end if;
 foreach signature in array fluid_private.account_worker_grants(p_capability)||array['public.report_account_worker_heartbeat(jsonb,uuid)','public.account_worker_observation_principal()'] loop
  if to_regprocedure(signature) is null then raise exception 'account_worker_helpers_unavailable' using errcode='55000'; end if;
  execute format('grant execute on function %s to %I',signature,context->>'roleName');
  if not has_function_privilege(context->>'roleName',signature,'EXECUTE') then raise exception 'account_worker_helpers_unavailable' using errcode='55000'; end if;
 end loop;
end $$;

create function public.provision_account_worker_enrollment(p_id uuid,p_token uuid,p_capability text,p_profile jsonb,p_credential_ref text,p_verifier text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token);
 s fluid_private.account_service_enrollment_steps; a fluid_private.account_worker_profile_approvals:=fluid_private.account_worker_profile(p_capability,p_profile);
 b fluid_private.account_worker_bindings; role_binding jsonb; fingerprint text; storage_actor uuid; op text; selected_policy jsonb; pilot uuid;
begin
 if e.eligibility<>'active' or e.state in('revoking','revoked') or p_capability not in('strategy','naming','logo') then raise exception 'account_worker_owner_unavailable' using errcode='42501'; end if;
 select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability=p_capability for update;
 if not s.effects_started or s.phase not in('provisioning','credential_reserved','provisioned','published','ready','blocked','uncertain')
  or p_credential_ref is null or p_credential_ref!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  or s.credential_ref is not null and s.credential_ref<>p_credential_ref then raise exception 'account_worker_credential_conflict' using errcode='55000'; end if;
 fingerprint:=encode(sha256(convert_to(fluid_private.account_worker_canonical(p_profile),'UTF8')),'hex');
 select * into b from fluid_private.account_worker_bindings where owner_id=e.owner_id and capability=p_capability for update;
 if found and b.generation=e.generation and (b.operation_key<>s.operation_key or b.profile_id<>a.profile_id or b.profile_fingerprint<>fingerprint or b.credential_ref<>p_credential_ref)
  then raise exception 'account_worker_binding_conflict' using errcode='55000'; end if;
 if found and b.generation<>e.generation and (b.enabled or b.disabled_at is null) then raise exception 'account_worker_prior_generation_active' using errcode='55000'; end if;
 if p_capability='logo' then
  if to_regclass('fluid_private.logo_local_capabilities') is null or to_regprocedure('public.local_logo_operation(uuid,text,jsonb)') is null
   then raise exception 'account_worker_logo_uncapped_contract_unavailable' using errcode='55000'; end if;
  select auth_user_id into storage_actor from fluid_private.account_worker_storage_approvals x where x.identity_ref=p_profile->>'storageIdentityRef' and x.owner_id=e.owner_id
   and x.generation=e.generation and x.operation_key=s.operation_key
   and x.approved_at<=clock_timestamp() and (x.expires_at>clock_timestamp() or
    b.owner_id=e.owner_id and b.generation=e.generation and b.operation_key=s.operation_key and b.profile_id=a.profile_id and b.storage_auth_user_id=x.auth_user_id)
   and not exists(select 1 from fluid_private.account_worker_approval_revocations where kind='storage' and reference=x.identity_ref);
  if storage_actor is null or storage_actor=e.owner_id or not fluid_private.account_worker_storage_actor_active(storage_actor) then raise exception 'account_worker_storage_unavailable' using errcode='55000'; end if;
 end if;
 update fluid_private.account_service_enrollment_steps set credential_ref=p_credential_ref,phase=case when phase in('provisioned','published','ready') then phase else 'credential_reserved' end
  where enrollment_id=e.id and generation=e.generation and capability=p_capability;
 role_binding:=fluid_private.create_account_enrollment_login(p_id,p_token,p_capability,p_verifier);
 perform fluid_private.grant_account_worker_login(p_id,p_token,p_capability);
 -- Adopt only the exact owner. A preexisting foreign or historical live binding
 -- is an operator conflict, never overwritten as a side effect of signup.
 if p_capability='strategy' then
  if exists(select 1 from fluid_private.api_text_worker_principals where (role_name=role_binding->>'roleName' or role_oid=(role_binding->>'roleOid')::oid) and owner_id<>e.owner_id) then raise exception 'account_worker_binding_conflict' using errcode='55000'; end if;
  insert into fluid_private.api_text_worker_principals(role_name,role_oid,owner_id) values(role_binding->>'roleName',(role_binding->>'roleOid')::oid,e.owner_id) on conflict(role_name) do nothing;
  perform fluid_private.lock_strategy_owner(e.owner_id);
  if not exists(select 1 from fluid_private.strategy_billing_routes where owner_id=e.owner_id) then
   if exists(select 1 from public.jobs where owner_id=e.owner_id and fluid_private.api_text_operation(operation)
    and state not in('succeeded','failed','partial','cancelled')) then raise exception 'account_worker_strategy_route_unavailable' using errcode='55000'; end if;
   -- Explicit approved uncapped profile selects this provider route. No credit,
   -- allowance, cohort, monetary cap or accounting row is invented here.
   insert into fluid_private.strategy_billing_routes(owner_id,billing_mode,revision) values(e.owner_id,'openai_api',1);
  elsif not exists(select 1 from fluid_private.strategy_billing_routes where owner_id=e.owner_id and billing_mode='openai_api') then
   raise exception 'account_worker_strategy_route_unavailable' using errcode='55000';
  end if;
  foreach op in array array['strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality'] loop
   selected_policy:=a.policies->op;
   if selected_policy is null or encode(sha256(convert_to(selected_policy::text,'UTF8')),'hex') is distinct from p_profile#>>array['policyIdentities',op]
    or not exists(select 1 from fluid_private.strategy_runtime_policy where operation=op and enabled and strategy_runtime_policy.policy=selected_policy)
    then raise exception 'account_worker_strategy_policy_unavailable' using errcode='55000'; end if;
   if exists(select 1 from fluid_private.api_strategy_bindings where owner_id=e.owner_id and operation=op and enabled and (role_oid<>(role_binding->>'roleOid')::oid or deployment_id<>p_profile->>'deploymentId' or policy_identity<>p_profile#>>array['policyIdentities',op])) then raise exception 'account_worker_binding_conflict' using errcode='55000'; end if;
   insert into fluid_private.api_strategy_bindings(owner_id,operation,role_oid,policy_identity,deployment_id,enabled)
    values(e.owner_id,op,(role_binding->>'roleOid')::oid,p_profile#>>array['policyIdentities',op],p_profile->>'deploymentId',true)
    on conflict(owner_id,operation) do update set role_oid=excluded.role_oid,policy_identity=excluded.policy_identity,deployment_id=excluded.deployment_id,enabled=true;
  end loop;
 elsif p_capability='naming' then
  selected_policy:=a.policies->'naming.generate';
  if selected_policy is null or fluid_private.naming_brain_valid_policy(selected_policy) is distinct from true or encode(sha256(convert_to(selected_policy::text,'UTF8')),'hex') is distinct from p_profile->>'policyIdentity'
   then raise exception 'account_worker_naming_policy_unavailable' using errcode='55000'; end if;
  if exists(select 1 from fluid_private.naming_brain_pilots where owner_id=e.owner_id and enabled and (role_name<>role_binding->>'roleName' or role_oid<>(role_binding->>'roleOid')::oid or deployment_id<>p_profile->>'deploymentId' or naming_brain_pilots.policy<>selected_policy)) then raise exception 'account_worker_binding_conflict' using errcode='55000'; end if;
  insert into fluid_private.naming_brain_pilots(owner_id,role_name,role_oid,deployment_id,policy,enabled,readiness_fingerprint)
   values(e.owner_id,role_binding->>'roleName',(role_binding->>'roleOid')::oid,p_profile->>'deploymentId',selected_policy,true,jsonb_build_object('version',1,'normalizer','naming-preferences-v1:nfc-lower-nfc','implementationHash','7108319323898692a388fcf17cb542509583288b0d4b05d7384f8c5b707aeb01','nodeVersion',p_profile#>>'{runtime,node}','icuVersion',p_profile#>>'{runtime,icu}','unicodeVersion',p_profile#>>'{runtime,unicode}'))
   on conflict(owner_id) do update set role_name=excluded.role_name,role_oid=excluded.role_oid,deployment_id=excluded.deployment_id,policy=excluded.policy,readiness_fingerprint=excluded.readiness_fingerprint,enabled=true returning id into pilot;
  if exists(select 1 from fluid_private.hosted_naming_capabilities where owner_id=e.owner_id and enabled and (role_name<>role_binding->>'roleName' or role_oid<>(role_binding->>'roleOid')::oid or deployment_id<>p_profile->>'deploymentId' or policy_identity<>p_profile->>'policyIdentity')) then raise exception 'account_worker_binding_conflict' using errcode='55000'; end if;
  insert into fluid_private.hosted_naming_capabilities(owner_id,pilot_id,role_name,role_oid,deployment_id,policy_identity,enabled)
   values(e.owner_id,pilot,role_binding->>'roleName',(role_binding->>'roleOid')::oid,p_profile->>'deploymentId',p_profile->>'policyIdentity',true)
   on conflict(owner_id) do update set pilot_id=excluded.pilot_id,role_name=excluded.role_name,role_oid=excluded.role_oid,deployment_id=excluded.deployment_id,policy_identity=excluded.policy_identity,enabled=true;
 else
  if exists(select 1 from fluid_private.logo_worker_principals where owner_id=e.owner_id and (role_name<>role_binding->>'roleName' or role_oid<>(role_binding->>'roleOid')::oid)) then raise exception 'account_worker_binding_conflict' using errcode='55000'; end if;
  insert into fluid_private.logo_worker_principals(role_name,role_oid,owner_id) values(role_binding->>'roleName',(role_binding->>'roleOid')::oid,e.owner_id) on conflict(role_name) do nothing;
  foreach op in array array['identity.logo_concept','identity.logo_refine'] loop
   selected_policy:=a.policies->op;
   if selected_policy is null or selected_policy->>'policyIdentity' is distinct from p_profile#>>array['policyIdentities',op] or selected_policy->>'operation' is distinct from op
    or selected_policy->>'model' is distinct from p_profile->>'model' or selected_policy->>'provider' is distinct from 'openai' or selected_policy->>'handlerVersion' is distinct from 'logo-image-v1'
    or (selected_policy->>'maxCostMicrousd')::bigint<=0 then raise exception 'account_worker_logo_policy_unavailable' using errcode='55000'; end if;
   if exists(select 1 from fluid_private.logo_runtime_policies where owner_id=e.owner_id and operation=op and enabled and fluid_private.logo_policy_descriptor(logo_runtime_policies)<>selected_policy) then raise exception 'account_worker_binding_conflict' using errcode='55000'; end if;
   insert into fluid_private.logo_runtime_policies(owner_id,operation,policy_identity,handler_version,provider,model,engine,max_cost_microusd,enabled)
    values(e.owner_id,op,selected_policy->>'policyIdentity',selected_policy->>'handlerVersion','openai',selected_policy->>'model',null,(selected_policy->>'maxCostMicrousd')::bigint,true)
    on conflict(owner_id,operation) do update set policy_identity=excluded.policy_identity,handler_version=excluded.handler_version,provider=excluded.provider,model=excluded.model,engine=null,max_cost_microusd=excluded.max_cost_microusd,enabled=true;
  end loop;
  if exists(select 1 from fluid_private.logo_storage_principals where (auth_user_id=storage_actor or owner_id=e.owner_id and enabled) and (auth_user_id<>storage_actor or owner_id<>e.owner_id or role_name<>role_binding->>'roleName' or role_oid<>(role_binding->>'roleOid')::oid)) then raise exception 'account_worker_storage_conflict' using errcode='55000'; end if;
  insert into fluid_private.logo_storage_principals(auth_user_id,owner_id,role_name,role_oid,worker_id,enabled)
   values(storage_actor,e.owner_id,role_binding->>'roleName',(role_binding->>'roleOid')::oid,'embel-'||p_capability||'-'||replace(e.owner_id::text,'-','')||'-g'||e.generation,true)
   on conflict(auth_user_id) do update set role_name=excluded.role_name,role_oid=excluded.role_oid,worker_id=excluded.worker_id,enabled=true;
  foreach op in array array['identity.logo_concept','identity.logo_refine'] loop
   insert into fluid_private.logo_generative_storage_capabilities(auth_user_id,operation,policy_identity,enabled)
    values(storage_actor,op,p_profile#>>array['policyIdentities',op],true) on conflict(auth_user_id,operation) do update set policy_identity=excluded.policy_identity,enabled=true;
  end loop;
  if exists(select 1 from fluid_private.logo_local_capabilities where owner_id=e.owner_id and enabled and
   (role_name<>role_binding->>'roleName' or role_oid<>(role_binding->>'roleOid')::oid or policy_identity<>p_profile#>>'{policyIdentities,identity.logo_concept}'))
   then raise exception 'account_worker_binding_conflict' using errcode='55000'; end if;
  insert into fluid_private.logo_local_capabilities(owner_id,role_name,role_oid,worker_id,policy_identity,enabled)
   values(e.owner_id,role_binding->>'roleName',(role_binding->>'roleOid')::oid,'embel-'||p_capability||'-'||replace(e.owner_id::text,'-','')||'-g'||e.generation,p_profile#>>'{policyIdentities,identity.logo_concept}',true)
   on conflict(owner_id) do update set role_name=excluded.role_name,role_oid=excluded.role_oid,worker_id=excluded.worker_id,policy_identity=excluded.policy_identity,enabled=true;
 end if;
 insert into fluid_private.account_worker_bindings(owner_id,capability,enrollment_id,generation,revision,operation_key,role_name,role_oid,credential_ref,profile_id,profile_fingerprint,worker_id,deployment_id,storage_auth_user_id,enabled)
  values(e.owner_id,p_capability,e.id,e.generation,e.revision,s.operation_key,role_binding->>'roleName',(role_binding->>'roleOid')::oid,p_credential_ref,a.profile_id,fingerprint,
   'embel-'||p_capability||'-'||replace(e.owner_id::text,'-','')||'-g'||e.generation,p_profile->>'deploymentId',storage_actor,true)
  on conflict(owner_id,capability) do update set enrollment_id=excluded.enrollment_id,generation=excluded.generation,revision=excluded.revision,operation_key=excluded.operation_key,
   role_name=excluded.role_name,role_oid=excluded.role_oid,credential_ref=excluded.credential_ref,profile_id=excluded.profile_id,profile_fingerprint=excluded.profile_fingerprint,
   worker_id=excluded.worker_id,deployment_id=excluded.deployment_id,storage_auth_user_id=excluded.storage_auth_user_id,enabled=true,disabled_at=null,suspended_at=null returning * into b;
 update fluid_private.account_service_enrollment_steps set phase=case when phase in('published','ready') then phase else 'provisioned' end,reason=null,updated_at=clock_timestamp()
  where enrollment_id=e.id and generation=e.generation and capability=p_capability;
 if not fluid_private.account_worker_managed_role(b.role_name,b.role_oid) then raise exception 'account_worker_principal_unsafe' using errcode='55000'; end if;
 return fluid_private.account_worker_binding_json(b);
end $$;

create function public.adopt_account_worker_enrollment(p_id uuid,p_token uuid,p_capability text,p_profile jsonb,p_binding jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token); b fluid_private.account_worker_bindings;
 a fluid_private.account_worker_profile_approvals:=fluid_private.account_worker_profile(p_capability,p_profile);
begin
 select * into b from fluid_private.account_worker_bindings where owner_id=e.owner_id and capability=p_capability and enrollment_id=e.id and generation=e.generation and revision=e.revision;
 if b.profile_id is distinct from a.profile_id or p_binding is distinct from fluid_private.account_worker_binding_json(b)
  or not fluid_private.account_worker_managed_role(b.role_name,b.role_oid) then raise exception 'account_worker_binding_unavailable' using errcode='55000'; end if;
 return fluid_private.account_worker_binding_json(b);
end $$;

create function public.report_account_worker_heartbeat(p_binding jsonb,p_storage_session uuid default null) returns boolean
language plpgsql security definer set search_path='' as $$
declare b fluid_private.account_worker_bindings;
begin
 select * into b from fluid_private.account_worker_bindings where role_name=session_user and role_oid=to_regrole(session_user)::oid;
 if b.owner_id is null or p_binding is distinct from fluid_private.account_worker_binding_json(b) or not fluid_private.account_worker_managed_role(b.role_name,b.role_oid)
  then raise exception 'account_worker_heartbeat_unavailable' using errcode='42501'; end if;
 if b.capability='logo' then
  if p_storage_session is null or not fluid_private.account_worker_storage_actor_active(b.storage_auth_user_id)
   or not exists(select 1 from auth.sessions s join auth.users u on u.id=s.user_id where s.id=p_storage_session and s.user_id=b.storage_auth_user_id
   and not u.is_anonymous and (s.not_after is null or s.not_after>clock_timestamp())) then raise exception 'account_worker_storage_unavailable' using errcode='42501'; end if;
 elsif p_storage_session is not null then raise exception 'account_worker_storage_unavailable' using errcode='42501'; end if;
 insert into fluid_private.account_worker_heartbeats values(b.owner_id,b.capability,b.generation,b.revision,b.operation_key,b.role_oid,p_storage_session,clock_timestamp(),clock_timestamp()+interval '45 seconds')
  on conflict(owner_id,capability) do update set generation=excluded.generation,revision=excluded.revision,operation_key=excluded.operation_key,role_oid=excluded.role_oid,
   storage_session_id=excluded.storage_session_id,observed_at=excluded.observed_at,expires_at=excluded.expires_at;
 return true;
end $$;

create function public.report_account_worker_process(p_binding jsonb,p_state text,p_receipt text,p_observed_at timestamptz) returns boolean
language plpgsql security definer set search_path='' as $$
declare b fluid_private.account_worker_bindings; a fluid_private.account_worker_profile_approvals; reporter pg_catalog.pg_roles; prior fluid_private.account_worker_process_reports;
begin
 select * into b from fluid_private.account_worker_bindings where owner_id=(p_binding->>'ownerId')::uuid and capability=p_binding->>'capability';
 select * into a from fluid_private.account_worker_profile_approvals where profile_id=b.profile_id;
 select * into reporter from pg_roles where rolname=session_user and oid=a.reporter_role_oid and rolname=a.reporter_role_name;
 if reporter.oid is null or not reporter.rolcanlogin or reporter.rolinherit or reporter.rolsuper or reporter.rolcreatedb or reporter.rolcreaterole or reporter.rolreplication or reporter.rolbypassrls
  or exists(select 1 from fluid_private.account_enrollment_operators where role_oid=reporter.oid or role_name=reporter.rolname)
  or exists(select 1 from pg_auth_members edge where member=reporter.oid or roleid=reporter.oid and not(
   edge.admin_option and not edge.inherit_option and not edge.set_option and exists(
    select 1 from fluid_private.account_enrollment_role_manager c join pg_roles root_role on root_role.oid=c.root_role_oid and root_role.rolname=c.root_role_name
    where c.singleton and root_role.rolcanlogin and (root_role.rolsuper or root_role.rolcreaterole) and edge.member=root_role.oid)))
  or (select count(*) from pg_auth_members where roleid=reporter.oid)>1 or exists(select 1 from pg_class where relowner=reporter.oid)
  or exists(select 1 from pg_namespace where nspowner=reporter.oid) or p_binding is distinct from fluid_private.account_worker_binding_json(b)
  or exists(select 1 from pg_class t join pg_namespace n on n.oid=t.relnamespace where n.nspname in('public','fluid_private','auth','storage') and t.relkind in('r','p','v','m','f')
   and (has_any_column_privilege(reporter.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES') or has_table_privilege(reporter.oid,t.oid,'DELETE,TRUNCATE,TRIGGER')))
  or p_state not in('running','stopped') or p_observed_at is null or p_observed_at>clock_timestamp() or p_observed_at<clock_timestamp()-interval '30 seconds'
  or p_receipt is null or p_receipt!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' or p_state='running' and not fluid_private.account_worker_managed_role(b.role_name,b.role_oid)
  or p_state='stopped' and b.enabled then raise exception 'account_worker_reporter_unavailable' using errcode='42501'; end if;
 select * into prior from fluid_private.account_worker_process_reports where receipt=p_receipt;
 if found then
  if prior.binding<>p_binding or prior.state<>p_state or prior.observed_at<>p_observed_at or prior.reporter_role_oid<>reporter.oid then raise exception 'account_worker_process_receipt_conflict' using errcode='55000'; end if;
  return true;
 end if;
 insert into fluid_private.account_worker_process_reports(receipt,owner_id,capability,generation,revision,operation_key,binding,state,reporter_role_name,reporter_role_oid,observed_at)
 values(p_receipt,b.owner_id,b.capability,b.generation,b.revision,b.operation_key,p_binding,p_state,reporter.rolname,reporter.oid,p_observed_at);
 return true;
end $$;

create function fluid_private.account_worker_restart_allowed(b fluid_private.account_worker_bindings) returns boolean
language sql stable security definer set search_path='' as $$
 select b.owner_id is not null and not b.enabled and b.disabled_at is null and b.suspended_at is not null
  and exists(select 1 from fluid_private.account_worker_process_reports report where report.receipt=(
   select receipt from fluid_private.account_worker_process_reports where owner_id=b.owner_id and capability=b.capability and generation=b.generation and revision=b.revision
    order by observed_at desc,recorded_at desc limit 1) and report.state='stopped'
   and report.binding=fluid_private.account_worker_binding_json(b) and report.observed_at>=b.suspended_at and report.observed_at>clock_timestamp()-interval '30 seconds')
  and not exists(select 1 from fluid_private.account_worker_heartbeats where owner_id=b.owner_id and capability=b.capability and expires_at>clock_timestamp())
  and not exists(select 1 from public.jobs where owner_id=b.owner_id and lease_expires_at>clock_timestamp()
   and (worker_id=b.worker_id or b.capability='strategy' and operation like 'strategy.%'))
  and (b.capability<>'naming' or not exists(select 1 from fluid_private.naming_worker_leadership where owner_id=b.owner_id and deployment_id=b.deployment_id and expires_at>clock_timestamp()));
$$;
create function public.read_account_worker_enrollment(p_id uuid,p_token uuid,p_capability text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token);
 b fluid_private.account_worker_bindings; a fluid_private.account_worker_profile_approvals; heartbeat jsonb;
begin
 select * into b from fluid_private.account_worker_bindings where enrollment_id=e.id and owner_id=e.owner_id and capability=p_capability and generation=e.generation and revision=e.revision;
 select * into a from fluid_private.account_worker_profile_approvals where profile_id=b.profile_id;
 perform fluid_private.account_worker_profile(p_capability,a.profile);
 if e.eligibility<>'active' or e.state in('revoking','revoked') or b.owner_id is null or b.disabled_at is not null
  or not fluid_private.account_worker_observation_role(b.role_name,b.role_oid) then raise exception 'account_worker_maintenance_unavailable' using errcode='55000'; end if;
 if fluid_private.account_worker_heartbeat_current(b) then
  select jsonb_build_object('workerId',b.worker_id,'roleOid',b.role_oid::bigint,'observedAt',to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'storageSessionId',storage_session_id)
   into heartbeat from fluid_private.account_worker_heartbeats where owner_id=b.owner_id and capability=b.capability;
 end if;
 return jsonb_build_object('descriptor',jsonb_build_object('version',1,'binding',fluid_private.account_worker_binding_json(b),'profile',a.profile),
  'heartbeat',heartbeat,'restartAllowed',fluid_private.account_worker_restart_allowed(b));
end $$;
create function public.suspend_account_worker_enrollment(p_id uuid,p_token uuid,p_capability text,p_reason text) returns boolean
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token);
begin
 if e.eligibility<>'active' or e.state in('revoking','revoked') or p_capability not in('strategy','naming','logo')
  or p_reason not in('adapter_unavailable','store_unavailable','publication_unavailable','verification_unavailable','provision_unavailable','effect_unknown')
  then raise exception 'account_worker_maintenance_unavailable' using errcode='55000'; end if;
 update fluid_private.account_worker_bindings set enabled=false,suspended_at=coalesce(suspended_at,clock_timestamp()) where enrollment_id=e.id and owner_id=e.owner_id
  and capability=p_capability and generation=e.generation and revision=e.revision and disabled_at is null;
 if not found then raise exception 'account_worker_maintenance_unavailable' using errcode='55000'; end if;
 delete from fluid_private.account_worker_heartbeats where owner_id=e.owner_id and capability=p_capability;
 -- Keep the durable READY phase and observation identity; runtime availability
 -- is separately gated by enabled + actual heartbeat. No issued evidence lost.
 return true;
end $$;
create function public.resume_account_worker_enrollment(p_id uuid,p_token uuid,p_capability text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare state jsonb:=public.read_account_worker_enrollment(p_id,p_token,p_capability); b fluid_private.account_worker_bindings;
begin
 if state->'restartAllowed' is distinct from 'true'::jsonb then raise exception 'account_worker_restart_unconfirmed' using errcode='55000'; end if;
 update fluid_private.account_worker_bindings set enabled=true,suspended_at=null where enrollment_id=p_id and capability=p_capability
  and generation=(state#>>'{descriptor,binding,generation}')::integer and revision=(state#>>'{descriptor,binding,revision}')::bigint returning * into b;
 if b.owner_id is null then raise exception 'account_worker_restart_unconfirmed' using errcode='55000'; end if;
 return state->'descriptor';
end $$;

-- Queue descriptors contain no owner or prompt. Only the profile's dedicated
-- launcher reporter may resolve a current already-admitted dispatch to its
-- exact ready child binding; the enrollment operator cannot use this route.
create function public.get_account_worker_strategy_route(p_message jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare b fluid_private.account_worker_bindings; reporter pg_catalog.pg_roles;
begin
 select * into reporter from pg_roles where rolname=session_user;
 if reporter.oid is null or not reporter.rolcanlogin or reporter.rolinherit or reporter.rolsuper or reporter.rolcreatedb or reporter.rolcreaterole or reporter.rolreplication or reporter.rolbypassrls
  or exists(select 1 from fluid_private.account_enrollment_operators where role_oid=reporter.oid or role_name=reporter.rolname)
  or exists(select 1 from pg_auth_members edge where member=reporter.oid or roleid=reporter.oid and not(
   edge.admin_option and not edge.inherit_option and not edge.set_option and exists(
    select 1 from fluid_private.account_enrollment_role_manager c join pg_roles root_role on root_role.oid=c.root_role_oid and root_role.rolname=c.root_role_name
    where c.singleton and root_role.rolcanlogin and (root_role.rolsuper or root_role.rolcreaterole) and edge.member=root_role.oid)))
  or (select count(*) from pg_auth_members where roleid=reporter.oid)>1
  or exists(select 1 from pg_class where relowner=reporter.oid) or exists(select 1 from pg_namespace where nspowner=reporter.oid)
  or not exists(select 1 from fluid_private.account_worker_profile_approvals where capability='strategy' and reporter_role_name=reporter.rolname and reporter_role_oid=reporter.oid)
  or exists(select 1 from pg_class t join pg_namespace n on n.oid=t.relnamespace where n.nspname in('public','fluid_private','auth','storage') and t.relkind in('r','p','v','m','f')
   and (has_any_column_privilege(reporter.oid,t.oid,'SELECT,INSERT,UPDATE,REFERENCES') or has_table_privilege(reporter.oid,t.oid,'DELETE,TRUNCATE,TRIGGER')))
  then raise exception 'account_worker_reporter_unavailable' using errcode='42501'; end if;
 if jsonb_typeof(p_message) is distinct from 'object' or p_message-array['version','jobId','policyIdentity','deploymentId','dispatchIdentity']<>'{}'
  or not(p_message ?& array['version','jobId','policyIdentity','deploymentId','dispatchIdentity']) or p_message->'version' is distinct from '1'::jsonb
  or not coalesce(fluid_private.logo_uuid(p_message->'jobId'),false) or p_message->>'policyIdentity'!~'^[a-f0-9]{64}$'
  or p_message->>'dispatchIdentity'!~'^[a-f0-9]{64}$' then return null; end if;
 select bindings.* into b from fluid_private.account_worker_bindings bindings
 join fluid_private.account_worker_profile_approvals profile on profile.profile_id=bindings.profile_id and profile.reporter_role_name=reporter.rolname and profile.reporter_role_oid=reporter.oid
 join public.jobs j on j.owner_id=bindings.owner_id
 join fluid_private.api_text_dispatches d on d.job_id=j.id and d.owner_id=j.owner_id and d.deployment_id=bindings.deployment_id
 where bindings.capability='strategy' and j.id=(p_message->>'jobId')::uuid and j.billing_mode='openai_api' and fluid_private.api_text_operation(j.operation)
  and d.policy_identity=p_message->>'policyIdentity' and d.dispatch_identity=p_message->>'dispatchIdentity' and d.deployment_id=p_message->>'deploymentId'
  and j.input->'version'='3'::jsonb and j.input->>'spendControl'='uncapped' and j.input->>'policyIdentity'=d.policy_identity
  and d.policy_identity=encode(sha256(convert_to((j.input->'policy')::text,'UTF8')),'hex')
  and fluid_private.account_worker_owner_ready(bindings.owner_id,'strategy');
 if b.owner_id is null then return null; end if;
 return fluid_private.account_worker_binding_json(b);
end $$;

create function public.publish_account_worker_enrollment(p_id uuid,p_token uuid,p_capability text,p_receipt text) returns boolean
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token); b fluid_private.account_worker_bindings; report fluid_private.account_worker_process_reports;
begin
 select * into b from fluid_private.account_worker_bindings where owner_id=e.owner_id and capability=p_capability and generation=e.generation and revision=e.revision;
 select * into report from fluid_private.account_worker_process_reports where owner_id=b.owner_id and capability=b.capability and generation=b.generation and revision=b.revision order by observed_at desc,recorded_at desc limit 1;
 if b.owner_id is null or not fluid_private.account_worker_managed_role(b.role_name,b.role_oid) or report.state is distinct from 'running'
  or report.receipt is distinct from p_receipt or report.observed_at<clock_timestamp()-interval '30 seconds'
  or report.binding is distinct from fluid_private.account_worker_binding_json(b) then raise exception 'account_worker_publication_unavailable' using errcode='55000'; end if;
 update fluid_private.account_service_enrollment_steps set phase=case when phase='ready' then phase else 'published' end,
  publication_receipt=case when phase='ready' then publication_receipt else report.receipt end,reason=null,updated_at=clock_timestamp()
  where enrollment_id=e.id and generation=e.generation and capability=p_capability and phase in('provisioned','published','ready');
 if not found then raise exception 'account_worker_publication_unavailable' using errcode='55000'; end if;
 return true;
end $$;

create function public.verify_account_worker_enrollment(p_id uuid,p_token uuid,p_capability text,p_proof jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token); b fluid_private.account_worker_bindings;
 a fluid_private.account_worker_profile_approvals; h fluid_private.account_worker_heartbeats; report fluid_private.account_worker_process_reports;
begin
 select * into b from fluid_private.account_worker_bindings where owner_id=e.owner_id and capability=p_capability and generation=e.generation and revision=e.revision;
 select * into a from fluid_private.account_worker_profile_approvals where profile_id=b.profile_id;
 perform fluid_private.account_worker_profile(p_capability,a.profile);
 select * into h from fluid_private.account_worker_heartbeats where owner_id=b.owner_id and capability=b.capability and generation=b.generation and revision=b.revision and operation_key=b.operation_key and role_oid=b.role_oid and expires_at>clock_timestamp();
 select * into report from fluid_private.account_worker_process_reports where owner_id=b.owner_id and capability=b.capability and generation=b.generation and revision=b.revision order by observed_at desc,recorded_at desc limit 1;
 if not fluid_private.account_worker_managed_role(b.role_name,b.role_oid) or h.owner_id is null or report.state is distinct from 'running' or report.observed_at<clock_timestamp()-interval '30 seconds'
  or report.binding is distinct from fluid_private.account_worker_binding_json(b) or p_proof->>'receipt' is distinct from report.receipt
  or (p_proof->>'ownerId')::uuid is distinct from b.owner_id or (p_proof->>'generation')::integer is distinct from b.generation
  or (p_proof->>'revision')::bigint is distinct from b.revision or (p_proof->>'operationKey')::uuid is distinct from b.operation_key
  or p_proof->>'capability' is distinct from b.capability or p_proof->>'profileFingerprint' is distinct from b.profile_fingerprint
  or (p_proof->>'roleOid')::oid is distinct from b.role_oid or p_proof->>'workerId' is distinct from b.worker_id
  or p_proof->>'sourceRevision' is distinct from a.profile->>'sourceRevision' or p_proof->>'artifactSha256' is distinct from a.profile->>'artifactSha256'
  or (p_proof->>'observedAt')::timestamptz is distinct from report.observed_at or (p_proof->>'storageSessionId')::uuid is distinct from h.storage_session_id
  then raise exception 'account_worker_verification_unavailable' using errcode='55000'; end if;
 if p_capability='naming' and not exists(select 1 from fluid_private.naming_brain_pilots p join fluid_private.naming_worker_leadership l on l.owner_id=p.owner_id and l.deployment_id=p.deployment_id
  where p.owner_id=b.owner_id and p.role_oid=b.role_oid and p.worker_id=b.worker_id and p.ready_until>clock_timestamp() and l.worker_id=b.worker_id and l.role_oid=b.role_oid and l.expires_at>clock_timestamp()) then raise exception 'account_worker_heartbeat_unavailable' using errcode='55000'; end if;
 if p_capability='strategy' and (to_regprocedure('public.get_managed_strategy_availability(uuid)') is null
  or to_regprocedure('public.enqueue_managed_strategy_job(uuid,integer,text,text,text)') is null)
  then raise exception 'account_worker_strategy_uncapped_contract_unavailable' using errcode='55000'; end if;
 if p_capability='logo' and ((select count(*) from fluid_private.logo_worker_readiness where owner_id=b.owner_id and role_oid=b.role_oid and worker_id=b.worker_id and ready_until>clock_timestamp() and operation in('identity.logo_concept','identity.logo_refine'))<>2
  or not exists(select 1 from fluid_private.logo_storage_principals where auth_user_id=b.storage_auth_user_id and owner_id=b.owner_id and role_oid=b.role_oid and worker_id=b.worker_id and enabled)
  or not exists(select 1 from auth.sessions where id=h.storage_session_id and user_id=b.storage_auth_user_id and (not_after is null or not_after>clock_timestamp()))) then raise exception 'account_worker_storage_unavailable' using errcode='55000'; end if;
 update fluid_private.account_service_enrollment_steps set phase='ready',verification_receipt=report.receipt,reason=null,updated_at=clock_timestamp()
  where enrollment_id=e.id and generation=e.generation and capability=p_capability and phase in('published','ready');
 if not found then raise exception 'account_worker_publication_unavailable' using errcode='55000'; end if;
 return true;
end $$;

create function public.disable_account_worker_enrollment(p_id uuid,p_token uuid,p_capability text) returns boolean
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token); b fluid_private.account_worker_bindings;
begin
 if e.eligibility='active' and e.state<>'revoking' or p_capability not in('strategy','naming','logo') then raise exception 'account_worker_revocation_not_requested' using errcode='55000'; end if;
 select * into b from fluid_private.account_worker_bindings where owner_id=e.owner_id and capability=p_capability for update;

 if b.owner_id is not null then
  update fluid_private.account_worker_bindings set enabled=false,disabled_at=coalesce(disabled_at,clock_timestamp()) where owner_id=b.owner_id and capability=b.capability;
  delete from fluid_private.account_worker_heartbeats where owner_id=b.owner_id and capability=b.capability;
  if p_capability='logo' then
   update fluid_private.logo_storage_principals set enabled=false where auth_user_id=b.storage_auth_user_id and owner_id=e.owner_id and role_oid=b.role_oid;
   update fluid_private.logo_generative_storage_capabilities set enabled=false where auth_user_id=b.storage_auth_user_id;
  end if;
 end if;
 return true;
end $$;

create function fluid_private.account_worker_authority_absent(e fluid_private.account_service_enrollments,p_capability text) returns boolean
language sql stable security definer set search_path='' as $$
 select p_capability in('strategy','naming','logo') and not exists(select 1 from fluid_private.account_worker_bindings where owner_id=e.owner_id and capability=p_capability and generation>=e.generation)
  and not exists(select 1 from fluid_private.account_enrollment_managed_roles where owner_id=e.owner_id and capability=p_capability and generation>=e.generation)
  and not exists(select 1 from pg_roles where rolname=fluid_private.account_enrollment_role_name(e.owner_id,p_capability) and rolcanlogin)
  and not exists(select 1 from public.jobs where owner_id=e.owner_id and (
   p_capability='strategy' and operation like 'strategy.%' or p_capability='naming' and operation='naming.generate' or p_capability='logo' and operation like 'identity.logo_%')
   and (state not in('succeeded','failed','partial','cancelled') or worker_id='embel-'||p_capability||'-'||replace(e.owner_id::text,'-','')||'-g'||e.generation))
  and (p_capability<>'strategy' or not exists(select 1 from fluid_private.api_strategy_bindings where owner_id=e.owner_id and enabled))
  and (p_capability<>'naming' or not exists(select 1 from fluid_private.naming_brain_pilots where owner_id=e.owner_id and enabled))
  and (p_capability<>'logo' or not exists(select 1 from fluid_private.logo_storage_principals where owner_id=e.owner_id and (enabled or worker_id='embel-logo-'||replace(e.owner_id::text,'-','')||'-g'||e.generation)));
$$;
create function fluid_private.account_worker_actor_sessions(p_actor uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare sessions_absent boolean; tokens_absent boolean; live_tokens boolean;
begin
 if to_regclass('auth.sessions') is null or to_regclass('auth.refresh_tokens') is null
  or not exists(select 1 from pg_attribute where attrelid=to_regclass('auth.sessions') and attname='user_id' and not attisdropped)
  or not exists(select 1 from pg_attribute where attrelid=to_regclass('auth.refresh_tokens') and attname='user_id' and not attisdropped)
  or not exists(select 1 from pg_attribute where attrelid=to_regclass('auth.refresh_tokens') and attname='revoked' and not attisdropped)
  then raise exception 'account_worker_actor_session_proof_unavailable' using errcode='55000'; end if;
 select not exists(select 1 from auth.sessions where user_id=p_actor) into sessions_absent;
 -- Only booleans are selected. No session, token or refresh value is exposed.
 execute 'select not exists(select 1 from auth.refresh_tokens where lower(user_id::text)=$1),exists(select 1 from auth.refresh_tokens where lower(user_id::text)=$1 and not coalesce(revoked,false))'
  into tokens_absent,live_tokens using p_actor::text;
 return jsonb_build_object('sessionsAbsent',sessions_absent,'refreshTokensAbsent',tokens_absent,'liveRefreshTokensAbsent',not live_tokens);
end $$;

create function public.prove_unprovisioned_account_worker_storage_actor(p_id uuid,p_token uuid,p_actor uuid,p_profile jsonb,p_reservation_ref text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token);
 s fluid_private.account_service_enrollment_steps; a fluid_private.account_worker_profile_approvals; prior fluid_private.account_worker_actor_reservations;
 account jsonb; expected_metadata jsonb; sessions jsonb; registered boolean;
begin
 select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability='logo';
 select * into a from fluid_private.account_worker_profile_approvals where profile_id=p_profile->>'profileId' and capability='logo' and profile=p_profile;
 if e.eligibility='active' and e.state<>'revoking' or a.profile_id is null or not s.effects_started or p_actor is null or p_actor=e.owner_id
  or p_reservation_ref is null or p_reservation_ref!~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  or not fluid_private.account_worker_authority_absent(e,'logo') then raise exception 'account_worker_never_provisioned_unconfirmed' using errcode='55000'; end if;
 -- Serialize with Auth's exact UUID INSERT fence. An already-started create
 -- settles before this read; a later create sees the committed retirement.
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text||':account-worker-storage-actor',0));
 select to_jsonb(u) into account from auth.users u where id=p_actor;
 select * into prior from fluid_private.account_worker_actor_reservations where owner_id=e.owner_id and generation=e.generation and operation_key=s.operation_key;
 if prior.auth_user_id is null then
  -- Vault-only reservation: actual absent Auth UUID plus this terminal SQL
  -- fence permits retiring the unused credential, never touching an account.
  if account is not null then raise exception 'account_worker_service_actor_reservation_unavailable' using errcode='55000'; end if;
  insert into fluid_private.account_worker_actor_reservations(enrollment_id,owner_id,generation,operation_key,auth_user_id,profile_id,identity_ref,reservation_ref,cleanup_only)
   values(e.id,e.owner_id,e.generation,s.operation_key,p_actor,a.profile_id,p_profile->>'storageIdentityRef',p_reservation_ref,true) returning * into prior;
 end if;
 if prior.auth_user_id<>p_actor or prior.profile_id<>a.profile_id or prior.identity_ref<>p_profile->>'storageIdentityRef' or prior.reservation_ref<>p_reservation_ref
  then raise exception 'account_worker_service_actor_conflict' using errcode='55000'; end if;
 expected_metadata:=jsonb_build_object('version',1,'enrollmentId',e.id,'ownerId',e.owner_id,'generation',e.generation,'operationKey',s.operation_key,'storageIdentityRef',prior.identity_ref,'reservationRef',p_reservation_ref);
 if account is not null and account#>'{raw_app_meta_data,embel_worker_storage}' is distinct from expected_metadata
  then raise exception 'account_worker_service_actor_metadata_unavailable' using errcode='55000'; end if;
 if exists(select 1 from fluid_private.logo_storage_principals where auth_user_id=p_actor)
  or exists(select 1 from public.projects where owner_id=p_actor)
  or exists(select 1 from storage.objects where owner_id=p_actor::text)
  then raise exception 'account_worker_never_provisioned_unconfirmed' using errcode='55000'; end if;
 sessions:=fluid_private.account_worker_actor_sessions(p_actor);
 select exists(select 1 from fluid_private.account_service_actors where auth_user_id=p_actor and purpose='logo_storage' and registration_receipt=p_reservation_ref) into registered;
 -- This exact UUID fence also rejects a delayed Admin create request that
 -- arrives after absence was observed. It never affects ordinary signup IDs.
 insert into fluid_private.account_worker_actor_retirements(auth_user_id) values(p_actor) on conflict(auth_user_id) do nothing;
 return jsonb_build_object('ownerId',e.owner_id,'generation',e.generation,'revision',e.revision,'operationKey',s.operation_key,
  'authUserId',p_actor,'storageIdentityRef',prior.identity_ref,'receipt',p_reservation_ref,'scope','never_provisioned','authorityAbsent',true,'storageDenied',true,
  'authUserAbsent',account is null,'registered',registered,'sessionsAbsent',sessions->'sessionsAbsent','refreshTokensAbsent',sessions->'refreshTokensAbsent');
end $$;

create function public.verify_account_worker_revocation(p_id uuid,p_token uuid,p_capability text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token); b fluid_private.account_worker_bindings; report fluid_private.account_worker_process_reports;
 s fluid_private.account_service_enrollment_steps; actor record; account jsonb; sessions jsonb; receipt text; observed timestamptz:=clock_timestamp();
begin
 if e.eligibility='active' and e.state<>'revoking' then raise exception 'account_worker_revocation_not_requested' using errcode='55000'; end if;
 select * into b from fluid_private.account_worker_bindings where owner_id=e.owner_id and capability=p_capability and generation=e.generation;
 if b.owner_id is null then
  if not fluid_private.account_worker_authority_absent(e,p_capability) then raise exception 'account_worker_revocation_unconfirmed' using errcode='55000'; end if;
  select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability=p_capability;
  if s.operation_key is null then raise exception 'account_worker_revocation_unconfirmed' using errcode='55000'; end if;
  if p_capability='logo' then
   for actor in select * from fluid_private.account_worker_actor_reservations where enrollment_id=e.id and generation=e.generation and operation_key=s.operation_key loop
    perform pg_advisory_xact_lock(hashtextextended(actor.auth_user_id::text||':account-worker-storage-actor',0));
    select to_jsonb(u) into account from auth.users u where id=actor.auth_user_id;
    sessions:=fluid_private.account_worker_actor_sessions(actor.auth_user_id);
    if not exists(select 1 from fluid_private.account_worker_actor_retirements where auth_user_id=actor.auth_user_id)
     or account is not null and account#>'{raw_app_meta_data,embel_worker_storage}' is distinct from jsonb_build_object('version',1,'enrollmentId',actor.enrollment_id,'ownerId',actor.owner_id,'generation',actor.generation,'operationKey',actor.operation_key,'storageIdentityRef',actor.identity_ref,'reservationRef',actor.reservation_ref)
     or account is not null and coalesce((account->>'banned_until')::timestamptz,'-infinity'::timestamptz)<=clock_timestamp()
     or sessions->'sessionsAbsent' is distinct from 'true'::jsonb or sessions->'liveRefreshTokensAbsent' is distinct from 'true'::jsonb
     or exists(select 1 from fluid_private.logo_storage_principals where auth_user_id=actor.auth_user_id)
     then raise exception 'account_worker_actor_retirement_unconfirmed' using errcode='55000'; end if;
   end loop;
  end if;
  receipt:='never-provisioned:'||encode(sha256(convert_to(e.id::text||':'||e.generation||':'||e.revision||':'||s.operation_key,'UTF8')),'hex');
  update fluid_private.account_service_enrollment_steps set revocation_receipt=receipt,revocation_verified_at=observed
   where enrollment_id=e.id and generation=e.generation and capability=p_capability;
  return jsonb_build_object('ownerId',e.owner_id,'generation',e.generation,'revision',e.revision,'operationKey',s.operation_key,'capability',p_capability,'receipt',receipt,
   'observedAt',to_char(observed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'authorityDisabled',true,'storageDenied',true,'scope','never_provisioned','authorityAbsent',true);
 end if;
 select * into report from fluid_private.account_worker_process_reports where owner_id=e.owner_id and capability=p_capability and generation=b.generation and revision=b.revision order by observed_at desc,recorded_at desc limit 1;
 if b.owner_id is null or b.enabled or b.disabled_at is null or report.state is distinct from 'stopped' or report.observed_at<b.disabled_at
  or report.observed_at<clock_timestamp()-interval '30 seconds' or report.binding is distinct from fluid_private.account_worker_binding_json(b)
  or not exists(select 1 from pg_roles where oid=b.role_oid and rolname=b.role_name)
  or exists(select 1 from public.jobs where owner_id=b.owner_id and (lease_expires_at>clock_timestamp() or state in('running','cancel_requested')) and (worker_id=b.worker_id or p_capability='strategy' and operation like 'strategy.%'))
  or p_capability='logo' and exists(select 1 from fluid_private.logo_storage_principals where auth_user_id=b.storage_auth_user_id and enabled)
  then raise exception 'account_worker_revocation_unconfirmed' using errcode='55000'; end if;
 update fluid_private.account_service_enrollment_steps set revocation_receipt=report.receipt,revocation_verified_at=clock_timestamp()
  where enrollment_id=e.id and generation=e.generation and capability=p_capability;
 perform fluid_private.disable_account_enrollment_login(p_id,p_token,p_capability);
 if exists(select 1 from pg_roles where oid=b.role_oid and rolname=b.role_name and rolcanlogin) then raise exception 'account_worker_revocation_unconfirmed' using errcode='55000'; end if;
 return jsonb_build_object('ownerId',e.owner_id,'generation',e.generation,'revision',e.revision,'operationKey',b.operation_key,'capability',p_capability,'receipt',report.receipt,
  'observedAt',to_char(report.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'authorityDisabled',true,'runtimeStopped',true,'storageDenied',true);
end $$;

create function public.revoke_account_worker_storage_actor(p_id uuid,p_token uuid,p_actor uuid,p_profile jsonb,p_reservation_ref text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e fluid_private.account_service_enrollments:=fluid_private.lock_account_enrollment(p_id,p_token);
 b fluid_private.account_worker_bindings; s fluid_private.account_service_enrollment_steps; a fluid_private.account_worker_profile_approvals;
begin
 select * into b from fluid_private.account_worker_bindings where owner_id=e.owner_id and capability='logo';
 select * into a from fluid_private.account_worker_profile_approvals where profile_id=b.profile_id and capability='logo' and profile=p_profile;
 select * into s from fluid_private.account_service_enrollment_steps where enrollment_id=e.id and generation=e.generation and capability='logo';
 if e.eligibility='active' and e.state<>'revoking' or b.owner_id is null or b.enabled or b.disabled_at is null or b.storage_auth_user_id is distinct from p_actor or a.profile_id is null
  or s.revocation_receipt is null or s.revocation_verified_at is null or s.revocation_verified_at<e.updated_at
  or not exists(select 1 from pg_roles where oid=b.role_oid and rolname=b.role_name and not rolcanlogin)
  or not exists(select 1 from fluid_private.account_worker_storage_approvals where owner_id=e.owner_id and generation=b.generation and operation_key=b.operation_key
   and auth_user_id=p_actor and identity_ref=p_profile->>'storageIdentityRef' and registration_receipt=p_reservation_ref)
  or not exists(select 1 from fluid_private.logo_storage_principals where auth_user_id=p_actor and owner_id=e.owner_id and role_oid=b.role_oid and not enabled)
  or exists(select 1 from fluid_private.logo_generative_storage_capabilities where auth_user_id=p_actor and enabled)
  or exists(select 1 from public.jobs where owner_id=e.owner_id and worker_id=b.worker_id and (lease_expires_at>clock_timestamp() or state in('running','cancel_requested')))
  then raise exception 'account_worker_service_actor_revocation_unconfirmed' using errcode='55000'; end if;
 return jsonb_build_object('ownerId',e.owner_id,'generation',e.generation,'revision',e.revision,'operationKey',s.operation_key,
  'authUserId',p_actor,'storageIdentityRef',p_profile->>'storageIdentityRef','receipt',s.revocation_receipt,'runtimeStopped',true,'storageDenied',true);
end $$;

-- Existing Strategy store reads are exposed through fixed owned selectors;
-- managed workers and their NOLOGIN manager get no customer-table SELECT.
create function public.read_account_worker_strategy_step(p_job uuid,p_owner uuid,p_project uuid,p_step text)
returns table(state text,request_key text,reserved_cost_microusd bigint)
language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from fluid_private.account_worker_bindings b join public.jobs j on j.owner_id=b.owner_id
  join fluid_private.api_text_dispatches d on d.job_id=j.id and d.owner_id=j.owner_id
  where b.capability='strategy' and b.role_name=session_user and j.id=p_job and j.owner_id=p_owner and j.project_id=p_project
   and d.deployment_id=b.deployment_id and d.policy_identity=encode(sha256(convert_to((j.input->'policy')::text,'UTF8')),'hex')
   and fluid_private.account_worker_observation_role(b.role_name,b.role_oid)) then raise exception 'account_worker_strategy_scope_unavailable' using errcode='42501'; end if;
 return query select s.state::text,s.request_key,s.reserved_cost_microusd from public.job_steps s where s.job_id=p_job and s.owner_id=p_owner and s.project_id=p_project and s.step_key=p_step;
end $$;
create function public.account_worker_strategy_has_results(p_job uuid,p_owner uuid,p_project uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from fluid_private.account_worker_bindings b join public.jobs j on j.owner_id=b.owner_id
  join fluid_private.api_text_dispatches d on d.job_id=j.id and d.owner_id=j.owner_id
  where b.capability='strategy' and b.role_name=session_user and j.id=p_job and j.owner_id=p_owner and j.project_id=p_project
   and d.deployment_id=b.deployment_id and d.policy_identity=encode(sha256(convert_to((j.input->'policy')::text,'UTF8')),'hex')
   and fluid_private.account_worker_observation_role(b.role_name,b.role_oid)) then raise exception 'account_worker_strategy_scope_unavailable' using errcode='42501'; end if;
 return exists(select 1 from public.job_steps where job_id=p_job and owner_id=p_owner and project_id=p_project and state='succeeded');
end $$;

create function fluid_private.account_worker_heartbeat_current(b fluid_private.account_worker_bindings) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from fluid_private.account_worker_heartbeats h where h.owner_id=b.owner_id and h.capability=b.capability
  and h.generation=b.generation and h.revision=b.revision and h.operation_key=b.operation_key and h.role_oid=b.role_oid and h.expires_at>clock_timestamp()
  and (b.capability<>'logo' or fluid_private.account_worker_storage_actor_active(b.storage_auth_user_id)
   and exists(select 1 from fluid_private.logo_storage_principals where auth_user_id=b.storage_auth_user_id and owner_id=b.owner_id and role_oid=b.role_oid and worker_id=b.worker_id and enabled)
   and exists(select 1 from auth.sessions where id=h.storage_session_id and user_id=b.storage_auth_user_id and (not_after is null or not_after>clock_timestamp()))));
$$;
create function fluid_private.account_worker_dispatch_ready() returns boolean
language sql stable security definer set search_path='' as $$
 select case when exists(select 1 from fluid_private.account_enrollment_managed_roles where role_name=session_user and capability in('strategy','naming','logo'))
 then exists(select 1 from fluid_private.account_worker_bindings b join fluid_private.account_service_enrollment_steps s
  on s.enrollment_id=b.enrollment_id and s.generation=b.generation and s.capability=b.capability and s.operation_key=b.operation_key
  where b.role_name=session_user and s.phase='ready' and fluid_private.account_worker_managed_role(b.role_name,b.role_oid) and fluid_private.account_worker_heartbeat_current(b))
 else true end;
$$;
create function fluid_private.account_worker_owner_ready(p_owner uuid,p_capability text) returns boolean
language sql stable security definer set search_path='' as $$
 select case when exists(select 1 from fluid_private.account_worker_bindings where owner_id=p_owner and capability=p_capability)
 then exists(select 1 from fluid_private.account_worker_bindings b join fluid_private.account_service_enrollment_steps s
  on s.enrollment_id=b.enrollment_id and s.generation=b.generation and s.capability=b.capability and s.operation_key=b.operation_key
  where b.owner_id=p_owner and b.capability=p_capability and s.phase='ready' and fluid_private.account_worker_managed_role(b.role_name,b.role_oid) and fluid_private.account_worker_heartbeat_current(b))
 else true end;
$$;
create function fluid_private.account_worker_logo_replay(p_owner uuid,p_project uuid,p_input jsonb) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(fluid_private.logo_uuid(p_input->'requestKey'),false) and (
  exists(select 1 from public.logo_operation_requests where owner_id=p_owner and project_id=p_project and request_key=(p_input->>'requestKey')::uuid)
  or exists(select 1 from public.logo_operation_rejections where owner_id=p_owner and project_id=p_project and request_key=(p_input->>'requestKey')::uuid));
$$;
create function public.account_logo_operation(p_project_id uuid,p_kind text,p_input jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare owner uuid:=auth.uid(); binding fluid_private.account_worker_bindings; profile fluid_private.account_worker_profile_approvals;
begin
 if owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 perform 1 from public.projects where id=p_project_id and owner_id=owner;
 if not found then raise exception 'logo_project_not_found' using errcode='P0002'; end if;
 if p_kind not in('capabilities','quote','admit') or p_kind is null then raise exception 'invalid_account_logo_action' using errcode='22023'; end if;
 if not(p_kind='admit' and fluid_private.account_worker_logo_replay(owner,p_project_id,p_input)) then
  select * into binding from fluid_private.account_worker_bindings where owner_id=owner and capability='logo';
  select * into profile from fluid_private.account_worker_profile_approvals where profile_id=binding.profile_id;
  if binding.owner_id is null or not fluid_private.account_worker_owner_ready(owner,'logo') or profile.profile->>'admissionContract'<>'account_logo_operation'
   or profile.profile->>'spendControl'<>'uncapped' then raise exception 'account_worker_not_ready' using errcode='55000'; end if;
  if p_kind='admit' then
   -- Bookkeeping only, after explicit owned uncapped authority. Existing ledger
   -- rows/balances are never changed; this zero is not an admission allowance.
   perform fluid_private.lock_strategy_owner(owner);
   perform 1 from public.projects where id=p_project_id and owner_id=owner for update;
   insert into public.usage_accounts(owner_id,limit_microusd) values(owner,0) on conflict(owner_id) do nothing;
  end if;
 end if;
 -- Existing private transaction witness grants only its reviewed aggregate
 -- exception. Quoted per-operation integrity/accounting remains unchanged.
 return public.local_logo_operation(p_project_id,p_kind,p_input);
end $$;

do $logo_readiness$
declare body text; definition text;
begin
 select prosrc into body from pg_proc where oid=to_regprocedure('fluid_private.logo_operation_ready(uuid,text)') and not prosecdef and provolatile='v'
  and proconfig=array['search_path=""'] and not proleakproof and proowner=to_regrole('postgres')::oid;
 if body is null or encode(sha256(convert_to(body,'UTF8')),'hex') not in(
  'b30010957639806115d173e2d70451e1113937c73cd072d8abb9f04b469e1708',
  'f4d4e69dce3f607604a1578ad0575c3ca67633be378763c555a42ea3c18511db') then raise exception 'unexpected_account_logo_readiness_predecessor' using errcode='55000'; end if;
 definition:=pg_get_functiondef('fluid_private.logo_operation_ready(uuid,text)'::regprocedure);
 execute replace(definition,'CREATE OR REPLACE FUNCTION fluid_private.logo_operation_ready(','CREATE FUNCTION fluid_private.account_worker_legacy_logo_ready(');
end $logo_readiness$;
create or replace function fluid_private.logo_operation_ready(p_owner uuid,p_operation text) returns boolean
language sql volatile set search_path='' as $$
 select fluid_private.account_worker_owner_ready(p_owner,'logo') and fluid_private.account_worker_legacy_logo_ready(p_owner,p_operation);
$$;
-- Guard only new managed jobs. Existing bodies/ACLs/OIDs remain intact; exact
-- predecessor hashes below make this packet reject an unreviewed SQL version.
do $dispatch_guards$
declare signature text; expected text; body text; definition text; guard text;
begin
 for signature,expected in values
 ('public.claim_api_text_job(uuid,text,integer,text,text)','399628804d96ca082c58c92164f20c36b68daf2ecfe8aac08b7710706247ef81'),
 ('public.authorize_api_text_dispatch(uuid,uuid,text,text,text)','a9afd9181d7524908576609639911932d6e5207cf45390ace1bc328b899a6e6f'),
 ('public.claim_naming_brain_job(text,text,integer)','18ddbd0c0e58ddcff7a64d2d0ac6626460922297062947e2fc1bbfad5fe581c5'),
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)','5332a09487afdd3ded05ccc72911bef5dc942bfe2a4c674c6a3052483c4e9721'),
 ('public.claim_logo_job(text,integer)','62bdab69d9ef76610fa52de869b5291ef582d3a5a2bd518b52d47dfe3d752d63'),
 ('public.begin_job_step(uuid,uuid,text,text,bigint)','18f7b41e833b9e3773ac7e3f7bffbde2809a37e79d9d6455d251ab7803ae39cd'),
 ('public.begin_logo_job_step(uuid,uuid,text,text,bigint)','a188bae5fee2c50527c874540e0289096f39d5d3ff82e5db47e54e5f7f7125f4'),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)','477cab631f6b4c1aa7c6e2f0f1cf34a7bd284bdffda368eba2d98919172342b1'),
 ('public.enqueue_strategy_job(uuid,integer,text,text,bigint)','69bc1645e21a2df4ba96e94c07e99d18cf03a9963b717bd2b3aa8882709ae707'),
 ('public.ensure_hosted_naming_brain_run(uuid,jsonb)','5c96676692871c9d54d361140c8870f775b90cc8cbb196a715dd8cfb401dd004'),
 ('public.admit_logo_operation(uuid,jsonb)','6567f6572b4744dd6e9fa78144de8c7c9b88aa86490fc3bf2ed719d88dee8188'),
 ('public.local_logo_operation(uuid,text,jsonb)','e02407ad28fab03e3dd13d817d659c90b17c887eb5961b2bb840282ef15c2804') loop
  if signature='public.local_logo_operation(uuid,text,jsonb)' and to_regprocedure(signature) is null then continue; end if;
  select prosrc into body from pg_proc where oid=to_regprocedure(signature) and proconfig=array['search_path=""'] and not proleakproof
   and proowner=to_regrole('postgres')::oid and prosecdef and prolang=(select oid from pg_language where lanname='plpgsql');
  if body is null or (encode(sha256(convert_to(body,'UTF8')),'hex')<>expected and not(
    signature='public.claim_logo_job(text,integer)' and encode(sha256(convert_to(body,'UTF8')),'hex')='f063d20491c20e0afa43b29bed08234d42a5efc3a2c4f9f8ae73026b15697122'
    or signature='public.begin_logo_job_step(uuid,uuid,text,text,bigint)' and encode(sha256(convert_to(body,'UTF8')),'hex')='4b57ad86083610a8fba9c4b629936cf7d844ad876471e5f2e47645d4dcd60e09'
    or signature='public.admit_logo_operation(uuid,jsonb)' and encode(sha256(convert_to(body,'UTF8')),'hex')='e20df921bd3ed79f0f31a908d6787722ad1fc51f4cecd21ecced9ae374d9be6e'))
   then raise exception 'unexpected_account_worker_dispatch_predecessor' using errcode='55000'; end if;
  definition:=pg_get_functiondef(to_regprocedure(signature));
  if signature='public.ensure_hosted_naming_brain_run(uuid,jsonb)' then
   if (length(definition)-length(replace(definition,'insert into fluid_private.hosted_naming_admission_context values(pg_backend_pid(),txid_current(),o,p_project_id,c.id);','')))
    /length('insert into fluid_private.hosted_naming_admission_context values(pg_backend_pid(),txid_current(),o,p_project_id,c.id);')<>1 then raise exception 'unexpected_account_naming_bookkeeping_shape' using errcode='55000'; end if;
   definition:=replace(definition,'insert into fluid_private.hosted_naming_admission_context values(pg_backend_pid(),txid_current(),o,p_project_id,c.id);',
    E'insert into fluid_private.hosted_naming_admission_context values(pg_backend_pid(),txid_current(),o,p_project_id,c.id);\n if exists(select 1 from fluid_private.account_worker_bindings binding join fluid_private.account_worker_profile_approvals profile on profile.profile_id=binding.profile_id where binding.owner_id=o and binding.capability=\'naming\' and profile.profile->>\'admissionContract\'=\'hosted_owner_v1\' and profile.profile->\'providerBudgetVersion\'=\'2\'::jsonb and profile.profile->>\'spendControl\'=\'uncapped\' and fluid_private.account_worker_owner_ready(o,\'naming\')) then\n  perform 1 from public.projects where id=p_project_id and owner_id=o for update;\n  insert into public.usage_accounts(owner_id,limit_microusd) values(o,0) on conflict(owner_id) do nothing;\n end if;');
  end if;
  if position(E'begin\n' in definition)=0 then raise exception 'unexpected_account_worker_dispatch_shape' using errcode='55000'; end if;
  guard:='not fluid_private.account_worker_dispatch_ready()';
  if signature='public.naming_brain_worker_action(uuid,uuid,text,jsonb)' then
   guard:=guard||' and p_action not in(''heartbeat'',''stage'',''progressive_state'',''provider_item'',''provider_turn'',''tool_result'',''artifact'',''finish'')';
  elsif signature='public.enqueue_strategy_job(uuid,integer,text,text,bigint)' then guard:='not fluid_private.account_worker_owner_ready(auth.uid(),''strategy'')';
  elsif signature='public.ensure_hosted_naming_brain_run(uuid,jsonb)' then guard:='not fluid_private.account_worker_owner_ready(auth.uid(),''naming'') and not exists(select 1 from fluid_private.naming_brain_intents where owner_id=auth.uid() and project_id=p_project_id and request_key=p_intent->>''idempotencyKey'')';
  elsif signature='public.admit_logo_operation(uuid,jsonb)' then guard:='not fluid_private.account_worker_owner_ready(auth.uid(),''logo'') and not fluid_private.account_worker_logo_replay(auth.uid(),p_project_id,p_input)';
  elsif signature='public.local_logo_operation(uuid,text,jsonb)' then guard:='not fluid_private.account_worker_owner_ready(auth.uid(),''logo'') and not(p_kind=''admit'' and fluid_private.account_worker_logo_replay(auth.uid(),p_project_id,p_input))'; end if;
  execute overlay(definition placing E'begin\n if '||guard||E' then raise exception \'account_worker_not_ready\' using errcode=\'55000\'; end if;\n' from position(E'begin\n' in definition) for length(E'begin\n'));
 end loop;
end $dispatch_guards$;

-- Function grants are capability definitions only. No operator/reporter login
-- receives EXECUTE here. The manager is NOLOGIN and owns no customer relation.
do $$declare proc_record record; signature text; grantee name;begin
 for proc_record in select p.oid as function_oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='fluid_private' and (p.proname like 'account_worker_%' or p.proname='grant_account_worker_login'))
   or (n.nspname='public' and p.proname in('provision_account_worker_enrollment','adopt_account_worker_enrollment','reserve_account_worker_storage_actor','register_account_worker_storage_actor','prove_unprovisioned_account_worker_storage_actor','revoke_account_worker_storage_actor','report_account_worker_heartbeat','report_account_worker_process','get_account_worker_strategy_route','read_account_worker_enrollment','suspend_account_worker_enrollment','resume_account_worker_enrollment','publish_account_worker_enrollment','account_worker_observation_principal','verify_account_worker_enrollment','disable_account_worker_enrollment','verify_account_worker_revocation','read_account_worker_strategy_step','account_worker_strategy_has_results','account_logo_operation')) loop
  execute format('revoke all on function %I.%I(%s) from public,anon,authenticated,service_role',proc_record.nspname,proc_record.proname,proc_record.args);
  for grantee in select r.rolname from pg_proc fn,lateral aclexplode(coalesce(fn.proacl,acldefault('f',fn.proowner))) a
   join pg_roles r on r.oid=a.grantee where fn.oid=proc_record.function_oid and a.grantee<>fn.proowner loop
   execute format('revoke all on function %I.%I(%s) from %I cascade',proc_record.nspname,proc_record.proname,proc_record.args,grantee);
  end loop;
 end loop;
 foreach signature in array fluid_private.account_worker_grants('strategy')||fluid_private.account_worker_grants('naming')||fluid_private.account_worker_grants('logo')||array['public.report_account_worker_heartbeat(jsonb,uuid)','public.account_worker_observation_principal()'] loop
  if to_regprocedure(signature) is null then raise exception 'account_worker_helpers_unavailable' using errcode='55000'; end if;
  execute format('grant execute on function %s to embel_account_role_manager with grant option',signature);
 end loop;
end $$;
grant execute on function fluid_private.account_worker_grants(text) to embel_account_role_manager;
grant execute on function public.account_logo_operation(uuid,text,jsonb) to authenticated;
-- A supported NOSUPER postgres installer uses one temporary SET edge and
-- schema CREATE capability for this exact transfer, then removes both. Its
-- original PG17 creator ADMIN edge remains NOSET/NOINHERIT.
grant create on schema fluid_private to embel_account_role_manager;
grant embel_account_role_manager to postgres with inherit false,set true;
alter function fluid_private.grant_account_worker_login(uuid,uuid,text) owner to embel_account_role_manager;
set role embel_account_role_manager;
grant execute on function fluid_private.grant_account_worker_login(uuid,uuid,text) to postgres;
reset role;
revoke create on schema fluid_private from embel_account_role_manager;
revoke embel_account_role_manager from postgres granted by postgres;
do $$begin
 if not exists(select 1 from pg_auth_members where roleid=to_regrole('embel_account_role_manager')::oid) then
  execute 'grant embel_account_role_manager to postgres with admin true,inherit false,set false';
 end if;
 if (select count(*) from pg_auth_members where roleid=to_regrole('embel_account_role_manager')::oid)<>1
  or not exists(select 1 from pg_auth_members where roleid=to_regrole('embel_account_role_manager')::oid and member=to_regrole('postgres')::oid
   and admin_option and not inherit_option and not set_option) then raise exception 'account_enrollment_manager_admin_edge_unavailable'; end if;
end $$;
commit;
