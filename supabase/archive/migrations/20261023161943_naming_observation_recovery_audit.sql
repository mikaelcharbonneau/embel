-- Private append-only operator audit. No application/worker access is granted.
-- Creating this table does not reopen any observation window.
create table fluid_private.naming_observation_recovery_audit (
  run_id uuid primary key,
  owner_id uuid not null,
  project_id uuid not null,
  job_id uuid not null unique,
  decision_reference text not null check(length(decision_reference) between 16 and 300),
  prior_observation jsonb not null,
  prior_job jsonb not null,
  calls_sha256 text not null check(calls_sha256 ~ '^[0-9a-f]{64}$'),
  issued_call_count integer not null check(issued_call_count = 4),
  new_deadline_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key(run_id,owner_id,project_id) references fluid_private.naming_brain_runs(id,owner_id,project_id),
  foreign key(job_id,owner_id,project_id) references public.jobs(id,owner_id,project_id),
  check(jsonb_typeof(prior_observation) = 'object' and jsonb_typeof(prior_job) = 'object')
);
alter table fluid_private.naming_observation_recovery_audit enable row level security;
revoke all on fluid_private.naming_observation_recovery_audit from public,anon,authenticated,service_role;
create trigger naming_observation_recovery_audit_immutable before update or delete
on fluid_private.naming_observation_recovery_audit
for each row execute function fluid_private.prevent_history_change();
