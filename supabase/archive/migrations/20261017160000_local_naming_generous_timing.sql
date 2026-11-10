-- New explicitly local jobs receive generous call timing. The immutable input
-- witness is created only during trusted admission; historical inputs and saved
-- requests retain their original deadlines and hashes.
begin;
do $patch$
declare signature text; expected text; definition text; original text; replacement text;
begin
 for signature,expected in values
 ('public.ensure_naming_brain_run(uuid,jsonb)','142c9a7320e6d598b56a4f1aa4399d5d'),
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)','9afcd81b9d513c39bc1e5e5c6adc7625'),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)','4dd7b8f2841b4850c9c278be31f31598') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.prosecdef and p.provolatile='v' and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.proowner=(select oid from pg_roles where rolname=current_user)) then raise exception 'unexpected_local_generous_timing_predecessor: %',signature; end if;
 end loop;
 for signature,original,replacement in values
 ('public.ensure_naming_brain_run(uuid,jsonb)',
 $old$input:=jsonb_build_object('version',2,'handlerVersion','naming-brain-v1','billingMode','openai_api','runId',runid,'jobId',jobid,'batchId',batchid,'snapshot',snapshot,'acceptedPolicyIdentity',encode(sha256(convert_to(pilot.policy::text,'UTF8')),'hex'),'policy',pilot.policy);$old$,
 $new$input:=jsonb_build_object('version',2,'handlerVersion','naming-brain-v1','billingMode','openai_api','runId',runid,'jobId',jobid,'batchId',batchid,'snapshot',snapshot,'acceptedPolicyIdentity',encode(sha256(convert_to(pilot.policy::text,'UTF8')),'hex'),'policy',pilot.policy);
 if fluid_private.local_prototype_unlimited_context(o,p.id) then input:=input||jsonb_build_object('localTimingVersion',2); end if;$new$),
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)',
 $old$ if not exists(select 1 from public.job_steps where job_id=j.id and step_key=stage and state='in_flight'$old$,
 $new$ if p_request#>'{policy,deadlineMs}'='900000'::jsonb and (j.input->'localTimingVersion' is distinct from '2'::jsonb
 or p_request#>>'{policy,budgetControl}' is distinct from 'local_unlimited_v1' or not fluid_private.local_prototype_unlimited_job(r.job_id))
 then raise exception 'invalid_local_timing' using errcode='22023'; end if;
 if not exists(select 1 from public.job_steps where job_id=j.id and step_key=stage and state='in_flight'$new$),
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)',
 $old$case when stage in('creation','gap') and fluid_private.local_prototype_unlimited_job(r.job_id)
 and p_request#>>'{policy,budgetControl}'='local_unlimited_v1' then interval '1 hour' else interval '240 seconds' end$old$,
 $new$case when fluid_private.local_prototype_unlimited_job(r.job_id) and p_request#>>'{policy,budgetControl}'='local_unlimited_v1'
 then case when stage in('creation','gap') then interval '1 hour'
 when j.input->'localTimingVersion'='2'::jsonb and p_request#>'{policy,deadlineMs}'='900000'::jsonb then interval '20 minutes'
 else interval '240 seconds' end else interval '240 seconds' end$new$),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)',
 $old$case when stage in('creation','gap') and fluid_private.local_prototype_unlimited_job(r.job_id)
 and exists(select 1 from fluid_private.naming_brain_calls local_call where local_call.run_id=r.id and local_call.stage_key=stage and local_call.request#>>'{policy,budgetControl}'='local_unlimited_v1')
 and not exists(select 1 from fluid_private.naming_brain_calls native_call where native_call.run_id=r.id and native_call.stage_key=stage and native_call.request#>>'{policy,budgetControl}' is distinct from 'local_unlimited_v1')
 then interval '1 hour' else interval '240 seconds' end$old$,
 $new$case when fluid_private.local_prototype_unlimited_job(r.job_id)
 and exists(select 1 from fluid_private.naming_brain_calls local_call where local_call.run_id=r.id and local_call.stage_key=stage and local_call.request#>>'{policy,budgetControl}'='local_unlimited_v1')
 and not exists(select 1 from fluid_private.naming_brain_calls native_call where native_call.run_id=r.id and native_call.stage_key=stage and native_call.request#>>'{policy,budgetControl}' is distinct from 'local_unlimited_v1')
 then case when stage in('creation','gap') then interval '1 hour'
 when j.input->'localTimingVersion'='2'::jsonb and not exists(select 1 from fluid_private.naming_brain_calls old_call where old_call.run_id=r.id and old_call.stage_key=stage and old_call.request#>'{policy,deadlineMs}' is distinct from '900000'::jsonb) then interval '20 minutes'
 else interval '240 seconds' end else interval '240 seconds' end$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_local_generous_timing_fragment: %',signature; end if;
  execute replace(definition,original,replacement);
 end loop;
end $patch$;
commit;
