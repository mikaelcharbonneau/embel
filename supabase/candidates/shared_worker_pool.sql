-- UNAPPLIED fixed-slot authority. Installation creates metadata/functions only:
-- no LOGIN role, password, provider request, existing-job rewrite or live grant.
-- Lane adapters install their own fixed action gateways after this packet.
begin;
do $$begin
 if current_user<>'postgres' or to_regclass('fluid_private.shared_worker_slots') is not null then
  raise exception 'shared_worker_fresh_postgres_install_required' using errcode='55000';
 end if;
 if to_regprocedure('auth.uid()') is null or to_regclass('auth.users') is null or to_regclass('public.jobs') is null then
  raise exception 'shared_worker_baseline_required' using errcode='55000';
 end if;
end $$;

create table fluid_private.shared_accounts (
 owner_id uuid primary key, eligibility_epoch bigint not null default 1 check(eligibility_epoch>0),
 enabled boolean not null default true, updated_at timestamptz not null default clock_timestamp()
);
-- Fixed service identities must be registered before confirmation. This marker
-- never conveys customer or Storage authority by itself.
create table fluid_private.shared_service_actors (
 auth_user_id uuid primary key, purpose text not null check(purpose in('logo_storage','legacy_logo_storage'))
);
-- Classifications are permanent. A legacy actor stays under its existing
-- Storage policies; it must never be reclassified as a shared slot actor or
-- become a customer when its old runtime is disabled or Auth is updated.
create function fluid_private.shared_service_actor_classification() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' or tg_op='UPDATE' and (new.auth_user_id,new.purpose) is distinct from(old.auth_user_id,old.purpose) then
  raise exception 'shared_service_actor_classification_immutable' using errcode='42501';
 end if;
 if tg_op='UPDATE' then return new; end if;
 if new.purpose='legacy_logo_storage' then
  if to_regclass('fluid_private.logo_storage_principals') is null or to_regclass('fluid_private.logo_worker_principals') is null then
   raise exception 'shared_legacy_actor_binding_unqualified' using errcode='55000';
  end if;
  if not exists(select 1 from fluid_private.logo_storage_principals b
   join fluid_private.logo_worker_principals p on p.role_name=b.role_name and p.role_oid=b.role_oid and p.owner_id=b.owner_id
   join pg_catalog.pg_roles r on r.oid=b.role_oid and r.rolname=b.role_name
   join auth.users actor on actor.id=b.auth_user_id
   where b.auth_user_id=new.auth_user_id and b.auth_user_id<>b.owner_id and actor.is_anonymous=false
    and not r.rolinherit and not r.rolsuper and not r.rolbypassrls and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
    and not exists(select 1 from pg_catalog.pg_auth_members where member=r.oid)) then
   raise exception 'shared_legacy_actor_binding_unqualified' using errcode='42501';
  end if;
 elsif to_regclass('fluid_private.logo_storage_principals') is not null then
  if exists(select 1 from fluid_private.logo_storage_principals where auth_user_id=new.auth_user_id) then
   raise exception 'shared_legacy_actor_kind_required' using errcode='42501';
  end if;
 end if;
 return new;
end $$;
create trigger shared_service_actor_classification before insert or update or delete on fluid_private.shared_service_actors
 for each row execute function fluid_private.shared_service_actor_classification();
create table fluid_private.shared_worker_slots (
 slot_id uuid primary key, lane text not null check(lane in('strategy','naming','logo')),
 slot_index smallint not null check(slot_index between 1 and 64),
 role_name name not null unique, role_oid oid not null unique,
 deployment_id text not null check(length(deployment_id) between 1 and 200),
 enabled boolean not null default false,
 tenant_active_limit smallint not null default 1 check(tenant_active_limit between 1 and 16),
 instance_id uuid, generation bigint not null default 0 check(generation between 0 and 9007199254740991),
 lease_token uuid, expires_at timestamptz,
 unique(lane,slot_index), check(role_name::text ~ ('^embel_shared_'||lane||'_[a-z0-9_]{1,30}$')),
 check((instance_id is null)=(lease_token is null)),
 check((lease_token is null)=(expires_at is null))
);
create table fluid_private.shared_worker_policies (
 slot_id uuid not null references fluid_private.shared_worker_slots(slot_id),
 operation text not null check(length(operation) between 1 and 100),
 policy_identity text not null check(length(policy_identity) between 1 and 200),
 policy jsonb not null check(jsonb_typeof(policy)='object' and octet_length(policy::text)<=32768),
 primary key(slot_id,operation)
);
create function fluid_private.shared_worker_slot_identity_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if (new.slot_id,new.lane,new.slot_index,new.role_name,new.role_oid) is distinct from(old.slot_id,old.lane,old.slot_index,old.role_name,old.role_oid) then
  raise exception 'shared_slot_identity_immutable' using errcode='42501'; end if;
 return new;
end $$;
create trigger shared_worker_slot_identity_immutable before update of slot_id,lane,slot_index,role_name,role_oid
 on fluid_private.shared_worker_slots for each row execute function fluid_private.shared_worker_slot_identity_immutable();
