-- UNAPPLIED. A short brainstorm set no longer blocks the next one.
-- Requires shared_naming_brainstorm.sql (and the packets after it).
--
-- Brainstorm admission inherited a rule from the earlier progressive pipeline:
-- while the project's current run ended with an incomplete set (partial,
-- failed or cancelled), every new "initial" or "scroll" request returned that
-- run instead of starting another, because that pipeline offered Resume for it.
-- Brainstorm runs never offer Resume (naming_brain_summary sets canResume to
-- false), so a set that ended at 95 of 100 names blocked More names until the
-- naming choices were changed.
--
-- An ended brainstorm run is final: its calls are terminal and its hold is
-- settled, so starting a new run never repeats possibly completed paid work.
-- This exempts only brainstorm runs from that rule. Runs that may still be in
-- flight or unconfirmed (queued, running, cancel_requested,
-- needs_reconciliation) keep blocking exactly as before, as do older runs.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $install$
declare body text; definition text; needle text; replacement text;
begin
 if current_user<>'postgres' or session_user<>current_user
  or to_regprocedure('fluid_private.naming_brainstorm_job(uuid)') is null
 then raise exception 'shared_naming_brainstorm_continuation_prerequisite' using errcode='55000'; end if;
 select prosrc into body from pg_proc p where p.oid=to_regprocedure('fluid_private.shared_naming_brainstorm_ensure_core(uuid,jsonb)')
  and encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='33ea6188451e1c3ae9d25c0bb1d5acaffd009a9cb5a3b8a07ab267b84de48d34'
  and p.proowner='postgres'::regrole and p.proconfig=array['search_path=""'] and p.prosecdef and p.provolatile='v' and not p.proleakproof;
 if body is null then raise exception 'shared_naming_brainstorm_continuation_predecessor_mismatch' using errcode='55000'; end if;
 needle:=$needle$(jj.state in('partial','failed','cancelled') and not exists(select 1 from fluid_private.naming_brain_prepared_sets complete where complete.run_id=rr.id and complete.prepared#>>'{fulfillment,status}'='complete'))$needle$;
 replacement:=$replacement$(jj.state in('partial','failed','cancelled') and not fluid_private.naming_brainstorm_job(jj.id) and not exists(select 1 from fluid_private.naming_brain_prepared_sets complete where complete.run_id=rr.id and complete.prepared#>>'{fulfillment,status}'='complete'))$replacement$;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'shared_naming_brainstorm_continuation_rule_mismatch'; end if;
 definition:=pg_get_functiondef('fluid_private.shared_naming_brainstorm_ensure_core(uuid,jsonb)'::regprocedure);
 execute replace(definition,body,replace(body,needle,replacement));
end $install$;
commit;
