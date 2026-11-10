-- Honor existing operator-granted Strategy testing when an account's retained
-- allowance exceeds the legacy account-size ceiling. No allowance, grant,
-- policy, request, history or accounting row is changed by this migration.
begin;
create temporary table strategy_ceiling_original_functions on commit drop as
 select oid,proowner,proacl,prosecdef,provolatile,proconfig,proleakproof from pg_proc
 where oid in (
  'fluid_private.api_text_project_allowance_available(uuid,text,uuid)'::regprocedure,
  'fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint)'::regprocedure,
  'fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)'::regprocedure,
  'public.check_api_text_runtime(text,jsonb,text)'::regprocedure);
do $guard$
declare signature text; expected text; definer boolean; volatility text;
begin
 for signature,expected,definer,volatility in values
  ('fluid_private.api_text_project_allowance_available(uuid,text,uuid)','bfeaa536550fcd5595817270d7ace65a',false,'s'),
  ('fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint)','50819915d4fd223e0d69dd076c5bd67c',true,'v'),
  ('fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)','2bd3020adfa7e2301d68fb0d1d7df5c3',false,'s'),
  ('public.check_api_text_runtime(text,jsonb,text)','ad366f72570c64e05a534417438ba3c8',true,'v') loop
  if not exists(select 1 from pg_proc p where p.oid=signature::regprocedure
   and md5(p.prosrc)=expected and p.prosecdef=definer and p.provolatile::text=volatility
   and p.proconfig=array['search_path=""'] and not p.proleakproof
   and p.proowner=(select oid from pg_roles where rolname=current_user)) then
   raise exception 'unexpected_strategy_ceiling_predecessor: %',signature;
  end if;
 end loop;
end $guard$;

-- Admission derives the owner/project and tests the existing per-operation
-- authority. Execution additionally requires its immutable testing admission;
-- runtime only accepts the exact private gateway context for that job.
-- All surrounding quota, overrun, uncertainty, policy, lease and cost checks
-- stay intact. Null-project inspection and ordinary accounts remain bounded.
do $patch$
declare signature text; original text; replacement text; definition text;
begin
 for signature,original,replacement in values
  ('fluid_private.api_text_project_allowance_available(uuid,text,uuid)',
   $old$or a.limit_microusd>5000000$old$,
   $new$or (a.limit_microusd>5000000 and not fluid_private.api_text_testing_project_scope(p_owner,p_operation,p_project))$new$),
  ('fluid_private.enqueue_strategy_job_legacy(uuid,integer,text,text,bigint)',
   $old$if v_account.limit_microusd>5000000 then$old$,
   $new$if v_account.limit_microusd>5000000
   and not fluid_private.api_text_testing_project_scope(v_owner,p_operation,p_project_id) then$new$),
  ('fluid_private.api_text_descriptor(public.jobs,fluid_private.api_text_dispatches)',
   $old$and limit_microusd<=5000000$old$,
   $new$and (limit_microusd<=5000000 or fluid_private.api_text_testing_job_allowed(p_job.id))$new$),
  ('public.check_api_text_runtime(text,jsonb,text)',
   $old$and limit_microusd<=5000000$old$,
   $new$and (limit_microusd<=5000000
  or fluid_private.api_text_testing_gateway_matches(v_owner,p_operation,p_policy,p_deployment_id))$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if(length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
   raise exception 'unexpected_strategy_ceiling_fragment: %',signature;
  end if;
  execute replace(definition,original,replacement);
 end loop;
 if exists(select 1 from strategy_ceiling_original_functions old left join pg_proc p on p.oid=old.oid
  where p.oid is null or (p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proleakproof)
   is distinct from (old.proowner,old.proacl,old.prosecdef,old.provolatile,old.proconfig,old.proleakproof)) then
  raise exception 'strategy_ceiling_security_changed';
 end if;
end $patch$;
commit;
