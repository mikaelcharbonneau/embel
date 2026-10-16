-- One owner-confirmed stop-and-delete intent. No worker deployment, new queue,
-- provider call, quota grant, forced reconciliation, erasure or fake refund.
begin;
alter table public.projects add column deletion_requested_at timestamptz
  check(deletion_requested_at is null or isfinite(deletion_requested_at));
-- Write-once provenance for an already-admitted job's deletion cancellation.
-- It survives Restore so a real in-flight subscription result can still settle.
alter table public.jobs add column project_deletion_requested_at timestamptz
  check(project_deletion_requested_at is null or isfinite(project_deletion_requested_at));
create index projects_owner_deletion_requested on public.projects(owner_id,created_at desc,id desc)
  where deletion_requested_at is not null;

-- Completion is derived from durable evidence, never a job->project write from
-- a worker/settlement trigger. Resolved partial results are terminal and retained.
create function fluid_private.project_deletion_state(p_project_id uuid,p_owner_id uuid)
returns text language plpgsql stable set search_path='' as $$
declare p public.projects;
begin
  select * into p from public.projects where id=p_project_id and owner_id=p_owner_id;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if p.deleted_at is not null then return 'deleted'; end if;
  if p.deletion_requested_at is null then return 'active'; end if;
  if exists(select 1 from public.jobs j where j.project_id=p.id and j.owner_id=p.owner_id and j.state='needs_reconciliation')
    or exists(select 1 from public.job_steps s join public.jobs j on j.id=s.job_id and j.owner_id=s.owner_id and j.project_id=s.project_id
      where j.project_id=p.id and j.owner_id=p.owner_id and (s.state='ambiguous'
        or (s.state='in_flight' and j.state not in ('queued','running','cancel_requested'))))
    or exists(select 1 from public.usage_reservations r join public.jobs j on j.id=r.job_id and j.owner_id=r.owner_id and j.project_id=r.project_id
      where r.project_id=p.id and r.owner_id=p.owner_id and r.state='active' and j.state not in ('queued','running','cancel_requested')) then
    return 'awaiting_resolution';
  end if;
  if exists(select 1 from public.jobs j where j.project_id=p.id and j.owner_id=p.owner_id
    and (j.state in ('queued','running','cancel_requested') or j.lease_token is not null)) then return 'stopping'; end if;
  if exists(select 1 from public.usage_reservations r where r.project_id=p.id and r.owner_id=p.owner_id and r.state='active') then return 'awaiting_resolution'; end if;
  return 'deleted';
end $$;

create function fluid_private.project_deletion_summary(p_project_id uuid,p_owner_id uuid)
returns jsonb language sql stable set search_path='' as $$
  select to_jsonb(p)||jsonb_build_object('deletion_state',fluid_private.project_deletion_state(p.id,p.owner_id))
    from public.projects p where p.id=p_project_id and p.owner_id=p_owner_id;
$$;

