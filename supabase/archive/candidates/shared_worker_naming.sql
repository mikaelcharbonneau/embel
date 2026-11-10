-- UNAPPLIED shared Naming lane. Requires baseline migrations + shared_worker_pool.
-- Fixed restricted slot identities; no LOGIN creation, credentials, grants,
-- allowance activation, existing-input rewrite or provider call.
begin;
do $guard$
declare signature text; expected text;
begin
 if current_user<>'postgres' or to_regclass('fluid_private.shared_worker_slots') is null
  or to_regclass('fluid_private.shared_naming_slot_configuration') is not null then raise exception 'shared_naming_install_prerequisite'; end if;
 for signature,expected in values
 ('fluid_private.naming_brain_worker_owner()','3ae842011463bff6bfd45c1b74105225'),
 ('fluid_private.naming_brain_run_worker(fluid_private.naming_brain_runs)','a74523bd25c58d94a3d36d9538613300'),
 ('fluid_private.naming_brain_ready(fluid_private.naming_brain_runs,text)','857e5dc858814b015be59348144a68c4'),
 ('fluid_private.naming_brain_execution_authority(uuid)','ecb8b3afba205848b1c112a9dc1d8dd3'),
 ('fluid_private.naming_brain_paid_paused(uuid,uuid,uuid)','23a25e58d375a4b3c0ae2f0c10930117'),
 ('fluid_private.naming_worker_claim_core(text,text,integer)','4e300b9217f94229c6f9c87e7ea5f0fb'),
 ('fluid_private.hosted_naming_step_authority(uuid)','297560da2358ba20e620c2d3fc602e50'),
 ('fluid_private.local_naming_previous_worker_action(uuid,uuid,text,jsonb)','5ed3897da300a27c652321131a5dbbfc'),
 ('fluid_private.local_naming_progressive_action(uuid,uuid,text,jsonb)','31f892f36933444ec602ddc2bee98f70'),
 ('fluid_private.naming_brain_paid_resume(fluid_private.naming_brain_runs)','028e73fb07391e4d665eee6d617598af'),
 ('public.ensure_naming_brain_run(uuid,jsonb)','bc07eeb8c7bc321bb1572dd029b547a9') loop
  if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(signature) and md5(p.prosrc)=expected
   and p.proowner=(select oid from pg_roles where rolname='postgres') and p.proconfig=array['search_path=""'] and not p.proleakproof) then
   raise exception 'shared_naming_predecessor_mismatch: %',signature;
  end if;
 end loop;
end $guard$;
create table fluid_private.shared_naming_slot_configuration(
 slot_id uuid primary key references fluid_private.shared_worker_slots(slot_id),
 readiness_fingerprint jsonb not null check(jsonb_typeof(readiness_fingerprint)='object'
  and readiness_fingerprint->'version'='1'::jsonb
  and readiness_fingerprint->>'normalizer'='naming-preferences-v1:nfc-lower-nfc'
  and readiness_fingerprint->>'implementationHash'='7108319323898692a388fcf17cb542509583288b0d4b05d7384f8c5b707aeb01'),
 ready_until timestamptz
);
create table fluid_private.shared_naming_request_context(
 backend_pid integer not null,transaction_id bigint not null,owner_id uuid not null,project_id uuid not null,
 slot_id uuid not null references fluid_private.shared_worker_slots(slot_id),mode text not null check(mode in('admit','preferences')),
 primary key(backend_pid,transaction_id)
);
-- Logical customer policy membership is independent of a slot credential.
-- The pilot row is retained only for the unchanged historical input structure.
create table fluid_private.shared_naming_owner_bindings(
 binding_id uuid primary key default gen_random_uuid(),owner_id uuid not null references auth.users(id),
 binding_revision bigint not null default 1 check(binding_revision>0),predecessor_id uuid,
 pilot_id uuid not null references fluid_private.naming_brain_pilots(id),
 policy_identity text not null,policy jsonb not null,deployment_id text not null,readiness_fingerprint jsonb not null,
 binding_version integer not null default 1 check(binding_version=1),legacy_authority_sha256 text,approval_id uuid unique,
 check((legacy_authority_sha256 is null)=(approval_id is null)),
 check(legacy_authority_sha256 is null or legacy_authority_sha256~'^[a-f0-9]{64}$'),
 unique(owner_id,binding_revision),unique(owner_id,binding_id),unique(predecessor_id),
 foreign key(owner_id,predecessor_id) references fluid_private.shared_naming_owner_bindings(owner_id,binding_id),
 check((binding_revision=1)=(predecessor_id is null))
);
-- Current authority is a projection over append-only revisions. A normal
-- deployment can add an approved successor without rewriting any predecessor.
create index shared_naming_current_binding on fluid_private.shared_naming_owner_bindings(owner_id,binding_revision desc);
create view fluid_private.shared_naming_owners as
 select distinct on(owner_id) owner_id,pilot_id,policy_identity,policy,deployment_id,readiness_fingerprint,
 binding_version,legacy_authority_sha256,approval_id,binding_id,binding_revision
 from fluid_private.shared_naming_owner_bindings order by owner_id,binding_revision desc;
create trigger shared_naming_owner_immutable before update or delete on fluid_private.shared_naming_owner_bindings
 for each row execute function fluid_private.api_text_admission_immutable();
alter table fluid_private.shared_naming_slot_configuration enable row level security;
alter table fluid_private.shared_naming_slot_configuration force row level security;
alter table fluid_private.shared_naming_request_context enable row level security;
alter table fluid_private.shared_naming_request_context force row level security;
alter table fluid_private.shared_naming_owner_bindings enable row level security;
alter table fluid_private.shared_naming_owner_bindings force row level security;


-- Empty, DB-owner-authored approval records are the only existing-owner bridge.
-- No runtime principal can author or activate these records. The selected slot
-- qualifies a logical future policy, never a new customer credential/process.
create table fluid_private.shared_naming_adoption_approvals(
 approval_id uuid primary key,owner_id uuid not null references auth.users(id),
 pilot_id uuid not null references fluid_private.naming_brain_pilots(id),
 legacy_authority_sha256 text not null check(legacy_authority_sha256~'^[a-f0-9]{64}$'),
 expected_prior_binding uuid,expected_prior_revision bigint not null default 0 check(expected_prior_revision>=0),
 check((expected_prior_revision=0)=(expected_prior_binding is null)),
 foreign key(owner_id,expected_prior_binding) references fluid_private.shared_naming_owner_bindings(owner_id,binding_id),
 slot_id uuid not null references fluid_private.shared_worker_slots(slot_id),role_name name not null,role_oid oid not null,
 deployment_id text not null,policy_identity text not null,policy jsonb not null,readiness_fingerprint jsonb not null,
 approval_receipt text not null check(length(approval_receipt) between 16 and 256),expires_at timestamptz not null
);
create trigger shared_naming_adoption_approval_immutable before update or delete on fluid_private.shared_naming_adoption_approvals
 for each row execute function fluid_private.api_text_admission_immutable();
