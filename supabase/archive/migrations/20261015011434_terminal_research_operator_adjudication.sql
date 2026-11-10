-- Installs the operator-adjudication mechanism for one terminal unusable response.
-- Installs no receipt and grants no capability. The separate apply packet is
-- required to adjudicate the single pinned historical request. This deliberately
-- distinguishes an unusable, completed response from unresolved provider billing.
-- It never settles/refunds a reservation or establishes a final provider charge.
begin;

create temporary table research_adjudication_original_functions on commit drop as
 select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof
 from pg_catalog.pg_proc where oid in (
  'fluid_private.api_text_paid_paused(uuid)'::regprocedure,
  'fluid_private.api_text_allowance_paused()'::regprocedure);

do $guard$
declare signature text; expected text;
begin
 for signature,expected in values
  ('fluid_private.api_text_paid_paused(uuid)','b5fbefcfc2f0aead9bc72889df0862ee'),
  ('fluid_private.api_text_allowance_paused()','971854cfc6760022f4315c11cd40fb56') loop
  if not exists(select 1 from pg_catalog.pg_proc p where p.oid=signature::regprocedure
   and md5(p.prosrc)=expected and not p.prosecdef and p.provolatile='s'
   and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user)) then
   raise exception 'unexpected_research_adjudication_predecessor: %',signature;
  end if;
 end loop;
end $guard$;