-- Positive existing worker identities only; a missing JWT alone is never a
-- publication capability. Gateway owner context is already checked by its helper.
create function fluid_private.project_deletion_worker(p_owner_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(public.subscription_worker_owner()=p_owner_id,false)
    or coalesce(public.api_text_worker_owner()=p_owner_id,false)
    or coalesce(fluid_private.logo_worker_owner()=p_owner_id,false);
$$;

-- Existing content grants and lease checks still authorize every worker write.
-- Browser/manual transactions carry auth.uid(); worker SQL identities do not.
-- Freeze owner edits during stopping but allow already-admitted worker outputs
-- until terminal settlement. Historical accounting/audit exclusions are unchanged.
create or replace function fluid_private.guard_project_content_lifecycle()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_link record; p public.projects;
begin
  for v_link in select NEW.project_id as project_id,NEW.owner_id as owner_id where TG_OP<>'DELETE'
    union select OLD.project_id,OLD.owner_id where TG_OP<>'INSERT'
  loop
    if v_link.project_id is null then continue; end if;
    select * into p from public.projects where id=v_link.project_id and owner_id=v_link.owner_id;
    if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
    if p.deleted_at is not null or (p.deletion_requested_at is not null and
      (not fluid_private.project_deletion_worker(p.owner_id) or fluid_private.project_deletion_state(p.id,p.owner_id)='deleted')) then
      raise exception 'project_deleted' using errcode='PT409';
    end if;
  end loop;
  if TG_OP='DELETE' then return OLD; end if;
  return NEW;
end $$;

-- Storage uses the existing exact persisted-path guard. New owner uploads stop;
-- existing leased workers retain their authorized publication path while stopping.
create or replace function fluid_private.require_active_project(p_project_id uuid,p_owner_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare p public.projects;
begin
  select * into p from public.projects where id=p_project_id and owner_id=p_owner_id for share;
  if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
  if p.deleted_at is not null or (p.deletion_requested_at is not null and
    (not fluid_private.project_deletion_worker(p.owner_id) or fluid_private.project_deletion_state(p.id,p.owner_id)='deleted')) then
    raise exception 'project_deleted' using errcode='PT409';
  end if;
end $$;

create or replace function fluid_private.guard_project_job_admission()
returns trigger language plpgsql security definer set search_path='' as $$
declare p public.projects;
begin
  if TG_OP='INSERT' or (NEW.project_id,NEW.owner_id) is distinct from (OLD.project_id,OLD.owner_id)
    or (NEW.state in ('queued','running','partial','cancel_requested','needs_reconciliation') and OLD.state in ('succeeded','failed','cancelled')) then
    select * into p from public.projects where id=NEW.project_id and owner_id=NEW.owner_id for share;
    if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
    if p.deleted_at is not null or p.deletion_requested_at is not null then raise exception 'project_deleted' using errcode='PT409'; end if;
  elsif NEW.state in ('queued','running') and NEW.state is distinct from OLD.state then
    -- No new job->project lock on claim/retry. The stop transaction atomically
    -- locks/cancels every pre-existing job; INSERT uses the strong fence above.
    if exists(select 1 from public.projects where id=NEW.project_id and owner_id=NEW.owner_id
      and (deleted_at is not null or deletion_requested_at is not null)) then
      raise exception 'project_deleted' using errcode='PT409';
    end if;
  end if;
  return NEW;
end $$;

create or replace function fluid_private.guard_project_lifecycle_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (NEW.deleted_at,NEW.deletion_requested_at) is distinct from (OLD.deleted_at,OLD.deletion_requested_at) then
    if current_setting('transaction_isolation') not in ('read committed','read uncommitted') then
      raise exception 'lifecycle_requires_read_committed' using errcode='40001';
    end if;
    if NEW.lifecycle_version<>OLD.lifecycle_version+1
      or (NEW.deleted_at is not null and NEW.deletion_requested_at is not null)
      or (NEW.deleted_at is not null and OLD.deleted_at is not null)
      or (NEW.deletion_requested_at is not null and OLD.deletion_requested_at is not null)
      or (to_jsonb(NEW)-array['deleted_at','deletion_requested_at','lifecycle_version']) is distinct from
        (to_jsonb(OLD)-array['deleted_at','deletion_requested_at','lifecycle_version']) then
      raise exception 'invalid_lifecycle_transition' using errcode='22023';
    end if;
    -- Preserve the original direct-delete contract for older clients. Only the
    -- new explicit stop intent is allowed to cancel work through the new RPC.
    if NEW.deleted_at is not null and (exists(select 1 from public.jobs where project_id=OLD.id and owner_id=OLD.owner_id
      and state in ('queued','running','partial','cancel_requested','needs_reconciliation'))
      or exists(select 1 from public.usage_reservations where project_id=OLD.id and owner_id=OLD.owner_id and state='active')) then
      raise exception 'project_busy' using errcode='PT409';
    end if;
  elsif NEW.lifecycle_version<>OLD.lifecycle_version then
    raise exception 'invalid_lifecycle_transition' using errcode='22023';
  elsif NEW is distinct from OLD and (OLD.deleted_at is not null or (OLD.deletion_requested_at is not null and
    (not fluid_private.project_deletion_worker(OLD.owner_id) or fluid_private.project_deletion_state(OLD.id,OLD.owner_id)='deleted'))) then
    raise exception 'project_deleted' using errcode='PT409';
  end if;
  return NEW;
end $$;

create function public.request_project_deletion(p_project_id uuid,p_expected_revision integer,p_expected_lifecycle_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); p public.projects; j public.jobs;
begin
  if v_owner is null then raise exception 'authentication_required' using errcode='42501'; end if;
  if p_expected_revision is null or p_expected_revision<1 or p_expected_lifecycle_version is null
    or p_expected_lifecycle_version not between 0 and 2147483646 then raise exception 'invalid_lifecycle_request' using errcode='22023'; end if;
  -- Identity/existence before any owner lock. This never discloses a foreign ID.
  if not exists(select 1 from public.projects where id=p_project_id and owner_id=v_owner) then raise exception 'project_not_found' using errcode='P0002'; end if;
  -- Same advisory identity used by lock_strategy_owner. All additional locks
  -- are NOWAIT in this owner-request transaction only: a contended child/account
  -- can never form a project->job/ledger cycle with a paid worker. Retry means
  -- the entire request rolled back, including intent and reservation changes.
  if not pg_try_advisory_xact_lock(hashtextextended(v_owner::text,723902)) then
    raise exception 'deletion_lock_busy' using errcode='55P03';
  end if;
  perform 1 from fluid_private.strategy_billing_routes where owner_id=v_owner for update nowait;
  perform 1 from public.usage_accounts where owner_id=v_owner for update nowait;
  select * into p from public.projects where id=p_project_id and owner_id=v_owner for update nowait;
  if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
  -- Lost HTTP acknowledgements replay only their exact still-current epoch.
  -- Withdrawal/Restore increments the epoch, so a late retry cannot re-delete.
  if p.deletion_requested_at is not null and p.current_revision=p_expected_revision
    and p.lifecycle_version=p_expected_lifecycle_version+1 then return fluid_private.project_deletion_summary(p.id,v_owner); end if;
  if p.current_revision<>p_expected_revision or p.lifecycle_version<>p_expected_lifecycle_version
    or p.deleted_at is not null or p.deletion_requested_at is not null then raise exception 'lifecycle_conflict' using errcode='PT409'; end if;
  perform j0.id from public.jobs j0 where j0.project_id=p.id and j0.owner_id=v_owner order by j0.id for update nowait;
  perform r.job_id from public.usage_reservations r where r.project_id=p.id and r.owner_id=v_owner order by r.job_id for update nowait;
  update public.projects set deletion_requested_at=clock_timestamp(),lifecycle_version=lifecycle_version+1 where id=p.id and owner_id=v_owner;
  for j in select * from public.jobs where project_id=p.id and owner_id=v_owner order by id loop
    if j.state='queued' then
      -- begin_job_step is durable before any potentially billed request. A prior
      -- predispatch claim alone (attempts>0) is not evidence of provider spending.
      if j.actual_cost_microusd=0 and j.lease_token is null
        and not exists(select 1 from public.job_steps where job_id=j.id)
        and not exists(select 1 from public.subscription_job_partials where job_id=j.id)
        and not exists(select 1 from public.logo_provider_responses where job_id=j.id)
        and not exists(select 1 from public.logo_asset_publications where job_id=j.id)
        and not exists(select 1 from public.logo_direction_publications where job_id=j.id)
        and not exists(select 1 from public.logo_export_publications where job_id=j.id) then
        perform public.request_job_cancel(j.id);
      else
        update public.jobs set state='needs_reconciliation',cancel_requested_at=coalesce(cancel_requested_at,clock_timestamp()),
          error_code=coalesce(error_code,'deletion_stop_requires_review') where id=j.id and owner_id=v_owner;
      end if;
    elsif j.state in ('running','cancel_requested') then
      update public.jobs set project_deletion_requested_at=coalesce(project_deletion_requested_at,clock_timestamp()) where id=j.id and owner_id=v_owner;
      if j.state='running' then perform public.request_job_cancel(j.id); end if;
    elsif j.state='needs_reconciliation' then
      perform public.request_job_cancel(j.id);
    end if;
  end loop;
  return fluid_private.project_deletion_summary(p.id,v_owner);
exception when lock_not_available then
  raise exception 'project_deletion_retry' using errcode='PT409';
end $$;

create function public.restore_project_deletion(p_project_id uuid,p_expected_revision integer,p_expected_lifecycle_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); p public.projects;
begin
  if v_owner is null then raise exception 'authentication_required' using errcode='42501'; end if;
  select * into p from public.projects where id=p_project_id and owner_id=v_owner for update;
  if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
  if p_expected_revision is null or p_expected_revision<1 or p_expected_lifecycle_version is null
    or p_expected_lifecycle_version not between 0 and 2147483646 then raise exception 'invalid_lifecycle_request' using errcode='22023'; end if;
  if p.current_revision<>p_expected_revision or p.lifecycle_version<>p_expected_lifecycle_version
    or (p.deleted_at is null and p.deletion_requested_at is null) then raise exception 'lifecycle_conflict' using errcode='PT409'; end if;
  update public.projects set deleted_at=null,deletion_requested_at=null,lifecycle_version=lifecycle_version+1 where id=p.id and owner_id=v_owner;
  -- Cancellation already requested remains intact. Restore never queues work.
  return fluid_private.project_deletion_summary(p.id,v_owner);
end $$;

create function public.get_project_deletion(p_project_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); result jsonb;
begin
  if v_owner is null then raise exception 'authentication_required' using errcode='42501'; end if;
  result:=fluid_private.project_deletion_summary(p_project_id,v_owner);
  if result is null then raise exception 'project_not_found' using errcode='P0002'; end if;
  return result;
end $$;

create function public.get_project_deletion_states(p_project_ids uuid[])
returns table(id uuid,owner_id uuid,current_revision integer,lifecycle_version integer,deleted_at timestamptz,deletion_requested_at timestamptz,deletion_state text)
language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null then raise exception 'authentication_required' using errcode='42501'; end if;
  if p_project_ids is null or cardinality(p_project_ids)>100 or array_position(p_project_ids,null) is not null
    or cardinality(p_project_ids)<>(select count(distinct item) from unnest(p_project_ids) item) then raise exception 'invalid_project_ids' using errcode='22023'; end if;
  return query select p.id,p.owner_id,p.current_revision,p.lifecycle_version,p.deleted_at,p.deletion_requested_at,
    fluid_private.project_deletion_state(p.id,p.owner_id) from public.projects p where p.owner_id=v_owner and p.id=any(p_project_ids);
end $$;

-- Exact deployed predecessor only. Preserve its signature, OID, ownership and
-- ACL; do not silently overwrite an independently changed settlement contract.
do $$ begin
  if not exists(select 1 from pg_proc where oid='fluid_private.complete_job_step_core(uuid,uuid,text,text,bigint,jsonb,text)'::regprocedure
    and encode(sha256(convert_to(prosrc,'UTF8')),'hex')='38c408ae10cf01534172e0f5c0a0880467b2a9317da349292b7b50fdbe483e51'
    and prosecdef and provolatile='v' and prorettype='public.job_steps'::regtype and proconfig=array['search_path=""']) then
    raise exception 'project_deletion_settlement_predecessor_mismatch' using errcode='55000';
  end if;
end $$;

-- One condition changes: an already-started, deletion-cancelled subscription
-- result may settle with its existing lease and unchanged runtime policy. This
-- never admits a new step and persists through Restore via job provenance.
create or replace function fluid_private.complete_job_step_core(p_job_id uuid, p_lease_token uuid, p_step_key text, p_state text,
  p_actual_cost_microusd bigint, p_output jsonb default null, p_provider_request_id text default null)
returns public.job_steps language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_step public.job_steps; v_reservation public.usage_reservations;
begin
  v_job := fluid_private.lock_leased_job(p_job_id, p_lease_token);
  select * into v_step from public.job_steps where job_id = p_job_id and step_key = p_step_key for update;
  if not found then raise exception 'step_not_found' using errcode = 'P0002'; end if;
  if p_state is null or p_state not in ('succeeded','failed','ambiguous') or p_actual_cost_microusd is null or p_actual_cost_microusd not between 0 and 9007199254740991 then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;
  if v_step.state <> 'in_flight' then
    if (v_step.state, v_step.actual_cost_microusd, v_step.output, v_step.provider_request_id)
      is not distinct from (p_state, p_actual_cost_microusd, p_output, p_provider_request_id) then return v_step; end if;
    raise exception 'immutable_result' using errcode = '55000';
  end if;
  if v_job.billing_mode = 'openai_api' then
  select * into strict v_reservation from public.usage_reservations where job_id = p_job_id for update;
  update public.usage_accounts set
    spent_microusd = spent_microusd + least(greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd,0), p_actual_cost_microusd),
    provider_actual_microusd = provider_actual_microusd + p_actual_cost_microusd,
    reserved_microusd = reserved_microusd - least(greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd,0), p_actual_cost_microusd)
    where owner_id = v_job.owner_id;
  update public.usage_reservations set actual_microusd = actual_microusd + p_actual_cost_microusd,
    captured_microusd = captured_microusd + least(greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd,0), p_actual_cost_microusd) where job_id = p_job_id;
  else
    if p_actual_cost_microusd <> 0 then raise exception 'invalid_subscription_cost' using errcode='22023'; end if;
    if p_state='succeeded' and ((v_job.state<>'running' and not(v_job.state='cancel_requested' and v_job.project_deletion_requested_at is not null)) or not exists(select 1 from fluid_private.subscription_runtime_policy p where p.owner_id=v_job.owner_id and p.operation=v_job.operation and p.enabled and p.policy=v_job.input->'policy')) then raise exception 'subscription_changed' using errcode='55000'; end if;
    if p_state='succeeded' and (p_output->>'billingMode' is distinct from 'chatgpt_subscription' or p_output->>'provider' is distinct from 'openai' or p_output->>'operation' is distinct from v_job.operation or p_output->>'model' is distinct from v_job.input->'policy'->>'model') then raise exception 'invalid_subscription_result' using errcode='22023'; end if;
  end if;
  update public.job_steps set state = p_state, actual_cost_microusd = p_actual_cost_microusd, output = p_output,
    provider_request_id = p_provider_request_id, completed_at = clock_timestamp() where id = v_step.id returning * into v_step;
  update public.jobs set actual_cost_microusd = actual_cost_microusd + p_actual_cost_microusd where id = p_job_id;
  -- Retain real billing evidence even on an unexpected overrun; stop all further execution.
  if p_state = 'ambiguous' or p_actual_cost_microusd > v_step.reserved_cost_microusd then
    update public.jobs set state = 'needs_reconciliation', lease_token = null, lease_expires_at = null,
      error_code = case when p_state = 'ambiguous' then 'provider_outcome_unknown' else 'cost_overrun' end where id = p_job_id;
  end if;
  return v_step;