alter table fluid_private.shared_naming_adoption_approvals enable row level security;
alter table fluid_private.shared_naming_adoption_approvals force row level security;
-- Authority only: heartbeat, enabled, allowance, counters and settlement updates
-- must not invalidate a captured historical principal or the future binding.
create function fluid_private.shared_naming_pilot_authority(p fluid_private.naming_brain_pilots) returns text
language sql immutable set search_path='' as $$
 select encode(sha256(convert_to(jsonb_build_object('id',p.id,'ownerId',p.owner_id,'roleName',p.role_name,
 'roleOid',p.role_oid,'deploymentId',p.deployment_id,'policy',p.policy,'readinessFingerprint',p.readiness_fingerprint)::text,'UTF8')),'hex');
$$;
create function fluid_private.shared_naming_binding_live(p_owner uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from fluid_private.shared_naming_owners b join fluid_private.naming_brain_pilots p on p.id=b.pilot_id and p.owner_id=b.owner_id
 where b.owner_id=p_owner and (b.legacy_authority_sha256 is null or b.legacy_authority_sha256=fluid_private.shared_naming_pilot_authority(p)));
$$;
-- An old immutable pilot can remain a safe historical anchor after its work
-- drains and its LOGIN is retired. This proof grants no runtime capability;
-- every actual future slot still requires the independent full LOGIN proof.
create function fluid_private.shared_naming_historical_role(p_name name,p_oid oid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from pg_catalog.pg_roles r where r.rolname=p_name and r.oid=p_oid
 and not r.rolinherit and not r.rolsuper and not r.rolbypassrls
 and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication
 and not exists(select 1 from pg_catalog.pg_auth_members m where m.member=r.oid
  or (m.roleid=r.oid and not(m.member=(select oid from pg_catalog.pg_roles where rolname='postgres')
   and m.admin_option and not m.inherit_option and not m.set_option)))
 and not exists(select 1 from pg_catalog.pg_shdepend d where d.refclassid='pg_catalog.pg_authid'::regclass
  and d.refobjid=r.oid and d.deptype='o'));
$$;
create function fluid_private.shared_naming_adopt_existing(p_approval uuid) returns boolean
language plpgsql security invoker set search_path='' as $$
declare a fluid_private.shared_naming_adoption_approvals;p fluid_private.naming_brain_pilots;s fluid_private.shared_worker_slots;b fluid_private.shared_naming_owners;
begin
 if session_user<>'postgres' or current_user<>'postgres' then raise exception 'shared_naming_operator_required' using errcode='42501'; end if;
 select * into strict a from fluid_private.shared_naming_adoption_approvals where approval_id=p_approval;
 perform fluid_private.lock_strategy_owner(a.owner_id);
 select * into strict p from fluid_private.naming_brain_pilots where id=a.pilot_id and owner_id=a.owner_id for update;
 select * into strict s from fluid_private.shared_worker_slots where slot_id=a.slot_id;
 if not fluid_private.shared_account_customer_active(a.owner_id) or a.expires_at<=clock_timestamp()
 or a.legacy_authority_sha256<>fluid_private.shared_naming_pilot_authority(p)
 or not fluid_private.shared_naming_historical_role(p.role_name,p.role_oid)
 or (s.role_name,s.role_oid,s.deployment_id) is distinct from (a.role_name,a.role_oid,a.deployment_id)
 or s.lane<>'naming' or not s.enabled or s.expires_at<=clock_timestamp()
 or not fluid_private.shared_worker_role_safe(s.role_name,s.role_oid)
 or not fluid_private.naming_brain_valid_policy(a.policy) or a.policy->>'model'<>'gpt-6-luna'
 or a.policy_identity<>encode(sha256(convert_to(a.policy::text,'UTF8')),'hex')
 or not exists(select 1 from fluid_private.shared_worker_policies sp join fluid_private.shared_naming_slot_configuration cfg using(slot_id)
 where sp.slot_id=s.slot_id and sp.operation='naming.generate' and (sp.policy_identity,sp.policy,cfg.readiness_fingerprint)=(a.policy_identity,a.policy,a.readiness_fingerprint)
 and cfg.ready_until>clock_timestamp()) then raise exception 'shared_naming_adoption_proof_mismatch' using errcode='42501'; end if;
 select * into b from fluid_private.shared_naming_owners where owner_id=a.owner_id;
 if found and b.approval_id=a.approval_id and b.legacy_authority_sha256=a.legacy_authority_sha256 then return true; end if;
 if coalesce(b.binding_revision,0)<>a.expected_prior_revision or b.binding_id is distinct from a.expected_prior_binding then
  raise exception 'shared_naming_adoption_conflict' using errcode='PT409';
 end if;
 insert into fluid_private.shared_naming_owner_bindings(owner_id,pilot_id,policy_identity,policy,deployment_id,readiness_fingerprint,legacy_authority_sha256,approval_id,binding_revision,predecessor_id)
 values(a.owner_id,p.id,a.policy_identity,a.policy,a.deployment_id,a.readiness_fingerprint,a.legacy_authority_sha256,a.approval_id,a.expected_prior_revision+1,a.expected_prior_binding);
 return true;
end $$;
-- A virtual composite is used ONLY inside the two trusted shared contexts.
-- Original pilot, runs, profiles and observation entrypoints stay untouched.
create function fluid_private.shared_naming_admission_pilot(p_owner uuid) returns fluid_private.naming_brain_pilots
language plpgsql stable security definer set search_path='' as $$
declare p fluid_private.naming_brain_pilots;b fluid_private.shared_naming_owners;s fluid_private.shared_worker_slots;
begin
 if not fluid_private.shared_naming_binding_live(p_owner) or not fluid_private.shared_account_customer_active(p_owner) then return null; end if;
 select ss.* into s from fluid_private.shared_naming_request_context c join fluid_private.shared_worker_slots ss using(slot_id)
 join fluid_private.shared_naming_slot_configuration cfg using(slot_id)
 where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.owner_id=p_owner
 and ((c.mode='admit' and auth.uid()=p_owner) or (c.mode='preferences' and ss.role_name=session_user))
 and ss.lane='naming' and ss.enabled and ss.expires_at>clock_timestamp() and cfg.ready_until>clock_timestamp()
 and fluid_private.shared_worker_role_safe(ss.role_name,ss.role_oid);
 if not found then return null; end if;
 select * into strict b from fluid_private.shared_naming_owners where owner_id=p_owner;
 if not exists(select 1 from fluid_private.shared_worker_policies sp join fluid_private.shared_naming_slot_configuration cfg using(slot_id)
 where sp.slot_id=s.slot_id and sp.operation='naming.generate'
 and (sp.policy_identity,sp.policy,cfg.readiness_fingerprint,s.deployment_id)=(b.policy_identity,b.policy,b.readiness_fingerprint,b.deployment_id)) then return null; end if;
 select * into strict p from fluid_private.naming_brain_pilots where id=b.pilot_id and owner_id=p_owner;
 p.role_name:=s.role_name;p.role_oid:=s.role_oid;p.deployment_id:=b.deployment_id;p.policy:=b.policy;
 p.readiness_fingerprint:=b.readiness_fingerprint;p.enabled:=true;p.ready_until:=s.expires_at;
 return p;
