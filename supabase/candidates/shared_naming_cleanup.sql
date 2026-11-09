-- UNAPPLIED. Remove the retired Naming generation machinery (November 2026).
-- Requires shared_naming_generation.sql. See docs/naming-rebuild-plan-20261108.md.
--
-- The previous Naming engines (ChatGPT-subscription batches, the naming brain,
-- progressive/local/hosted runtimes and brainstorm_v1) are no longer used. This
-- packet:
--  1. rewrites fifteen shared functions that still referred to them, deriving
--     each new body from the generic code it already wrapped;
--  2. drops the old Naming tables and functions (an explicit keep-list protects
--     the saved-names features and the new generation path);
--  3. ends old Naming jobs that were still open and releases their internal
--     usage holds, keeping the job rows as evidence;
--  4. removes the names those engines generated (old batches, workshop
--     variations and copies of removed names) with their likes, selections and
--     screening records. Names people added themselves and names from the new
--     generation path stay. A project's chosen name lives in its own context.
-- A final check fails the packet if any remaining function still names a
-- removed object.
begin;
set local lock_timeout='5s';

-- Predecessor bodies this packet was reviewed against.
do $guard$ declare expected jsonb:='{
 "public.begin_job_step(uuid,uuid,text,text,bigint)":"9989543965e1047747d11aa3e872fca0",
 "public.claim_job(text,integer)":"071ccf5747b8df66e57736324dce8143",
 "public.expire_job_leases()":"107f6db6bdec9a472c987e74651ef323",
 "public.request_job_cancel(uuid)":"56c8b7b3be338978343fb3a782d74d9d",
 "fluid_private.api_text_strategy_paused(uuid,text,uuid)":"6e79564e32a9c16cc965fd671a34aaa1",
 "fluid_private.local_prototype_owner_enabled(uuid)":"ce18e5e068aa930a8024f2b4fb4762bb",
 "fluid_private.local_prototype_unlimited_job(uuid)":"e3b11fd1df966e4ac2228f3c8d0fe496",
 "fluid_private.local_strategy_worker_owner()":"0ec315a16cc834f254de352abb835e4c",
 "fluid_private.naming_batch_dto(public.naming_batches)":"d36a3b8f5fbc2ca235ede4fc5cc92719",
 "fluid_private.naming_candidate_dto(public.name_candidates)":"045774e3c1487cf5fd650258932b500b",
 "fluid_private.naming_job_dto(public.naming_batches)":"f14fdcece1bf56f8d248c28cba046cc0",
 "fluid_private.project_deletion_worker(uuid)":"52597c5cb7bae17195a24cc63e9fc0b0",
 "fluid_private.settle_reservation(uuid)":"3547545242855b939bdc82d62bef2143",
 "fluid_private.shared_worker_legacy_lock_leased_job_v1(uuid,uuid)":"eda76e0b705bd8652b90c24f3b4a07b3",
 "fluid_private.naming_brain_legacy_batch_dto(public.naming_batches)":"e482e51b153a478eb38e9e924402f665",
 "fluid_private.naming_brain_legacy_candidate_dto(public.name_candidates)":"408c42ea0ed2eb997a7b34f486d38f37",
 "fluid_private.naming_brain_legacy_job_dto(public.naming_batches)":"5b0bdad9f923238c98bcc4797edc5f13",
 "fluid_private.naming_brain_legacy_lock(uuid,uuid)":"d1cd344d380b5e9085f40bee05320eea",
 "fluid_private.naming_brain_legacy_settle(uuid)":"01b8acaa197e9c7ae29995c586a1f04e"}'; fn record;
begin
 for fn in select key,value from jsonb_each_text(expected) loop
  if not exists(select 1 from pg_proc where oid=to_regprocedure(fn.key) and md5(prosrc)=fn.value) then
   raise exception 'naming_cleanup_predecessor %',fn.key using errcode='55000'; end if;
 end loop;