end $$;

-- Scrub hostile inherited function defaults on only the new inventory. Replaced
-- functions retain their existing narrow ACLs and OIDs; no worker grants added.
do $$ declare obj record; access record; begin
  for obj in select oid,proowner from pg_proc where oid in (
    'fluid_private.project_deletion_worker(uuid)'::regprocedure,'fluid_private.project_deletion_state(uuid,uuid)'::regprocedure,'fluid_private.project_deletion_summary(uuid,uuid)'::regprocedure,
    'public.request_project_deletion(uuid,integer,integer)'::regprocedure,'public.restore_project_deletion(uuid,integer,integer)'::regprocedure,
    'public.get_project_deletion(uuid)'::regprocedure,'public.get_project_deletion_states(uuid[])'::regprocedure
  ) loop
    for access in select distinct a.grantee,r.rolname from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      left join pg_roles r on r.oid=a.grantee where p.oid=obj.oid and a.grantee<>obj.proowner loop
      execute 'revoke all on function '||obj.oid::regprocedure::text||' from '||case when access.grantee=0 then 'PUBLIC' else quote_ident(access.rolname) end;
    end loop;
  end loop;
end $$;
grant execute on function public.request_project_deletion(uuid,integer,integer),public.restore_project_deletion(uuid,integer,integer),
  public.get_project_deletion(uuid),public.get_project_deletion_states(uuid[]) to authenticated;
commit;
