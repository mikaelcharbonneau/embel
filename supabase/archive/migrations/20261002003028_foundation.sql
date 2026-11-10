-- Greenfield Fluid foundation. No data or schema imported from an earlier app.
begin;

create schema fluid_private;
revoke all on schema fluid_private from public, anon, authenticated;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  scope text not null check (scope in ('complete_brand','naming_only','visual_identity_only')),
  title text not null check (length(title) between 1 and 200),
  current_revision integer not null default 1 check (current_revision > 0),
  created_at timestamptz not null default now(),
  unique(id, owner_id)
);
create index projects_owner_created on public.projects(owner_id, created_at desc);

create table public.project_revisions (
  project_id uuid not null,
  owner_id uuid not null default auth.uid(),
  revision integer not null check (revision > 0),
  context jsonb not null check (jsonb_typeof(context) = 'object' and octet_length(context::text) <= 131072),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key(project_id, revision),
  unique(project_id, owner_id, revision),
  foreign key(project_id, owner_id) references public.projects(id, owner_id)
);
alter table public.projects add constraint projects_current_revision_fk
  foreign key(id, owner_id, current_revision) references public.project_revisions(project_id, owner_id, revision)
  deferrable initially deferred;
create index project_revisions_owner on public.project_revisions(owner_id, project_id);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  project_id uuid not null,
  kind text not null check(length(kind) between 1 and 64),
  liked boolean not null default false,
  saved boolean not null default false,
  used boolean not null default false,
  created_at timestamptz not null default now(),
  unique(id, project_id, owner_id),
  foreign key(project_id, owner_id) references public.projects(id, owner_id)
);
create index assets_owner_project on public.assets(owner_id, project_id);

create table public.asset_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  project_id uuid not null,
  asset_id uuid not null,
  version integer not null check(version > 0),
  input_revision integer not null,
  input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
  content jsonb not null default '{}' check(octet_length(content::text) <= 1048576),
  content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
  mime_type text not null check(length(mime_type) between 1 and 150),
  storage_path text unique,
  provenance jsonb not null check(jsonb_typeof(provenance) = 'object' and octet_length(provenance::text) <= 32768),
  created_at timestamptz not null default now(),
  unique(asset_id, version),
  unique(id, asset_id, project_id, owner_id),
  foreign key(asset_id, project_id, owner_id) references public.assets(id, project_id, owner_id),
  foreign key(project_id, owner_id, input_revision) references public.project_revisions(project_id, owner_id, revision),
  check(storage_path is null or storage_path = owner_id::text || '/' || project_id::text || '/' || asset_id::text || '/' || id::text)
);
create index asset_versions_owner_project on public.asset_versions(owner_id, project_id);

create table public.asset_selections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  project_id uuid not null,
  asset_id uuid not null,
  version_id uuid not null,
  reason text not null check(reason in ('selected','restored')),
  created_at timestamptz not null default now(),
  foreign key(version_id, asset_id, project_id, owner_id) references public.asset_versions(id, asset_id, project_id, owner_id)
);
create index asset_selections_owner_project on public.asset_selections(owner_id, project_id, created_at desc);

