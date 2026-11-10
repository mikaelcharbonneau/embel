-- Operator-only, exact evidence repair after 20261017100000 and 17110000.
-- Append the current attempt's corrected verdict; do not certify expense, release holds,
-- rewrite immutable provider history, enqueue work or call the provider.
begin;
do $repair$
declare expected record; r fluid_private.naming_brain_runs; j public.jobs; s public.job_steps; prior fluid_private.naming_brain_stage_results;
begin
 perform fluid_private.lock_strategy_owner('6840f4c2-15a6-45a7-97be-41e7e5e37f42');
 if current_user<>'postgres' or to_regprocedure('fluid_private.local_prototype_unlimited_job(uuid)') is null
 or to_regprocedure('fluid_private.naming_brain_rejected_receipt(fluid_private.naming_brain_calls)') is null then raise exception 'known_rejection_repair_prerequisite'; end if;
 for expected in select * from (values
  ('e839cccb-89be-4c6c-9be8-5199b417dda4'::uuid,'90d3fda3-de0b-48c2-946e-2200b67a883a'::uuid,'b3b82fa9-36a6-437e-9826-9afaf0d796a1'::uuid)
 ) repair(run_id,project_id,job_id) loop
  select * into strict r from fluid_private.naming_brain_runs where id=expected.run_id and project_id=expected.project_id
   and job_id=expected.job_id and owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42' for update;
  select * into strict j from public.jobs where id=r.job_id and owner_id=r.owner_id and project_id=r.project_id for update;
  if j.operation<>'naming.generate' or j.state<>'needs_reconciliation' or j.error_code is distinct from 'provider_request_rejected'
   or j.lease_token is not null or j.lease_expires_at is not null or j.cancel_requested_at is not null or j.actual_cost_microusd<>0
   or r.recovery_mode<>'observe_only' or r.actual_cost_microusd is not null or r.settlement_evidence is not null or r.superseded
   or (select count(*) from fluid_private.naming_brain_calls where run_id=r.id)<>1
   or exists(select 1 from fluid_private.naming_brain_calls c where c.run_id=r.id and (c.stage_key<>'research' or not fluid_private.naming_brain_rejected_receipt(c)))
   or exists(select 1 from fluid_private.naming_brain_provider_records where run_id=r.id)
   or exists(select 1 from fluid_private.naming_brain_artifacts where run_id=r.id)
   or exists(select 1 from fluid_private.naming_brain_prepared_sets where run_id=r.id)
   or exists(select 1 from fluid_private.naming_brain_feed_entries where run_id=r.id)
   or not exists(select 1 from public.usage_reservations where job_id=j.id and owner_id=r.owner_id and project_id=r.project_id
    and state='active' and reserved_microusd=5000000 and actual_microusd=0 and captured_microusd=0)
   then raise exception 'known_rejection_repair_evidence_mismatch: %',r.id; end if;
  if (select count(*) from public.job_steps where job_id=j.id)<>1
   or (select count(*) from fluid_private.naming_brain_stage_results where run_id=r.id)<>1 then raise exception 'known_rejection_repair_stage_mismatch: %',r.id; end if;
  select * into strict s from public.job_steps where job_id=j.id and step_key='research' and owner_id=r.owner_id and project_id=r.project_id for update;
  select * into strict prior from fluid_private.naming_brain_stage_results where run_id=r.id and stage_key='research' and owner_id=r.owner_id and project_id=r.project_id;
  if s.state<>'ambiguous' or prior.state<>'ambiguous' or s.output is distinct from prior.output
   or s.output->>'errorCode' is distinct from 'provider_request_rejected' or s.output->'artifactIds'<>'[]'::jsonb
   or s.actual_cost_microusd<>0 then raise exception 'known_rejection_repair_verdict_mismatch: %',r.id; end if;
  insert into fluid_private.naming_brain_stage_results(run_id,owner_id,project_id,stage_key,state,output)
   values(r.id,r.owner_id,r.project_id,'research','failed',s.output);
  update public.job_steps set state='failed',completed_at=clock_timestamp() where id=s.id;
  update public.jobs set state='failed',finished_at=clock_timestamp() where id=j.id;
  update fluid_private.naming_brain_runs set revision=revision+1,updated_at=clock_timestamp() where id=r.id;
 end loop;
end $repair$;
commit;
