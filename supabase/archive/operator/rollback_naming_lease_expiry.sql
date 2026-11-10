-- Roll back the shared Naming "expire" action (shared_naming_lease_expiry.sql).
-- Drain all shared lanes first, then restore the matching prior worker artifact.
-- Job states already moved on by expiry stay as they are: they are truthful
-- outcomes, and their provider/billing evidence is never rewritten here.
-- This is an operator rollback, not a migration or an authority source packet.
begin;
set local search_path='';
set local lock_timeout='2s';
set local statement_timeout='30s';
do $rollback$
declare body text;definition text;needle text;replacement text;predecessor text;
begin
 if current_user<>'postgres' or session_user<>current_user
  or to_regprocedure('fluid_private.expire_shared_naming_leases(jsonb,jsonb)') is null
 then raise exception 'naming_lease_expiry_rollback_prerequisite' using errcode='55000';end if;
 if not exists(select 1 from pg_proc p where p.oid='fluid_private.expire_shared_naming_leases(jsonb,jsonb)'::regprocedure
   and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='a575266fe9b7e1dcf0a99e9dd60a0a56fe3a51213473396b877a0322ca9a8769'
   and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and p.prosecdef and p.provolatile='v' and not p.proleakproof)
 then raise exception 'naming_lease_expiry_rollback_source_mismatch: %','fluid_private.expire_shared_naming_leases(jsonb,jsonb)' using errcode='55000';end if;
 select prosrc into body from pg_proc p where p.oid='public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure
  and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and p.prosecdef and p.provolatile='v' and not p.proleakproof;
 -- Each exact installed gateway maps to the exact gateway it replaced.
 predecessor:=case encode(sha256(convert_to(coalesce(body,''),'UTF8')),'hex')
  when '9e0d4eac2b9430b6ee17eb489c927c0c588684e81a5bfbad66c68bbbab685d78' then '1a044e660bde27bf2d16cb3acce55fbe3e4f6bb88ada104ef354cc9b39c58d4f'
  when 'dc97f278f938e24ad8852234b0dc06bd490683e2a6adcf7a80b43ab79f6829e2' then 'c0dd10c70fa62f5d9f7551c1c34443e53b9a0a398293249805eb30e80211e598' end;
 if predecessor is null then raise exception 'naming_lease_expiry_rollback_source_mismatch: %','public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)' using errcode='55000';end if;
 definition:=pg_get_functiondef('public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure);
 needle:=$needle$ if p_action='expire' then
  if p_execution is not null then raise exception 'invalid_shared_naming_expiry' using errcode='22023';end if;
  return fluid_private.expire_shared_naming_leases(p_slot,p_args);
 end if;
 if p_action='brainstorm_recover_delivery' then return fluid_private.recover_naming_brainstorm_delivery(p_slot,p_execution,p_args);end if;$needle$;
 replacement:=$replacement$ if p_action='brainstorm_recover_delivery' then return fluid_private.recover_naming_brainstorm_delivery(p_slot,p_execution,p_args);end if;$replacement$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'naming_lease_expiry_rollback_gateway_mismatch';end if;
 execute replace(definition,body,replace(body,needle,replacement));
 drop function fluid_private.expire_shared_naming_leases(jsonb,jsonb);
 if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure)<>predecessor
 then raise exception 'naming_lease_expiry_rollback_result_mismatch' using errcode='55000';end if;
end $rollback$;
commit;