create table public.usage_accounts (
  owner_id uuid primary key references auth.users(id),
  limit_microusd bigint not null default 0 check(limit_microusd between 0 and 9007199254740991),
  reserved_microusd bigint not null default 0 check(reserved_microusd >= 0),
  spent_microusd bigint not null default 0 check(spent_microusd >= 0),
  provider_actual_microusd bigint not null default 0 check(provider_actual_microusd >= 0)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  project_id uuid not null,
  operation text not null check(length(operation) between 1 and 100),
  input_revision integer not null,
  input_hash text not null check(input_hash ~ '^[0-9a-f]{64}$'),
  input jsonb not null check(jsonb_typeof(input) = 'object' and octet_length(input::text) <= 131072),
  plan_manifest jsonb,
  plan_fingerprint text check(plan_fingerprint is null or plan_fingerprint ~ '^[0-9a-f]{64}$'),
  plan_registered_at timestamptz,
  idempotency_key text not null check(length(idempotency_key) between 1 and 200),
  state text not null default 'queued' check(state in ('queued','running','partial','cancel_requested','cancelled','succeeded','failed','needs_reconciliation')),
  progress integer not null default 0 check(progress between 0 and 100),
  lease_token uuid,
  lease_expires_at timestamptz,
  worker_id text,
  attempts integer not null default 0,
  max_attempts integer not null default 3 check(max_attempts between 1 and 10),
  reserved_cost_microusd bigint not null check(reserved_cost_microusd between 0 and 9007199254740991),
  actual_cost_microusd bigint not null default 0 check(actual_cost_microusd >= 0),
  cancel_requested_at timestamptz,
  error_code text check(error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(owner_id, idempotency_key),
  unique(id, owner_id, project_id),
  foreign key(project_id, owner_id, input_revision) references public.project_revisions(project_id, owner_id, revision),
  check(attempts between 0 and max_attempts),
  check((plan_manifest is null) = (plan_fingerprint is null) and (plan_manifest is null) = (plan_registered_at is null)),
  check((lease_token is null) = (lease_expires_at is null)),
  check((state in ('running','cancel_requested')) = (lease_token is not null))
);
create index jobs_owner_project on public.jobs(owner_id, project_id, created_at desc);
create index jobs_claim_queue on public.jobs(created_at, id) where state = 'queued';
create index jobs_expired_leases on public.jobs(lease_expires_at) where lease_token is not null;

create table public.job_steps (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  owner_id uuid not null,
  project_id uuid not null,
  step_key text not null check(length(step_key) between 1 and 200),
  request_key text not null check(length(request_key) between 1 and 200),
  state text not null check(state in ('in_flight','succeeded','failed','ambiguous')),
  reserved_cost_microusd bigint not null check(reserved_cost_microusd between 0 and 9007199254740991),
  actual_cost_microusd bigint not null default 0 check(actual_cost_microusd >= 0),
  provider_request_id text check(provider_request_id is null or length(provider_request_id) between 1 and 300),
  output jsonb check(output is null or octet_length(output::text) <= 1048576),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(job_id, step_key),
  unique(job_id, request_key),
  foreign key(job_id, owner_id, project_id) references public.jobs(id, owner_id, project_id)
);
create index job_steps_owner_project on public.job_steps(owner_id, project_id);

create table public.usage_reservations (
  job_id uuid primary key,
  owner_id uuid not null,
  project_id uuid not null,
  reserved_microusd bigint not null check(reserved_microusd between 0 and 9007199254740991),
  actual_microusd bigint not null default 0 check(actual_microusd >= 0),
  captured_microusd bigint not null default 0 check(captured_microusd between 0 and reserved_microusd),
  state text not null default 'active' check(state in ('active','settled')),
  created_at timestamptz not null default now(),
  foreign key(owner_id) references public.usage_accounts(owner_id),
  foreign key(job_id, owner_id, project_id) references public.jobs(id, owner_id, project_id)
);
create index usage_reservations_owner on public.usage_reservations(owner_id);

-- Every public owned table has both grants and RLS. No anonymous reads, even empty tables.
do $$ declare t text; begin
  foreach t in array array['projects','project_revisions','assets','asset_versions','asset_selections','jobs','job_steps','usage_accounts','usage_reservations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated, service_role', t);
    execute format('create policy owned_read on public.%I for select to authenticated using (owner_id = (select auth.uid()))', t);
  end loop;
end $$;
-- Lease tokens and worker internals are not a user-facing capability or status field.
revoke select on public.jobs from authenticated;
grant select(id, owner_id, project_id, operation, input_revision, state, progress,
  reserved_cost_microusd, actual_cost_microusd, cancel_requested_at, error_code, created_at, finished_at)
  on public.jobs to authenticated;

grant update(title) on public.projects to authenticated;
create policy owned_project_update on public.projects for update to authenticated
  using(owner_id = (select auth.uid())) with check(owner_id = (select auth.uid()));
grant update(liked, saved, used) on public.assets to authenticated;
create policy owned_asset_update on public.assets for update to authenticated
  using(owner_id = (select auth.uid())) with check(owner_id = (select auth.uid()));
grant insert(project_id, asset_id, version_id, reason) on public.asset_selections to authenticated;
create policy owned_selection_insert on public.asset_selections for insert to authenticated
  with check(owner_id = (select auth.uid()));

create function fluid_private.prevent_history_change() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'immutable_history' using errcode = '55000'; end $$;
create trigger revisions_immutable before update or delete on public.project_revisions for each row execute function fluid_private.prevent_history_change();
create trigger versions_immutable before update or delete on public.asset_versions for each row execute function fluid_private.prevent_history_change();
create trigger selections_immutable before update or delete on public.asset_selections for each row execute function fluid_private.prevent_history_change();

create function fluid_private.protect_job_plan() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.plan_manifest is not null and (new.plan_manifest, new.plan_fingerprint, new.plan_registered_at)
      is distinct from (old.plan_manifest, old.plan_fingerprint, old.plan_registered_at) then
    raise exception 'immutable_job_plan' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger job_plan_immutable before update on public.jobs for each row execute function fluid_private.protect_job_plan();

create function public.create_project(p_scope text, p_title text, p_context jsonb, p_input_hash text)
returns public.projects language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid(); v_project public.projects;
begin
  if v_owner is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  insert into public.projects(owner_id, scope, title) values(v_owner, p_scope, p_title) returning * into v_project;
  insert into public.project_revisions(project_id, owner_id, revision, context, input_hash)
    values(v_project.id, v_owner, 1, p_context, p_input_hash);
  return v_project;
end $$;

create function public.append_project_revision(p_project_id uuid, p_expected_revision integer, p_context jsonb, p_input_hash text)
returns public.project_revisions language plpgsql security definer set search_path = '' as $$
declare v_project public.projects; v_revision public.project_revisions;
begin
  select * into v_project from public.projects where id = p_project_id and owner_id = auth.uid() for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_project.current_revision <> p_expected_revision then raise exception 'revision_conflict' using errcode = '40001'; end if;
  insert into public.project_revisions(project_id, owner_id, revision, context, input_hash)
    values(v_project.id, v_project.owner_id, p_expected_revision + 1, p_context, p_input_hash) returning * into v_revision;
  update public.projects set current_revision = v_revision.revision where id = v_project.id;
  return v_revision;
end $$;

-- Budget limits are an administrative policy input. There is deliberately no user RPC to raise them.
create function public.enqueue_job(p_owner_id uuid, p_project_id uuid, p_operation text,
  p_input_revision integer, p_input_hash text, p_input jsonb, p_idempotency_key text,
  p_max_cost_microusd bigint, p_max_attempts integer default 3)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare v_existing public.jobs; v_job public.jobs; v_account public.usage_accounts; v_revision integer;
begin
  -- The account lock serializes both budget checks and same-owner idempotency races.
  select * into v_account from public.usage_accounts where owner_id = p_owner_id for update;
  if not found then raise exception 'budget_unavailable' using errcode = 'P0001'; end if;
  select * into v_existing from public.jobs where owner_id = p_owner_id and idempotency_key = p_idempotency_key;
  if found then
    if (v_existing.project_id, v_existing.operation, v_existing.input_revision, v_existing.input_hash,
        v_existing.input, v_existing.reserved_cost_microusd, v_existing.max_attempts)
       is distinct from (p_project_id, p_operation, p_input_revision, p_input_hash, p_input, p_max_cost_microusd, p_max_attempts) then
      raise exception 'idempotency_conflict' using errcode = '23505';
    end if;
    return v_existing;
  end if;
  select current_revision into v_revision from public.projects where id = p_project_id and owner_id = p_owner_id for share;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_revision <> p_input_revision then raise exception 'revision_conflict' using errcode = '40001'; end if;
  if p_max_cost_microusd < 0 or p_max_cost_microusd > v_account.limit_microusd - greatest(v_account.spent_microusd, v_account.provider_actual_microusd) - v_account.reserved_microusd then
    raise exception 'budget_exceeded' using errcode = 'P0001';
  end if;
  insert into public.jobs(owner_id, project_id, operation, input_revision, input_hash, input, idempotency_key, reserved_cost_microusd, max_attempts)
    values(p_owner_id, p_project_id, p_operation, p_input_revision, p_input_hash, p_input, p_idempotency_key, p_max_cost_microusd, p_max_attempts)
    returning * into v_job;
  insert into public.usage_reservations(job_id, owner_id, project_id, reserved_microusd)
    values(v_job.id, p_owner_id, p_project_id, p_max_cost_microusd);
  update public.usage_accounts set reserved_microusd = reserved_microusd + p_max_cost_microusd where owner_id = p_owner_id;
  return v_job;
end $$;

create function fluid_private.lock_leased_job(p_job_id uuid, p_lease_token uuid)
returns public.jobs language plpgsql set search_path = '' as $$
declare v_job public.jobs;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found or p_lease_token is null or v_job.lease_token is distinct from p_lease_token
      or v_job.lease_expires_at <= clock_timestamp() or v_job.state not in ('running','cancel_requested') then
    raise exception 'lease_lost' using errcode = '40001';
  end if;
  return v_job;
end $$;

create function fluid_private.settle_reservation(p_job_id uuid) returns void language plpgsql set search_path = '' as $$
declare v_reservation public.usage_reservations;
begin
  select * into strict v_reservation from public.usage_reservations where job_id = p_job_id for update;
  if v_reservation.state = 'settled' then return; end if;
  update public.usage_accounts set reserved_microusd = reserved_microusd - greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd, 0)
    where owner_id = v_reservation.owner_id;
  update public.usage_reservations set state = 'settled' where job_id = p_job_id;
