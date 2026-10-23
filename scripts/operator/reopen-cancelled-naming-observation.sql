-- Execute only inside an operator transaction with transaction-local
-- embel.recovery_request JSON containing runId, jobId, ownerId, projectId,
-- expectedCallsSha256 and decisionReference. No embedded account/run IDs.
-- This creates exactly ONE additional observation claim, never a paid retry.
do $$
declare
  request jsonb := current_setting('embel.recovery_request')::jsonb;
  r fluid_private.naming_brain_runs;
  j public.jobs;
  calls jsonb;
  digest text;
  deadline timestamptz := clock_timestamp() + interval '5 minutes';
begin
  if jsonb_typeof(request) is distinct from 'object'
     or not(request ?& array['runId','jobId','ownerId','projectId','expectedCallsSha256','decisionReference'])
     or request-array['runId','jobId','ownerId','projectId','expectedCallsSha256','decisionReference'] <> '{}'::jsonb
     or length(request->>'decisionReference') not between 16 and 300 then
    raise exception 'invalid_recovery_request';
  end if;
  perform fluid_private.lock_strategy_owner((request->>'ownerId')::uuid);
  select * into strict j from public.jobs where id=(request->>'jobId')::uuid for update;
  select * into strict r from fluid_private.naming_brain_runs where id=(request->>'runId')::uuid for update;
  if r.job_id<>j.id or r.owner_id<>j.owner_id or r.project_id<>j.project_id
     or r.owner_id is distinct from (request->>'ownerId')::uuid
     or r.project_id is distinct from (request->>'projectId')::uuid
     or j.operation<>'naming.generate' or not fluid_private.naming_brain_is_job(j)
     or j.state<>'needs_reconciliation' or j.cancel_requested_at is null
     or j.lease_token is not null or j.lease_expires_at is not null
     or r.recovery_mode<>'observe_only' or r.observation_attempts<>12
     or r.actual_cost_microusd is not null or r.observed_overrun
     or j.reserved_cost_microusd<>5000000
     or not exists(select 1 from public.usage_reservations where job_id=j.id and state='active' and reserved_microusd=5000000)
     or not exists(select 1 from public.job_steps where job_id=j.id and state in('in_flight','ambiguous')) then
    raise exception 'recovery_target_changed';
  end if;
  if exists(select 1 from fluid_private.naming_observation_recovery_audit where run_id=r.id) then
    raise exception 'recovery_already_recorded';
  end if;
  select jsonb_agg(to_jsonb(c) order by c.stage_key,c.call_key) into calls
  from fluid_private.naming_brain_calls c where c.run_id=r.id;
  digest:=encode(sha256(convert_to(calls::text,'UTF8')),'hex');
  if jsonb_array_length(calls) is distinct from 4 or digest is distinct from request->>'expectedCallsSha256'
     or exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=r.id
       and not exists(select 1 from fluid_private.naming_brain_receipts p
         where p.run_id=c.run_id and p.stage_key=c.stage_key and p.call_key=c.call_key and p.receipt->>'sessionId' is not null)) then
    raise exception 'recovery_calls_changed';
  end if;
  insert into fluid_private.naming_observation_recovery_audit
    (run_id,owner_id,project_id,job_id,decision_reference,prior_observation,prior_job,calls_sha256,issued_call_count,new_deadline_at)
  values(r.id,r.owner_id,r.project_id,j.id,request->>'decisionReference',
    jsonb_build_object('attempts',r.observation_attempts,'deadlineAt',r.observation_deadline_at,'nextAt',r.next_observation_at,'mode',r.recovery_mode,'revision',r.revision,'updatedAt',r.updated_at),
    jsonb_build_object('state',j.state,'errorCode',j.error_code,'cancelRequestedAt',j.cancel_requested_at,'reservedCostMicrousd',j.reserved_cost_microusd,'actualCostMicrousd',j.actual_cost_microusd),
    digest,4,deadline);
  -- The next claim increments 11 to 12; eligibility then refuses another claim.
  -- Preserve cancellation, observe-only mode, requests, outputs and all finances.
  update fluid_private.naming_brain_runs set observation_attempts=11,
    observation_deadline_at=deadline,next_observation_at=clock_timestamp() where id=r.id;
end $$;