create table fluid_private.shared_job_admissions (
 job_id uuid primary key, owner_id uuid not null, project_id uuid not null,
 lane text not null check(lane in('strategy','naming','logo')), operation text not null,
 input_hash text not null, policy_identity text not null, policy jsonb not null,
 deployment_id text not null, eligibility_epoch bigint not null check(eligibility_epoch>0),
 authority_version smallint not null default 1 check(authority_version=1),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id)
);
create table fluid_private.shared_worker_executions (
 execution_id uuid primary key default gen_random_uuid(), execution_token uuid not null default gen_random_uuid(),
 slot_id uuid not null references fluid_private.shared_worker_slots(slot_id),
 instance_id uuid not null, generation bigint not null, slot_lease_token uuid not null, lane text not null,
 owner_id uuid not null, project_id uuid not null, job_id uuid not null references fluid_private.shared_job_admissions(job_id),
 lease_token uuid not null, operation text not null, policy_identity text not null, deployment_id text not null,
 state text not null default 'active' check(state in('active','observing','closed')),
 created_at timestamptz not null default clock_timestamp(), closed_at timestamptz,
 unique(job_id,lease_token), check((state='closed')=(closed_at is not null))
);
create unique index shared_worker_one_active_slot on fluid_private.shared_worker_executions(slot_id) where state='active';
create index shared_worker_tenant_active on fluid_private.shared_worker_executions(lane,owner_id) where state='active';
create index shared_worker_recovery_page on fluid_private.shared_worker_executions(slot_id,execution_id) where state<>'closed';
create table fluid_private.shared_worker_gateway_context (
 backend_pid integer not null, transaction_id bigint not null, role_name name not null, role_oid oid not null,
 slot_id uuid not null, slot_generation bigint not null, slot_instance_id uuid not null,
 job_id uuid not null, execution_id uuid, mode text not null check(mode in('claim','active','observe')),
 primary key(backend_pid,transaction_id)
);
create function fluid_private.shared_worker_context_closed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from fluid_private.shared_worker_gateway_context where backend_pid=new.backend_pid and transaction_id=new.transaction_id) then
  raise exception 'shared_context_cleanup_required' using errcode='55000'; end if;
 return null;
end $$;
create constraint trigger shared_worker_context_cleanup after insert on fluid_private.shared_worker_gateway_context
 deferrable initially deferred for each row execute function fluid_private.shared_worker_context_closed();

create function fluid_private.shared_account_customer_active(p_owner uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from fluid_private.shared_accounts a join auth.users u on u.id=a.owner_id
  where a.owner_id=p_owner and a.enabled and u.email_confirmed_at is not null
  and u.is_anonymous=false and u.deleted_at is null
  and (u.banned_until is null or u.banned_until<=clock_timestamp())
  and not exists(select 1 from fluid_private.shared_service_actors s where s.auth_user_id=u.id));