end $guard$;

-- 1a. Bodies that become exactly the generic code they wrapped. CREATE OR
-- REPLACE keeps each function's identity, owner and permissions.
do $derive$ declare pair text[]; d text;
begin
 foreach pair slice 1 in array array[
  ['fluid_private.naming_brain_legacy_candidate_dto(public.name_candidates)','fluid_private.naming_brain_legacy_candidate_dto(','fluid_private.naming_candidate_dto('],
  ['fluid_private.naming_brain_legacy_batch_dto(public.naming_batches)','fluid_private.naming_brain_legacy_batch_dto(','fluid_private.naming_batch_dto('],
  ['fluid_private.naming_brain_legacy_job_dto(public.naming_batches)','fluid_private.naming_brain_legacy_job_dto(','fluid_private.naming_job_dto('],
  ['fluid_private.naming_brain_legacy_settle(uuid)','fluid_private.naming_brain_legacy_settle(','fluid_private.settle_reservation(']] loop
  d:=pg_get_functiondef(to_regprocedure(pair[1]));
  if (length(d)-length(replace(d,'FUNCTION '||pair[2],'')))/length('FUNCTION '||pair[2])<>1 then raise exception 'naming_cleanup_derive %',pair[1]; end if;
  execute replace(d,'FUNCTION '||pair[2],'FUNCTION '||pair[3]);
 end loop;
end $derive$;

-- The generic job lock keeps its body under a neutral name; the shared wrapper
-- no longer has a Naming branch.
alter function fluid_private.naming_brain_legacy_lock(uuid,uuid) rename to shared_worker_base_lock_leased_job;
create or replace function fluid_private.shared_worker_legacy_lock_leased_job_v1(p_job_id uuid,p_lease_token uuid) returns public.jobs
language plpgsql set search_path='' as $$
 declare j public.jobs; begin
 select * into j from public.jobs where id=p_job_id;
 if not found then raise exception 'lease_lost' using errcode='PT409'; end if;
 if fluid_private.api_text_operation(j.operation) and exists(select 1 from fluid_private.local_prototype_jobs where job_id=j.id) then return fluid_private.lock_local_strategy_job(p_job_id,p_lease_token); end if;
 return fluid_private.shared_worker_base_lock_leased_job(p_job_id,p_lease_token); end $$;

-- The version 1 preference check stays, under a name that says what it is.
alter function fluid_private.naming_brain_legacy_preferences(jsonb) rename to naming_preferences_v1_valid;
do $prefs$ declare d text:=pg_get_functiondef('fluid_private.valid_naming_preferences(jsonb)'::regprocedure);
begin
 if (length(d)-length(replace(d,'fluid_private.naming_brain_legacy_preferences(','')))/length('fluid_private.naming_brain_legacy_preferences(')<>2 then
  raise exception 'naming_cleanup_preferences'; end if;
 execute replace(d,'fluid_private.naming_brain_legacy_preferences(','fluid_private.naming_preferences_v1_valid(');
end $prefs$;