end $$;
create function fluid_private.shared_naming_ready_preferences(p_owner uuid,p_project uuid,p_version integer) returns uuid
language sql stable security definer set search_path='' as $$
 select a.id from fluid_private.naming_brain_preference_attestations a join public.naming_preferences pref
 on pref.owner_id=a.owner_id and pref.project_id=a.project_id and pref.version=a.preferences_version
 join fluid_private.shared_naming_owners b on b.owner_id=a.owner_id
 where a.owner_id=p_owner and a.project_id=p_project and a.preferences_version=p_version
 and fluid_private.shared_naming_binding_live(p_owner)
 and a.preferences_hash=encode(sha256(convert_to(pref.preferences::text,'UTF8')),'hex')
 and a.fingerprint=b.readiness_fingerprint and a.readiness='{"ready":true,"missing":[]}'::jsonb;
$$;

-- Clone pinned baseline bodies before additive wrappers. Legacy bodies/ACLs stay
-- available through their original entrypoints with no new slot grants.
do $copies$
declare sig text; target text; definition text;
begin
 for sig,target in values
 ('fluid_private.naming_brain_worker_owner()','shared_naming_legacy_owner'),
 ('fluid_private.naming_brain_run_worker(fluid_private.naming_brain_runs)','shared_naming_legacy_run_worker'),
 ('fluid_private.naming_brain_ready(fluid_private.naming_brain_runs,text)','shared_naming_legacy_ready'),
 ('fluid_private.naming_brain_execution_authority(uuid)','shared_naming_legacy_authority'),
 ('fluid_private.naming_brain_paid_paused(uuid,uuid,uuid)','shared_naming_legacy_paused'),
 ('fluid_private.hosted_naming_step_authority(uuid)','shared_naming_legacy_step_authority'),
 ('fluid_private.naming_brain_available(uuid)','shared_naming_legacy_available') loop
  definition:=pg_get_functiondef(sig::regprocedure);
  execute regexp_replace(definition,'^CREATE OR REPLACE FUNCTION [a-z_]+\.[a-z_]+','CREATE FUNCTION fluid_private.'||target);
 end loop;
end $copies$;
create function fluid_private.shared_naming_admission_active(p_owner uuid,p_project uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from fluid_private.shared_naming_request_context c
 join fluid_private.shared_worker_slots s using(slot_id)
 join fluid_private.shared_naming_slot_configuration cfg on cfg.slot_id=s.slot_id
 where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.mode='admit'
 and c.owner_id=p_owner and c.project_id=p_project and auth.uid()=p_owner
 and s.lane='naming' and s.enabled and s.expires_at>clock_timestamp() and cfg.ready_until>clock_timestamp()
 and fluid_private.shared_account_customer_active(p_owner));
$$;
create function fluid_private.shared_naming_job(p_job uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from fluid_private.shared_job_admissions a join public.jobs j on j.id=a.job_id
 join fluid_private.naming_brain_runs r on r.job_id=j.id
 where a.job_id=p_job and a.lane='naming' and a.operation='naming.generate'
 and (j.owner_id,j.project_id,j.operation,j.input_hash)=(a.owner_id,a.project_id,a.operation,a.input_hash)
 and (r.owner_id,r.project_id,r.deployment_id,r.policy_identity,r.policy,r.snapshot_hash)=(a.owner_id,a.project_id,a.deployment_id,a.policy_identity,a.policy,a.input_hash)
 and j.input->>'acceptedPolicyIdentity'=a.policy_identity and j.input->'policy'=a.policy
 and j.input->>'executionAuthority'='hosted_owner_v1' and j.input->'providerBudgetVersion'='2'::jsonb
 and j.input->'localTimingVersion'='2'::jsonb and j.input->'localPipelineVersion'='2'::jsonb);
$$;
create function fluid_private.shared_naming_session() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from fluid_private.shared_worker_slots s join pg_roles r on r.oid=s.role_oid and r.rolname=s.role_name
 where s.lane='naming' and r.rolname=session_user);
$$;
create or replace function fluid_private.naming_brain_worker_owner() returns uuid
language sql stable security definer set search_path='' as $$
 select case when fluid_private.shared_naming_session() then fluid_private.shared_worker_context_owner('naming')
 else fluid_private.shared_naming_legacy_owner() end;
$$;
create or replace function fluid_private.naming_brain_run_worker(r fluid_private.naming_brain_runs) returns boolean
language sql stable set search_path='' as $$
 select case when fluid_private.shared_naming_session() then
 r.job_id=fluid_private.shared_worker_context_job('naming') and r.owner_id=fluid_private.shared_worker_context_owner('naming')
 and fluid_private.shared_naming_job(r.job_id) else fluid_private.shared_naming_legacy_run_worker(r) end;
$$;
create or replace function fluid_private.naming_brain_execution_authority(p_job uuid) returns text
language sql stable set search_path='' as $$
 select case when fluid_private.shared_naming_job(p_job) then 'shared_slot_v1' else fluid_private.shared_naming_legacy_authority(p_job) end;
$$;
-- Shared authority is an immutable admission, separate from fresh dispatch.
create or replace function fluid_private.naming_brain_unlimited_job(p_job uuid) returns boolean
language sql stable set search_path='' as $$
 select fluid_private.local_prototype_unlimited_job(p_job)
 or coalesce(fluid_private.naming_brain_execution_authority(p_job) in('hosted_owner_v1','shared_slot_v1'),false);
$$;
create or replace function fluid_private.naming_brain_paid_paused(p_owner uuid,p_project uuid,p_job uuid default null) returns boolean
language sql stable set search_path='' as $$
 select case when fluid_private.shared_naming_admission_active(p_owner,p_project) or exists(select 1 from fluid_private.shared_job_admissions a
 where a.job_id=p_job and a.owner_id=p_owner and a.project_id=p_project and fluid_private.shared_naming_job(a.job_id))
 then fluid_private.local_prototype_project_paused(p_owner,p_project)
 else fluid_private.shared_naming_legacy_paused(p_owner,p_project,p_job) end;
$$;
create or replace function fluid_private.hosted_naming_step_authority(p_job uuid) returns boolean
language sql stable set search_path='' as $$
 select fluid_private.shared_naming_legacy_step_authority(p_job) or
 (fluid_private.shared_worker_context_job('naming')=p_job and fluid_private.shared_worker_context_mode('naming')='active'
 and fluid_private.shared_naming_job(p_job) and exists(select 1 from fluid_private.naming_brain_runs r
 where r.job_id=p_job and fluid_private.naming_brain_run_worker(r)
 and not fluid_private.naming_brain_paid_paused(r.owner_id,r.project_id,r.job_id)));
