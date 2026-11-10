-- Local queued Creator waves and phased gap work share a finite one-hour stage
-- envelope. Individual provider calls retain their existing 240-second policy;
-- their exact committed authorization timestamps are read through the scoped RPC.
begin;
do $patch$
declare signature text; expected text; definition text; original text; replacement text;
begin
 for signature,expected in values
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)','cfde0bff9c4d4c1db5c7814de5c8c6e8'),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)','4341dd0ab330d5cb029340d13c0d424f') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.prosecdef and p.provolatile='v' and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.proowner=(select oid from pg_roles where rolname=current_user)) then raise exception 'unexpected_local_call_timing_predecessor: %',signature; end if;
 end loop;
 for signature,original,replacement in values
 ('public.authorize_naming_brain_dispatch(uuid,uuid,jsonb)',
 $old$created_at+interval '240 seconds'>clock_timestamp()$old$,
 $new$created_at+(case when stage in('creation','gap') and fluid_private.local_prototype_unlimited_job(r.job_id)
 and p_request#>>'{policy,budgetControl}'='local_unlimited_v1' then interval '1 hour' else interval '240 seconds' end)>clock_timestamp()$new$),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)',
 $old$s.created_at+interval '240 seconds'<=clock_timestamp()$old$,
 $new$s.created_at+(case when stage in('creation','gap') and fluid_private.local_prototype_unlimited_job(r.job_id)
 and exists(select 1 from fluid_private.naming_brain_calls local_call where local_call.run_id=r.id and local_call.stage_key=stage and local_call.request#>>'{policy,budgetControl}'='local_unlimited_v1')
 and not exists(select 1 from fluid_private.naming_brain_calls native_call where native_call.run_id=r.id and native_call.stage_key=stage and native_call.request#>>'{policy,budgetControl}' is distinct from 'local_unlimited_v1')
 then interval '1 hour' else interval '240 seconds' end)<=clock_timestamp()$new$),
 ('public.naming_brain_worker_action(uuid,uuid,text,jsonb)',
 $old$'requests',coalesce((select jsonb_agg(request order by authorized_at,call_key) from fluid_private.naming_brain_calls where run_id=r.id and stage_key=stage),'[]'),$old$,
 $new$'requests',coalesce((select jsonb_agg(request order by authorized_at,call_key) from fluid_private.naming_brain_calls where run_id=r.id and stage_key=stage),'[]'),
 'authorizations',coalesce((select jsonb_agg(jsonb_build_object('providerCallKey',call_key,'requestHash',request->>'requestHash','authorizedAt',authorized_at) order by authorized_at,call_key) from fluid_private.naming_brain_calls where run_id=r.id and stage_key=stage),'[]'),$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_local_call_timing_fragment: %',signature; end if;
  execute replace(definition,original,replacement);
 end loop;
end $patch$;
commit;
