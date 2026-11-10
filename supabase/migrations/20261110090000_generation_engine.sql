-- Generation engine foundation: credits ledger and Vercel Workflow run records.
-- Design: docs/generation-engine.md. Additive only; no existing object changes.
-- The embel_engine login gets its password outside migrations, in production only.

-- Plans and credits ----------------------------------------------------------

create table fluid_private.plans (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null check (length(name) between 1 and 40),
  monthly_credits integer not null check (monthly_credits >= 0),
  active boolean not null default true
);
insert into fluid_private.plans (id, name, monthly_credits) values
  ('free', 'Free', 30), ('pro', 'Pro', 300), ('studio', 'Studio', 1000);

create table public.credit_accounts (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  plan_id text not null default 'free' references fluid_private.plans(id),
  period_start timestamptz not null,
  period_end timestamptz not null,
  granted_period_start timestamptz,
  updated_at timestamptz not null default now(),
  check (period_end > period_start)
);

create table public.credit_entries (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null check (delta <> 0),
  kind text not null check (kind in ('grant', 'charge', 'refund', 'adjustment')),
  run_id uuid,
  note text check (note is null or length(note) <= 200),
  created_at timestamptz not null default now()
);
create index credit_entries_owner on public.credit_entries (owner_id, created_at);
create unique index credit_entries_one_charge on public.credit_entries (run_id) where kind = 'charge';
create unique index credit_entries_one_refund on public.credit_entries (run_id) where kind = 'refund';

-- Generation kinds, runs and outputs ----------------------------------------

create table fluid_private.generation_kinds (
  kind text primary key check (kind ~ '^[a-z]+(\.[a-z_]+)+$'),
  credits integer not null check (credits >= 0),
  enabled boolean not null default false,
  max_per_day integer not null default 50 check (max_per_day > 0)
);
-- A zero-cost loop that proves start, claim, save and finish end to end.
insert into fluid_private.generation_kinds (kind, credits, enabled, max_per_day) values ('engine.probe', 0, true, 5);

create table public.generation_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null references fluid_private.generation_kinds(kind),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  input jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 65536),
  credits integer not null check (credits >= 0),
  workflow_run_id text check (workflow_run_id is null or length(workflow_run_id) between 1 and 200),
  error_code text check (error_code is null or error_code ~ '^[a-z_]{1,64}$'),
  cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (owner_id, idempotency_key)
);
create index generation_runs_project on public.generation_runs (project_id, kind, created_at desc);
create index generation_runs_owner_day on public.generation_runs (owner_id, kind, created_at);
create unique index generation_runs_one_active on public.generation_runs (project_id, kind) where status in ('queued', 'running');

create table public.generation_outputs (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.generation_runs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  output_key text not null check (output_key ~ '^[a-z0-9_.:-]{1,64}$'),
  output jsonb not null check (pg_column_size(output) <= 1048576),
  provider_response_id text check (provider_response_id is null or length(provider_response_id) between 1 and 200),
  cost_microusd bigint not null default 0 check (cost_microusd >= 0),
  created_at timestamptz not null default now(),
  unique (run_id, output_key)
);
create index generation_outputs_day on public.generation_outputs (created_at);

create table fluid_private.engine_settings (
  id boolean primary key default true check (id),
  paused boolean not null default false,
  global_daily_cost_cap_microusd bigint not null default 50000000 check (global_daily_cost_cap_microusd > 0)
);
insert into fluid_private.engine_settings default values;

-- Access: owners read their own rows; every write goes through functions. -----

alter table public.credit_accounts enable row level security;
alter table public.credit_accounts force row level security;
alter table public.credit_entries enable row level security;
alter table public.credit_entries force row level security;
alter table public.generation_runs enable row level security;
alter table public.generation_runs force row level security;
alter table public.generation_outputs enable row level security;
alter table public.generation_outputs force row level security;
alter table fluid_private.plans enable row level security;
alter table fluid_private.generation_kinds enable row level security;
alter table fluid_private.engine_settings enable row level security;

revoke all on public.credit_accounts, public.credit_entries, public.generation_runs, public.generation_outputs
  from public, anon, authenticated, service_role;