$$;
do $project_unknown_scope$
declare definition text; fragment text:='fluid_private.naming_brain_execution_authority(r.job_id) is distinct from ''hosted_owner_v1''';
begin
 definition:=pg_get_functiondef('fluid_private.local_naming_previous_worker_action(uuid,uuid,text,jsonb)'::regprocedure);
 if (length(definition)-length(replace(definition,fragment,'')))/length(fragment)<>1 then raise exception 'shared_naming_project_scope_fragment'; end if;
 execute replace(definition,fragment,'('||fragment||' and not fluid_private.shared_naming_job(r.job_id))');
end $project_unknown_scope$;
-- The old progressive read fast path checked the active job lease directly.
-- Historical observation gets only its exact stored snapshot and original
-- execution token; it cannot claim, renew, authorize or mutate a paid stage.
do $observation_snapshot$
declare definition text; fragment text:=$old$if p_token is null or j.lease_token is distinct from p_token or j.lease_expires_at<=clock_timestamp() or j.state not in('running','cancel_requested') then raise exception 'lease_lost' using errcode='PT409'; end if;$old$;
begin
 definition:=pg_get_functiondef('fluid_private.local_naming_progressive_action(uuid,uuid,text,jsonb)'::regprocedure);
 if (length(definition)-length(replace(definition,fragment,'')))/length(fragment)<>1 then raise exception 'shared_naming_observation_snapshot_fragment'; end if;
 execute replace(definition,fragment,$new$if (p_token is null or j.lease_token is distinct from p_token or j.lease_expires_at<=clock_timestamp() or j.state not in('running','cancel_requested'))
 and not coalesce(fluid_private.shared_worker_context_job('naming')=p_job and fluid_private.shared_worker_context_mode('naming')='observe'
 and (fluid_private.shared_worker_context_execution('naming')).lease_token=p_token,false) then raise exception 'lease_lost' using errcode='PT409'; end if;$new$);
end $observation_snapshot$;
create or replace function fluid_private.naming_brain_ready(r fluid_private.naming_brain_runs,p_worker text default null) returns boolean
language sql stable set search_path='' as $$
 select case when fluid_private.shared_naming_session() then
 fluid_private.naming_brain_run_worker(r) and fluid_private.shared_worker_context_mode('naming') in('claim','active')
 and fluid_private.shared_account_customer_active(r.owner_id)
 and exists(select 1 from fluid_private.shared_worker_gateway_context c
 join fluid_private.shared_worker_slots s using(slot_id)
 join fluid_private.shared_worker_policies p on p.slot_id=s.slot_id and p.operation='naming.generate'
 join fluid_private.shared_naming_slot_configuration cfg on cfg.slot_id=s.slot_id
 join fluid_private.naming_worker_leadership l on l.owner_id=r.owner_id and l.deployment_id=r.deployment_id
 where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.job_id=r.job_id
 and s.enabled and s.expires_at>clock_timestamp() and cfg.ready_until>clock_timestamp()
 and p.policy_identity=r.policy_identity and p.policy=r.policy
 and (l.role_name,l.role_oid)=(s.role_name,s.role_oid) and l.expires_at>clock_timestamp()
 and (p_worker is null or l.worker_id=p_worker)
 and exists(select 1 from fluid_private.naming_brain_preference_attestations a where a.id=r.readiness_attestation_id
 and a.owner_id=r.owner_id and a.project_id=r.project_id and a.fingerprint=cfg.readiness_fingerprint
 and a.preferences_hash=encode(sha256(convert_to((r.snapshot->'preferences')::text,'UTF8')),'hex')
 and a.readiness='{"ready":true,"missing":[]}'::jsonb))
 else fluid_private.shared_naming_legacy_ready(r,p_worker) end;
$$;
create or replace function fluid_private.naming_brain_available(p_owner uuid) returns jsonb
language sql stable set search_path='' as $$
 select coalesce((select jsonb_build_object('status','available','handlerVersion','naming-brain-v1','protocol','openai_agents',
 'acceptedPolicyIdentity',p.policy_identity) from fluid_private.shared_worker_slots s
 join fluid_private.shared_worker_policies p using(slot_id) join fluid_private.shared_naming_slot_configuration cfg using(slot_id)
 where s.lane='naming' and s.enabled and s.expires_at>clock_timestamp() and cfg.ready_until>clock_timestamp()
 and p.operation='naming.generate' and fluid_private.shared_account_customer_active(p_owner)
 order by s.slot_index limit 1),fluid_private.shared_naming_legacy_available(p_owner));
$$;
create function fluid_private.shared_naming_resume_ready(r fluid_private.naming_brain_runs) returns boolean
language sql stable security definer set search_path='' as $$
 select fluid_private.shared_naming_job(r.job_id) and fluid_private.shared_account_customer_active(r.owner_id)
 and fluid_private.shared_naming_binding_live(r.owner_id)
 and exists(select 1 from fluid_private.shared_naming_owners owned
 join fluid_private.shared_worker_slots s on s.lane='naming' and s.deployment_id=owned.deployment_id
 join fluid_private.shared_worker_policies p on p.slot_id=s.slot_id and p.operation='naming.generate'
 join fluid_private.shared_naming_slot_configuration cfg on cfg.slot_id=s.slot_id
 where owned.owner_id=r.owner_id and owned.pilot_id=r.pilot_id and owned.policy_identity=r.policy_identity and owned.policy=r.policy
 and (p.policy_identity,p.policy,cfg.readiness_fingerprint)=(owned.policy_identity,owned.policy,owned.readiness_fingerprint)
 and s.enabled and s.expires_at>clock_timestamp() and cfg.ready_until>clock_timestamp());
$$;
do $resume_copy$
declare definition text; original text; fragment text:='pilot.enabled and pilot.ready_until>clock_timestamp() and fluid_private.api_text_restricted_role(pilot.role_name,pilot.role_oid)';
begin
 original:=pg_get_functiondef('fluid_private.naming_brain_paid_resume(fluid_private.naming_brain_runs)'::regprocedure);
 execute replace(original,'FUNCTION fluid_private.naming_brain_paid_resume(','FUNCTION fluid_private.shared_naming_legacy_paid_resume(');
 definition:=replace(original,'FUNCTION fluid_private.naming_brain_paid_resume(','FUNCTION fluid_private.shared_naming_current_paid_resume(');
 if (length(definition)-length(replace(definition,fragment,'')))/length(fragment)<>1 then raise exception 'shared_naming_resume_readiness_fragment'; end if;
 definition:=replace(definition,fragment,'fluid_private.shared_naming_resume_ready(r)');
 definition:=replace(definition,'fluid_private.naming_brain_ready_preferences(', 'fluid_private.shared_naming_ready_preferences(');
 execute definition;
end $resume_copy$;
create or replace function fluid_private.naming_brain_paid_resume(r fluid_private.naming_brain_runs) returns boolean
language sql stable set search_path='' as $$
 select case when fluid_private.shared_naming_job(r.job_id) then fluid_private.shared_naming_current_paid_resume(r)
 else fluid_private.shared_naming_legacy_paid_resume(r) end;