end $$;

create function public.claim_job(p_worker_id text, p_lease_seconds integer default 60)
returns setof public.jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs;
begin
  if p_worker_id is null or length(p_worker_id) not between 1 and 100 or p_lease_seconds is null or p_lease_seconds not between 5 and 300 then
    raise exception 'invalid_lease' using errcode = '22023';
  end if;
  select j.* into v_job from public.jobs j join public.usage_accounts a on a.owner_id = j.owner_id
    where j.state = 'queued' and j.attempts < j.max_attempts
      and a.reserved_microusd <= a.limit_microusd - greatest(a.spent_microusd, a.provider_actual_microusd)
    order by j.created_at, j.id for update of j skip locked limit 1;
  if not found then return; end if;
  return query update public.jobs set state = 'running', lease_token = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
    worker_id = p_worker_id, attempts = attempts + 1 where id = v_job.id returning *;
end $$;

create function public.heartbeat_job(p_job_id uuid, p_lease_token uuid, p_lease_seconds integer default 60)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs;
begin
  v_job := fluid_private.lock_leased_job(p_job_id, p_lease_token);
  if p_lease_seconds is null or p_lease_seconds not between 5 and 300 then raise exception 'invalid_lease' using errcode = '22023'; end if;
  update public.jobs set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds) where id = p_job_id returning * into v_job;
  return v_job;