-- 1b. Narrow edits. Each needle must occur the stated number of times.
do $edits$ declare e record; d text; n integer;
begin
 for e in select * from (values
  ('public.claim_job(text,integer)','not fluid_private.naming_brain_is_job(j)','j.operation<>''naming.generate''',1),
  ('public.expire_job_leases()','not fluid_private.naming_brain_is_job(jobs)','operation<>''naming.generate''',1),
  ('public.request_job_cancel(uuid)',E'\n ||case when fluid_private.naming_brain_is_job(v_job) then ''{"version":2,"billing_mode":"openai_api"}''::jsonb else ''{}''::jsonb end;',';',1),
  ('public.request_job_cancel(uuid)','if not fluid_private.shared_identity_job(v_job) then perform fluid_private.settle_reservation(p_job_id);end if;',
   'if not fluid_private.shared_identity_job(v_job) and v_job.operation<>''naming.generate'' then perform fluid_private.settle_reservation(p_job_id);end if;',1),
  -- A running Naming run is asked to stop through cancel_requested_at; its
  -- worker ends it, so its state stays running until then.
  ('public.request_job_cancel(uuid)',E'  elsif v_job.state = ''running'' then\n',
   E'  elsif v_job.state = ''running'' and v_job.operation = ''naming.generate'' then\n    update public.jobs set cancel_requested_at = coalesce(cancel_requested_at, clock_timestamp()) where id = p_job_id returning * into v_job;\n  elsif v_job.state = ''running'' then\n',1),
  ('fluid_private.api_text_strategy_paused(uuid,text,uuid)',E'\n  or exists(select 1 from fluid_private.naming_brain_runs r where r.owner_id=p_owner and r.observed_overrun)','',1),
  ('fluid_private.local_prototype_unlimited_job(uuid)',E'\n or exists(select 1 from fluid_private.naming_brain_runs r where r.job_id=j.id and r.owner_id=marker.owner_id and r.project_id=marker.project_id\n  and r.admitted_role_name=marker.role_name and r.admitted_role_oid=marker.role_oid and r.deployment_id=marker.deployment_id)','',1),
  ('fluid_private.project_deletion_worker(uuid)',' or coalesce(fluid_private.naming_brain_worker_owner()=p_owner_id,false)','',1),
  ('public.begin_job_step(uuid,uuid,text,text,bigint)',E'\n  and not fluid_private.hosted_naming_step_authority(v_job.id)','',1),
  ('public.begin_job_step(uuid,uuid,text,text,bigint)',E'\n    and not fluid_private.hosted_naming_step_authority(v_job.id)','',2)
 ) as x(fn,needle,replacement,expected) loop
  d:=pg_get_functiondef(to_regprocedure(e.fn));
  n:=(length(d)-length(replace(d,e.needle,'')))/length(e.needle);
  if n<>e.expected then raise exception 'naming_cleanup_edit % (% of %)',e.fn,n,e.expected; end if;
  execute replace(d,e.needle,e.replacement);
 end loop;
end $edits$;

-- The local prototype Strategy runtime required a Naming pilot binding. No such
-- binding exists any more, so these keep their empty-binding result.
create or replace function fluid_private.local_prototype_owner_enabled(p_owner uuid) returns boolean
language sql stable set search_path='' as $$ select false; $$;
create or replace function fluid_private.local_strategy_worker_owner() returns uuid
language sql stable set search_path='' as $$ select null::uuid; $$;

-- 2. Drop the old machinery: views and tables first (with their triggers), then
-- every Naming function outside the keep-list.
create temp table naming_cleanup_removed(name text primary key) on commit drop;
insert into naming_cleanup_removed
 select distinct p.proname::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in('public','fluid_private') and p.proname ~ '(naming|brainstorm)' and p.proname::text not in(
  'check_naming_context','ensure_naming_session','identity_naming_source','naming_batch_dto','naming_candidate_dto','naming_entry',
  'naming_expire_job','naming_finish_job','naming_generation_policy','naming_generation_policy_valid','naming_job_dto','naming_preference_dto',
  'naming_preferences_v1_valid','naming_project_dto','naming_readiness','naming_round_json','naming_run_json','naming_selection_dto',
  'naming_session_dto','naming_strategy_basis','naming_transform_dto','valid_naming_preferences',
  'get_naming_availability','get_naming_batch','get_naming_batches','get_naming_generation','get_naming_usage','get_project_naming',
  'save_naming_preferences','save_naming_view','shared_naming_worker_action','start_naming_run','stop_naming_run')
 union select c.relname::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='fluid_private' and c.relkind in('r','v')
  and c.relname ~ '^(naming_brain_|naming_brainstorm_|hosted_naming_|naming_worker_|naming_observation_recovery_audit$|shared_naming_(adoption_approvals|owner_bindings|owners|request_context)$)';

