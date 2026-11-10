-- Approved Naming correction: 250 for new first admissions, legacy 100/50 retained.
-- User approval: 2026-10-05 04:12:33 UTC, [private approval receipt omitted].
-- No new grants, roles, policy changes, provider retries or historical rewrites.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.naming_batches drop constraint naming_batches_target_count_check;
alter table public.naming_batches add constraint naming_batches_target_count_check check (target_count in (100, 50, 250));

create or replace function public.enqueue_subscription_naming_job(p_project_id uuid,p_expected_project_revision integer,p_expected_preferences_version integer,p_expected_batch_sequence integer,p_idempotency_key text,p_accepted_policy_identity text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_session public.naming_sessions; v_project public.projects; v_revision public.project_revisions;
 v_batch public.naming_batches; v_job public.jobs; v_policy fluid_private.subscription_runtime_policy; v_input jsonb;v_exclusion_snapshot jsonb;
begin
 if v_owner is null then raise exception 'unauthenticated' using errcode='42501'; end if;
 if p_expected_project_revision is null or p_expected_project_revision<1 or p_expected_preferences_version is null or p_expected_preferences_version<1
  or p_expected_batch_sequence is null or p_expected_batch_sequence<0 or p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9._:-]{16,128}$'
  or p_accepted_policy_identity is null or p_accepted_policy_identity!~'^[0-9a-f]{64}$' then raise exception 'invalid_input' using errcode='22023'; end if;
 if not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'not_found' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_owner::text,723902));
 v_session:=fluid_private.ensure_naming_session(p_project_id,v_owner);
 select * into v_batch from public.naming_batches where owner_id=v_owner and idempotency_key=p_idempotency_key;
 if not found then
  if exists(select 1 from public.jobs where owner_id=v_owner and idempotency_key=p_idempotency_key) then raise exception 'idempotency_conflict' using errcode='23505'; end if;
  select * into v_batch from public.naming_batches where owner_id=v_owner and project_id=p_project_id and sequence=p_expected_batch_sequence+1;
 end if;
 if v_batch.id is not null then
  if (v_batch.project_id,v_batch.context_revision,v_batch.preferences_version,v_batch.sequence,v_batch.policy_identity)
   is distinct from(p_project_id,p_expected_project_revision,p_expected_preferences_version,p_expected_batch_sequence+1,p_accepted_policy_identity) then raise exception 'batch_intent_conflict' using errcode='PT409'; end if;
  return (public.get_naming_batch(p_project_id,v_batch.id)-'result')||jsonb_build_object('session',(select fluid_private.naming_session_dto(s) from public.naming_sessions s where project_id=p_project_id and owner_id=v_owner));
 end if;
 select * into strict v_project from public.projects where id=p_project_id and owner_id=v_owner;
 if v_project.current_revision<>p_expected_project_revision or coalesce(v_session.preferences_version,0)<>p_expected_preferences_version or v_session.batch_sequence<>p_expected_batch_sequence then raise exception 'naming_revision_conflict' using errcode='PT409'; end if;
 if exists(select 1 from public.jobs where owner_id=v_owner and project_id=p_project_id and operation='naming.generate' and state in('queued','running','cancel_requested')) then raise exception 'naming_active' using errcode='PT409'; end if;
 select * into strict v_revision from public.project_revisions where project_id=p_project_id and owner_id=v_owner and revision=p_expected_project_revision;
 if (fluid_private.naming_readiness(v_project.scope,v_revision.context)->>'ready')::boolean is not true then raise exception 'strategy_incomplete' using errcode='PT409'; end if;
 select * into v_policy from fluid_private.subscription_runtime_policy where owner_id=v_owner and operation='naming.generate' and enabled for share;
 if not found or v_policy.worker_ready_until is null or v_policy.worker_ready_until<=clock_timestamp() then raise exception 'runtime_unavailable' using errcode='P0001'; end if;
 if encode(sha256(convert_to(v_policy.policy::text,'UTF8')),'hex')<>p_accepted_policy_identity then raise exception 'policy_identity_conflict' using errcode='PT409'; end if;
 if (public.get_naming_availability(p_project_id)->>'status')<>'available' then raise exception 'quota_unavailable' using errcode='P0001'; end if;
 v_batch.id:=gen_random_uuid();v_batch.job_id:=gen_random_uuid();v_batch.owner_id:=v_owner;v_batch.project_id:=p_project_id;
 v_batch.context_revision:=p_expected_project_revision;v_batch.strategy_basis:=fluid_private.naming_strategy_basis(v_revision.context);v_batch.preferences_version:=p_expected_preferences_version;
 v_batch.sequence:=p_expected_batch_sequence+1;v_batch.target_count:=case when v_batch.sequence=1 then 250 else 50 end;
 v_batch.policy_identity:=p_accepted_policy_identity;v_batch.idempotency_key:=p_idempotency_key;v_batch.created_at:=clock_timestamp();
 select coalesce(jsonb_agg(jsonb_build_object('candidateId',c.id,'value',c.value) order by c.created_at,c.id),'[]') into v_batch.favorites_snapshot
  from public.name_candidates c join public.name_retention r on r.candidate_id=c.id and r.owner_id=c.owner_id and r.project_id=c.project_id where c.project_id=p_project_id and c.owner_id=v_owner and r.liked;
 select coalesce(jsonb_agg(identity_key order by identity_key),'[]') into v_batch.exclusion_keys from(select distinct identity_key from public.name_candidates where project_id=p_project_id and owner_id=v_owner and identity_key<>'') x;
 select coalesce(jsonb_agg(jsonb_build_object('candidateId',id,'value',value,'identityKey',identity_key) order by created_at,id),'[]') into v_exclusion_snapshot from public.name_candidates where project_id=p_project_id and owner_id=v_owner;
 if jsonb_array_length(v_exclusion_snapshot)>10000 or jsonb_array_length(v_batch.favorites_snapshot)>10000 or jsonb_array_length(v_batch.exclusion_keys)>10000 then raise exception 'naming_history_capacity' using errcode='PT409'; end if;
 v_input:=jsonb_build_object('version',1,'billingMode','chatgpt_subscription','context',v_revision.context,'policy',v_policy.policy,'batch',fluid_private.naming_batch_dto(v_batch),'exclusionKeys',v_batch.exclusion_keys,'exclusionSnapshot',v_exclusion_snapshot);
 if octet_length(v_input::text)>131072 or octet_length(to_jsonb(v_input::text)::text)+8192>(v_policy.policy#>>'{limits,maxInputBytes}')::integer then raise exception 'naming_history_capacity' using errcode='PT409'; end if;
 insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,reserved_cost_microusd,max_attempts,billing_mode,policy_identity)
 values(v_batch.job_id,v_owner,p_project_id,'naming.generate',p_expected_project_revision,v_revision.input_hash,v_input,p_idempotency_key,0,1,'chatgpt_subscription',p_accepted_policy_identity) returning * into v_job;
 insert into public.naming_batches select (v_batch).*;
 update public.naming_sessions set batch_sequence=v_batch.sequence,revision=revision+1,updated_at=clock_timestamp() where project_id=p_project_id and owner_id=v_owner;
 return (public.get_naming_batch(p_project_id,v_batch.id)-'result')||jsonb_build_object('session',(select fluid_private.naming_session_dto(s) from public.naming_sessions s where project_id=p_project_id and owner_id=v_owner));
end $$;
