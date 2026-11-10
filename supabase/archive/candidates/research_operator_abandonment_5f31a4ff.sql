-- REVIEW-ONLY: extends the existing operator mechanism to a second exact job.
-- Installs no receipt, releases no hold, publishes no result, and grants nothing.
-- The separate apply packet records the deliberate operator decision. The
-- original incident/receipt and every pause predicate remain unchanged.
begin;
create temporary table research_adjudication_extension_functions on commit drop as
 select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof,md5(prosrc) source_md5
 from pg_catalog.pg_proc where oid in (
  'fluid_private.record_research_operator_adjudication()'::regprocedure,
  'fluid_private.research_operator_adjudication_matches(uuid)'::regprocedure,
  'fluid_private.api_text_paid_paused(uuid)'::regprocedure,
  'fluid_private.api_text_allowance_paused()'::regprocedure);
create temporary table research_adjudication_extension_receipts on commit drop as
 select * from fluid_private.api_text_operator_adjudications;
create temporary table research_adjudication_extension_security on commit drop as
 select relowner,relacl,relrowsecurity,relforcerowsecurity from pg_catalog.pg_class
 where oid='fluid_private.api_text_operator_adjudications'::regclass;
do $guard$
declare signature text; expected text;
begin
 for signature,expected in values
  ('fluid_private.record_research_operator_adjudication()','e6a1f54f15666b89447de29fa715b1cc'),
  ('fluid_private.research_operator_adjudication_matches(uuid)','22d1c318d1bf7b535fb3bdf0ce8d7e66'),
  ('fluid_private.api_text_paid_paused(uuid)','c56c43eaeb7007aa3668e798e044df8e'),
  ('fluid_private.api_text_allowance_paused()','e0721ff6199194ef1a29c4d7fe34b2de') loop
  if not exists(select 1 from pg_catalog.pg_proc p where p.oid=signature::regprocedure
   and md5(p.prosrc)=expected and not p.prosecdef
   and p.provolatile=case when signature='fluid_private.record_research_operator_adjudication()' then 'v' else 's' end
   and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user)) then
   raise exception 'unexpected_research_adjudication_extension_predecessor: %',signature;
  end if;
 end loop;
 if not exists(select 1 from research_adjudication_extension_security
  where relowner=(select oid from pg_catalog.pg_roles where rolname=current_user) and relrowsecurity and relforcerowsecurity) then
  raise exception 'unexpected_research_adjudication_extension_table'; end if;
end $guard$;

-- Retain owner, decision, external authorization-reference, reason, reservation,
-- foreign-key and primary-key constraints. A composite check prevents mixing
-- identities, source versions or costs across the two allowed incidents.
alter table fluid_private.api_text_operator_adjudications
 drop constraint api_text_operator_adjudications_job_id_check,
 drop constraint api_text_operator_adjudications_project_id_check,
 drop constraint api_text_operator_adjudications_step_id_check,
 drop constraint api_text_operator_adjudications_output_sha256_check,
 drop constraint api_text_operator_adjudications_source_revision_check,
 drop constraint api_text_operator_adjudications_source_adapter_sha256_check,
 drop constraint api_text_operator_adjudications_observed_microusd_check,
 drop constraint api_text_operator_adjudications_retained_microusd_check,
 add constraint api_text_operator_adjudications_exact_incident_check check (
  (job_id,project_id,step_id,output_sha256,source_revision,source_adapter_sha256,observed_microusd,retained_microusd) in (
   ('6b310a38-eadf-4d64-9474-b7632cfa2340','8aa59964-7057-4a96-8142-82561fc5ffda','bf70b5ce-3a48-4b8d-92c0-f4e29b145595','c787e1485edc74f13cd1d03736b536933b7a3c75fc9f5ac826e7890977382dde','af6faf18912cc24afb37179a6988a11f83cf9cdf','419acb2adcdb5bf27ee99f92bf3f737876efad9ca8c4a7c1836f1c00a68a1255',74665,15818215),
   ('5f31a4ff-f747-4464-bc79-64b757fe5df3','4da54b89-43b8-4da6-a092-ce6113fd3916','a4794328-be5e-4c7e-a6b0-9a6f007e0f05','2182808eb117289a1e340943063c4033fbaef6ff534c030965a20578353e3a6c','4c0bbf362e8c85132f9d5068ec25dc771ef5cd5b','d37e4c528334e7099d042d835d2cebc75cc06d214c2b52deb3299e38441888a9',81399,15811481)
  ));

