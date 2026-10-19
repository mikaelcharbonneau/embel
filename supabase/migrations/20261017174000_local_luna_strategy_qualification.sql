-- D080: future owner-approved local Luna policies qualify independently of the
-- shared hosted Sol policy. Keep the global operation kill switch and every
-- existing owner, restricted-role, readiness, saved-policy and lease fence.
-- No policy row, admitted job, hosted binding or privilege is changed here.
begin;
do $qualification$
declare signature text; expected text; definer boolean; volatility text;
 definition text; original text; replacement text;
begin
 for signature,expected,definer,volatility in values
  ('fluid_private.local_strategy_job_ready(uuid)','ee90f3f6ff5f1279f7dd48f97d8ff810',false,'s'),
  ('public.get_local_strategy_availability(uuid)','3a45250620fd0546da6aed38844a5292',true,'v'),
  ('public.enqueue_local_strategy_job(uuid,integer,text,text,bigint)','fbdc684e6ac8bdbc961399aa1c114861',true,'v'),
  ('fluid_private.report_local_strategy_ready(text,jsonb,integer)','aa0ac9a1d40e45a1af663e1416f521a0',false,'v'),
  ('fluid_private.claim_local_strategy_job(text,integer)','bfbfe583da40709b21a2cb92cf1dc814',false,'v') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.prosecdef=definer and p.provolatile::text=volatility and p.proconfig=array['search_path=""']
   and not p.proleakproof and p.proowner=(select oid from pg_roles where rolname=current_user)) then
   raise exception 'unexpected_local_luna_qualification_predecessor: %',signature;
  end if;
 end loop;
 for signature in values
  ('fluid_private.local_strategy_job_ready(uuid)'),
  ('public.get_local_strategy_availability(uuid)'),
  ('public.enqueue_local_strategy_job(uuid,integer,text,text,bigint)'),
  ('fluid_private.report_local_strategy_ready(text,jsonb,integer)'),
  ('fluid_private.claim_local_strategy_job(text,integer)') loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if signature='public.enqueue_local_strategy_job(uuid,integer,text,text,bigint)' then
   original:='runtime.policy=cap.policy';
   replacement:=$local$(runtime.policy=cap.policy or (cap.policy->>'model'='gpt-6-luna' and fluid_private.api_text_guided_policy(cap.operation,cap.policy)))$local$;
  else
   original:='p.policy=c.policy';
   replacement:=$local$(p.policy=c.policy or (c.policy->>'model'='gpt-6-luna' and fluid_private.api_text_guided_policy(c.operation,c.policy)))$local$;
  end if;
  if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
   raise exception 'unexpected_local_luna_qualification_fragment: %',signature;
  end if;
  execute replace(definition,original,replacement);
 end loop;
end $qualification$;
commit;