revoke all on fluid_private.plans, fluid_private.generation_kinds, fluid_private.engine_settings
  from public, anon, authenticated, service_role;
grant select on public.credit_accounts, public.credit_entries, public.generation_runs, public.generation_outputs to authenticated;

create policy credit_accounts_own on public.credit_accounts for select to authenticated using (owner_id = auth.uid());
create policy credit_entries_own on public.credit_entries for select to authenticated using (owner_id = auth.uid());
create policy generation_runs_own on public.generation_runs for select to authenticated using (owner_id = auth.uid());
create policy generation_outputs_own on public.generation_outputs for select to authenticated using (owner_id = auth.uid());

-- Credits -------------------------------------------------------------------

create function fluid_private.credit_balance(p_owner uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(delta), 0)::integer from public.credit_entries where owner_id = p_owner;
$$;

-- Monthly allowances don't roll over: a new period resets the balance to the plan's allowance.
create function fluid_private.ensure_credit_period(p_owner uuid) returns public.credit_accounts
language plpgsql security definer set search_path = '' as $$
declare a public.credit_accounts; monthly integer; balance integer;
begin
  insert into public.credit_accounts (owner_id, period_start, period_end)
    values (p_owner, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month')
    on conflict (owner_id) do nothing;
  select * into strict a from public.credit_accounts where owner_id = p_owner for update;
  if a.period_end <= now() then
    update public.credit_accounts
       set period_start = date_trunc('month', now()), period_end = date_trunc('month', now()) + interval '1 month', updated_at = now()
     where owner_id = p_owner returning * into a;
  end if;
  if a.granted_period_start is distinct from a.period_start then
    select monthly_credits into strict monthly from fluid_private.plans where id = a.plan_id;
    balance := fluid_private.credit_balance(p_owner);
    if monthly - balance <> 0 then
      insert into public.credit_entries (owner_id, delta, kind, note) values (p_owner, monthly - balance, 'grant', 'Monthly allowance');
    end if;
    update public.credit_accounts set granted_period_start = a.period_start, updated_at = now()
     where owner_id = p_owner returning * into a;
  end if;
  return a;
end $$;

create function public.get_credit_summary() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o uuid := auth.uid(); a public.credit_accounts;
begin
  if o is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  a := fluid_private.ensure_credit_period(o);
  return jsonb_build_object('planId', a.plan_id, 'balance', fluid_private.credit_balance(o), 'periodEnd', a.period_end);
end $$;

-- Plans and per-kind credits for the app; never prices.
create function public.get_generation_catalog() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  return jsonb_build_object(
    'plans', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'monthlyCredits', p.monthly_credits) order by p.monthly_credits)
                         from fluid_private.plans p where p.active), '[]'::jsonb),
    'kinds', coalesce((select jsonb_agg(jsonb_build_object('kind', k.kind, 'credits', k.credits, 'enabled', k.enabled) order by k.kind)
                         from fluid_private.generation_kinds k), '[]'::jsonb));
end $$;

-- Runs ----------------------------------------------------------------------

-- Ends a run once. A failed or cancelled run returns its credits.
create function fluid_private.finish_generation_run(p_run_id uuid, p_status text, p_error text) returns public.generation_runs
language plpgsql security definer set search_path = '' as $$
declare r public.generation_runs;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then raise exception 'invalid_status' using errcode = '22023'; end if;
  update public.generation_runs
     set status = p_status, error_code = case when p_status = 'succeeded' then null else p_error end, finished_at = now()
   where id = p_run_id and status in ('queued', 'running')
   returning * into r;
  if not found then
    select * into strict r from public.generation_runs where id = p_run_id;
    return r;
  end if;
  if p_status <> 'succeeded' and r.credits > 0 then
    insert into public.credit_entries (owner_id, delta, kind, run_id, note)
      values (r.owner_id, r.credits, 'refund', r.id, 'Generation did not finish')
      on conflict (run_id) where kind = 'refund' do nothing;
  end if;
  return r;
end $$;