create or replace function fluid_private.record_research_operator_adjudication()
returns trigger language plpgsql set search_path='' as $$
declare j public.jobs; s public.job_steps; r public.usage_reservations;
 d fluid_private.api_text_dispatches; a fluid_private.api_text_allowance_admissions;
 t fluid_private.api_text_testing_admissions; ledger public.usage_accounts; incident record;
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
 -- Literal evidence tuples allow only the two individually reviewed incidents.
 -- This is not a general provider-failure bypass or a runtime registration API.
 select * into incident from (values
  ('6b310a38-eadf-4d64-9474-b7632cfa2340'::uuid,
   '8aa59964-7057-4a96-8142-82561fc5ffda'::uuid,
   'bf70b5ce-3a48-4b8d-92c0-f4e29b145595'::uuid,
   '8db2a72d2376339aad0bdde50f2097ab98d84e6bfa1aeb05fed6542d28efe6ef'::text,
   '36e8eb404ddd2553e88c99e60fb7269546bb639938af1d54f5b7e106a2cd2a09'::text,
   'strategy-openai-guided-v1:strategy.competitors:0d8273285a00846d419b430c'::text,
   '8d98c0dd974e9cab53f8219dd47be631fb5d803798a8b4321ec72218456e60e3'::text,
   'resp_0959915f311fe770016ad02385554087d29b4acba26b8d485b'::text,
   '2026-10-15 00:51:40.064741+00'::timestamptz,
   'dpl_AsMYHhJeVxxMtmfRmRM1QT379Shd'::text,
   '74dd47827976d8e6b83f39f146019cd7f11c7cb343aaf5a10d8212ecc0e1ce77'::text,
   '2026-10-15 00:51:15.830025+00'::timestamptz,
   74665::bigint),
  ('5f31a4ff-f747-4464-bc79-64b757fe5df3'::uuid,
   '4da54b89-43b8-4da6-a092-ce6113fd3916'::uuid,
   'a4794328-be5e-4c7e-a6b0-9a6f007e0f05'::uuid,
   'fcf1028e9f40eca0bf4b24187593b7251fac4701589e387840e591919d3e0332'::text,
   'd7caefe8330aaae7a052f0637c6e4b7da54a0514ab8352387ba610453ab528b6'::text,
   'strategy-openai-guided-v1:strategy.competitors:3358af25ab3cafbf9b34ad16'::text,
   'fbb6da4354b3ca12e5e56415b97800a1d0b34e311f39a35d34dc76129b0d6d42'::text,
   'resp_01fb73b509bba760016ad0313774d487d2911a901d0890e66e'::text,
   '2026-10-15 01:50:07.395506+00'::timestamptz,
   'dpl_dH4b38QkzS5sQnFDuYHZgsVv84Jy'::text,
   '3332203ce900ff11305e3b8e9f3278dfea93bbda03ae2aa3c021fc797124e1a0'::text,
   '2026-10-15 01:49:38.166426+00'::timestamptz,
   81399::bigint)
 ) as evidence(job_id,project_id,step_id,input_hash,plan_fingerprint,step_key,request_key,response_id,completed_at,deployment_id,dispatch_identity,published_at,observed_microusd) where evidence.job_id=new.job_id;
 if not found then raise exception 'research_adjudication_evidence_mismatch' using errcode='55000'; end if;
 if new.job_id<>incident.job_id
  or new.owner_id<>'6840f4c2-15a6-45a7-97be-41e7e5e37f42'
  or new.project_id<>incident.project_id
  or new.step_id<>incident.step_id
  or (j.id,j.owner_id,j.project_id,j.operation,j.input_revision,j.input_hash,j.plan_fingerprint,j.state,
      j.attempts,j.max_attempts,j.reserved_cost_microusd,j.actual_cost_microusd,j.error_code)
   is distinct from (new.job_id,new.owner_id,new.project_id,'strategy.competitors',1,
    incident.input_hash,
    incident.plan_fingerprint,'needs_reconciliation',
    1,3,15892880::bigint,incident.observed_microusd,'provider_outcome_unknown')
  or j.billing_mode is distinct from 'openai_api' or j.policy_identity is not null
  or j.lease_token is not null or j.lease_expires_at is not null or j.finished_at is not null
  or j.input#>>'{policy,handlerVersion}' is distinct from 'strategy-openai-guided-v1'
  or not coalesce(fluid_private.api_text_guided_policy(j.operation,j.input->'policy'),false)
  or encode(sha256(convert_to(j.input::text,'UTF8')),'hex') is distinct from j.input_hash
  or not coalesce(fluid_private.api_text_testing_enabled(j.owner_id,j.operation),false)
  or (s.job_id,s.owner_id,s.project_id,s.state,s.step_key,s.request_key,s.provider_request_id,
      s.reserved_cost_microusd,s.actual_cost_microusd,s.completed_at)
   is distinct from (new.job_id,new.owner_id,new.project_id,'ambiguous',
    incident.step_key,
    incident.request_key,
    incident.response_id,15892880::bigint,incident.observed_microusd,
    incident.completed_at)
  or s.output->>'error' is distinct from 'provider_unexpected_output'
  or encode(sha256(convert_to(s.output::text,'UTF8')),'hex') is distinct from new.output_sha256
  or (select count(*) from public.job_steps where job_id=j.id)<>1
  or (r.owner_id,r.project_id,r.reserved_microusd,r.actual_microusd,r.captured_microusd,r.state)
   is distinct from (new.owner_id,new.project_id,15892880::bigint,incident.observed_microusd,incident.observed_microusd,'active')
  or (d.owner_id,d.project_id,d.policy_identity,d.deployment_id,d.dispatch_identity,d.publication_generation,d.published_at)
   is distinct from (new.owner_id,new.project_id,
    'aec17e433d66a556c6762a1c945b83464e4a4ac4851ac91118df4c2eddbe739b',
    incident.deployment_id,incident.dispatch_identity,
    0,incident.published_at)
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

do $preservation$
begin
 if exists(select 1 from research_adjudication_extension_functions old
  left join pg_catalog.pg_proc p on p.oid=old.oid where p.oid is null
   or (p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proleakproof)
    is distinct from (old.proowner,old.proacl,old.prosecdef,old.provolatile,old.proconfig,old.proleakproof)
   or (old.oid<>'fluid_private.record_research_operator_adjudication()'::regprocedure and md5(p.prosrc)<>old.source_md5)) then
  raise exception 'research_adjudication_extension_function_changed'; end if;
 if exists(select * from research_adjudication_extension_receipts except select * from fluid_private.api_text_operator_adjudications)
  or exists(select * from fluid_private.api_text_operator_adjudications except select * from research_adjudication_extension_receipts) then
  raise exception 'research_adjudication_extension_receipt_changed'; end if;
 if exists(select 1 from research_adjudication_extension_security old
  join pg_catalog.pg_class c on c.oid='fluid_private.api_text_operator_adjudications'::regclass
  where (c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) is distinct from
   (old.relowner,old.relacl,old.relrowsecurity,old.relforcerowsecurity)) then
  raise exception 'research_adjudication_extension_security_changed'; end if;
end $preservation$;
commit;
