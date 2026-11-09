-- Running time limits for the generation engine (docs/generation-engine.md).
-- A run whose workflow stopped reporting must not block its step forever. Each kind
-- now has a running time limit; past it, the run ends as failed with run_timed_out and
-- its credits come back. Nothing is retried for the person: they can start again.
-- The check runs where the owner acts: when they start a run and when they cancel one.
-- Additive: one column with a default, one private helper, two replaced functions with
-- unchanged signatures and grants.

alter table fluid_private.generation_kinds
  add column max_running_minutes integer not null default 30
  check (max_running_minutes between 1 and 240);

-- Ends this owner's overdue runs, with refunds:
-- - queued with no workflow after ten minutes: the start failed (start_failed);
-- - running past its kind's limit: the workflow stopped reporting (run_timed_out).
create function fluid_private.expire_overdue_generation_runs(p_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare overdue record;
begin
  for overdue in
    select r.id, case when r.status = 'queued' then 'start_failed' else 'run_timed_out' end as code
      from public.generation_runs r join fluid_private.generation_kinds k on k.kind = r.kind
     where r.owner_id = p_owner
       and ((r.status = 'queued' and r.workflow_run_id is null and r.created_at < now() - interval '10 minutes')
         or (r.status = 'running' and r.started_at < now() - make_interval(mins => k.max_running_minutes)))
  loop
    perform fluid_private.finish_generation_run(overdue.id, 'failed', overdue.code);
  end loop;
end $$;
revoke all on function fluid_private.expire_overdue_generation_runs(uuid) from public, anon, authenticated, service_role;

create or replace function public.start_generation(p_project_id uuid, p_kind text, p_idempotency_key text, p_input jsonb default '{}'::jsonb)
returns public.generation_runs
language plpgsql security definer set search_path = '' as $$
declare o uuid := auth.uid(); k fluid_private.generation_kinds; r public.generation_runs; s fluid_private.engine_settings;
  today integer; spent bigint;
begin
  if o is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_project_id is null or p_kind is null or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     or p_input is null or jsonb_typeof(p_input) <> 'object' or pg_column_size(p_input) > 65536 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- One owner's admissions are serialized so balances and limits can't race.
  perform pg_advisory_xact_lock(hashtextextended('embel_generation:' || o::text, 0));
  select * into r from public.generation_runs where owner_id = o and idempotency_key = p_idempotency_key;
  if found then
    if r.project_id <> p_project_id or r.kind <> p_kind then raise exception 'idempotency_conflict' using errcode = '23505'; end if;
    return r;
  end if;
  if not exists (select 1 from public.projects where id = p_project_id and owner_id = o and deleted_at is null and deletion_requested_at is null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into k from fluid_private.generation_kinds where kind = p_kind;
  if not found or not k.enabled then raise exception 'generation_unavailable' using errcode = '55000'; end if;
  select * into strict s from fluid_private.engine_settings where id;
  if s.paused then raise exception 'generation_paused' using errcode = '55000'; end if;
  perform fluid_private.expire_overdue_generation_runs(o);
  if exists (select 1 from public.generation_runs where project_id = p_project_id and kind = p_kind and status in ('queued', 'running')) then
    raise exception 'generation_active' using errcode = 'PT409';
  end if;
  select count(*) into today from public.generation_runs where owner_id = o and kind = p_kind and created_at > now() - interval '1 day';
  if today >= k.max_per_day then raise exception 'daily_limit' using errcode = 'PT429'; end if;
  select coalesce(sum(cost_microusd), 0) into spent from public.generation_outputs where created_at > now() - interval '1 day';
  if spent >= s.global_daily_cost_cap_microusd then raise exception 'generation_paused' using errcode = '55000'; end if;
  perform fluid_private.ensure_credit_period(o);
  if k.credits > 0 and fluid_private.credit_balance(o) < k.credits then
    raise exception 'insufficient_credits' using errcode = 'PT402';
  end if;
  insert into public.generation_runs (owner_id, project_id, kind, idempotency_key, input, credits)
    values (o, p_project_id, p_kind, p_idempotency_key, p_input, k.credits) returning * into r;
  if k.credits > 0 then
    insert into public.credit_entries (owner_id, delta, kind, run_id) values (o, -k.credits, 'charge', r.id);
  end if;
  return r;
end $$;

-- Cancelling an overdue run ends it at once; a live one still stops at its next step.
create or replace function public.cancel_generation(p_run_id uuid) returns public.generation_runs
language plpgsql security definer set search_path = '' as $$
declare o uuid := auth.uid(); r public.generation_runs;
begin
  if o is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  update public.generation_runs set cancel_requested_at = coalesce(cancel_requested_at, now())
   where id = p_run_id and owner_id = o returning * into r;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  -- Nothing has started yet, so it can end right away.
  if r.status = 'queued' and r.workflow_run_id is null then
    r := fluid_private.finish_generation_run(r.id, 'cancelled', 'cancelled');
  else
    perform fluid_private.expire_overdue_generation_runs(o);
    select * into strict r from public.generation_runs where id = p_run_id;
  end if;
  return r;
end $$;