end $$;

create function public.report_job_progress(p_job_id uuid, p_lease_token uuid, p_progress integer)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs;
begin
  v_job := fluid_private.lock_leased_job(p_job_id, p_lease_token);
  if p_progress is null or p_progress not between v_job.progress and 99 then raise exception 'invalid_progress' using errcode = '22023'; end if;
  update public.jobs set progress = p_progress where id = p_job_id returning * into v_job;
  return v_job;
end $$;

-- Register the exact ordered operation plan before the first provider boundary.
-- This survives worker deploys and prevents a smaller retry plan from claiming success.
create function public.register_job_plan(p_job_id uuid, p_lease_token uuid, p_manifest jsonb)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_step jsonb; v_key text; v_keys text[] := '{}'; v_max numeric; v_total numeric := 0;
begin
  v_job := fluid_private.lock_leased_job(p_job_id, p_lease_token);
  if v_job.state <> 'running' then raise exception 'cancel_requested' using errcode = '55000'; end if;
  if v_job.plan_manifest is not null then
    if v_job.plan_manifest is distinct from p_manifest then raise exception 'plan_conflict' using errcode = '40001'; end if;
    return v_job;
  end if;
  if exists(select 1 from public.job_steps where job_id = p_job_id) then raise exception 'plan_already_started' using errcode = '55000'; end if;
  if p_manifest is null or jsonb_typeof(p_manifest) <> 'array' then raise exception 'invalid_plan' using errcode = '22023'; end if;
  if jsonb_array_length(p_manifest) not between 1 and 1000 or octet_length(p_manifest::text) > 262144 then
    raise exception 'invalid_plan' using errcode = '22023';
  end if;
  for v_step in select value from jsonb_array_elements(p_manifest) loop
    if jsonb_typeof(v_step) <> 'object' then raise exception 'invalid_plan' using errcode = '22023'; end if;
    if jsonb_typeof(v_step->'key') is distinct from 'string' or jsonb_typeof(v_step->'maximumCostMicrousd') is distinct from 'number'
        or v_step - 'key' - 'maximumCostMicrousd' <> '{}'::jsonb then
      raise exception 'invalid_plan' using errcode = '22023';
    end if;
    v_key := v_step->>'key';
    v_max := (v_step->>'maximumCostMicrousd')::numeric;
    if v_key !~ '^[A-Za-z0-9._:-]{1,100}$' or v_key = any(v_keys) or v_max not between 0 and 9007199254740991 or trunc(v_max) <> v_max then
      raise exception 'invalid_plan' using errcode = '22023';
    end if;
    v_keys := array_append(v_keys, v_key);
    v_total := v_total + v_max;
  end loop;
  if v_total > v_job.reserved_cost_microusd then raise exception 'budget_exceeded' using errcode = 'P0001'; end if;
  update public.jobs set plan_manifest = p_manifest,
    plan_fingerprint = encode(sha256(convert_to(p_manifest::text, 'UTF8')), 'hex'),
    plan_registered_at = clock_timestamp() where id = p_job_id returning * into v_job;
  return v_job;
