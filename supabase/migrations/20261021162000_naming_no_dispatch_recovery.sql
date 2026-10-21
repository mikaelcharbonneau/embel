-- Recover only a stopped, unleased Naming failure with durable proof that no
-- provider call was authorized. Existing history is retained. Unknown creates,
-- receipts, outputs, live leases and observed overruns are deliberately excluded.
-- Reuse the existing restricted worker maintenance entrypoint and its ACLs.
begin;
do $migration$
declare definition text; original_acl aclitem[]; original_owner oid; original_oid oid;
 needle text := 'n:=n+1; end loop; return n;';
 replacement text := $body$
 n:=n+1; end loop;
 for j in
  select j0.* from public.jobs j0
  join fluid_private.naming_brain_runs r0 on r0.job_id=j0.id and r0.owner_id=j0.owner_id and r0.project_id=j0.project_id
  where r0.owner_id=o and r0.deployment_id=p_deployment_id
   and fluid_private.naming_brain_run_worker(r0)
   and j0.state='needs_reconciliation' and j0.lease_token is null and j0.lease_expires_at is null
   and j0.actual_cost_microusd=0 and not r0.observed_overrun and r0.actual_cost_microusd is null
   and j0.error_code in ('progressive_execution_unknown','progressive_context_unknown','local_planning_failed')
   and fluid_private.naming_brain_no_dispatch(j0.id)
   and not exists(select 1 from fluid_private.naming_brain_provider_records pr where pr.run_id=r0.id)
   and not exists(select 1 from fluid_private.naming_brain_artifacts a where a.run_id=r0.id)
   and not exists(select 1 from fluid_private.naming_brain_prepared_sets ps where ps.run_id=r0.id)
   and not exists(select 1 from public.usage_reservations ur where ur.job_id=j0.id and (ur.actual_microusd<>0 or ur.captured_microusd<>0))
  order by j0.id for update of j0,r0 skip locked
 loop
  select * into strict r from fluid_private.naming_brain_runs where job_id=j.id;
  -- Append the corrected classification; never overwrite immutable observations.
  insert into fluid_private.naming_brain_stage_results(run_id,owner_id,project_id,stage_key,state,output)
   select r.id,r.owner_id,r.project_id,s.step_key,'failed',
    jsonb_build_object('artifactIds','[]'::jsonb,'errorCode','local_planning_failed',
      'partialArtifacts',jsonb_build_array(jsonb_build_object('kind','database_no_dispatch','originalErrorCode',j.error_code)))
   from public.job_steps s where s.job_id=j.id and s.state in ('in_flight','ambiguous');
  update public.job_steps set state='failed',completed_at=clock_timestamp(),
   output=jsonb_build_object('artifactIds','[]'::jsonb,'errorCode','local_planning_failed',
     'partialArtifacts',jsonb_build_array(jsonb_build_object('kind','database_no_dispatch','originalErrorCode',j.error_code)))
   where job_id=j.id and state in ('in_flight','ambiguous');
  update public.jobs set state=case when cancel_requested_at is not null then 'cancelled' else 'failed' end,
   error_code='local_planning_failed',finished_at=clock_timestamp() where id=j.id;
  -- This pre-existing function records database_no_dispatch financial evidence
  -- before settling the zero-spend reservation. It never guesses provider spend.
  perform fluid_private.settle_reservation(j.id);
  n:=n+1;
 end loop;
 return n;
$body$;
begin
 select oid,proacl,proowner into original_oid,original_acl,original_owner from pg_proc
  where oid='public.expire_naming_brain_leases(text,text)'::regprocedure
   and md5(prosrc)='bd0b8aa2bb6b426abf67101703844ca6'
   and prosecdef and proconfig=array['search_path=""'] and proowner=(select oid from pg_roles where rolname=current_user);
 if original_oid is null then raise exception 'unexpected_naming_recovery_predecessor'; end if;
 definition:=pg_get_functiondef(original_oid);
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'unexpected_naming_recovery_shape'; end if;
 execute replace(definition,needle,replacement);
 if not exists(select 1 from pg_proc where oid=original_oid and proacl is not distinct from original_acl and proowner=original_owner and prosecdef and proconfig=array['search_path=""']) then
  raise exception 'naming_recovery_security_changed';
 end if;
end $migration$;
commit;
