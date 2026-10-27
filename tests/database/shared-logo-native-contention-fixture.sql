-- DISPOSABLE NATIVE FIXTURE ONLY. No LOGIN, credentials, grants or provider call.
-- Caller supplies ONE row with existing confirmed customer/project and an
-- existing qualified fixed Logo slot (actual role/instance/generation claimed).
-- CREATE TEMP TABLE shared_logo_contention_parameters(owner_id uuid,project_id uuid,slot_id uuid);
-- INSERT INTO shared_logo_contention_parameters VALUES(<owner>,<project>,<slot>);
-- Run this seed as fixture administrator and COMMIT before the two-client test.
create temporary table shared_logo_contention_case as
 select p.owner_id,p.project_id,s.slot_id,gen_random_uuid() job_id,gen_random_uuid() lease_token,
  jsonb_build_object('operation','identity.logo_export','policyIdentity','fa35a3d5e43410d69832d1d0b35f24b8de4f68df8ea4d790e78a2dc06cbe797c',
   'handlerVersion','logo-export-v1','provider',null,'model',null,'engine',null,'maxCostMicrousd',0) policy
 from shared_logo_contention_parameters p join fluid_private.shared_worker_slots s on s.slot_id=p.slot_id and s.lane='logo';
insert into public.jobs(id,owner_id,project_id,operation,input_revision,input_hash,input,idempotency_key,state,reserved_cost_microusd,billing_mode,error_code,max_attempts)
 select c.job_id,c.owner_id,c.project_id,'identity.logo_export',p.current_revision,repeat('a',64),
  jsonb_build_object('version',2,'operation','identity.logo_export','policyIdentity',c.policy->>'policyIdentity'),
  'synthetic-native-export-lock:'||c.job_id::text,'needs_reconciliation',0,'openai_api','export_publication_unknown',1
 from shared_logo_contention_case c join public.projects p on (p.id,p.owner_id)=(c.project_id,c.owner_id);
insert into fluid_private.shared_job_admissions(job_id,owner_id,project_id,lane,operation,input_hash,policy_identity,policy,deployment_id,eligibility_epoch)
 select c.job_id,c.owner_id,c.project_id,'logo','identity.logo_export',repeat('a',64),c.policy->>'policyIdentity',c.policy,s.deployment_id,a.eligibility_epoch
 from shared_logo_contention_case c join fluid_private.shared_worker_slots s using(slot_id) join fluid_private.shared_accounts a on a.owner_id=c.owner_id;
insert into fluid_private.shared_worker_executions(slot_id,instance_id,generation,slot_lease_token,lane,owner_id,project_id,job_id,lease_token,operation,policy_identity,deployment_id,state)
 select s.slot_id,s.instance_id,s.generation,s.lease_token,'logo',c.owner_id,c.project_id,c.job_id,c.lease_token,'identity.logo_export',c.policy->>'policyIdentity',s.deployment_id,'observing'
 from shared_logo_contention_case c join fluid_private.shared_worker_slots s using(slot_id);
select c.job_id,c.project_id,s.role_name,fluid_private.shared_worker_slot_json(s) slot,
 fluid_private.shared_worker_execution_json(e) execution
 from shared_logo_contention_case c join fluid_private.shared_worker_slots s using(slot_id)
 join fluid_private.shared_worker_executions e on e.job_id=c.job_id;
-- Client A (administrator fixture session): BEGIN; SELECT 1 FROM public.projects WHERE id=$project FOR UPDATE;
-- Client B (actual restricted slot LOGIN session):
-- SELECT public.shared_logo_worker_action($slot::jsonb,$execution::jsonb,'finish_known','[]'::jsonb);
-- Must promptly return result {status:retained_unknown}, not wait for A. It may
-- park the observing execution again, but never writes an export witness/assets.
-- Client A: ROLLBACK. Verify job remains needs_reconciliation and all contexts empty.
-- Fixture database/container is removed normally after verification.