create function public.start_generation(p_project_id uuid, p_kind text, p_idempotency_key text, p_input jsonb default '{}'::jsonb)
returns public.generation_runs
language plpgsql security definer set search_path = '' as $$
declare o uuid := auth.uid(); k fluid_private.generation_kinds; r public.generation_runs; s fluid_private.engine_settings;
  stale record; today integer; spent bigint;
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
  -- A run whose workflow never started gets its credits back after ten minutes.
  for stale in select id from public.generation_runs
                where owner_id = o and status = 'queued' and workflow_run_id is null and created_at < now() - interval '10 minutes' loop
    perform fluid_private.finish_generation_run(stale.id, 'failed', 'start_failed');
  end loop;
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

create function public.cancel_generation(p_run_id uuid) returns public.generation_runs
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
  end if;
  return r;
end $$;

-- Engine-only functions -----------------------------------------------------

create function fluid_private.engine_claim(p_run_id uuid, p_workflow_run_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.generation_runs; paused boolean;
begin
  if p_workflow_run_id is null or length(p_workflow_run_id) not between 1 and 200 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into r from public.generation_runs where id = p_run_id for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  select s.paused into strict paused from fluid_private.engine_settings s where s.id;
  if r.status = 'queued' and (r.cancel_requested_at is not null or paused) then
    r := fluid_private.finish_generation_run(r.id, 'cancelled', case when paused then 'generation_paused' else 'cancelled' end);
  elsif r.status = 'queued' then
    update public.generation_runs set status = 'running', workflow_run_id = p_workflow_run_id, started_at = now()
     where id = r.id returning * into r;
  elsif r.workflow_run_id is distinct from p_workflow_run_id then
    raise exception 'claim_conflict' using errcode = '55000';
  end if;
  return jsonb_build_object('id', r.id, 'ownerId', r.owner_id, 'projectId', r.project_id, 'kind', r.kind,
    'status', r.status, 'input', r.input, 'cancelRequested', r.cancel_requested_at is not null);
end $$;

create function fluid_private.engine_check(p_run_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', r.status, 'cancelRequested', r.cancel_requested_at is not null, 'paused', s.paused)
    from public.generation_runs r cross join fluid_private.engine_settings s where r.id = p_run_id and s.id;
$$;

create function fluid_private.engine_save_output(p_run_id uuid, p_key text, p_output jsonb, p_response_id text, p_cost bigint)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare r public.generation_runs;
begin
  select * into r from public.generation_runs where id = p_run_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if r.status <> 'running' then raise exception 'run_not_running' using errcode = '55000'; end if;
  insert into public.generation_outputs (run_id, owner_id, output_key, output, provider_response_id, cost_microusd)
    values (r.id, r.owner_id, p_key, p_output, p_response_id, greatest(coalesce(p_cost, 0), 0))
    on conflict (run_id, output_key) do nothing;
  return found;
end $$;

create function fluid_private.engine_finish(p_run_id uuid, p_status text, p_error text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.generation_runs;
begin
  r := fluid_private.finish_generation_run(p_run_id, p_status, p_error);
  return jsonb_build_object('id', r.id, 'status', r.status, 'errorCode', r.error_code);
end $$;

-- Grants --------------------------------------------------------------------

revoke all on function fluid_private.credit_balance(uuid), fluid_private.ensure_credit_period(uuid),
  fluid_private.finish_generation_run(uuid, text, text), fluid_private.engine_claim(uuid, text),
  fluid_private.engine_check(uuid), fluid_private.engine_save_output(uuid, text, jsonb, text, bigint),
  fluid_private.engine_finish(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.start_generation(uuid, text, text, jsonb), public.cancel_generation(uuid),
  public.get_credit_summary(), public.get_generation_catalog() from public, anon, service_role;
grant execute on function public.start_generation(uuid, text, text, jsonb), public.cancel_generation(uuid),
  public.get_credit_summary(), public.get_generation_catalog() to authenticated;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'embel_engine') then
    create role embel_engine login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 40;
  end if;
end $$;
grant usage on schema fluid_private to embel_engine;
grant execute on function fluid_private.engine_claim(uuid, text), fluid_private.engine_check(uuid),
  fluid_private.engine_save_output(uuid, text, jsonb, text, bigint), fluid_private.engine_finish(uuid, text, text) to embel_engine;