$$;
create function fluid_private.refresh_shared_account(p_owner uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 insert into fluid_private.shared_accounts(owner_id,enabled) values(p_owner,exists(select 1 from auth.users where id=p_owner))
 on conflict(owner_id) do update set eligibility_epoch=fluid_private.shared_accounts.eligibility_epoch+1,
 enabled=exists(select 1 from auth.users where id=p_owner),updated_at=clock_timestamp();
end $$;
create function fluid_private.shared_account_auth_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform fluid_private.refresh_shared_account(case when tg_op='DELETE' then old.id else new.id end);
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger embel_shared_account_auth_changed after insert or update of email_confirmed_at,is_anonymous,banned_until,deleted_at or delete
 on auth.users for each row execute function fluid_private.shared_account_auth_changed();
-- Data-only old-account catch-up. Eligibility is re-derived from Auth on every
-- admission; this row is not a cached permission or a runtime readiness claim.
insert into fluid_private.shared_accounts(owner_id) select id from auth.users;
create function public.get_shared_account_enrollment() returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid(); a fluid_private.shared_accounts;
begin
 if o is null or not exists(select 1 from auth.users where id=o) then raise exception 'account_required' using errcode='42501'; end if;
 select * into a from fluid_private.shared_accounts where owner_id=o;
 return jsonb_build_object('version',1,'ownerId',o,'epoch',coalesce(a.eligibility_epoch,0),
  'eligible',fluid_private.shared_account_customer_active(o),'capabilities',jsonb_build_array('home_attachments','identity_transactions','strategy','naming','logo'));
end $$;
create function public.ensure_shared_account_enrollment() returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid();
begin
 if o is null or not exists(select 1 from auth.users where id=o) then raise exception 'account_required' using errcode='42501'; end if;
 insert into fluid_private.shared_accounts(owner_id) values(o) on conflict do nothing;
 return public.get_shared_account_enrollment();
end $$;

-- Qualification is checked on each entry, not just when a slot is configured.
-- PG17's trusted database-owner ADMIN-only creation edge is permitted, but it
-- cannot SET/INHERIT the slot; no outgoing or foreign incoming membership exists.
create function fluid_private.shared_worker_role_safe(p_name name,p_oid oid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from pg_catalog.pg_roles r where r.oid=p_oid and r.rolname=p_name
  and r.rolcanlogin and not r.rolsuper and not r.rolinherit and not r.rolcreaterole and not r.rolcreatedb
  and not r.rolreplication and not r.rolbypassrls and r.rolconnlimit=4
  and r.rolname::text ~ '^embel_shared_(strategy|naming|logo)_[a-z0-9_]{1,30}$'
  and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid
   or (m.roleid=r.oid and not(m.member=(select oid from pg_catalog.pg_roles where rolname='postgres')
    and m.admin_option and not m.inherit_option and not m.set_option)))
  and not exists(select 1 from pg_catalog.pg_class where relowner=r.oid)
  and not exists(select 1 from pg_catalog.pg_proc where proowner=r.oid)
  and not exists(select 1 from pg_catalog.pg_namespace where nspowner=r.oid)
  and not has_database_privilege(r.oid,current_database(),'CREATE')
  and not has_schema_privilege(r.oid,'public','CREATE') and not has_schema_privilege(r.oid,'fluid_private','CREATE')
  and not has_schema_privilege(r.oid,'fluid_private','USAGE')
  and not exists(select 1 from pg_catalog.pg_proc f join pg_catalog.pg_namespace n on n.oid=f.pronamespace
   where n.nspname='public' and f.prosecdef and has_function_privilege(r.oid,f.oid,'EXECUTE')
   and not exists(select 1 from unnest(array[
    'public.subscription_worker_owner()','public.subscription_worker_can_read_step(uuid,uuid)',
    'public.api_text_worker_owner()','public.api_text_worker_can_read_step(uuid,uuid)',
    'public.shared_worker_pool_configuration()','public.claim_shared_worker_slot(uuid,uuid,text,integer)',
    'public.renew_shared_worker_slot(jsonb,integer)','public.release_shared_worker_slot(jsonb)','public.fence_shared_worker_slot(jsonb)',
    'public.read_shared_worker_executions(jsonb)','public.read_shared_worker_execution_page(jsonb,uuid,integer)',
    case when r.rolname::text like 'embel_shared_strategy_%' then 'public.shared_strategy_worker_action(jsonb,jsonb,text,jsonb)' end,
    case when r.rolname::text like 'embel_shared_strategy_%' then 'public.list_shared_strategy_dispatches(jsonb,integer)' end,
    case when r.rolname::text like 'embel_shared_naming_%' then 'public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)' end,
    case when r.rolname::text like 'embel_shared_logo_%' then 'public.shared_logo_worker_action(jsonb,jsonb,text,jsonb)' end
   ]) allowed(signature) where to_regprocedure(allowed.signature)=f.oid))
  and not exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname in('public','fluid_private','auth','storage') and c.relkind in('r','p','v','m','f','S')
    and case when c.relkind='S' then has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
     else has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') or has_table_privilege(r.oid,c.oid,'DELETE,TRUNCATE,TRIGGER') end));
$$;
create function fluid_private.shared_worker_slot_json(s fluid_private.shared_worker_slots) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('version',1,'slotId',s.slot_id,'instanceId',s.instance_id,'lane',s.lane,'generation',s.generation,
  'leaseToken',s.lease_token,'expiresAt',s.expires_at,'roleName',s.role_name,'roleOid',s.role_oid::bigint);
$$;
create function fluid_private.shared_worker_execution_json(e fluid_private.shared_worker_executions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('version',1,'executionId',e.execution_id,'executionToken',e.execution_token,'slotId',e.slot_id,
 'instanceId',e.instance_id,'generation',e.generation,'lane',e.lane,'ownerId',e.owner_id,'projectId',e.project_id,'jobId',e.job_id,
 'leaseToken',e.lease_token,'operation',e.operation,'policyIdentity',e.policy_identity,'deploymentId',e.deployment_id);
$$;
create function public.shared_worker_pool_configuration() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r oid;
begin
 select oid into r from pg_catalog.pg_roles where rolname=session_user;
 if not exists(select 1 from fluid_private.shared_worker_slots where role_name=session_user and role_oid=r and enabled)
  or not fluid_private.shared_worker_role_safe(session_user,r) then raise exception 'shared_slot_denied' using errcode='42501'; end if;
 if (select min(tenant_active_limit) is distinct from max(tenant_active_limit) from fluid_private.shared_worker_slots where enabled) then
  raise exception 'shared_pool_tenant_limits_inconsistent' using errcode='55000'; end if;
 return (select jsonb_build_object('version',1,'tenantScope','per_lane','slotIds',coalesce(jsonb_agg(slot_id order by slot_id),'[]'::jsonb),
  'globalConcurrency',count(*),'maxPerTenantPerLane',coalesce(max(tenant_active_limit),0))
  from fluid_private.shared_worker_slots where enabled);
end $$;
create function fluid_private.lock_shared_worker_slot(p_lease jsonb,p_fresh boolean default true) returns fluid_private.shared_worker_slots
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots; r oid;
begin
 if jsonb_typeof(p_lease) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_lease))<>9
  or not p_lease?&array['version','slotId','instanceId','lane','generation','leaseToken','expiresAt','roleName','roleOid']
  or p_lease->'version'<>'1'::jsonb then raise exception 'invalid_shared_slot_lease' using errcode='22023'; end if;
 select oid into r from pg_catalog.pg_roles where rolname=session_user;
 select * into s from fluid_private.shared_worker_slots where slot_id=(p_lease->>'slotId')::uuid for update;
 if not found or (s.role_name,s.role_oid) is distinct from(session_user::name,r)
  or not fluid_private.shared_worker_role_safe(session_user,r)
  or (s.role_name::text,s.role_oid::bigint,s.lane) is distinct from(p_lease->>'roleName',(p_lease->>'roleOid')::bigint,p_lease->>'lane')
  or (s.instance_id,s.generation,s.lease_token) is distinct from((p_lease->>'instanceId')::uuid,(p_lease->>'generation')::bigint,(p_lease->>'leaseToken')::uuid)
  or p_fresh and (not s.enabled or s.expires_at<=clock_timestamp()) then
  raise exception 'shared_slot_fenced' using errcode='42501'; end if;
 return s;