end $$;

create function public.begin_job_step(p_job_id uuid, p_lease_token uuid, p_step_key text, p_request_key text, p_max_cost_microusd bigint)
returns public.job_steps language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_step public.job_steps; v_pending bigint; v_account public.usage_accounts;
begin
  v_job := fluid_private.lock_leased_job(p_job_id, p_lease_token);
  if v_job.state <> 'running' then raise exception 'cancel_requested' using errcode = '55000'; end if;
  select * into strict v_account from public.usage_accounts where owner_id = v_job.owner_id for share;
  if v_account.reserved_microusd > v_account.limit_microusd - greatest(v_account.spent_microusd, v_account.provider_actual_microusd) then
    raise exception 'budget_exceeded' using errcode = 'P0001';
  end if;
  if v_job.plan_manifest is null then raise exception 'plan_required' using errcode = '55000'; end if;
  if not exists(select 1 from jsonb_array_elements(v_job.plan_manifest) planned(step)
      where planned.step->>'key' = p_step_key and (planned.step->>'maximumCostMicrousd')::numeric = p_max_cost_microusd) then
    raise exception 'plan_step_mismatch' using errcode = '22023';
  end if;
  select * into v_step from public.job_steps where job_id = p_job_id and step_key = p_step_key;
  if found then
    if (v_step.request_key, v_step.reserved_cost_microusd) is distinct from (p_request_key, p_max_cost_microusd) then
      raise exception 'idempotency_conflict' using errcode = '23505';
    end if;
    -- Returning an existing in-flight row must NOT authorize another provider call.
    raise exception 'step_already_started' using errcode = '55000';
  end if;
  select coalesce(sum(reserved_cost_microusd),0) into v_pending from public.job_steps where job_id = p_job_id and state in ('in_flight','ambiguous');
  if p_max_cost_microusd is null or p_max_cost_microusd < 0 or p_max_cost_microusd > v_job.reserved_cost_microusd - v_job.actual_cost_microusd - v_pending then
    raise exception 'budget_exceeded' using errcode = 'P0001';
  end if;
  insert into public.job_steps(job_id, owner_id, project_id, step_key, request_key, state, reserved_cost_microusd)
    values(v_job.id, v_job.owner_id, v_job.project_id, p_step_key, p_request_key, 'in_flight', p_max_cost_microusd) returning * into v_step;
  return v_step;