drop view if exists fluid_private.shared_naming_owners;
-- Functions that take an old table row depend on that table, and trigger
-- functions are depended on by their tables' triggers. So: functions first
-- (leaving trigger functions still in use), then tables, then the rest.
do $drop_first$ declare fn regprocedure;
begin
 for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  join naming_cleanup_removed r on r.name=p.proname::text where n.nspname in('public','fluid_private') loop
  begin execute format('drop function %s',fn); exception when dependent_objects_still_exist then null; end;
 end loop;
end $drop_first$;
drop table if exists fluid_private.naming_brainstorm_supplemental_members;
drop table if exists
 fluid_private.naming_brainstorm_delivery_recoveries, fluid_private.naming_brainstorm_publications, fluid_private.naming_brainstorm_events,
 fluid_private.naming_brainstorm_completions, fluid_private.naming_brainstorm_calls,
 fluid_private.naming_brain_receipt_current, fluid_private.naming_brain_receipt_totals, fluid_private.naming_brain_progressive_results,
 fluid_private.naming_brain_microbatches, fluid_private.naming_brain_progressive_plans, fluid_private.naming_brain_feed_entries,
 fluid_private.naming_brain_identity_index, fluid_private.naming_brain_prepared_sets, fluid_private.naming_brain_artifacts,
 fluid_private.naming_brain_stage_results, fluid_private.naming_brain_provider_records, fluid_private.naming_brain_receipts,
 fluid_private.naming_brain_calls, fluid_private.naming_brain_call_plans, fluid_private.naming_brain_intents,
 fluid_private.naming_brain_financial_evidence, fluid_private.naming_observation_recovery_audit, fluid_private.naming_brain_runs,
 fluid_private.naming_brain_preference_attestations, fluid_private.naming_brain_heads,
 fluid_private.hosted_naming_jobs, fluid_private.hosted_naming_capabilities, fluid_private.hosted_naming_admission_context,
 fluid_private.naming_worker_job_authority, fluid_private.naming_worker_leadership, fluid_private.naming_worker_gateway_context,
 fluid_private.shared_naming_adoption_approvals, fluid_private.shared_naming_owner_bindings, fluid_private.shared_naming_request_context,
 fluid_private.naming_brain_pilots;
do $drop_rest$ declare fn regprocedure;
begin
 for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  join naming_cleanup_removed r on r.name=p.proname::text where n.nspname in('public','fluid_private') loop
  execute format('drop function %s',fn);
 end loop;
end $drop_rest$;

-- 3. Old Naming jobs: end any still open, release internal holds, close their
-- worker executions. Job rows and recorded costs stay as evidence.
set constraints all immediate;
create temp table naming_cleanup_jobs on commit drop as
 select id from public.jobs where operation='naming.generate' and input->'version' is distinct from '3'::jsonb;
update public.usage_accounts a set reserved_microusd=a.reserved_microusd-x.held
 from (select r.owner_id,sum(greatest(r.reserved_microusd-r.actual_microusd,0)) held from public.usage_reservations r
  where r.job_id in(select id from naming_cleanup_jobs) and r.state<>'settled' group by r.owner_id) x where a.owner_id=x.owner_id;
update public.usage_reservations set state='settled' where job_id in(select id from naming_cleanup_jobs) and state<>'settled';
update public.jobs set state=case when state='queued' then 'cancelled' else 'failed' end,error_code='naming_engine_retired',
 lease_token=null,lease_expires_at=null,finished_at=coalesce(finished_at,clock_timestamp())
 where id in(select id from naming_cleanup_jobs) and state not in('succeeded','failed','cancelled','partial');
update fluid_private.shared_worker_executions set state='closed',closed_at=clock_timestamp()
 where job_id in(select id from naming_cleanup_jobs) and state<>'closed';

