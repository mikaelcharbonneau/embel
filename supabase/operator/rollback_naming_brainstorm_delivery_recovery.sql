-- Roll back the Naming delivery entry point and its optional feed projection.
-- Drain all shared lanes first, then restore the matching prior worker artifact.
-- Keep recovered names, immutable delivery receipts and provider/billing evidence.
-- This is an operator rollback, not a migration or an authority source packet.
begin;
set local search_path='';
set local lock_timeout='2s';
set local statement_timeout='30s';
do $rollback$
declare signature text;hashes text[];definer boolean;volatility text;
 definition text;body text;needle text;replacement text;gateway_predecessor text;
begin
 if current_user<>'postgres' or session_user<>current_user
  or to_regclass('fluid_private.naming_brainstorm_delivery_recoveries') is null
 then raise exception 'brainstorm_delivery_rollback_prerequisite' using errcode='55000';end if;
 for signature,hashes,definer,volatility in values
  ('public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)',array['c0dd10c70fa62f5d9f7551c1c34443e53b9a0a398293249805eb30e80211e598','1a044e660bde27bf2d16cb3acce55fbe3e4f6bb88ada104ef354cc9b39c58d4f'],true,'v'),
  ('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)',array['f2b0ec503ff74da663f9dba3267c70448466a304c63d7d8435113bf0a44c8aad'],false,'s'),
  ('fluid_private.recover_naming_brainstorm_delivery(jsonb,jsonb,jsonb)',array['fe51e8b9ac9df1b690a82b626fd1e6ece488c20fadde4163c109cf87d42033f0'],false,'v')
 loop
  if not exists(select 1 from pg_proc p where p.oid=to_regprocedure(signature)
   and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=any(hashes)
   and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""']
   and p.prosecdef=definer and p.provolatile::text=volatility and not p.proleakproof)
  then raise exception 'brainstorm_delivery_rollback_source_mismatch: %',signature using errcode='55000';end if;
 end loop;
 select prosrc into body from pg_proc where oid='public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure;
 gateway_predecessor:=case encode(sha256(convert_to(body,'UTF8')),'hex')
  when 'c0dd10c70fa62f5d9f7551c1c34443e53b9a0a398293249805eb30e80211e598' then 'e8bae9ed6a46f0b87e8c78474d5d059dd608b27442421e730d2f0c9f4e599ea4'
  else '5b9e16f786364d7cb5e58a5b9380a1da3490f5c950f8dfb7f47fde435518d7f9' end;
 definition:=pg_get_functiondef('public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure);
 needle:=$needle$begin
 if p_action='brainstorm_recover_delivery' then return fluid_private.recover_naming_brainstorm_delivery(p_slot,p_execution,p_args);end if;
 if p_action not in('brainstorm_state','brainstorm_begin','brainstorm_event','brainstorm_publish','brainstorm_finish') then$needle$;
 replacement:=$replacement$begin
 if p_action not in('brainstorm_state','brainstorm_begin','brainstorm_event','brainstorm_publish','brainstorm_finish') then$replacement$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'brainstorm_delivery_rollback_gateway_mismatch';end if;
 execute replace(definition,body,replace(body,needle,replacement));
 select prosrc into body from pg_proc where oid='fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)'::regprocedure;
 definition:=pg_get_functiondef('fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)'::regprocedure);
 needle:=$needle$ ||case when exists(select 1 from fluid_private.naming_brainstorm_delivery_recoveries recovery where recovery.run_id=r.id and jsonb_array_length(recovery.candidate_ids)>0)
 then jsonb_build_object('recoveredNameCount',(select sum(jsonb_array_length(recovery.candidate_ids)) from fluid_private.naming_brainstorm_delivery_recoveries recovery where recovery.run_id=r.id)) else '{}'::jsonb end
 ||case when completion.id is not null$needle$;
 replacement:=$replacement$ ||case when completion.id is not null$replacement$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'brainstorm_delivery_rollback_summary_mismatch';end if;
 execute replace(definition,body,replace(body,needle,replacement));
 if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure)<>gateway_predecessor
  or (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='fluid_private.naming_brain_summary(fluid_private.naming_brain_runs)'::regprocedure)<>'8b50135a4883f4d6c5abe3ed03102627d3eca5fc58ce8428066e97b12ab2a5e4'
 then raise exception 'brainstorm_delivery_rollback_result_mismatch' using errcode='55000';end if;
end $rollback$;
commit;
