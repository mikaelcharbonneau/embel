-- A completed local stage can advance through the existing recovery gate after
-- its old inference deadline. Every issued authorization must have its genuine
-- completed output; the following stage still starts with its own deadline.
begin;
do $patch$
declare definition text; original text; replacement text;
begin
 if not exists(select 1 from pg_proc p where p.oid='public.naming_brain_worker_action(uuid,uuid,text,jsonb)'::regprocedure
  and md5(p.prosrc)='be75fdf23fcf2bc6a3cae7d39b30684e' and p.prosecdef and p.provolatile='v'
  and p.proconfig=array['search_path=""'] and not p.proleakproof and p.proowner=(select oid from pg_roles where rolname=current_user)) then
  raise exception 'unexpected_local_completed_stage_predecessor';
 end if;
 if not exists(select 1 from pg_proc p where p.oid='public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb)'::regprocedure
  and md5(p.prosrc)='934f9e75e4cbcc4418833f4d0139320f' and p.prosecdef and p.provolatile='v'
  and p.proconfig=array['search_path=""'] and not p.proleakproof and p.proowner=(select oid from pg_roles where rolname=current_user)) then
  raise exception 'unexpected_local_completed_output_predecessor';
 end if;
 original:=$old$or s.created_at+interval '240 seconds'<=clock_timestamp()$old$;
 replacement:=$new$or (s.created_at+interval '240 seconds'<=clock_timestamp() and not (
  fluid_private.local_prototype_unlimited_job(r.job_id) and s.state='succeeded'
  and exists(select 1 from fluid_private.naming_brain_calls completed where completed.run_id=r.id and completed.stage_key=stage)
  and not exists(select 1 from fluid_private.naming_brain_calls issued where issued.run_id=r.id
   and (issued.request#>>'{policy,budgetControl}' is distinct from 'local_unlimited_v1' or not fluid_private.naming_brain_call_completed(issued)))))$new$;
 definition:=pg_get_functiondef('public.naming_brain_worker_action(uuid,uuid,text,jsonb)'::regprocedure);
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_local_completed_stage_fragment'; end if;
 execute replace(definition,original,replacement);
 definition:=pg_get_functiondef('public.complete_naming_brain_stage(uuid,uuid,text,text,jsonb)'::regprocedure);
 original:=$old$ end if;
 return to_jsonb(s); end$old$;
 replacement:=$new$ end if;
 if p_state='succeeded' and p_stage_key<>'prepare' and r.recovery_mode='observe_only'
 and fluid_private.local_prototype_unlimited_job(r.job_id) then
  perform public.naming_brain_worker_action(p_job_id,p_lease_token,'resume_execution',jsonb_build_object('stageKey',p_stage_key));
 end if;
 return to_jsonb(s); end$new$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_local_completed_output_fragment'; end if;
 execute replace(definition,original,replacement);
end $patch$;
commit;