end $$;

create function public.complete_job_step(p_job_id uuid, p_lease_token uuid, p_step_key text, p_state text,
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
  select * into strict v_reservation from public.usage_reservations where job_id = p_job_id for update;
  update public.usage_accounts set
    spent_microusd = spent_microusd + least(greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd,0), p_actual_cost_microusd),
    provider_actual_microusd = provider_actual_microusd + p_actual_cost_microusd,
    reserved_microusd = reserved_microusd - least(greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd,0), p_actual_cost_microusd)
    where owner_id = v_job.owner_id;
  update public.usage_reservations set actual_microusd = actual_microusd + p_actual_cost_microusd,
    captured_microusd = captured_microusd + least(greatest(v_reservation.reserved_microusd - v_reservation.actual_microusd,0), p_actual_cost_microusd) where job_id = p_job_id;
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

create function public.finish_job(p_job_id uuid, p_lease_token uuid, p_state text, p_error_code text default null)
returns public.jobs language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_has_output boolean;
begin
  v_job := fluid_private.lock_leased_job(p_job_id, p_lease_token);
  if p_state is null or p_state not in ('succeeded','failed','partial','cancelled') then raise exception 'invalid_outcome' using errcode = '22023'; end if;
  if exists(select 1 from public.job_steps where job_id = p_job_id and state in ('in_flight','ambiguous')) then
    raise exception 'unresolved_steps' using errcode = '55000';
  end if;
  if v_job.state = 'cancel_requested' and p_state <> 'cancelled' then raise exception 'cancel_requested' using errcode = '55000'; end if;
  select exists(select 1 from public.job_steps where job_id = p_job_id and state = 'succeeded') into v_has_output;
  if (p_state in ('succeeded','partial') and not v_has_output) or
      (p_state = 'succeeded' and exists(select 1 from public.job_steps where job_id = p_job_id and state <> 'succeeded')) or
      (p_state = 'failed' and v_has_output) then raise exception 'invalid_outcome' using errcode = '22023'; end if;
  if p_state = 'succeeded' then
    if v_job.plan_manifest is null or exists(
        select 1 from jsonb_array_elements(v_job.plan_manifest) planned(step)
        where not exists(select 1 from public.job_steps s where s.job_id = p_job_id
          and s.step_key = planned.step->>'key' and s.state = 'succeeded'
          and s.reserved_cost_microusd = (planned.step->>'maximumCostMicrousd')::numeric))
        or exists(select 1 from public.job_steps s where s.job_id = p_job_id and not exists(
          select 1 from jsonb_array_elements(v_job.plan_manifest) planned(step) where planned.step->>'key' = s.step_key)) then
      raise exception 'plan_incomplete' using errcode = '55000';
    end if;
  end if;
  perform fluid_private.settle_reservation(p_job_id);
  update public.jobs set state = p_state, error_code = p_error_code,
    progress = case when p_state = 'succeeded' then 100 else progress end,
    lease_token = null, lease_expires_at = null, finished_at = clock_timestamp() where id = p_job_id returning * into v_job;
  return v_job;
end $$;