create table fluid_private.api_text_operator_adjudications (
 job_id uuid primary key check(job_id='6b310a38-eadf-4d64-9474-b7632cfa2340'),
 owner_id uuid not null check(owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42'),
 project_id uuid not null check(project_id='8aa59964-7057-4a96-8142-82561fc5ffda'),
 step_id uuid not null check(step_id='bf70b5ce-3a48-4b8d-92c0-f4e29b145595'),
 output_sha256 text not null check(output_sha256='c787e1485edc74f13cd1d03736b536933b7a3c75fc9f5ac826e7890977382dde'),
 source_revision text not null check(source_revision='af6faf18912cc24afb37179a6988a11f83cf9cdf'),
 source_adapter_sha256 text not null check(source_adapter_sha256='419acb2adcdb5bf27ee99f92bf3f737876efad9ca8c4a7c1836f1c00a68a1255'),
 terminal_evidence text not null check(terminal_evidence='reviewed_source_branch_order_provider_unexpected_output_after_completed'),
 decision text not null check(decision='abandon_unusable_result_billing_unresolved'),
 -- An operator-supplied external authorization reference, not proof that SQL
 -- can independently authenticate a human decision. No approval is prefilled.
 operator_decision_reference text not null check(operator_decision_reference ~ '^operator-decision:[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$'),
 reason text not null check(length(reason) between 40 and 2000),
 reserved_microusd bigint not null check(reserved_microusd=15892880),
 observed_microusd bigint not null check(observed_microusd=74665),
 retained_microusd bigint not null check(retained_microusd=15818215),
 -- Set by the trigger from locked rows, never accepted as caller evidence.
 job_sha256 text not null,
 step_sha256 text not null,
 reservation_sha256 text not null,
 dispatch_sha256 text not null,
 admission_sha256 text not null,
 testing_marker_sha256 text not null,
 ledger_before jsonb not null,
 original_job_state text not null,
 original_job_error text not null,
 operator_role name not null,
 operator_session name not null,
 recorded_at timestamptz not null,
 foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
 foreign key(step_id) references public.job_steps(id)
);

create function fluid_private.record_research_operator_adjudication()
returns trigger language plpgsql set search_path='' as $$
declare j public.jobs; s public.job_steps; r public.usage_reservations;
 d fluid_private.api_text_dispatches; a fluid_private.api_text_allowance_admissions;
 t fluid_private.api_text_testing_admissions; ledger public.usage_accounts;
begin
 -- TRUNCATE already holds ACCESS EXCLUSIVE, so no concurrent insertion can
 -- race this emptiness check. Empty fixture cleanup loses no audit history.
 if tg_op='TRUNCATE' and not exists(select 1 from fluid_private.api_text_operator_adjudications) then
  return null;
 end if;
 if tg_op<>'INSERT' then raise exception 'immutable_operator_adjudication' using errcode='55000'; end if;
 if current_user is distinct from pg_get_userbyid((select relowner from pg_catalog.pg_class where oid=tg_relid)) then
  raise exception 'operator_required' using errcode='42501'; end if;
 if new.operator_decision_reference is null or new.operator_decision_reference !~ '^operator-decision:[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$' then
  raise exception 'operator_decision_reference_required' using errcode='22023'; end if;
 -- Same rollout -> cohort -> owner -> job -> ledger order as admission.
 perform 1 from fluid_private.api_text_allowance_rollout where singleton for update;
 perform 1 from fluid_private.api_text_allowance_cohorts c
  join fluid_private.api_text_allowance_admissions a0 on a0.cohort_id=c.id
  where a0.job_id=new.job_id for update of c;
 perform fluid_private.lock_strategy_owner(new.owner_id);
 select * into j from public.jobs where id=new.job_id for update;
 select * into s from public.job_steps where id=new.step_id for update;
 select * into r from public.usage_reservations where job_id=new.job_id for update;
 select * into d from fluid_private.api_text_dispatches where job_id=new.job_id for update;
 select * into a from fluid_private.api_text_allowance_admissions where job_id=new.job_id;
 select * into t from fluid_private.api_text_testing_admissions where job_id=new.job_id;
 select * into ledger from public.usage_accounts where owner_id=new.owner_id for update;
 if new.job_id<>'6b310a38-eadf-4d64-9474-b7632cfa2340'
  or new.owner_id<>'6840f4c2-15a6-45a7-97be-41e7e5e37f42'
  or new.project_id<>'8aa59964-7057-4a96-8142-82561fc5ffda'
  or new.step_id<>'bf70b5ce-3a48-4b8d-92c0-f4e29b145595'
  or (j.id,j.owner_id,j.project_id,j.operation,j.input_revision,j.input_hash,j.plan_fingerprint,j.state,
      j.attempts,j.max_attempts,j.reserved_cost_microusd,j.actual_cost_microusd,j.error_code)
   is distinct from (new.job_id,new.owner_id,new.project_id,'strategy.competitors',1,
    '8db2a72d2376339aad0bdde50f2097ab98d84e6bfa1aeb05fed6542d28efe6ef',
    '36e8eb404ddd2553e88c99e60fb7269546bb639938af1d54f5b7e106a2cd2a09','needs_reconciliation',
    1,3,15892880::bigint,74665::bigint,'provider_outcome_unknown')
  or j.billing_mode is distinct from 'openai_api' or j.policy_identity is not null
  or j.lease_token is not null or j.lease_expires_at is not null or j.finished_at is not null
  or j.input#>>'{policy,handlerVersion}' is distinct from 'strategy-openai-guided-v1'
  or not coalesce(fluid_private.api_text_guided_policy(j.operation,j.input->'policy'),false)
  or encode(sha256(convert_to(j.input::text,'UTF8')),'hex') is distinct from j.input_hash
  or not coalesce(fluid_private.api_text_testing_enabled(j.owner_id,j.operation),false)
  or (s.job_id,s.owner_id,s.project_id,s.state,s.step_key,s.request_key,s.provider_request_id,
      s.reserved_cost_microusd,s.actual_cost_microusd,s.completed_at)
   is distinct from (new.job_id,new.owner_id,new.project_id,'ambiguous',
    'strategy-openai-guided-v1:strategy.competitors:0d8273285a00846d419b430c',
    '8d98c0dd974e9cab53f8219dd47be631fb5d803798a8b4321ec72218456e60e3',
    'resp_0959915f311fe770016ad02385554087d29b4acba26b8d485b',15892880::bigint,74665::bigint,
    '2026-10-15 00:51:40.064741+00'::timestamptz)
  or s.output->>'error' is distinct from 'provider_unexpected_output'
  or encode(sha256(convert_to(s.output::text,'UTF8')),'hex') is distinct from new.output_sha256
  or (select count(*) from public.job_steps where job_id=j.id)<>1
  or (r.owner_id,r.project_id,r.reserved_microusd,r.actual_microusd,r.captured_microusd,r.state)
   is distinct from (new.owner_id,new.project_id,15892880::bigint,74665::bigint,74665::bigint,'active')
  or (d.owner_id,d.project_id,d.policy_identity,d.deployment_id,d.dispatch_identity,d.publication_generation,d.published_at)
   is distinct from (new.owner_id,new.project_id,
    'aec17e433d66a556c6762a1c945b83464e4a4ac4851ac91118df4c2eddbe739b',
    'dpl_AsMYHhJeVxxMtmfRmRM1QT379Shd','74dd47827976d8e6b83f39f146019cd7f11c7cb343aaf5a10d8212ecc0e1ce77',
    0,'2026-10-15 00:51:15.830025+00'::timestamptz)
  or (a.owner_id,a.maximum_cost_microusd) is distinct from (new.owner_id,15892880::bigint)
  or t.job_id is distinct from j.id or ledger.owner_id is distinct from j.owner_id
  or ledger.reserved_microusd is distinct from (select coalesce(sum(greatest(reserved_microusd-actual_microusd,0)),0)
    from public.usage_reservations where owner_id=j.owner_id and state='active') then
  raise exception 'research_adjudication_evidence_mismatch' using errcode='55000';
 end if;
 new.job_sha256:=encode(sha256(convert_to((to_jsonb(j)-array['state','error_code','finished_at'])::text,'UTF8')),'hex');
 new.step_sha256:=encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex');
 new.reservation_sha256:=encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex');
 new.dispatch_sha256:=encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex');
 new.admission_sha256:=encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex');
 new.testing_marker_sha256:=encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex');
 new.ledger_before:=to_jsonb(ledger);
 new.original_job_state:=j.state; new.original_job_error:=j.error_code;
 new.operator_role:=current_user; new.operator_session:=session_user; new.recorded_at:=clock_timestamp();
 -- No step, reservation, account, project, input, dispatch or allowance write.
 update public.jobs set state='failed',error_code='operator_abandoned_billing_unresolved',finished_at=new.recorded_at
 where id=j.id;
 return new;
end $$;
create trigger research_operator_adjudication_insert before insert on fluid_private.api_text_operator_adjudications
 for each row execute function fluid_private.record_research_operator_adjudication();
create trigger research_operator_adjudication_immutable before update or delete on fluid_private.api_text_operator_adjudications
 for each row execute function fluid_private.record_research_operator_adjudication();
create trigger research_operator_adjudication_no_truncate before truncate on fluid_private.api_text_operator_adjudications
 for each statement execute function fluid_private.record_research_operator_adjudication();

-- Recheck every bound row on every use. A receipt cannot mask a new step,
-- changed evidence, released hold, restarted job, or changed publication.
create function fluid_private.research_operator_adjudication_matches(p_job uuid)
returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.api_text_operator_adjudications x
  join public.jobs j on j.id=x.job_id and j.owner_id=x.owner_id and j.project_id=x.project_id
  join public.job_steps s on s.id=x.step_id and s.job_id=j.id and s.owner_id=j.owner_id and s.project_id=j.project_id
  join public.usage_reservations r on r.job_id=j.id and r.owner_id=j.owner_id and r.project_id=j.project_id
  join fluid_private.api_text_dispatches d on d.job_id=j.id
  join fluid_private.api_text_allowance_admissions a on a.job_id=j.id
  join fluid_private.api_text_testing_admissions t on t.job_id=j.id
  join public.usage_accounts ledger on ledger.owner_id=j.owner_id
  where x.job_id=p_job and j.state='failed' and j.error_code='operator_abandoned_billing_unresolved'
   and j.finished_at=x.recorded_at and j.lease_token is null and j.lease_expires_at is null
   and s.state='ambiguous' and r.state='active'
   and (select count(*) from public.job_steps where job_id=j.id)=1
   and encode(sha256(convert_to((to_jsonb(j)-array['state','error_code','finished_at'])::text,'UTF8')),'hex')=x.job_sha256
   and encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex')=x.step_sha256
   and encode(sha256(convert_to(s.output::text,'UTF8')),'hex')=x.output_sha256
   and encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex')=x.reservation_sha256
   and encode(sha256(convert_to(to_jsonb(d)::text,'UTF8')),'hex')=x.dispatch_sha256
   and encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex')=x.admission_sha256
   and encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex')=x.testing_marker_sha256
   and ledger.reserved_microusd>=x.retained_microusd
   and ledger.reserved_microusd=(select coalesce(sum(greatest(reserved_microusd-actual_microusd,0)),0)
    from public.usage_reservations where owner_id=j.owner_id and state='active'));