$$;

-- New admission reuses the pinned intent/idempotency/Stop/provenance algorithm.
-- Only its explicit shared-context policy/authority seams differ; no historical
-- body or request is rewritten, and legacy aggregate fields remain accounting.
do $admission_copy$
declare definition text; old text;
begin
 definition:=pg_get_functiondef('public.ensure_naming_brain_run(uuid,jsonb)'::regprocedure);
 definition:=replace(definition,'FUNCTION public.ensure_naming_brain_run(','FUNCTION fluid_private.shared_naming_ensure_core(');
 definition:=replace(definition,'fluid_private.naming_brain_unlimited_context(o,p.id)','fluid_private.shared_naming_admission_active(o,p.id)');
 definition:=replace(definition,'fluid_private.hosted_naming_context(o,p.id)','fluid_private.shared_naming_admission_active(o,p.id)');
 old:='select * into pilot from fluid_private.naming_brain_pilots where owner_id=o and enabled and ready_until>clock_timestamp() and fluid_private.api_text_restricted_role(role_name,role_oid) for update;';
 if position(old in definition)=0 then raise exception 'shared_naming_pilot_fragment'; end if;
 definition:=replace(definition,old,'select * into pilot from fluid_private.shared_naming_admission_pilot(o) where id is not null and fluid_private.shared_naming_admission_active(o,p.id);');
 definition:=replace(definition,'fluid_private.naming_brain_ready_preferences(', 'fluid_private.shared_naming_ready_preferences(');
 definition:=replace(definition,'join fluid_private.naming_brain_pilots configured on configured.owner_id=a.owner_id','join fluid_private.shared_naming_owners configured on configured.owner_id=a.owner_id');
 old:=$old$ if input->>'executionAuthority'='hosted_owner_v1' then
 insert into fluid_private.hosted_naming_jobs(job_id,owner_id,project_id,capability_id,pilot_id,role_name,role_oid,deployment_id,policy_identity,job_input_sha256)
 select jobid,o,p.id,context.capability_id,pilot.id,pilot.role_name,pilot.role_oid,pilot.deployment_id,input->>'acceptedPolicyIdentity',encode(sha256(convert_to(input::text,'UTF8')),'hex')
 from fluid_private.hosted_naming_admission_context context where context.backend_pid=pg_backend_pid() and context.transaction_id=txid_current() and context.owner_id=o and context.project_id=p.id;
 if not found then raise exception 'hosted_naming_admission_missing' using errcode='55000'; end if;
 end if;$old$;
 if position(old in definition)=0 then raise exception 'shared_naming_admission_fragment'; end if;
 definition:=replace(definition,old,$new$ perform fluid_private.admit_shared_worker_job(jobid,'naming',input->>'acceptedPolicyIdentity',pilot.deployment_id,pilot.policy);$new$);
 execute definition;
