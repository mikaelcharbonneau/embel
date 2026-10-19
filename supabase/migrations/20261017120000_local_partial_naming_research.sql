-- A real local partial Research artifact may guide creative work. Its readiness
-- and provenance remain unchanged; factual claim verification remains mandatory.
begin;
do $patch$
declare definition text; original text; replacement text;
begin
 if not exists(select 1 from pg_proc p where p.oid='public.naming_brain_worker_action(uuid,uuid,text,jsonb)'::regprocedure
  and md5(p.prosrc)='de95c17d61d5640dcc3a7cf51636c9e3' and p.prosecdef and p.provolatile='v'
  and p.proconfig=array['search_path=""'] and not p.proleakproof and p.proowner=(select oid from pg_roles where rolname=current_user)) then raise exception 'unexpected_local_partial_research_predecessor'; end if;
 definition:=pg_get_functiondef('public.naming_brain_worker_action(uuid,uuid,text,jsonb)'::regprocedure);
 original:=$old$a.run_id=r.id and a.stage_key='research' and a.artifact->>'readiness'='sourced' and exists(select 1 from jsonb_array_elements(a.artifact->'sources') x where x->>'evidenceStatus'='retrieved')$old$;
 replacement:=$new$a.run_id=r.id and a.stage_key='research' and (
  (a.artifact->>'readiness'='sourced' and exists(select 1 from jsonb_array_elements(a.artifact->'sources') x where x->>'evidenceStatus'='retrieved'))
  or (a.artifact->>'readiness'='partial' and a.artifact#>>'{providerReceipt,budgetControl}'='local_unlimited_v1' and fluid_private.local_prototype_unlimited_job(r.job_id)))$new$;
 if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then raise exception 'unexpected_local_partial_research_fragment'; end if;
 execute replace(definition,original,replacement);
end $patch$;
commit;
