-- The global daily cost cap keeps counting the spend of deleted accounts
-- (pre-launch abuse test, architecture review M3; tests/qa/spending-abuse-adversarial.test.ts).
--
-- The hole: start_generation's last-resort global cap summed the provider cost of
-- public.generation_outputs from the past day. Deleting an account
-- (public.account_deletion_purge, 20261110200000) removes that person's runs and
-- outputs, so their spend left the sum. A script that signs up, spends its free
-- credits and deletes the account, over and over, was never stopped by the cap.
--
-- The fix: the cap also counts the provider cost the purge copies into
-- fluid_private.deleted_account_usage (one 'generation_run' row per run, with the
-- run's cost and its start time, indexed by occurred_at). Nothing else in the
-- function changes: owner check, input limits, the per-owner lock, pause switch,
-- running-time expiry, one active run per project and kind, the per-kind daily
-- limit and the credit check are exactly as before.
--
-- Rollback: re-run the start_generation definition from 20261110190000_baseline.sql
-- (and the same revoke/grant as below).

begin;

create or replace function public.start_generation(p_project_id uuid, p_kind text, p_idempotency_key text, p_input jsonb default '{}'::jsonb)
returns public.generation_runs
language plpgsql security definer set search_path = '' as $_$
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
  -- Spend of the past day, including accounts deleted since (their outputs are gone,
  -- the purge kept each run's cost in deleted_account_usage).
  select coalesce((select sum(o2.cost_microusd) from public.generation_outputs o2 where o2.created_at > now() - interval '1 day'), 0)
       + coalesce((select sum(d.cost_microusd) from fluid_private.deleted_account_usage d
                    where d.source = 'generation_run' and d.occurred_at > now() - interval '1 day'), 0)
    into spent;
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
end $_$;

revoke all on function public.start_generation(uuid, text, text, jsonb) from public, anon;
grant execute on function public.start_generation(uuid, text, text, jsonb) to authenticated;

commit;