end $admission_copy$;
create function public.ensure_shared_naming_brain_run(p_project_id uuid,p_intent jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid(); s fluid_private.shared_worker_slots; p fluid_private.shared_worker_policies; cfg fluid_private.shared_naming_slot_configuration;
 pilot fluid_private.naming_brain_pilots; result jsonb;
begin
 if not fluid_private.shared_account_customer_active(o) or not exists(select 1 from public.projects where id=p_project_id and owner_id=o
 and deleted_at is null and deletion_requested_at is null) then raise exception 'shared_naming_account_required' using errcode='42501'; end if;
 perform fluid_private.lock_strategy_owner(o);
 -- Exact historical intent replay retains its own original response/algorithm.
 if exists(select 1 from fluid_private.naming_brain_intents where owner_id=o and request_key=p_intent->>'idempotencyKey') then
  return public.ensure_naming_brain_run(p_project_id,p_intent);
 end if;
 select ss.* into s from fluid_private.shared_worker_slots ss join fluid_private.shared_worker_policies pp using(slot_id)
 join fluid_private.shared_naming_slot_configuration cc using(slot_id)
 where ss.lane='naming' and ss.enabled and ss.expires_at>clock_timestamp() and cc.ready_until>clock_timestamp()
 and pp.operation='naming.generate'
 and (not exists(select 1 from fluid_private.shared_naming_owners where owner_id=o)
 or exists(select 1 from fluid_private.shared_naming_owners b where b.owner_id=o
 and (b.deployment_id,b.policy_identity,b.policy,b.readiness_fingerprint)=(ss.deployment_id,pp.policy_identity,pp.policy,cc.readiness_fingerprint)))
 order by ss.slot_index limit 1;
 if not found then raise exception 'shared_naming_runtime_unavailable' using errcode='55000'; end if;
 select * into strict p from fluid_private.shared_worker_policies where slot_id=s.slot_id and operation='naming.generate';
 select * into strict cfg from fluid_private.shared_naming_slot_configuration where slot_id=s.slot_id;
 select * into pilot from fluid_private.naming_brain_pilots where owner_id=o for update;
 if not found then
  insert into fluid_private.naming_brain_pilots(owner_id,role_name,role_oid,deployment_id,policy,enabled,readiness_fingerprint)
  values(o,s.role_name,s.role_oid,s.deployment_id,p.policy,true,cfg.readiness_fingerprint) returning * into pilot;
  insert into fluid_private.shared_naming_owner_bindings(owner_id,pilot_id,policy_identity,policy,deployment_id,readiness_fingerprint) values(o,pilot.id,p.policy_identity,p.policy,s.deployment_id,cfg.readiness_fingerprint);
 end if;
 -- Existing pilot bindings are not repointed or silently adopted.
 if not fluid_private.shared_naming_binding_live(o) or not exists(select 1 from fluid_private.shared_naming_owners owned where owned.owner_id=o and owned.pilot_id=pilot.id
 and (owned.deployment_id,owned.policy_identity,owned.policy,owned.readiness_fingerprint)
 =(s.deployment_id,p.policy_identity,p.policy,cfg.readiness_fingerprint)) then
 raise exception 'shared_naming_existing_binding_requires_cutover' using errcode='55000'; end if;
 insert into fluid_private.shared_naming_request_context values(pg_backend_pid(),txid_current(),o,p_project_id,s.slot_id,'admit');
 -- A zero-limit bookkeeping row records holds/actuals; no credits or cap are
 -- activated. The explicit shared admission bypasses only legacy aggregates.
 insert into public.usage_accounts(owner_id) values(o) on conflict(owner_id) do nothing;
 result:=fluid_private.shared_naming_ensure_core(p_project_id,p_intent);
 delete from fluid_private.shared_naming_request_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
 return result;
end $$;
-- This wire describes the existing immutable hosted execution/input profile,
-- not a per-owner LOGIN identity. Actual slot authority remains shared_slot_v1.
create function public.get_shared_naming_availability(p_project_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare o uuid:=auth.uid();
begin
 if not fluid_private.shared_account_customer_active(o) then raise exception 'shared_naming_account_required' using errcode='42501'; end if;
 if p_project_id is not null and not exists(select 1 from public.projects where id=p_project_id and owner_id=o and deleted_at is null and deletion_requested_at is null) then
  raise exception 'not_found' using errcode='P0002'; end if;
 if exists(select 1 from fluid_private.naming_brain_pilots where owner_id=o) and not fluid_private.shared_naming_binding_live(o) then
  return jsonb_build_object('status','unavailable','executionAuthority','hosted_owner_v1','reason','runtime_disabled');
 end if;
 if exists(select 1 from fluid_private.shared_worker_slots s join fluid_private.shared_worker_policies p using(slot_id)
 join fluid_private.shared_naming_slot_configuration cfg using(slot_id)
 where s.lane='naming' and s.enabled and s.expires_at>clock_timestamp() and cfg.ready_until>clock_timestamp() and p.operation='naming.generate'
 and (not exists(select 1 from fluid_private.shared_naming_owners where owner_id=o)
 or exists(select 1 from fluid_private.shared_naming_owners b where b.owner_id=o
 and (b.deployment_id,b.policy_identity,b.policy,b.readiness_fingerprint)=(s.deployment_id,p.policy_identity,p.policy,cfg.readiness_fingerprint)))) then
  return jsonb_build_object('status','available','executionAuthority','hosted_owner_v1');
 end if;
 if exists(select 1 from fluid_private.naming_brain_pilots where owner_id=o)
 and not exists(select 1 from fluid_private.shared_naming_owners where owner_id=o) then
  return jsonb_build_object('status','unavailable','executionAuthority','hosted_owner_v1','reason','runtime_disabled');
 end if;
 return jsonb_build_object('status','unavailable','executionAuthority','hosted_owner_v1','reason','worker_unavailable');
end $$;
create function fluid_private.shared_naming_preference_owner() returns uuid
language sql stable security definer set search_path='' as $$
 select c.owner_id from fluid_private.shared_naming_request_context c
 join fluid_private.shared_worker_slots s using(slot_id) join pg_roles r on r.rolname=session_user and r.oid=s.role_oid
 where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.mode='preferences'
 and s.lane='naming' and s.role_name=session_user and s.enabled and s.expires_at>clock_timestamp()
 and fluid_private.shared_worker_role_safe(s.role_name,s.role_oid)
 and fluid_private.shared_account_customer_active(c.owner_id)
 and exists(select 1 from public.projects where id=c.project_id and owner_id=c.owner_id and deleted_at is null and deletion_requested_at is null);
$$;
do $attest_copy$
declare definition text;
begin
 if not exists(select 1 from pg_proc where oid='fluid_private.naming_worker_attest_core(uuid,integer,text,jsonb,jsonb)'::regprocedure
 and md5(prosrc)='ae4a8e7726380ac0cc356f14af0d9354' and proowner=(select oid from pg_roles where rolname='postgres') and proconfig=array['search_path=""']) then
 raise exception 'shared_naming_attest_predecessor'; end if;
 definition:=pg_get_functiondef('fluid_private.naming_worker_attest_core(uuid,integer,text,jsonb,jsonb)'::regprocedure);
 definition:=replace(definition,'FUNCTION fluid_private.naming_worker_attest_core(','FUNCTION fluid_private.shared_naming_attest_core(');
 if position('o uuid:=fluid_private.naming_brain_worker_owner()' in definition)=0 then raise exception 'shared_naming_attest_fragment'; end if;
 definition:=replace(definition,'o uuid:=fluid_private.naming_brain_worker_owner()','o uuid:=fluid_private.shared_naming_preference_owner()');
 if position('select * into strict pilot from fluid_private.naming_brain_pilots where owner_id=o;' in definition)=0 then raise exception 'shared_naming_attest_pilot_fragment'; end if;
 definition:=replace(definition,'select * into strict pilot from fluid_private.naming_brain_pilots where owner_id=o;', 'select * into strict pilot from fluid_private.shared_naming_admission_pilot(o) where id is not null;');
 execute definition;
end $attest_copy$;

create function public.shared_naming_worker_action(p_slot jsonb,p_execution jsonb,p_action text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s fluid_private.shared_worker_slots; e fluid_private.shared_worker_executions; l fluid_private.naming_worker_leadership;
 j public.jobs; r fluid_private.naming_brain_runs; cfg fluid_private.shared_naming_slot_configuration; result jsonb; mode text:='active';
 selected uuid; worker text; arg jsonb; work jsonb; v_project public.projects;
begin
 if jsonb_typeof(p_args) is distinct from 'array' or octet_length(p_args::text)>1048576
 or p_action not in('qualify','preference_work','attest_preferences','claim','action','authorize','receipt','complete','assert_continue','recover')
 or p_action is null then raise exception 'invalid_shared_naming_action' using errcode='22023'; end if;
 if p_execution is null then
  s:=fluid_private.lock_shared_worker_slot(p_slot,true);
  if s.lane<>'naming' then raise exception 'shared_lane_mismatch' using errcode='42501'; end if;
  select * into cfg from fluid_private.shared_naming_slot_configuration where slot_id=s.slot_id;
  if cfg.slot_id is null then raise exception 'shared_naming_configuration_absent' using errcode='55000'; end if;
  if p_action='qualify' then
   if jsonb_array_length(p_args)<>2 or p_args->1 is distinct from cfg.readiness_fingerprint
   or not exists(select 1 from fluid_private.shared_worker_policies where slot_id=s.slot_id and operation='naming.generate'
    and policy=p_args->0 and policy_identity=encode(sha256(convert_to((p_args->0)::text,'UTF8')),'hex')) then
    raise exception 'shared_naming_runtime_mismatch' using errcode='42501'; end if;
   update fluid_private.shared_naming_slot_configuration set ready_until=clock_timestamp()+interval '60 seconds' where slot_id=s.slot_id;
   return jsonb_build_object('execution',null,'result',true);
  end if;
  if cfg.ready_until is null or cfg.ready_until<=clock_timestamp() then raise exception 'shared_naming_runtime_stale' using errcode='42501'; end if;
  if p_action='preference_work' then
   if p_args<>'[20]'::jsonb then raise exception 'invalid_shared_preference_limit'; end if;
   select coalesce(jsonb_agg(jsonb_build_object('ownerId',x.owner_id,'projectId',x.project_id,'preferencesVersion',x.version,
    'preferences',x.preferences,'preferencesHash',encode(sha256(convert_to(x.preferences::text,'UTF8')),'hex'),
    'expectedFingerprint',cfg.readiness_fingerprint) order by x.project_id),'[]') into result from(
    select pref.* from public.naming_preferences pref join public.naming_sessions ns on ns.project_id=pref.project_id and ns.owner_id=pref.owner_id and ns.preferences_version=pref.version
    join public.projects project on project.id=pref.project_id and project.owner_id=pref.owner_id
    join fluid_private.naming_brain_pilots pilot on pilot.owner_id=pref.owner_id
    join fluid_private.shared_naming_owners owned on owned.owner_id=pilot.owner_id and owned.pilot_id=pilot.id
    join fluid_private.shared_worker_policies approved on approved.slot_id=s.slot_id and approved.operation='naming.generate'
    where (owned.deployment_id,owned.policy_identity,owned.policy,owned.readiness_fingerprint)=(s.deployment_id,approved.policy_identity,approved.policy,cfg.readiness_fingerprint)
    and pref.preferences->'version'='2'::jsonb and project.deleted_at is null and project.deletion_requested_at is null
    and fluid_private.shared_account_customer_active(pref.owner_id) and fluid_private.shared_naming_binding_live(pref.owner_id)
    and not exists(select 1 from fluid_private.naming_brain_preference_attestations a where a.owner_id=pref.owner_id and a.project_id=pref.project_id
     and a.preferences_version=pref.version and a.fingerprint=cfg.readiness_fingerprint)
    order by pref.project_id limit 20) x;
   return jsonb_build_object('execution',null,'result',result);
  elsif p_action='attest_preferences' then
   if jsonb_array_length(p_args)<>5 or p_args->3 is distinct from cfg.readiness_fingerprint then raise exception 'invalid_shared_attestation'; end if;
   select * into v_project from public.projects where id=(p_args->>0)::uuid and deleted_at is null and deletion_requested_at is null;
   if not found or not fluid_private.shared_account_customer_active(v_project.owner_id) or not fluid_private.shared_naming_binding_live(v_project.owner_id) or not exists(select 1 from fluid_private.shared_naming_owners owned
    join fluid_private.shared_worker_policies approved on approved.slot_id=s.slot_id and approved.operation='naming.generate'
    where owned.owner_id=v_project.owner_id and (owned.deployment_id,owned.policy_identity,owned.policy,owned.readiness_fingerprint)=(s.deployment_id,approved.policy_identity,approved.policy,cfg.readiness_fingerprint)) then
    raise exception 'shared_preference_scope_denied' using errcode='42501'; end if;
   insert into fluid_private.shared_naming_request_context values(pg_backend_pid(),txid_current(),v_project.owner_id,v_project.id,s.slot_id,'preferences');
   result:=fluid_private.shared_naming_attest_core(v_project.id,(p_args->>1)::integer,p_args->>2,p_args->3,p_args->4);
   delete from fluid_private.shared_naming_request_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
   return jsonb_build_object('execution',null,'result',result);
  elsif p_action<>'claim' then raise exception 'shared_naming_claim_required' using errcode='42501'; end if;
  if jsonb_array_length(p_args)<>3 or p_args->>1 is distinct from s.deployment_id or length(p_args->>0) not between 1 and 100
   or (p_args->>2)::integer not between 10 and 300 then raise exception 'invalid_shared_naming_claim'; end if;
  worker:=p_args->>0;
  -- SQL chooses the immutable admission. No owner/job selector is accepted.
  select a.job_id into selected from fluid_private.shared_job_admissions a join public.jobs jj on jj.id=a.job_id
   join fluid_private.naming_brain_runs rr on rr.job_id=jj.id
   join fluid_private.shared_worker_policies policy on policy.slot_id=s.slot_id and policy.operation=a.operation
   where a.lane='naming' and a.deployment_id=s.deployment_id and a.policy_identity=policy.policy_identity and a.policy=policy.policy
   and fluid_private.shared_naming_job(a.job_id) and fluid_private.shared_worker_claimable(p_slot,a.job_id)
   and not exists(select 1 from fluid_private.naming_worker_leadership old where old.owner_id=a.owner_id and old.deployment_id=a.deployment_id
    and old.expires_at>clock_timestamp() and (old.role_name,old.role_oid,old.worker_id) is distinct from(s.role_name,s.role_oid,worker))
   order by jj.created_at,jj.id limit 1;
  if selected is null then return jsonb_build_object('execution',null,'result',null); end if;
  perform fluid_private.enter_shared_worker_claim_context(p_slot,selected);
  select * into strict j from public.jobs where id=selected;
  perform fluid_private.lock_strategy_owner(j.owner_id);
  select * into l from fluid_private.naming_worker_leadership where owner_id=j.owner_id and deployment_id=s.deployment_id for update;
  if l.expires_at>clock_timestamp() and (l.role_name,l.role_oid,l.worker_id) is distinct from(s.role_name,s.role_oid,worker) then
   raise exception 'shared_naming_leadership_held' using errcode='40001'; end if;
  insert into fluid_private.naming_worker_leadership(owner_id,deployment_id,role_name,role_oid,worker_id,generation,expires_at)
   values(j.owner_id,s.deployment_id,s.role_name,s.role_oid,worker,coalesce(l.generation,0)+1,s.expires_at)
   on conflict(owner_id,deployment_id) do update set role_name=excluded.role_name,role_oid=excluded.role_oid,worker_id=excluded.worker_id,
    generation=excluded.generation,expires_at=excluded.expires_at returning * into l;
  result:=fluid_private.naming_worker_claim_core(worker,s.deployment_id,(p_args->>2)::integer);
  if result is null then
   perform fluid_private.leave_shared_worker_context();return jsonb_build_object('execution',null,'result',null);
  end if;
  if (result#>>'{job,id}')::uuid is distinct from selected then raise exception 'shared_naming_claim_scope_changed' using errcode='42501'; end if;
  e:=fluid_private.bind_shared_worker_execution(p_slot,selected);
  insert into fluid_private.naming_worker_job_authority values(e.job_id,e.owner_id,e.project_id,e.deployment_id,worker,l.generation,e.lease_token)
   on conflict(job_id) do update set owner_id=excluded.owner_id,project_id=excluded.project_id,deployment_id=excluded.deployment_id,
    worker_id=excluded.worker_id,generation=excluded.generation,lease_token=excluded.lease_token;
  perform fluid_private.leave_shared_worker_context();
  return jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'result',result);
 end if;
 -- Observation never authorizes a new create/continuation/publication or lease
 -- extension. Exact issued evidence remains usable after Stop/slot takeover.
 if p_action in('receipt','complete','recover') or p_action='action' and p_args->>2 in('stage','progressive_state','provider_item','provider_turn','tool_result','artifact','finish') then mode:='observe'; end if;
 if p_action='action' and p_args->>2='heartbeat' then
  begin
   e:=fluid_private.shared_worker_execution(p_slot,p_execution,'active');
  exception when insufficient_privilege then
   mode:='observe';e:=fluid_private.shared_worker_execution(p_slot,p_execution,'observe');
  end;
 else e:=fluid_private.shared_worker_execution(p_slot,p_execution,mode); end if;
 if e.lane<>'naming' then raise exception 'shared_lane_mismatch' using errcode='42501'; end if;
 perform fluid_private.enter_shared_worker_context(p_slot,p_execution,mode);
 if p_action='recover' then
  if p_args<>'[]'::jsonb then raise exception 'invalid_shared_naming_recovery'; end if;
  update fluid_private.naming_brain_runs set recovery_mode='observe_only' where job_id=e.job_id;
  select * into strict j from public.jobs where id=e.job_id;
  -- The current job state and lease fields stay truthful. The separately named
  -- immutable historical token permits only this execution's observation RPCs.
  result:=jsonb_build_object('observationJob',to_jsonb(j),'observationLeaseToken',e.lease_token);
 elsif p_action='assert_continue' then
  if p_args<>'[]'::jsonb and p_args<>jsonb_build_array(e.job_id,e.lease_token) then raise exception 'shared_naming_scope_mismatch' using errcode='42501'; end if;
  select * into strict r from fluid_private.naming_brain_runs where job_id=e.job_id;
  select * into strict j from public.jobs where id=e.job_id;
  result:=to_jsonb(j.state='running' and j.cancel_requested_at is null and r.recovery_mode='execute' and not r.superseded
   and fluid_private.naming_brain_ready(r,j.worker_id)
   and not exists(select 1 from fluid_private.naming_brain_heads where project_id=e.project_id and paused));
 else
  if (p_args->>0)::uuid is distinct from e.job_id or (p_args->>1)::uuid is distinct from e.lease_token then raise exception 'shared_naming_scope_mismatch' using errcode='42501'; end if;
  if p_action='action' and jsonb_array_length(p_args)=4 then
   arg:=(p_args->>3)::jsonb;
   if p_args->>2='heartbeat' then
    if mode='observe' then
     -- Stored status can deliver Stop/ban to a draining real engine, but no
     -- historical generation may extend a lease or regain paid readiness.
     update fluid_private.naming_brain_runs set recovery_mode='observe_only' where job_id=e.job_id returning * into r;
     select * into strict j from public.jobs where id=e.job_id;
     result:=to_jsonb(j)||jsonb_build_object('recoveryMode','observe_only','observationDeadlineAt',r.observation_deadline_at);
    else
     s:=fluid_private.lock_shared_worker_slot(p_slot,true);
     update fluid_private.shared_naming_slot_configuration set ready_until=clock_timestamp()+interval '60 seconds' where slot_id=s.slot_id;
     update fluid_private.naming_worker_leadership set expires_at=s.expires_at where owner_id=e.owner_id and deployment_id=e.deployment_id
      and role_name=s.role_name and role_oid=s.role_oid and worker_id=(select worker_id from public.jobs where id=e.job_id);
     result:=public.naming_brain_worker_action(e.job_id,e.lease_token,p_args->>2,arg);
    end if;
   else
    result:=public.naming_brain_worker_action(e.job_id,e.lease_token,p_args->>2,arg);
   end if;
  elsif p_action='authorize' and jsonb_array_length(p_args)=3 then result:=to_jsonb(public.authorize_naming_brain_dispatch(e.job_id,e.lease_token,(p_args->>2)::jsonb));
  elsif p_action='receipt' and jsonb_array_length(p_args)=3 then result:=public.record_naming_brain_provider_receipt(e.job_id,e.lease_token,(p_args->>2)::jsonb);
  elsif p_action='complete' and jsonb_array_length(p_args)=5 then result:=public.complete_naming_brain_stage(e.job_id,e.lease_token,p_args->>2,p_args->>3,(p_args->>4)::jsonb);
  else raise exception 'invalid_shared_naming_action' using errcode='22023'; end if;
 end if;
 perform fluid_private.leave_shared_worker_context();
 if p_action='complete' or p_action='action' and p_args->>2='finish' then
  select * into strict j from public.jobs where id=e.job_id;
  if j.state in('succeeded','failed','cancelled','partial') and j.lease_token is null
   and not exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then
   perform fluid_private.close_shared_worker_execution(p_slot,p_execution);
  elsif j.state='needs_reconciliation' or not fluid_private.shared_worker_admission_active(j.id) then
   perform fluid_private.park_shared_worker_execution(p_slot,p_execution);
  end if;
 end if;
 return jsonb_build_object('execution',fluid_private.shared_worker_execution_json(e),'result',result);
end $$;


-- Preserve the original algorithm for historical intent replays. After the
-- atomic binding insert, new requests must enter the separately qualified
-- shared facade. No pilot disable, role retarget, job cancellation or rewrite.
do $legacy_admission_copy$
declare definition text;
begin
 definition:=pg_get_functiondef('public.ensure_naming_brain_run(uuid,jsonb)'::regprocedure);
 execute replace(definition,'FUNCTION public.ensure_naming_brain_run(','FUNCTION fluid_private.shared_naming_legacy_ensure_core(');
end $legacy_admission_copy$;
create or replace function public.ensure_naming_brain_run(p_project_id uuid,p_intent jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o uuid:=auth.uid();
begin
 if o is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 perform fluid_private.lock_strategy_owner(o);
 if exists(select 1 from fluid_private.shared_naming_owners where owner_id=o)
 and not exists(select 1 from fluid_private.naming_brain_intents where owner_id=o and request_key=p_intent->>'idempotencyKey') then
  raise exception 'shared_naming_future_admission_required' using errcode='55000';
 end if;
 return fluid_private.shared_naming_legacy_ensure_core(p_project_id,p_intent);
end $$;

-- Strip every hostile default ACL on all new objects. No service principal is
-- granted access by installation; the later reviewed fixed-slot packet owns it.
do $acl$
declare item record; grant_row record; target text;
begin
 for item in select p.oid,p.proowner owner,p.proacl acl,'function' kind from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='fluid_private' and p.proname like 'shared_naming_%'
  or n.nspname='public' and p.proname in('shared_naming_worker_action','ensure_shared_naming_brain_run','get_shared_naming_availability') loop
  target:=item.oid::regprocedure::text;
  for grant_row in select distinct a.grantee,r.rolname from aclexplode(coalesce(item.acl,acldefault('f',item.owner))) a left join pg_roles r on r.oid=a.grantee where a.grantee<>item.owner loop
   execute format('revoke all on function %s from %s',target,case when grant_row.grantee=0 then 'PUBLIC' else quote_ident(grant_row.rolname) end);
  end loop;
 end loop;
 for item in select c.oid,c.relowner owner,c.relacl acl from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='fluid_private' and c.relname in('shared_naming_slot_configuration','shared_naming_request_context','shared_naming_owners','shared_naming_owner_bindings','shared_naming_adoption_approvals') loop
  for grant_row in select distinct a.grantee,r.rolname from aclexplode(coalesce(item.acl,acldefault('r',item.owner))) a left join pg_roles r on r.oid=a.grantee where a.grantee<>item.owner loop
   execute format('revoke all on table %s from %s',item.oid::regclass,case when grant_row.grantee=0 then 'PUBLIC' else quote_ident(grant_row.rolname) end);
  end loop;
 end loop;
end $acl$;
-- Authenticated web may invoke only the owner-derived admission wrapper.
grant execute on function public.ensure_shared_naming_brain_run(uuid,jsonb) to authenticated;
grant execute on function public.get_shared_naming_availability(uuid) to authenticated;
commit;