create function public.request_job_cancel(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs;
begin
  select * into v_job from public.jobs where id = p_job_id and owner_id = auth.uid() for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_job.state = 'queued' then
    perform fluid_private.settle_reservation(p_job_id);
    update public.jobs set state = 'cancelled', cancel_requested_at = clock_timestamp(), finished_at = clock_timestamp()
      where id = p_job_id returning * into v_job;
  elsif v_job.state = 'running' then
    update public.jobs set state = 'cancel_requested', cancel_requested_at = clock_timestamp() where id = p_job_id returning * into v_job;
  elsif v_job.state = 'needs_reconciliation' then
    update public.jobs set cancel_requested_at = coalesce(cancel_requested_at, clock_timestamp()) where id = p_job_id returning * into v_job;
  end if;
  return jsonb_build_object(
    'id', v_job.id, 'project_id', v_job.project_id, 'operation', v_job.operation,
    'input_revision', v_job.input_revision, 'state', v_job.state, 'progress', v_job.progress,
    'reserved_cost_microusd', v_job.reserved_cost_microusd, 'actual_cost_microusd', v_job.actual_cost_microusd,
    'cancel_requested_at', v_job.cancel_requested_at, 'error_code', v_job.error_code,
    'created_at', v_job.created_at, 'finished_at', v_job.finished_at);
end $$;

create function public.expire_job_leases() returns integer language plpgsql security definer set search_path = '' as $$
declare v_job public.jobs; v_next text; v_count integer := 0;
begin
  for v_job in select * from public.jobs where lease_expires_at <= clock_timestamp() and state in ('running','cancel_requested') for update skip locked loop
    if exists(select 1 from public.job_steps where job_id = v_job.id and state in ('in_flight','ambiguous')) then
      v_next := 'needs_reconciliation';
    elsif v_job.state = 'cancel_requested' then v_next := 'cancelled';
    elsif v_job.attempts < v_job.max_attempts then v_next := 'queued';
    elsif exists(select 1 from public.job_steps where job_id = v_job.id and state = 'succeeded') then v_next := 'partial';
    else v_next := 'failed'; end if;
    if v_next in ('cancelled','partial','failed') then perform fluid_private.settle_reservation(v_job.id); end if;
    update public.jobs set state = v_next, lease_token = null, lease_expires_at = null,
      error_code = case when v_next = 'needs_reconciliation' then 'lease_expired_with_unresolved_step' else 'lease_expired' end,
      finished_at = case when v_next in ('cancelled','partial','failed') then clock_timestamp() else null end where id = v_job.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- No reconciliation RPC intentionally: provider-specific evidence/policy must be approved first.
-- Functions default to PUBLIC execute in PostgreSQL; explicitly revoke every one.
revoke all on all functions in schema fluid_private from public, anon, authenticated, service_role;
revoke all on function public.create_project(text,text,jsonb,text),
 public.append_project_revision(uuid,integer,jsonb,text), public.request_job_cancel(uuid),
 public.enqueue_job(uuid,uuid,text,integer,text,jsonb,text,bigint,integer),
 public.claim_job(text,integer), public.heartbeat_job(uuid,uuid,integer), public.report_job_progress(uuid,uuid,integer),
 public.register_job_plan(uuid,uuid,jsonb), public.begin_job_step(uuid,uuid,text,text,bigint), public.complete_job_step(uuid,uuid,text,text,bigint,jsonb,text),
 public.finish_job(uuid,uuid,text,text), public.expire_job_leases() from public, anon, authenticated, service_role;
grant execute on function public.create_project(text,text,jsonb,text), public.append_project_revision(uuid,integer,jsonb,text), public.request_job_cancel(uuid) to authenticated;
grant execute on function public.enqueue_job(uuid,uuid,text,integer,text,jsonb,text,bigint,integer),
 public.claim_job(text,integer), public.heartbeat_job(uuid,uuid,integer), public.report_job_progress(uuid,uuid,integer),
 public.register_job_plan(uuid,uuid,jsonb), public.begin_job_step(uuid,uuid,text,text,bigint), public.complete_job_step(uuid,uuid,text,text,bigint,jsonb,text),
 public.finish_job(uuid,uuid,text,text), public.expire_job_leases() to service_role;

-- Private object reads/uploads require an exact immutable version manifest belonging to the user.
-- No user UPDATE/DELETE policy: storage upsert would destroy version immutability.
insert into storage.buckets(id, name, public, file_size_limit)
  values('fluid-assets','fluid-assets',false,52428800);
create policy fluid_asset_read on storage.objects for select to authenticated
  using(bucket_id = 'fluid-assets' and exists(select 1 from public.asset_versions v where v.storage_path = name and v.owner_id = (select auth.uid())));
create policy fluid_asset_insert on storage.objects for insert to authenticated
  with check(bucket_id = 'fluid-assets' and owner_id = (select auth.uid())::text
    and exists(select 1 from public.asset_versions v where v.storage_path = name and v.owner_id = (select auth.uid())));

commit;