$$;

-- Keep known overruns outside the exception. No other paused row is excluded.
create or replace function fluid_private.api_text_paid_paused(p_owner uuid) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.jobs j where j.owner_id=p_owner and j.billing_mode='openai_api'
 and (j.actual_cost_microusd>j.reserved_cost_microusd or
  ((j.state='needs_reconciliation' or exists(select 1 from public.job_steps s where s.job_id=j.id and s.state='ambiguous'))
   and not fluid_private.research_operator_adjudication_matches(j.id))));
$$;
create or replace function fluid_private.api_text_allowance_paused() returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from fluid_private.api_text_allowance_admissions a join public.jobs j on j.id=a.job_id
  where j.actual_cost_microusd>a.maximum_cost_microusd or
   ((j.state='needs_reconciliation' or exists(select 1 from public.job_steps s where s.job_id=j.id and s.state='ambiguous'))
    and not fluid_private.research_operator_adjudication_matches(j.id)));
$$;

do $deny$
declare object_id oid; privilege record;
begin
 alter table fluid_private.api_text_operator_adjudications enable row level security;
 alter table fluid_private.api_text_operator_adjudications force row level security;
 revoke all on fluid_private.api_text_operator_adjudications from public,anon,authenticated,service_role;
 for privilege in select distinct a.grantee from pg_catalog.pg_class c,
  lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  where c.oid='fluid_private.api_text_operator_adjudications'::regclass and a.grantee<>c.relowner loop
  execute format('revoke all on fluid_private.api_text_operator_adjudications from %s cascade',
   case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
 end loop;
 foreach object_id in array array['fluid_private.record_research_operator_adjudication()'::regprocedure,
  'fluid_private.research_operator_adjudication_matches(uuid)'::regprocedure] loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',object_id::regprocedure);
  for privilege in select distinct a.grantee from pg_catalog.pg_proc p,
   lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid=object_id and a.grantee<>p.proowner loop
   execute format('revoke all on function %s from %s cascade',object_id::regprocedure,
    case when privilege.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(privilege.grantee)) end);
  end loop;
 end loop;
 if exists(select 1 from research_adjudication_original_functions old
  left join pg_catalog.pg_proc p on p.oid=old.oid
  where p.oid is null or (p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proleakproof)
   is distinct from (old.proowner,old.proacl,old.prosecdef,old.provolatile,old.proconfig,old.proleakproof)) then
  raise exception 'research_adjudication_security_changed'; end if;
end $deny$;
commit;