-- 4. Names the old engines generated, workshop variations and copies of them.
create temp table naming_cleanup_names on commit drop as
 select c.id from public.name_candidates c left join public.naming_batches b on b.id=c.batch_id
 where coalesce(b.engine_version,0) in(1,2) and c.batch_id is not null or c.origin->>'kind' in('generated','transform');
do $copies$ begin
 loop
  insert into naming_cleanup_names select c.id from public.name_candidates c
   where c.source_candidate_id in(select id from naming_cleanup_names) and c.id not in(select id from naming_cleanup_names);
  exit when not found;
 end loop;
end $copies$;
create temp table naming_cleanup_selections on commit drop as
 select s.id from public.name_selections s where s.candidate_id in(select id from naming_cleanup_names);
do $chain$ begin
 loop
  insert into naming_cleanup_selections select s.id from public.name_selections s
   where s.prior_selection_id in(select id from naming_cleanup_selections) and s.id not in(select id from naming_cleanup_selections);
  exit when not found;
 end loop;
end $chain$;

-- Saved naming history is immutable and guarded for deleted projects; this
-- one deliberate reset bypasses those user triggers. Constraints stay on.
alter table public.project_screening_records disable trigger user;
alter table public.name_selections disable trigger user;
alter table public.naming_sessions disable trigger user;
alter table public.name_retention disable trigger user;
alter table public.name_transforms disable trigger user;
alter table public.name_candidates disable trigger user;
alter table public.naming_batch_results disable trigger user;
alter table public.naming_batches disable trigger user;

update public.naming_sessions set current_selection_id=null where current_selection_id in(select id from naming_cleanup_selections);
delete from public.project_screening_records where selection_id in(select id from naming_cleanup_selections) or candidate_id in(select id from naming_cleanup_names);
delete from public.name_selections where id in(select id from naming_cleanup_selections);
delete from public.name_retention where candidate_id in(select id from naming_cleanup_names);
delete from public.name_candidates where id in(select id from naming_cleanup_names) and (transform_id is not null or source_candidate_id is not null);
delete from public.name_transforms where parent_candidate_id in(select id from naming_cleanup_names) or secondary_candidate_id in(select id from naming_cleanup_names)
 or not exists(select 1 from public.name_candidates c where c.transform_id=name_transforms.id);
delete from public.name_candidates where id in(select id from naming_cleanup_names);
delete from public.naming_batch_results where batch_id in(select id from public.naming_batches where engine_version in(1,2));
delete from public.naming_batches where engine_version in(1,2);

alter table public.project_screening_records enable trigger user;
alter table public.name_selections enable trigger user;
alter table public.naming_sessions enable trigger user;
alter table public.name_retention enable trigger user;
alter table public.name_transforms enable trigger user;
alter table public.name_candidates enable trigger user;
alter table public.naming_batch_results enable trigger user;
alter table public.naming_batches enable trigger user;

-- 5. Nothing that remains may name a removed object, and only runs remain.
do $verify$ declare leftover text;
begin
 select string_agg(distinct n.nspname||'.'||p.proname||' -> '||r.name,', ') into leftover
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join naming_cleanup_removed r on p.prosrc ~ ('\m'||r.name||'\M')
  where n.nspname in('public','fluid_private');
 if leftover is not null then raise exception 'naming_cleanup_reference %',leftover using errcode='55000'; end if;
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace join naming_cleanup_removed r on r.name=c.relname::text
   where n.nspname='fluid_private') then raise exception 'naming_cleanup_table_left' using errcode='55000'; end if;
 if exists(select 1 from public.naming_batches where engine_version<>3) or exists(select 1 from public.name_candidates where origin->>'kind' in('generated','transform'))
  or exists(select 1 from public.jobs where operation='naming.generate' and state in('queued','running','cancel_requested','needs_reconciliation')
   and input->'version' is distinct from '3'::jsonb) then raise exception 'naming_cleanup_data_left' using errcode='55000'; end if;
end $verify$;
commit;
