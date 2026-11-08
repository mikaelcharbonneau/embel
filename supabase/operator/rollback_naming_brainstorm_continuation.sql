-- Roll back shared_naming_brainstorm_continuation.sql: an ended brainstorm run
-- with an incomplete set blocks new runs again. Drain the shared lanes first,
-- then restore the matching prior worker artifact and authority manifest.
-- Runs already started while the change was live stay as they are.
-- This is an operator rollback, not a migration or an authority source packet.
begin;
set local search_path='';
set local lock_timeout='2s';
set local statement_timeout='30s';
do $rollback$
declare body text; definition text; needle text; replacement text;
begin
 if current_user<>'postgres' or session_user<>current_user then raise exception 'naming_brainstorm_continuation_rollback_prerequisite' using errcode='55000'; end if;
 select prosrc into body from pg_proc p where p.oid=to_regprocedure('fluid_private.shared_naming_brainstorm_ensure_core(uuid,jsonb)')
  and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and p.prosecdef and p.provolatile='v' and not p.proleakproof;
 needle:=$needle$(jj.state in('partial','failed','cancelled') and not fluid_private.naming_brainstorm_job(jj.id) and not exists(select 1 from fluid_private.naming_brain_prepared_sets complete where complete.run_id=rr.id and complete.prepared#>>'{fulfillment,status}'='complete'))$needle$;
 replacement:=$replacement$(jj.state in('partial','failed','cancelled') and not exists(select 1 from fluid_private.naming_brain_prepared_sets complete where complete.run_id=rr.id and complete.prepared#>>'{fulfillment,status}'='complete'))$replacement$;
 if body is null or (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'naming_brainstorm_continuation_rollback_source_mismatch' using errcode='55000'; end if;
 definition:=pg_get_functiondef('fluid_private.shared_naming_brainstorm_ensure_core(uuid,jsonb)'::regprocedure);
 execute replace(definition,body,replace(body,needle,replacement));
 if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='fluid_private.shared_naming_brainstorm_ensure_core(uuid,jsonb)'::regprocedure)
  <>'33ea6188451e1c3ae9d25c0bb1d5acaffd009a9cb5a3b8a07ab267b84de48d34'
 then raise exception 'naming_brainstorm_continuation_rollback_result_mismatch' using errcode='55000'; end if;
end $rollback$;
commit;