end $$;
create function public.claim_shared_worker_slot(p_slot uuid,p_instance uuid,p_deployment text,p_seconds integer default 60) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots; r oid;
begin
 if p_instance is null or p_seconds is null or p_seconds not between 5 and 120 then raise exception 'invalid_shared_slot_claim' using errcode='22023'; end if;
 select oid into r from pg_catalog.pg_roles where rolname=session_user;
 select * into s from fluid_private.shared_worker_slots where slot_id=p_slot for update;
 if not found or not s.enabled or (s.role_name,s.role_oid,s.deployment_id) is distinct from(session_user::name,r,p_deployment)
  or not fluid_private.shared_worker_role_safe(session_user,r) then raise exception 'shared_slot_denied' using errcode='42501'; end if;
 if s.expires_at>clock_timestamp() then
  raise exception 'shared_slot_held' using errcode='40001';
 else
  if s.generation>=9007199254740991 then raise exception 'shared_slot_generation_exhausted' using errcode='55000'; end if;
  s.generation:=s.generation+1; s.instance_id:=p_instance; s.lease_token:=gen_random_uuid();
  update fluid_private.shared_worker_executions set state='observing' where slot_id=s.slot_id and state='active';
 end if;
 update fluid_private.shared_worker_slots set instance_id=s.instance_id,generation=s.generation,lease_token=s.lease_token,
  expires_at=clock_timestamp()+make_interval(secs=>p_seconds) where slot_id=s.slot_id returning * into s;
 return fluid_private.shared_worker_slot_json(s);
end $$;
create function public.renew_shared_worker_slot(p_lease jsonb,p_seconds integer default 60) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots;
begin
 if p_seconds is null or p_seconds not between 5 and 120 then raise exception 'invalid_shared_slot_ttl' using errcode='22023'; end if;
 s:=fluid_private.lock_shared_worker_slot(p_lease,true);
 update fluid_private.shared_worker_slots set expires_at=clock_timestamp()+make_interval(secs=>p_seconds) where slot_id=s.slot_id returning * into s;
 return fluid_private.shared_worker_slot_json(s);
end $$;
create function public.release_shared_worker_slot(p_lease jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots;
begin
 s:=fluid_private.lock_shared_worker_slot(p_lease,false);
 if exists(select 1 from fluid_private.shared_worker_executions where slot_id=s.slot_id and state='active') then
  raise exception 'shared_slot_not_drained' using errcode='55000'; end if;
 update fluid_private.shared_worker_slots set instance_id=null,lease_token=null,expires_at=null where slot_id=s.slot_id;
 return true;
end $$;
-- Fatal local engine/journal failure withdraws admission immediately. Expiry
-- fences future dispatch, while issued observations retain their frozen scope.
create function public.fence_shared_worker_slot(p_lease jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots;
begin
 s:=fluid_private.lock_shared_worker_slot(p_lease,false);
 update fluid_private.shared_worker_slots set expires_at=clock_timestamp() where slot_id=s.slot_id;
 update fluid_private.shared_worker_executions set state='observing' where slot_id=s.slot_id and state='active';
 return true;
end $$;

create function fluid_private.shared_job_admission_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'shared_admission_immutable' using errcode='42501'; end $$;
create trigger shared_job_admission_immutable before update or delete on fluid_private.shared_job_admissions
 for each row execute function fluid_private.shared_job_admission_immutable();
create function fluid_private.shared_worker_admission_active(p_job uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from fluid_private.shared_job_admissions a join fluid_private.shared_accounts c on c.owner_id=a.owner_id
  where a.job_id=p_job and a.eligibility_epoch=c.eligibility_epoch and fluid_private.shared_account_customer_active(a.owner_id));
$$;
create function fluid_private.admit_shared_worker_job(p_job uuid,p_lane text,p_policy_identity text,p_deployment text,p_policy jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare j public.jobs; a fluid_private.shared_job_admissions; v_epoch bigint;
begin
 select * into j from public.jobs where id=p_job for update;
 perform 1 from auth.users where id=j.owner_id for share;
 if not found or j.owner_id is distinct from auth.uid() or not fluid_private.shared_account_customer_active(j.owner_id)
  or j.state<>'queued' or j.lease_token is not null then raise exception 'shared_admission_denied' using errcode='42501'; end if;
 if not exists(select 1 from fluid_private.shared_worker_slots s join fluid_private.shared_worker_policies p using(slot_id)
  where s.lane=p_lane and s.enabled and s.deployment_id=p_deployment and p.operation=j.operation
  and p.policy_identity=p_policy_identity and p.policy=p_policy) then raise exception 'shared_policy_unavailable' using errcode='55000'; end if;
 select eligibility_epoch into strict v_epoch from fluid_private.shared_accounts where owner_id=j.owner_id;
 select * into a from fluid_private.shared_job_admissions where job_id=j.id;
 if found then
  if (a.owner_id,a.project_id,a.lane,a.operation,a.input_hash,a.policy_identity,a.policy,a.deployment_id,a.eligibility_epoch)
   is distinct from(j.owner_id,j.project_id,p_lane,j.operation,j.input_hash,p_policy_identity,p_policy,p_deployment,v_epoch) then
   raise exception 'shared_admission_immutable' using errcode='42501'; end if;
  return;
 end if;
 insert into fluid_private.shared_job_admissions(job_id,owner_id,project_id,lane,operation,input_hash,policy_identity,policy,deployment_id,eligibility_epoch)
 values(j.id,j.owner_id,j.project_id,p_lane,j.operation,j.input_hash,p_policy_identity,p_policy,p_deployment,v_epoch);
end $$;
create function fluid_private.shared_worker_claimable(p_lease jsonb,p_job uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots;
begin
 s:=fluid_private.lock_shared_worker_slot(p_lease,true);
 return exists(select 1 from fluid_private.shared_job_admissions a join public.jobs j on j.id=a.job_id
  join fluid_private.shared_worker_policies p on p.slot_id=s.slot_id and p.operation=a.operation
  where a.job_id=p_job and (a.lane,a.deployment_id,a.operation,a.policy_identity,a.policy)=(s.lane,s.deployment_id,j.operation,p.policy_identity,p.policy)
  and (j.owner_id,j.project_id,j.input_hash)=(a.owner_id,a.project_id,a.input_hash)
  and j.state in('queued','needs_reconciliation') and j.lease_token is null and fluid_private.shared_worker_admission_active(j.id)
  and not exists(select 1 from fluid_private.shared_worker_executions where (slot_id=s.slot_id and state='active') or (job_id=j.id and state<>'closed'))
  and (select count(*) from fluid_private.shared_worker_executions where lane=s.lane and owner_id=j.owner_id and state='active')<s.tenant_active_limit);
end $$;
create function fluid_private.enter_shared_worker_claim_context(p_lease jsonb,p_job uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots; j public.jobs;
begin
 if exists(select 1 from fluid_private.shared_worker_gateway_context where backend_pid=pg_backend_pid() and transaction_id=txid_current()) then raise exception 'nested_shared_context' using errcode='42501'; end if;
 s:=fluid_private.lock_shared_worker_slot(p_lease,true);
 select * into j from public.jobs where id=p_job for update;
 if not found then raise exception 'shared_job_denied' using errcode='42501'; end if;
 perform 1 from auth.users where id=j.owner_id for share;
 perform pg_advisory_xact_lock(hashtextextended('embel-shared:'||s.lane||':'||j.owner_id::text,0));
 if not fluid_private.shared_worker_claimable(p_lease,p_job) then raise exception 'shared_job_denied' using errcode='42501'; end if;
 insert into fluid_private.shared_worker_gateway_context values(pg_backend_pid(),txid_current(),session_user,s.role_oid,s.slot_id,s.generation,s.instance_id,j.id,null,'claim');
end $$;
create function fluid_private.bind_shared_worker_execution(p_lease jsonb,p_job uuid) returns fluid_private.shared_worker_executions
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots; a fluid_private.shared_job_admissions; j public.jobs; e fluid_private.shared_worker_executions;
begin
 s:=fluid_private.lock_shared_worker_slot(p_lease,true);
 select * into j from public.jobs where id=p_job for update;
 perform 1 from auth.users where id=j.owner_id for share;
 select * into a from fluid_private.shared_job_admissions where job_id=p_job;
 if a.job_id is null or (a.lane,a.deployment_id,a.owner_id,a.project_id,a.operation,a.input_hash)
  is distinct from(s.lane,s.deployment_id,j.owner_id,j.project_id,j.operation,j.input_hash)
  or not fluid_private.shared_worker_admission_active(j.id)
  or j.lease_token is null or j.lease_expires_at<=clock_timestamp() or j.state<>'running'
  or not exists(select 1 from fluid_private.shared_worker_policies p where p.slot_id=s.slot_id and p.operation=j.operation and p.policy_identity=a.policy_identity and p.policy=a.policy) then
  raise exception 'shared_execution_denied' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('embel-shared:'||s.lane||':'||j.owner_id::text,0));
 select * into e from fluid_private.shared_worker_executions where job_id=j.id and lease_token=j.lease_token;
 if found then
  if (e.slot_id,e.instance_id,e.generation,e.state) is distinct from(s.slot_id,s.instance_id,s.generation,'active'::text) then raise exception 'shared_execution_fenced' using errcode='42501'; end if;
  return e;
 end if;
 if exists(select 1 from fluid_private.shared_worker_executions where (slot_id=s.slot_id and state='active') or (job_id=j.id and state<>'closed'))
  or (select count(*) from fluid_private.shared_worker_executions where lane=s.lane and owner_id=j.owner_id and state='active')>=s.tenant_active_limit then
  raise exception 'shared_capacity_held' using errcode='40001'; end if;
 insert into fluid_private.shared_worker_executions(slot_id,instance_id,generation,slot_lease_token,lane,owner_id,project_id,job_id,lease_token,operation,policy_identity,deployment_id)
 values(s.slot_id,s.instance_id,s.generation,s.lease_token,s.lane,j.owner_id,j.project_id,j.id,j.lease_token,j.operation,a.policy_identity,s.deployment_id) returning * into e;
 return e;
end $$;
create function fluid_private.shared_worker_execution(p_lease jsonb,p_execution jsonb,p_mode text) returns fluid_private.shared_worker_executions
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots; e fluid_private.shared_worker_executions; a fluid_private.shared_job_admissions; j public.jobs; r oid; v_slot uuid;
begin
 if p_mode not in('active','observe') or p_mode is null or jsonb_typeof(p_execution) is distinct from 'object' then raise exception 'invalid_shared_execution' using errcode='22023'; end if;
 select oid into r from pg_catalog.pg_roles where rolname=session_user;
 select slot_id into v_slot from fluid_private.shared_worker_executions where execution_id=(p_execution->>'executionId')::uuid;
 select * into s from fluid_private.shared_worker_slots where slot_id=v_slot for update;
 select * into e from fluid_private.shared_worker_executions where execution_id=(p_execution->>'executionId')::uuid for update;
 if not found or fluid_private.shared_worker_execution_json(e) is distinct from p_execution or e.state='closed' then raise exception 'shared_execution_denied' using errcode='42501'; end if;
 if (s.role_name,s.role_oid) is distinct from(session_user::name,r) or not fluid_private.shared_worker_role_safe(session_user,r) then raise exception 'shared_slot_denied' using errcode='42501'; end if;
 -- Current lease permits recovery; original exact historical lease permits only
 -- observation of issued work after takeover, never a new dispatch.
 if p_mode='active' then
  s:=fluid_private.lock_shared_worker_slot(p_lease,true);
  if (e.slot_id,e.instance_id,e.generation,e.state) is distinct from(s.slot_id,s.instance_id,s.generation,'active'::text) then raise exception 'shared_execution_fenced' using errcode='42501'; end if;
 else
  if p_lease->'version' is distinct from '1'::jsonb or not coalesce(((p_lease->>'slotId')::uuid=s.slot_id and p_lease->>'roleName'=s.role_name::text and (p_lease->>'roleOid')::oid=s.role_oid
   and p_lease->>'lane'=s.lane and (((p_lease->>'instanceId')::uuid,(p_lease->>'generation')::bigint,(p_lease->>'leaseToken')::uuid)=(s.instance_id,s.generation,s.lease_token)
    or ((p_lease->>'instanceId')::uuid,(p_lease->>'generation')::bigint,(p_lease->>'leaseToken')::uuid)=(e.instance_id,e.generation,e.slot_lease_token))),false) then
   raise exception 'shared_observation_fenced' using errcode='42501'; end if;
 end if;
 select * into a from fluid_private.shared_job_admissions where job_id=e.job_id;
 select * into j from public.jobs where id=e.job_id for update;
 if p_mode='active' then perform 1 from auth.users where id=e.owner_id for share; end if;
 if (j.owner_id,j.project_id,j.operation,j.input_hash) is distinct from(e.owner_id,e.project_id,e.operation,a.input_hash)
  or (a.owner_id,a.project_id,a.lane,a.operation,a.policy_identity,a.deployment_id) is distinct from(e.owner_id,e.project_id,e.lane,e.operation,e.policy_identity,e.deployment_id)
  or (j.lease_token is not null and j.lease_token<>e.lease_token) then raise exception 'shared_job_scope_changed' using errcode='42501'; end if;
 if p_mode='active' and (not fluid_private.shared_worker_admission_active(e.job_id)
  or j.state<>'running' or j.lease_token is distinct from e.lease_token or j.lease_expires_at<=clock_timestamp()
  or not exists(select 1 from fluid_private.shared_worker_policies p where p.slot_id=s.slot_id and p.operation=e.operation and p.policy_identity=e.policy_identity and p.policy=a.policy)) then
  raise exception 'shared_dispatch_closed' using errcode='42501'; end if;
 return e;
end $$;
create function fluid_private.enter_shared_worker_context(p_lease jsonb,p_execution jsonb,p_mode text) returns void
language plpgsql security definer set search_path='' as $$
declare e fluid_private.shared_worker_executions; r oid;
begin
 if exists(select 1 from fluid_private.shared_worker_gateway_context where backend_pid=pg_backend_pid() and transaction_id=txid_current()) then raise exception 'nested_shared_context' using errcode='42501'; end if;
 e:=fluid_private.shared_worker_execution(p_lease,p_execution,p_mode);
 select oid into strict r from pg_catalog.pg_roles where rolname=session_user;
 insert into fluid_private.shared_worker_gateway_context values(pg_backend_pid(),txid_current(),session_user,r,e.slot_id,e.generation,e.instance_id,e.job_id,e.execution_id,p_mode);
end $$;
create function fluid_private.leave_shared_worker_context() returns void
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 delete from fluid_private.shared_worker_gateway_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and role_name=session_user;
 get diagnostics n=row_count; if n<>1 then raise exception 'shared_context_lost' using errcode='42501'; end if;
end $$;
create function fluid_private.shared_worker_context_job(p_lane text) returns uuid
language sql stable security definer set search_path='' as $$
 select c.job_id from fluid_private.shared_worker_gateway_context c join fluid_private.shared_worker_slots s using(slot_id)
  join pg_catalog.pg_roles r on r.rolname=session_user and r.oid=c.role_oid
  join fluid_private.shared_job_admissions a on a.job_id=c.job_id and a.lane=s.lane
  join public.jobs j on (j.id,j.owner_id,j.project_id,j.operation,j.input_hash)=(a.job_id,a.owner_id,a.project_id,a.operation,a.input_hash)
 where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.role_name=session_user
  and (s.role_name,s.role_oid)=(c.role_name,c.role_oid) and s.lane=p_lane;
$$;
create function fluid_private.shared_worker_context_owner(p_lane text) returns uuid
language sql stable security definer set search_path='' as $$
 select owner_id from fluid_private.shared_job_admissions where job_id=fluid_private.shared_worker_context_job(p_lane);
$$;
create function fluid_private.shared_worker_context_mode(p_lane text) returns text
language sql stable security definer set search_path='' as $$
 select mode from fluid_private.shared_worker_gateway_context where backend_pid=pg_backend_pid() and transaction_id=txid_current()
  and role_name=session_user and job_id=fluid_private.shared_worker_context_job(p_lane);
$$;
create function fluid_private.shared_worker_context_execution(p_lane text) returns fluid_private.shared_worker_executions
language sql stable security definer set search_path='' as $$
 select e from fluid_private.shared_worker_gateway_context c join fluid_private.shared_worker_executions e using(execution_id)
 where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.role_name=session_user
  and e.job_id=fluid_private.shared_worker_context_job(p_lane);
$$;

-- Preserve the reviewed legacy body under a private name. Only an exact private
-- observation context may settle an already-issued call after lease expiry.
-- Both this common helper and its backup retain the predecessor's exact ACL;
-- the fixed slot role has no private-schema USAGE or direct helper grants.
do $$declare fn record; begin
 select p.*,l.lanname into fn from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
 where p.oid=to_regprocedure('fluid_private.lock_leased_job(uuid,uuid)');
 if not found or fn.proowner<>(select oid from pg_catalog.pg_roles where rolname='postgres') or fn.prosecdef
  or fn.lanname<>'plpgsql' or fn.proconfig is distinct from array['search_path=""']
  or encode(sha256(convert_to(fn.prosrc,'UTF8')),'hex')<>'04a3a277b84fb5bad04dd9bff328fa7dcec72d026aa9c93e852b15de5de2508f' then
  raise exception 'shared_worker_lock_predecessor_mismatch' using errcode='55000'; end if;
end $$;
alter function fluid_private.lock_leased_job(uuid,uuid) rename to shared_worker_legacy_lock_leased_job_v1;
create function fluid_private.lock_leased_job(p_job_id uuid,p_lease_token uuid) returns public.jobs
language plpgsql set search_path='' as $$
declare c fluid_private.shared_worker_gateway_context; e fluid_private.shared_worker_executions; j public.jobs;
begin
 if session_user::text !~ '^embel_shared_(strategy|naming|logo)_[a-z0-9_]{1,30}$' then
  return fluid_private.shared_worker_legacy_lock_leased_job_v1(p_job_id,p_lease_token);
 end if;
 select * into c from fluid_private.shared_worker_gateway_context where backend_pid=pg_backend_pid() and transaction_id=txid_current()
  and role_name=session_user and job_id=p_job_id and mode='observe';
 if found then
  e:=fluid_private.shared_worker_context_execution((select lane from fluid_private.shared_worker_slots where slot_id=c.slot_id));
  if e.execution_id is null or e.lease_token is distinct from p_lease_token then raise exception 'shared_observation_lease_mismatch' using errcode='42501'; end if;
  select * into j from public.jobs where id=e.job_id and owner_id=e.owner_id and project_id=e.project_id for update;
  if not found or (j.lease_token is not null and j.lease_token<>e.lease_token) then raise exception 'shared_observation_lease_mismatch' using errcode='42501'; end if;
  return j;
 end if;
 return fluid_private.shared_worker_legacy_lock_leased_job_v1(p_job_id,p_lease_token);
end $$;
do $$declare gr record; begin
 for gr in select distinct x.grantee from pg_catalog.pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
  where p.oid='fluid_private.lock_leased_job(uuid,uuid)'::regprocedure and x.grantee<>p.proowner loop
  execute format('revoke all on function fluid_private.lock_leased_job(uuid,uuid) from %s',case when gr.grantee=0 then 'public' else quote_ident(pg_get_userbyid(gr.grantee)) end);
 end loop;
 for gr in select x.grantee,x.is_grantable from pg_catalog.pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
  where p.oid='fluid_private.shared_worker_legacy_lock_leased_job_v1(uuid,uuid)'::regprocedure and x.grantee<>p.proowner loop
  execute format('grant execute on function fluid_private.lock_leased_job(uuid,uuid) to %s %s',
   case when gr.grantee=0 then 'public' else quote_ident(pg_get_userbyid(gr.grantee)) end,case when gr.is_grantable then 'with grant option' else '' end);
 end loop;
end $$;
create function public.read_shared_worker_executions(p_lease jsonb) returns setof jsonb
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots; e fluid_private.shared_worker_executions; j public.jobs;
begin
 s:=fluid_private.lock_shared_worker_slot(p_lease,true);
 for e in select * from fluid_private.shared_worker_executions where slot_id=s.slot_id and state<>'closed' order by execution_id limit 25 loop
  select * into strict j from public.jobs where id=e.job_id;
  return next jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'job',to_jsonb(j),
   'mode',case when e.generation=s.generation and e.instance_id=s.instance_id and e.state='active'
    and fluid_private.shared_worker_admission_active(e.job_id) and j.state='running' and j.lease_expires_at>clock_timestamp() then 'active' else 'observe' end);
 end loop;
end $$;
create function public.read_shared_worker_execution_page(p_lease jsonb,p_after uuid default null,p_limit integer default 25) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots; e fluid_private.shared_worker_executions; j public.jobs;
 items jsonb:='[]'::jsonb; cursor_id uuid; has_more boolean:=false; n integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'invalid_shared_recovery_limit' using errcode='22023'; end if;
 s:=fluid_private.lock_shared_worker_slot(p_lease,true);
 for e in select * from fluid_private.shared_worker_executions where slot_id=s.slot_id and state<>'closed'
  and (p_after is null or execution_id>p_after) order by execution_id limit p_limit+1 loop
  n:=n+1; if n>p_limit then has_more:=true; exit; end if;
  select * into strict j from public.jobs where id=e.job_id;
  items:=items||jsonb_build_array(jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'job',to_jsonb(j),
   'mode',case when e.generation=s.generation and e.instance_id=s.instance_id and e.state='active'
    and fluid_private.shared_worker_admission_active(e.job_id) and j.state='running' and j.lease_expires_at>clock_timestamp() then 'active' else 'observe' end));
  cursor_id:=e.execution_id;
 end loop;
 return jsonb_build_object('version',1,'items',items,'nextCursor',case when has_more then cursor_id else null end);
end $$;
create function fluid_private.close_shared_worker_execution(p_lease jsonb,p_execution jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare e fluid_private.shared_worker_executions; j public.jobs;
begin
 e:=fluid_private.shared_worker_execution(p_lease,p_execution,'observe');
 select * into strict j from public.jobs where id=e.job_id for update;
 if j.state not in('succeeded','failed','cancelled','partial') or j.lease_token is not null
  or exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then
  raise exception 'shared_execution_not_drained' using errcode='55000'; end if;
 update fluid_private.shared_worker_executions set state='closed',closed_at=clock_timestamp() where execution_id=e.execution_id;
end $$;
-- Release current scheduling capacity only after a database-proven observation
-- state. This neither ends a provider request nor resolves/refunds its outcome.
create function fluid_private.park_shared_worker_execution(p_lease jsonb,p_execution jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare e fluid_private.shared_worker_executions; j public.jobs;
begin
 e:=fluid_private.shared_worker_execution(p_lease,p_execution,'observe');
 if e.state='observing' then return; end if;
 select * into strict j from public.jobs where id=e.job_id for update;
 if j.state<>'needs_reconciliation' and fluid_private.shared_worker_admission_active(e.job_id)
  and not(j.state in('succeeded','failed','cancelled','partial')
   and exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous'))) then
  raise exception 'shared_execution_not_observable' using errcode='55000'; end if;
 update fluid_private.shared_worker_executions set state='observing' where execution_id=e.execution_id and state='active';
end $$;

-- Scrub inherited default ACLs on precisely this packet's new objects. Do not
-- mutate global defaults, predecessor functions or pre-existing customer data.
do $$declare obj record; gr record; begin
 for obj in select c.oid,c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='fluid_private' and c.relname in('shared_accounts','shared_service_actors','shared_worker_slots','shared_worker_policies','shared_job_admissions','shared_worker_executions','shared_worker_gateway_context') loop
  execute format('alter table fluid_private.%I enable row level security',obj.relname);
  execute format('alter table fluid_private.%I force row level security',obj.relname);
  for gr in select distinct x.grantee from pg_catalog.pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x where c.oid=obj.oid and x.grantee<>c.relowner loop
   execute format('revoke all on table fluid_private.%I from %s',obj.relname,case when gr.grantee=0 then 'public' else quote_ident(pg_get_userbyid(gr.grantee)) end);
  end loop;
 end loop;
 for obj in select p.oid,p.oid::regprocedure::text signature from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname in('public','fluid_private') and p.proname<>'shared_worker_legacy_lock_leased_job_v1'
   and (p.proname like '%shared_worker%' or p.proname in('shared_account_customer_active','shared_service_actor_classification','refresh_shared_account','shared_account_auth_changed','get_shared_account_enrollment','ensure_shared_account_enrollment','shared_job_admission_immutable')) loop
  for gr in select distinct x.grantee from pg_catalog.pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where p.oid=obj.oid and x.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s',obj.signature,case when gr.grantee=0 then 'public' else quote_ident(pg_get_userbyid(gr.grantee)) end);
  end loop;
 end loop;
end $$;
grant execute on function public.get_shared_account_enrollment(),public.ensure_shared_account_enrollment() to authenticated;
commit;
